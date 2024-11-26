import { spawnSync } from 'child_process';
import * as fs from "fs";
import * as path from "node:path";
import { Octokit } from "octokit";
import { parse as yamlParse } from "yaml";

import configurationJSON from "../config/publish.json" assert { type: "json" };
import secureConfigurationJSON from "../config/publish.secure.json" assert { type: "json" };

interface Configuration {
    version: string;
    organization: string;
    directories: string[];
    ignoreUncommitted?: boolean;
}

interface SecureConfiguration {
    token: string;
}

const configuration: Configuration = configurationJSON;
const secureConfiguration: SecureConfiguration = secureConfigurationJSON;

type UntypedRecord = Record<string, unknown>;
type UndefinableUntypedRecord = UntypedRecord | undefined;

interface Workflow {
    name: string;
    on: {
        push?: {
            branches: string[];
        };
        release?: {
            types: string[];
        };
    }
}

function run(captureOutput: boolean, command: string, ...args: string[]): string[] {
    const spawnResult = spawnSync(command, args, {
        stdio: ["inherit", captureOutput ? "pipe" : "inherit", "inherit"]
    });

    if (spawnResult.error !== undefined) {
        throw spawnResult.error;
    }

    if (spawnResult.status === null) {
        throw new Error(`Terminated by signal ${spawnResult.signal}`);
    } else if (spawnResult.status !== 0) {
        throw new Error(`Failed with status ${spawnResult.status}`);
    }

    return captureOutput ? spawnResult.stdout.toString().split("\n").slice(0, -1) : [];
}

