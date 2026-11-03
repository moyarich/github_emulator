async function requestJson(url, token, options = {}, http = fetch) {
  const response = await http(url, {
    method: options.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: options.body === void 0 ? void 0 : JSON.stringify(options.body),
    signal: AbortSignal.timeout(3e4)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} at ${new URL(url).pathname}: ${await response.text()}`);
  return response.json();
}
export {
  requestJson as r
};
