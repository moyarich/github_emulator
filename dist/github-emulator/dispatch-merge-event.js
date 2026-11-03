import { r as requestJson } from "./pr-merge-api-CuDrsZrg.js";
async function triggerMockMerge(repository, token, apiBase = "http://github-emulator:4001", gatewayBase = "http://127.0.0.1:4002", http = fetch) {
  const prs = await requestJson(
    `${apiBase}/repos/${repository}/pulls`,
    token,
    {},
    http
  );
  const pr = prs.at(-1);
  if (!pr) throw new Error("Mock PR was not seeded");
  await requestJson(
    `${gatewayBase}/repos/${repository}/pulls/${pr.number}/merge`,
    token,
    { method: "PUT", body: { merge_method: "merge" } },
    http
  );
  return pr.number;
}
async function waitForWorkflows(token, options = {}, http = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const gateway = options.gateway ?? "http://127.0.0.1:4002";
  const deadline = Date.now() + (options.timeoutMs ?? 9e5);
  while (Date.now() < deadline) {
    const status = await requestJson(
      `${gateway}/_dispatcher/status`,
      token,
      {},
      http
    );
    if (status.accepted > 0 && status.pending === 0) {
      if (status.failed > 0 || status.workflows === 0)
        throw new Error("Dispatched workflows failed or none matched");
      return status;
    }
    await sleep(options.intervalMs ?? 2e3);
  }
  throw new Error("Timed out awaiting dispatched workflows");
}
async function runDispatcherEvent(environment = process.env) {
  const repository = environment.REPO;
  const token = environment.TOKEN;
  if (!repository || !token) throw new Error("REPO and TOKEN are required");
  const number = await triggerMockMerge(repository, token);
  console.log(`Triggered mock merge for PR #${number}`);
  const status = await waitForWorkflows(token);
  console.log(JSON.stringify(status));
}
runDispatcherEvent().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
export {
  runDispatcherEvent
};
