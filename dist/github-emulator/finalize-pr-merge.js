import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { r as readServiceLogs, s as stopServices } from "./compose-services-Cb-WMZ74.js";
async function finalizePrMerge(environment = process.env) {
  const path = environment["STATE_pr-merge-state"];
  if (!path || !existsSync(path)) return;
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (!state.files.length) return;
  const composeEnvironment = { ...environment, ...state.environment };
  try {
    const logs = await readServiceLogs(state.project, state.files, void 0, composeEnvironment);
    if (environment.RUNNER_TEMP)
      writeFileSync(join(environment.RUNNER_TEMP, "pr-merge.log"), logs, { mode: 384 });
  } catch (error) {
    console.warn("Could not collect compose logs:", error);
  } finally {
    await stopServices(state.project, state.files, void 0, composeEnvironment);
  }
}
finalizePrMerge().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
export {
  finalizePrMerge
};
