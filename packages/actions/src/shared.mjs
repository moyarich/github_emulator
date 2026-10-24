import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export function writeRunnerFile(file, name, value) {
  if (!file) throw new Error(`Runner file is unavailable for ${name}`);
  const marker = `emulator_${randomUUID()}`;
  appendFileSync(file, `${name}<<${marker}\n${value}\n${marker}\n`);
}

export function input(name, fallback = "", environment = process.env) {
  // GitHub uses uppercase names with hyphens intact for action inputs.
  return environment[`INPUT_${name.toUpperCase()}`] || fallback;
}

export function configuration(environment = process.env) {
  const mode = input("mode", "server", environment);
  if (!["server", "smoke-test"].includes(mode))
    throw new Error("mode must be server or smoke-test");
  const repository = input(
    "repository",
    environment.GITHUB_REPOSITORY || "moyarich/release-smoke-test",
    environment,
  );
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("repository must be owner/name");
  const exportEnv = input("export-env", "true", environment);
  if (!["true", "false"].includes(exportEnv))
    throw new Error("export-env must be true or false");
  const updateBody = input("update-pr-body", "1", environment);
  if (!["0", "1"].includes(updateBody))
    throw new Error("update-pr-body must be 0 or 1");
  const seedFile = input("seed-file", "", environment);
  if (mode === "smoke-test" && seedFile)
    throw new Error("seed-file is supported in server mode only");
  return {
    mode,
    repository,
    exportEnv: exportEnv === "true",
    seedFile,
    token: input("token", "local-test-token", environment),
    baseBranch: input("base-branch", "main", environment),
    manifestPath: input(
      "manifest-path",
      "packages/core/package.json",
      environment,
    ),
    oldVersion: input("old-version", "1.0.0", environment),
    newVersion: input("new-version", "1.1.0", environment),
    updateBody,
  };
}

export function execute(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    if (capture)
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

export async function removeContainer(container, executeCommand = execute) {
  if (container) await executeCommand("docker", ["rm", "--force", container]);
}
