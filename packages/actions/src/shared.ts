import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export function writeRunnerFile(
  file: string | undefined,
  name: string,
  value: string,
) {
  if (!file) throw new Error(`Runner file is unavailable for ${name}`);
  const marker = `emulator_${randomUUID()}`;
  appendFileSync(file, `${name}<<${marker}\n${value}\n${marker}\n`);
}

export function input(
  name: string,
  fallback = "",
  environment: NodeJS.ProcessEnv = process.env,
) {
  // GitHub uses uppercase names with hyphens intact for action inputs.
  return environment[`INPUT_${name.toUpperCase()}`] || fallback;
}

export function configuration(environment: NodeJS.ProcessEnv = process.env) {
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
  const seedFile = input("seed-file", "", environment);
  return {
    repository,
    exportEnv: exportEnv === "true",
    seedFile,
    token: input("token", "local-test-token", environment),
    baseBranch: input("base-branch", "main", environment),
  };
}

export function execute(
  command: string,
  args: string[],
  { capture = false }: { capture?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
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

export async function removeContainer(
  container: string | undefined,
  executeCommand: typeof execute = execute,
) {
  if (container) await executeCommand("docker", ["rm", "--force", container]);
}
