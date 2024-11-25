import { spawnSync } from 'child_process';
import * as fs from "fs";
import * as path from "node:path";
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

function publish(): void {
    const publisherPath = path.resolve(".");

    const stateFilePath = path.resolve(publisherPath, "config/publish.state.json");

    let repositoryStates: Record<string, string | undefined> = {};

    if (fs.existsSync(stateFilePath)) {
        fs.readFile(stateFilePath, null, (err, data) => {
            if (err !== null) {
                throw err;
            }

            repositoryStates = JSON.parse(data.toString());
        });
    }

    for (const repository of config.repositories) {
        console.log(`Repository ${repository}...`);

        process.chdir(`../${repository}`);

        if (run(true, "git", "branch", "--show-current")[0] !== "main") {
            throw new Error("Repository is not on main branch");
        }

        if (repositoryStates[repository] === undefined) {
            if (run(true, "git", "status", "--short").length !== 0) {
                throw new Error("Repository has uncommitted changes");
            }
        }

        function step(state: string, callback: () => void) {
            let repositoryState = repositoryStates[repository];

            if (repositoryState === undefined || repositoryState === state) {
                repositoryStates[repository] = state;

                try {
                    callback();

                    delete repositoryStates[repository];
                } finally {
                    fs.writeFile(stateFilePath, `${JSON.stringify(repositoryStates, null, 2)}\n`, (err) => {
                        if (err !== null) {
                            throw err;
                        }
                    });
                }
            }
        }

        step("package", () => {
            const packageConfigPath = path.resolve("package.json");

            fs.readFile(packageConfigPath, null, (err, data) => {
                if (err !== null) {
                    throw err;
                }

                const packageConfig: JSONAsRecord = JSON.parse(data.toString());

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

                fs.writeFile(packageConfigPath, `${JSON.stringify(packageConfig, null, 2)}\n`, (err) => {
                    if (err !== null) {
                        throw err;
                    }
                });
            });
        });

        step("npm install", () => {
            run(false, "npm", "install");
        });

        step("git commit", () => {
            run(false, "git", "commit", "--all", `--message=\"Updated to version ${config.version}\"`);
        });

        step("git tag", () => {
            run(false, "git", "tag", `v${config.version}`);
        });

        step("git push", () => {
            run(false, "git", "push", "--tags");
        });
    }
}

try {
    publish();
} catch (e) {
    console.error(e);
}
