import { requestJson, type HttpClient } from "./pr-merge-api.js";

/** Dispatcher completion snapshot. */
export interface DispatcherStatus {
  accepted: number;
  pending: number;
  failed: number;
  workflows: number;
}

/** Polls the mock dispatcher and rejects missing or unsuccessful workflows. */
export async function waitForWorkflows(
  token: string,
  options: { gateway?: string; timeoutMs?: number; intervalMs?: number } = {},
  http: HttpClient = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<DispatcherStatus> {
  const gateway = options.gateway ?? "http://127.0.0.1:4002";
  const deadline = Date.now() + (options.timeoutMs ?? 900_000);
  while (Date.now() < deadline) {
    const status = await requestJson<DispatcherStatus>(
      `${gateway}/_dispatcher/status`, token, {}, http,
    );
    if (status.accepted > 0 && status.pending === 0) {
      if (status.failed > 0 || status.workflows === 0)
        throw new Error("Dispatched workflows failed or none matched");
      return status;
    }
    await sleep(options.intervalMs ?? 2_000);
  }
  throw new Error("Timed out awaiting dispatched workflows");
}
