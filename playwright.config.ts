import { createServer } from "node:net";
import { defineConfig, devices } from "@playwright/test";

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a port for Playwright"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

// The Playwright runner loads this config before forking test workers.
// Persist the selected port in the environment so workers use the same baseURL.
const port = process.env.PLAYWRIGHT_PORT
  ? Number(process.env.PLAYWRIGHT_PORT)
  : await findAvailablePort();
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PLAYWRIGHT_PORT must be a valid TCP port");
}
process.env.PLAYWRIGHT_PORT = String(port);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.{ts,tsx,js,jsx}",
  testIgnore: ["**/node_modules/**", "**/dist/**"],
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm exec --workspace apps/playground -- vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
