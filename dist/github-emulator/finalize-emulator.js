import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { e as execute, r as removeContainer } from "./shared-BiJx6WeG.js";
async function captureDiagnostics(environment = process.env, command = execute) {
  const container = environment["STATE_container-id"];
  if (!container) return void 0;
  const logs = await command("docker", ["logs", "--timestamps", container], {
    capture: true
  });
  if (!environment.RUNNER_TEMP) return void 0;
  const directory = join(environment.RUNNER_TEMP, "github-emulator");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "container.log");
  writeFileSync(path, logs + "\n", { mode: 384 });
  console.log(`Emulator diagnostics saved to ${path}`);
  return path;
}
async function cleanup(environment = process.env, command = execute) {
  const container = environment["STATE_container-id"];
  if (!container) return;
  const existing = await command(
    "docker",
    ["ps", "--all", "--quiet", "--filter", `id=${container}`],
    { capture: true }
  );
  if (existing) await removeContainer(container, command);
}
async function run(environment = process.env, command = execute) {
  const errors = [];
  let cleanupSucceeded = false;
  let diagnostics;
  try {
    diagnostics = await captureDiagnostics(environment, command);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    console.error(`Emulator diagnostics failed: ${failure.message}`);
    errors.push(failure);
  } finally {
    try {
      await cleanup(environment, command);
      cleanupSucceeded = true;
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
          `- Cleanup: ${cleanupSucceeded ? "completed" : "failed"}`,
          ""
        ].join("\n") + "\n"
      );
    } catch (error) {
      console.warn(`Could not write post-job summary: ${String(error)}`);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Emulator post-job tasks failed");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
export {
  captureDiagnostics,
  cleanup,
  run
};
