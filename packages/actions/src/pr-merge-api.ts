/** HTTP dependency used by isolated mock-GitHub operations. */
export type HttpClient = typeof fetch;

/** Sends an authenticated JSON request and validates its response. */
export async function requestJson<T>(
  url: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
  http: HttpClient = fetch,
): Promise<T> {
  const response = await http(url, {
    method: options.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} at ${new URL(url).pathname}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
