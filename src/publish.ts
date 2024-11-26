import { spawnSync } from 'child_process';
import * as fs from "fs";
import * as path from "node:path";
import { Octokit } from "octokit";
import config from "../config/publish.json" assert { type: "json" };

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

    for (const directory of config.directories) {
        console.log(`Directory ${directory}...`);

        process.chdir(`../${directory}`);

        if (run(true, "git", "branch", "--show-current")[0] !== "main") {
            throw new Error("Repository is not on main branch");
        }

        if (directoryStates[directory] === undefined && run(true, "git", "status", "--short").length !== 0) {
            throw new Error("Repository has uncommitted changes");
        }

        function step(state: string, callback: () => void) {
            let directoryState = directoryStates[directory];

            if (directoryState === undefined || directoryState === state) {
                directoryStates[directory] = state;

                try {
                    callback();

                    delete directoryStates[directory];
                } finally {
                    fs.writeFileSync(stateFilePath, `${JSON.stringify(directoryStates, null, 2)}\n`);
                }
            }
        }

        step("package", () => {
            const packageConfigPath = "package.json";

            const packageConfig: JSONAsRecord = JSON.parse(fs.readFileSync(packageConfigPath).toString());

            packageConfig["version"] = config.version;

            const organizationPrefix = `@${config.organization}/`;
            const dependencyVersion = `^${config.version}`;

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
        });

        step("npm install", () => {
            run(false, "npm", "install");
        });

        step("git commit", () => {
            run(false, "git", "commit", "--all", `--message=Updated to version ${config.version}`);
        });

        step("git tag", () => {
            run(false, "git", "tag", `v${config.version}`);
        });

        step("git push", () => {
            run(false, "git", "push", "--all");
        });

        const [owner, repoGit] = run(true, "git", "config", "--get", "remote.origin.url")[0].split("/").slice(-2);
        const parameterBase = {
            owner: owner,
            repo: repoGit.substring(0, repoGit.length - 4)
        }

        const octokit = new Octokit();

        let queryCount = 0;

        do {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, queryCount === 0 ? 0 : 2000);
            }).then(() => {
                return octokit.rest.actions.listWorkflowRunsForRepo({
                    ...parameterBase
                });
            }).then((value) => {
                console.log(`${JSON.stringify(value, null, 2)}\n`);
            });
        } while (queryCount++ < 20);

        directoryStates[directory] = "complete";
        saveState();
    }

    directoryStates = {};
    saveState();
}

await publish().catch((e) => {
    console.error(e);
});
