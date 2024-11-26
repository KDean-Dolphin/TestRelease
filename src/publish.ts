import { spawnSync } from 'child_process';
import * as fs from "fs";
import * as path from "node:path";
import { Octokit } from "octokit";

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

type JSONAsRecord = Record<string, unknown>;
type UndefinableJSONAsRecord = JSONAsRecord | undefined;

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
    const stateFilePath = path.resolve("config/publish.state.json");

    let directoryStates: Record<string, string | undefined> = {};

    if (fs.existsSync(stateFilePath)) {
        directoryStates = JSON.parse(fs.readFileSync(stateFilePath).toString());
    }

    function saveState() {
        fs.writeFileSync(stateFilePath, `${JSON.stringify(directoryStates, null, 2)}\n`);
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
                    fs.writeFileSync(stateFilePath, `${JSON.stringify(directoryStates, null, 2)}\n`);
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

        await step("package", () => {
            const packageConfigPath = "package.json";

            const packageConfig: JSONAsRecord = JSON.parse(fs.readFileSync(packageConfigPath).toString());

            packageConfig["version"] = configuration.version;

            const organizationPrefix = `@${configuration.organization}/`;
            const dependencyVersion = `^${configuration.version}`;

            function updateDependencies(dependencies: UndefinableJSONAsRecord) {
                if (dependencies !== undefined) {
                    for (const key in dependencies) {
                        if (key.startsWith(organizationPrefix)) {
                            dependencies[key] = dependencyVersion;
                        }
                    }
                }
            }

            updateDependencies(packageConfig["devDependencies"] as UndefinableJSONAsRecord);
            updateDependencies(packageConfig["dependencies"] as UndefinableJSONAsRecord);

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
            return step("git tag", () => {
                run(false, "git", "tag", tag);
            });
        }).then(() => {
            return step("git push", () => {
                run(false, "git", "push", "--atomic", "origin", "main", tag);
            });
        }).then(() => {
            return step("release", async () => {
                const versionSplit = configuration.version.split("-");
                const prerelease = versionSplit.length !== 1;

                await octokit.rest.repos.createRelease({
                    ...parameterBase,
                    tag_name: tag,
                    // TODO Remove XXX.
                    name: `${prerelease ? `${versionSplit[1].substring(0, 1).toUpperCase()}${versionSplit[1].substring(1)} r` : "R"} elease ${versionSplit[0]} XXX`,
                    draft: true,
                    prerelease
                });
            });
        }).then(async () => {
            const workflowIDs = new Set<number>();

            let queryCount = 0;

            do {
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, queryCount === 0 ? 0 : 2000);
                }).then(() => {
                    return octokit.rest.actions.listWorkflowRunsForRepo({
                        ...parameterBase
                    });
                }).then((value) => {
                    for (const workflowRun of value.data.workflow_runs) {
                        if (workflowRun.status !== "completed" || workflowIDs.has(workflowRun.id)) {
                            workflowIDs.add(workflowRun.id);

                            console.log(`ID: ${workflowRun.id}\nName: ${workflowRun.name}\nStatus: ${workflowRun.status}\nConclusion: ${workflowRun.conclusion}\nBranch: ${workflowRun.head_branch}\nSHA: ${workflowRun.head_sha}\nEvent: ${workflowRun.event}\n\n`);
                        }
                    }

                    console.log("-");
                });
            } while (queryCount++ < 30);
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