async function publish(): Promise<void> {
    const statePath = path.resolve("config/publish.state.json");

    let directoryStates: Record<string, string | undefined> = {};

    if (fs.existsSync(statePath)) {
        directoryStates = JSON.parse(fs.readFileSync(statePath).toString());
    }

    function saveState() {
        fs.writeFileSync(statePath, `${JSON.stringify(directoryStates, null, 2)}\n`);
    }

    for (const directory of configuration.directories) {
        console.log(`Directory ${directory}...`);

        process.chdir(`../${directory}`);

        if (run(true, "git", "branch", "--show-current")[0] !== "main") {
            throw new Error("Repository is not on main branch");
        }

        if (!configuration.ignoreUncommitted && directoryStates[directory] === undefined && run(true, "git", "status", "--short").length !== 0) {
            throw new Error("Repository has uncommitted changes");
        }

        const releaseWorkflowPath = ".github/workflows/release.yml";

        let hasPushWorkflow = false;
        let hasReleaseWorkflow = false;

        if (fs.existsSync(releaseWorkflowPath)) {
            const workflowOn = (yamlParse(fs.readFileSync(releaseWorkflowPath).toString()) as Workflow).on;

            hasPushWorkflow = workflowOn.push?.branches?.includes("main") ?? false;
            hasReleaseWorkflow = workflowOn.release?.types?.includes("published") ?? false;
        }

        async function step(state: string, callback: () => (void | Promise<void>)): Promise<void> {
            function log(phase: string) {
                console.log(`${phase} ${state}`);
            }

            let directoryState = directoryStates[directory];

            if (directoryState === undefined || directoryState === state) {
                directoryStates[directory] = state;

                log("Starting");

                try {
                    const result = callback();

                    if (result instanceof Promise) {
                        log("Awaiting");

                        await result;

                        log("Resolved");
                    }

                    delete directoryStates[directory];

                    log("Completed");
                } finally {
                    fs.writeFileSync(statePath, `${JSON.stringify(directoryStates, null, 2)}\n`);
                }
            } else {
                log("Skipped");
            }
        }

        const tag = `v${configuration.version}`;

        const [owner, repoGit] = run(true, "git", "config", "--get", "remote.origin.url")[0].split("/").slice(-2);
        const parameterBase = {
            owner: owner,
            repo: repoGit.substring(0, repoGit.length - 4)
        }

        const octokit = new Octokit({
            auth: secureConfiguration.token,
            userAgent: `${configuration.organization} publisher`
        });

        let commitSHA = "";

        async function validateWorkflow() {
            const workflowIDs = new Set<number>();

            let queryCount = 0;
            let allCompleted = false;

            do {
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, queryCount === 0 ? 0 : 2000);
                }).then(() => {
                    return octokit.rest.actions.listWorkflowRunsForRepo({
                        ...parameterBase,
                        head_sha: commitSHA
                    });
                }).then((value) => {
                    for (const workflowRun of value.data.workflow_runs) {
                        if (workflowRun.status !== "completed" || workflowIDs.has(workflowRun.id)) {
                            if (workflowRun.status !== "completed") {
                                workflowIDs.add(workflowRun.id);
                            } else {
                                workflowIDs.delete(workflowRun.id);
                                allCompleted = workflowIDs.size === 0;
                            }

                            console.log(`ID: ${workflowRun.id}\nName: ${workflowRun.name}\nStatus: ${workflowRun.status}\nConclusion: ${workflowRun.conclusion}\nBranch: ${workflowRun.head_branch}\nSHA: ${workflowRun.head_sha}\nEvent: ${workflowRun.event}\n\n`);
                        }
                    }

                    console.log("-");
                });
            } while (queryCount++ < 30 && !allCompleted);
        }

        await step("package", () => {
            const packageConfigPath = "package.json";

            const packageConfig: UntypedRecord = JSON.parse(fs.readFileSync(packageConfigPath).toString());

            packageConfig["version"] = configuration.version;

            const organizationPrefix = `@${configuration.organization}/`;
            const dependencyVersion = `^${configuration.version}`;

            function updateDependencies(dependencies: UndefinableUntypedRecord) {
                if (dependencies !== undefined) {
                    for (const key in dependencies) {
                        if (key.startsWith(organizationPrefix)) {
                            dependencies[key] = dependencyVersion;
                        }
                    }
                }
            }

            updateDependencies(packageConfig["devDependencies"] as UndefinableUntypedRecord);
            updateDependencies(packageConfig["dependencies"] as UndefinableUntypedRecord);

            fs.writeFileSync(packageConfigPath, `${JSON.stringify(packageConfig, null, 2)}\n`);
        }).then(() => {
            return step("npm install", () => {
                run(false, "npm", "install");
            });
        }).then(() => {
            return step("git commit", () => {
                run(false, "git", "commit", "--all", `--message=Updated to version ${configuration.version}`);
            });
        }).then(() => {
            return step("git sha", () => {
                commitSHA = run(true, "git", "rev-parse", "HEAD")[0];
            });
        }).then(() => {
            return step("git tag", () => {
                run(false, "git", "tag", tag);
            });
        }).then(() => {
            return step("git push", () => {
                run(false, "git", "push", "--atomic", "origin", "main", tag);
            });
        }).then(() => {
            return step("push workflow", async () => {
                if (hasPushWorkflow) {
                    await validateWorkflow();
                }
            });
        }).then(() => {
            return step("release", async () => {
                const versionSplit = configuration.version.split("-");
                const prerelease = versionSplit.length !== 1;

                await octokit.rest.repos.createRelease({
                    ...parameterBase,
                    tag_name: tag,
                    name: `${prerelease ? `${versionSplit[1].substring(0, 1).toUpperCase()}${versionSplit[1].substring(1)} r` : "R"}elease ${versionSplit[0]}`,
                    prerelease
                });
            });
        }).then(() => {
            return step("release workflow", async () => {
                if (hasReleaseWorkflow) {
                    await validateWorkflow();
                }
            });
        });

        directoryStates[directory] = "complete";
        saveState();
    }

    directoryStates = {};
    saveState();
}

await publish().catch((e) => {
    console.error(e);
});
