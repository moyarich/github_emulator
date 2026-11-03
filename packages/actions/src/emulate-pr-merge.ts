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
import { composeArguments, readServiceLogs } from "./compose-services.js";

interface EmulationState { project: string; files: string[]; environment?: NodeJS.ProcessEnv; }

/** Run a real PR checkout entirely against the isolated mock GitHub services. */
export async function emulatePrMerge(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (environment.RUNNER_OS !== "Linux") throw new Error("PR merge emulation requires Linux");
  const config = prMergeConfiguration(environment);
  const temp = environment.RUNNER_TEMP;
  if (!temp) throw new Error("RUNNER_TEMP is required");
  const distribution = dirname(fileURLToPath(import.meta.url));
  const root = resolve(distribution, "../..");
  const project = `pr-merge-${randomUUID().slice(0, 12)}`;
  const state: EmulationState = { project, files: [] };
  const statePath = join(temp, "pr-merge-state.json");
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  writeRunnerFile(environment.GITHUB_STATE, "pr-merge-state", statePath);
  try {
    const source = await importPullRequest(config, temp);
    const actDirectory = await setupSandbox(distribution, temp, project);
    // Pass the installed act directory only to the isolated subprocesses.
    const runtime = await startDispatcher(source, root, temp, project, config.githubToken, config.token);
    state.files = runtime.files;
    state.environment = {
      COMPOSE_PROJECT_NAME: project,
      DISPATCH_WORKSPACE: source.workspace,
      REPO: source.repository,
      BASE_BRANCH: source.baseBranch,
      EMULATOR_PORT: "0",
      HTTPS_PORT: "0",
    };
    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    runtime.environment = { ...runtime.environment, PATH: `${actDirectory}:${runtime.environment.PATH ?? ""}` };
    await prepareMockPullRequest(source, runtime, config.token);
    await execute("docker", [
      ...composeArguments(project, runtime.files), "exec", "-T",
      "-e", `REPO=${config.repository}`, "-e", `TOKEN=${config.token}`,
      "github-dispatcher", "node", "/emulator-checkout/dist/github-emulator/dispatch-merge-event.js",
    ], { env: runtime.environment });
    const releaseJson = await execute("docker", [
      ...composeArguments(project, runtime.files), "exec", "-T",
      "-e", `REPO=${config.repository}`, "-e", `TOKEN=${config.token}`,
      "github-dispatcher", "node", "/emulator-checkout/dist/github-emulator/verify-mock-releases.js",
    ], { capture: true, env: runtime.environment });
    const releases = JSON.parse(releaseJson) as Array<{ tag_name: string; draft: boolean }>;
    if (environment.GITHUB_STEP_SUMMARY)
      appendFileSync(environment.GITHUB_STEP_SUMMARY,
        `## Emulated PR ${config.repository}#${config.prNumber}\nNo real merge or publish occurred.\n` +
        releases.map((release) => `- ${release.tag_name} (draft)`).join("\n") + "\n");
  } catch (error) {
    if (state.files.length) {
      try {
        const logs = await readServiceLogs(project, state.files, execute, state.environment);
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
