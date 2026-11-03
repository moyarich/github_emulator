import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readServiceLogs, stopServices } from "./compose-services.js";

interface EmulationState { project: string; files: string[]; environment?: NodeJS.ProcessEnv; }

/** Always collect diagnostics and remove isolated containers after the job. */
export async function finalizePrMerge(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const path = environment["STATE_pr-merge-state"];
  if (!path || !existsSync(path)) return;
  const state = JSON.parse(readFileSync(path, "utf8")) as EmulationState;
  if (!state.files.length) return;
  const composeEnvironment = { ...environment, ...state.environment };
  try {
    const logs = await readServiceLogs(state.project, state.files, undefined, composeEnvironment);
    if (environment.RUNNER_TEMP)
      writeFileSync(join(environment.RUNNER_TEMP, "pr-merge.log"), logs, { mode: 0o600 });
  } catch (error) {
    console.warn("Could not collect compose logs:", error);
  } finally {
    await stopServices(state.project, state.files, undefined, composeEnvironment);
  }
}

finalizePrMerge().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
