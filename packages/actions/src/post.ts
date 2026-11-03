import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execute, removeContainer } from "./shared.js";

/**
 * Collects emulator container logs before the container is removed.
 *
 * Diagnostics are best-effort: a stopped or missing container must not prevent
 * post-job cleanup. When RUNNER_TEMP is available, the logs are preserved in a
 * file that a calling workflow can upload as an artifact.
 *
 * @param environment - GitHub Actions environment, including saved action state.
 * @param command - Injectable command runner for testing.
 * @returns Path to the saved log, or undefined when none could be collected.
 */
export async function captureDiagnostics(
  environment: NodeJS.ProcessEnv = process.env,
  command: typeof execute = execute,
): Promise<string | undefined> {
  const container = environment["STATE_container-id"];
  if (!container) return undefined;

  const logs = await command("docker", ["logs", "--timestamps", container], {
    capture: true,
  });
  if (!environment.RUNNER_TEMP) return undefined;

  const directory = join(environment.RUNNER_TEMP, "github-emulator");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "container.log");
  writeFileSync(path, logs + "\n", { mode: 0o600 });
  console.log(`Emulator diagnostics saved to ${path}`);
  return path;
}

/**
 * Removes the emulator container when it still exists.
 *
 * This operation is idempotent: a container already removed by the caller is
 * treated as successfully cleaned up.
 *
 * @param environment - GitHub Actions environment containing STATE_container-id.
 * @param command - Injectable command runner for testing.
 */
export async function cleanup(
  environment: NodeJS.ProcessEnv = process.env,
  command: typeof execute = execute,
): Promise<void> {
  const container = environment["STATE_container-id"];
  if (!container) return;
  const existing = await command(
    "docker",
    ["ps", "--all", "--quiet", "--filter", `id=${container}`],
    { capture: true },
  );
  if (existing) await removeContainer(container, command);
}

/**
 * Captures diagnostics and always attempts cleanup, even if log collection
 * fails. Reports both failures when necessary without masking either one.
 *
 * @param environment - GitHub Actions environment.
 * @param command - Injectable command runner for testing.
 */
export async function run(
  environment: NodeJS.ProcessEnv = process.env,
  command: typeof execute = execute,
): Promise<void> {
  const errors: Error[] = [];
  let diagnostics: string | undefined;
  try {
    diagnostics = await captureDiagnostics(environment, command);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    console.error(`Emulator diagnostics failed: ${failure.message}`);
    errors.push(failure);
  } finally {
    try {
      await cleanup(environment, command);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      console.error(`Emulator cleanup failed: ${failure.message}`);
      errors.push(failure);
    }
  }

  if (environment.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(
        environment.GITHUB_STEP_SUMMARY,
        [
          "### GitHub emulator post-job",
          diagnostics ? `- Diagnostics: \`${diagnostics}\`` : "- Diagnostics: unavailable",
          `- Cleanup: ${errors.some((e) => e.message.includes("docker")) ? "check logs" : "attempted"}`,
          "",
        ].join("\n") + "\n",
      );
    } catch (error) {
      console.warn(`Could not write post-job summary: ${String(error)}`);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Emulator post-job tasks failed");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
