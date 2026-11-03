import { triggerMockMerge } from "./trigger-merge.js";
import { waitForWorkflows } from "./wait-for-workflows.js";

/** Dispatcher-side CLI for triggering a mock merge and awaiting matching workflows. */
export async function runDispatcherEvent(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const repository = environment.REPO;
  const token = environment.TOKEN;
  if (!repository || !token) throw new Error("REPO and TOKEN are required");
  const number = await triggerMockMerge(repository, token);
  console.log(`Triggered mock merge for PR #${number}`);
  const status = await waitForWorkflows(token);
  console.log(JSON.stringify(status));
}

runDispatcherEvent().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
