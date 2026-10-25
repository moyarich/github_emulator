import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
function writeRunnerFile(file, name, value) {
  if (!file) throw new Error(`Runner file is unavailable for ${name}`);
  const marker = `emulator_${randomUUID()}`;
  appendFileSync(file, `${name}<<${marker}
${value}
${marker}
`);
}
function input(name, fallback = "", environment = process.env) {
  return environment[`INPUT_${name.toUpperCase()}`] || fallback;
}
function configuration(environment = process.env) {
  const repository = input(
    "repository",
    environment.GITHUB_REPOSITORY || "moyarich/release-smoke-test",
    environment
  );
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("repository must be owner/name");
  const exportEnv = input("export-env", "true", environment);
  if (!["true", "false"].includes(exportEnv))
    throw new Error("export-env must be true or false");
  const seedFile = input("seed-file", "", environment);
  return {
    repository,
    exportEnv: exportEnv === "true",
    seedFile,
    token: input("token", "local-test-token", environment),
    baseBranch: input("base-branch", "main", environment)
  };
}
function execute(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit"
    });
    let stdout = "";
    if (capture)
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}
async function removeContainer(container, executeCommand = execute) {
  if (container) await executeCommand("docker", ["rm", "--force", container]);
}
export {
  configuration as c,
  execute as e,
  removeContainer as r,
  writeRunnerFile as w
};
