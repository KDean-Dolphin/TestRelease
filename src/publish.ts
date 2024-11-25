import { spawnSync } from 'child_process';
import * as fs from "fs";
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
    for (const repository of config.repositories) {
        console.log(`Repository ${repository}`);

        process.chdir(`../${repository}`);

        if (run(true, "git", "branch", "--show-current")[0] !== "main") {
            throw new Error("Repository ${repository} is not on main branch");
        }

        await fs.promises.readFile("package.json").then((buffer) => {
            return JSON.parse(buffer.toString()) as Record<string, unknown>;
        }).then((packageConfig) => {
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

            return fs.promises.writeFile("package.json", `${JSON.stringify(packageConfig, null, 2)}\n`);
        }).then(() => {
            run(false, "npm", "install");

            run(false, "git", "commit", "--all", `--message=\"Updated to version ${config.version}\"`);
            run(false, "git", "tag", `v${config.version}`);
            run(false, "git", "push", "--tags");

            // Wait for tag workflow to run.
            // Wait for release workflow to run, if it exists.

            console.log("Done.");
        });
    }
}

await publish().catch(reason => {
    console.log(reason);
});
