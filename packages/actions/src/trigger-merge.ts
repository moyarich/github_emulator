import { requestJson, type HttpClient } from "./pr-merge-api.js";

/** Triggers a merge against the isolated gateway, never the real GitHub API. */
export async function triggerMockMerge(
  repository: string,
  token: string,
  apiBase = "http://github-emulator:4001",
  gatewayBase = "http://127.0.0.1:4002",
  http: HttpClient = fetch,
): Promise<number> {
  const prs = await requestJson<Array<{ number: number }>>(
    `${apiBase}/repos/${repository}/pulls`, token, {}, http,
  );
  const pr = prs.at(-1);
  if (!pr) throw new Error("Mock PR was not seeded");
  await requestJson(
    `${gatewayBase}/repos/${repository}/pulls/${pr.number}/merge`,
    token, { method: "PUT", body: { merge_method: "merge" } }, http,
  );
  return pr.number;
}
