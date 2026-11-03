import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execute, writeRunnerFile } from "./shared.js";
import { prMergeConfiguration } from "./pr-merge-config.js";
import { importPullRequest } from "./import-pr.js";
import { setupSandbox } from "./setup-sandbox.js";
import { startDispatcher } from "./start-dispatcher.js";
import { prepareMockPullRequest } from "./prepare-mock-pr.js";
import { composeArguments, readServiceLogs, stopServices } from "./compose-services.js";
import { verifyDraftReleases } from "./verify-releases.js";

interface EmulationState { project: string; files: string[]; }

/** Run a real PR checkout entirely against the isolated mock GitHub services. */
export async function emulatePrMerge(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (environment.RUNNER_OS !== "Linux") throw new Error("PR merge emulation requires Linux");
  const config = prMergeConfiguration(environment);
  const temp = environment.RUNNER_TEMP;
  if (!temp) throw new Error("RUNNER_TEMP is required");
  const distribution = dirname(fileURLToPath(import.meta.url));
  const root = resolve(distribution, "../..");
  const project = `pr-merge-${randomUUID()}`;
  const state: EmulationState = { project, files: [] };
  const statePath = join(temp, "pr-merge-state.json");
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  writeRunnerFile(environment.GITHUB_STATE, "pr-merge-state", statePath);
  try {
    const source = await importPullRequest(config, temp);
    const actDirectory = await setupSandbox(distribution, temp, project);
    process.env.PATH = `${actDirectory}:${process.env.PATH ?? ""}`;
    const runtime = await startDispatcher(source, root, temp, project, config.githubToken);
    state.files = runtime.files;
    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    await prepareMockPullRequest(source, runtime, config.token);
    await execute("docker", [
      ...composeArguments(project, runtime.files), "exec", "-T",
      "-e", `REPO=${config.repository}`, "-e", `TOKEN=${config.token}`,
      "github-dispatcher", "node", "/emulator-checkout/dist/github-emulator/dispatch-merge-event.js",
    ]);
    const releases = await verifyDraftReleases(config.repository, config.token);
    if (environment.GITHUB_STEP_SUMMARY)
      appendFileSync(environment.GITHUB_STEP_SUMMARY,
        `## Emulated PR ${config.repository}#${config.prNumber}\nNo real merge or publish occurred.\n` +
        releases.map((release) => `- ${release.tag_name} (draft)`).join("\n") + "\n");
  } catch (error) {
    if (state.files.length) {
      try {
        const logs = await readServiceLogs(project, state.files);
        writeFileSync(join(temp, "pr-merge.log"), logs, { mode: 0o600 });
      } catch (diagnosticError) { console.error("Could not capture diagnostics:", diagnosticError); }
    }
    throw error;
  }
}

/** Node action entry point. */
emulatePrMerge().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
