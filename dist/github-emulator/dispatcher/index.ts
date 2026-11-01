import { createServer, type IncomingMessage } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, matchesGlob } from "node:path";
import { pathToFileURL } from "node:url";

// GitHub event payloads have event-specific, open-ended fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = Record<string, any>;
export interface DispatchEvent {
  name: string;
  payload: Data;
}

export function activity(
  method: string,
  path: string,
  input: Data,
  result: Data,
  previous?: Data,
): DispatchEvent | undefined {
  const resource = path.replace(/^\/repos\/[^/]+\/[^/]+/, "");
  if (method === "POST" && resource === "/dispatches")
    return {
      name: "repository_dispatch",
      payload: {
        action: input.event_type,
        client_payload: input.client_payload || {},
      },
    };
  if (method === "POST" && resource === "/pulls")
    return {
      name: "pull_request",
      payload: {
        action: "opened",
        number: result.number,
        pull_request: result,
      },
    };
  if (
    method === "PUT" &&
    /^\/pulls\/\d+\/merge$/.test(resource) &&
    result.merged
  )
    return {
      name: "pull_request",
      payload: {
        action: "closed",
        number: previous?.number,
        pull_request: {
          ...previous,
          state: "closed",
          merged: true,
          merge_commit_sha: result.sha,
        },
      },
    };
  if (method === "PATCH" && /^\/pulls\/\d+$/.test(resource)) {
    const action =
      input.state && input.state !== previous?.state
        ? input.state === "closed"
          ? "closed"
          : "reopened"
        : "edited";
    return {
      name: "pull_request",
      payload: { action, number: result.number, pull_request: result },
    };
  }
  if (method === "POST" && resource === "/issues")
    return { name: "issues", payload: { action: "opened", issue: result } };
  if (
    method === "PATCH" &&
    /^\/releases\/\d+$/.test(resource) &&
    previous?.draft &&
    result.draft === false
  )
    return {
      name: "release",
      payload: { action: "published", release: result },
    };
  if (method === "POST" && resource === "/releases" && !result.draft)
    return {
      name: "release",
      payload: { action: "published", release: result },
    };
}

export function matchesTrigger(
  triggers: Data | string | string[],
  event: DispatchEvent,
): boolean {
  if (typeof triggers === "string") triggers = { [triggers]: {} };
  if (Array.isArray(triggers))
    triggers = Object.fromEntries(triggers.map((name) => [name, {}]));
  const rules = triggers as Data;
  if (!rules || !Object.hasOwn(rules, event.name)) return false;
  const settings = rules[event.name] || {};
  if (settings.types && !settings.types.includes(event.payload.action))
    return false;
  if (event.name === "pull_request") {
    if (
      !settings.types &&
      !["opened", "synchronize", "reopened"].includes(event.payload.action)
    )
      return false;
    const branch = event.payload.pull_request?.base?.ref || "";
    if (settings.branches) {
      let included = false;
      for (const pattern of settings.branches) {
        const excluded = pattern.startsWith("!");
        if (matchesGlob(branch, excluded ? pattern.slice(1) : pattern))
          included = !excluded;
      }
      if (!included) return false;
    }
    if (
      settings["branches-ignore"]?.some((pattern: string) =>
        matchesGlob(branch, pattern),
      )
    )
      return false;
    // Changed-file comparisons aren't available from these API mutations.
    if (settings.paths || settings["paths-ignore"])
      throw new Error(
        "PR path filters require changed-file metadata; dispatch refused",
      );
  }
  return true;
}

function workflows(workspace: string, event: DispatchEvent): string[] {
  const data = execFileSync(
    "python3",
    [
      "-c",
      `
import json, pathlib, sys
from ruamel.yaml import YAML
root = pathlib.Path(sys.argv[1])
files = sorted(p for p in root.rglob("*") if p.suffix in (".yml", ".yaml")) if root.is_dir() else [root]
print(json.dumps([{ "file": str(p), "triggers": YAML(typ="safe").load(p.read_text()).get("on", {}) } for p in files]))
`,
      resolve(workspace, process.env.DISPATCH_WORKFLOWS || ".github/workflows"),
    ],
    { encoding: "utf8" },
  );
  return (JSON.parse(data) as { file: string; triggers: Data }[])
    .filter((item) => matchesTrigger(item.triggers, event))
    .map((item) => item.file);
}

export function createDispatcher(options: {
  upstream: string;
  repository: string;
  token: string;
  enabled?: boolean;
  run: (event: DispatchEvent) => Promise<void | number>;
}) {
  let queue = Promise.resolve();
  let dispatched = 0;
  let completed = 0;
  let failed = 0;
  let executed = 0;
  const headers = { Authorization: `Bearer ${options.token}` };
  async function get(path: string) {
    const response = await fetch(`${options.upstream}${path}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Read ${path}: ${response.status}`);
    return response.json();
  }
  const server = createServer(async (request: IncomingMessage, response) => {
    try {
      const url = new URL(request.url || "/", "http://dispatcher");
      if (url.pathname === "/_dispatcher/health") {
        response.writeHead(200).end("ok");
        return;
      }
      const path = url.pathname.replace(/^\/api\/v3(?=\/)/, "");
      const method = request.method || "GET";
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      let input: Data = {};
      try {
        input = body.length ? JSON.parse(body.toString()) : {};
      } catch {
        /* Preserve non-JSON API bodies when forwarding. */
      }
      const repoPath = `/repos/${options.repository}`;
      const supportedRepo =
        path === repoPath || path.startsWith(`${repoPath}/`);
      // Only this configured local token may create dispatch jobs.
      const authorized =
        request.headers.authorization === `Bearer ${options.token}` ||
        request.headers.authorization === `token ${options.token}`;
      if (path === "/_dispatcher/status") {
        if (!authorized) {
          response.writeHead(401).end();
          return;
        }
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            accepted: dispatched,
            pending: dispatched - completed - failed,
            completed,
            failed,
            workflows: executed,
          }),
        );
        return;
      }
      const dispatch = options.enabled && supportedRepo && authorized;
      let previous: Data | undefined;
      if (
        dispatch &&
        /\/pulls\/\d+(\/merge)?$/.test(path) &&
        ["PUT", "PATCH"].includes(method)
      )
        previous = await get(path.replace(/\/merge$/, ""));
      if (dispatch && method === "PATCH" && /\/releases\/\d+$/.test(path))
        previous = await get(path);
      let status: number;
      let output: Buffer;
      let result: Data = {};
      if (dispatch && method === "POST" && path === `${repoPath}/dispatches`) {
        if (
          typeof input.event_type !== "string" ||
          !input.event_type ||
          input.event_type.length > 100
        ) {
          response.writeHead(422).end();
          return;
        }
        status = 204;
        output = Buffer.alloc(0);
      } else {
        const forwarded = { ...request.headers };
        delete forwarded.host;
        delete forwarded["content-length"];
        delete forwarded["transfer-encoding"];
        delete forwarded.connection;
        const upstream = await fetch(
          `${options.upstream}${path}${url.search}`,
          {
            method,
            headers: forwarded as Record<string, string>,
            body: ["GET", "HEAD"].includes(method) ? undefined : body,
            redirect: "manual",
            signal: AbortSignal.timeout(30_000),
          },
        );
        status = upstream.status;
        output = Buffer.from(await upstream.arrayBuffer());
        upstream.headers.forEach((value, key) => {
          if (
            ![
              "content-length",
              "content-encoding",
              "transfer-encoding",
              "connection",
            ].includes(key)
          )
            response.setHeader(key, value);
        });
        try {
          result = JSON.parse(output.toString());
        } catch {
          /* Non-JSON responses are forwarded unchanged. */
        }
      }
      if (dispatch && status >= 200 && status < 300) {
        const event = activity(method, path, input, result, previous);
        if (event && dispatched >= 50)
          console.error(
            "[dispatcher] Event limit reached; restart the dispatcher to resume",
          );
        if (event && dispatched < 50) {
          dispatched += 1;
          // Capture repository metadata now; execute jobs serially after the request completes.
          let repository: Data;
          try {
            repository = await get(repoPath);
          } catch (error) {
            console.error(
              "[dispatcher] Could not prepare event after successful API mutation:",
              error,
            );
            response.writeHead(status).end(output);
            return;
          }
          event.payload = {
            ...event.payload,
            repository,
            ref: `refs/heads/${repository.default_branch || "main"}`,
            sender: { login: "mock-user" },
          };
          queue = queue
            .then(async () => {
              const count = await options.run(event);
              executed += count || 0;
              completed += 1;
            })
            .catch((error) => {
              failed += 1;
              console.error("[dispatcher] Workflow failed:", error);
            });
        }
      }
      response.writeHead(status).end(output);
    } catch (error) {
      console.error("[dispatcher] Request failed:", error);
      response
        .writeHead(502)
        .end(JSON.stringify({ message: "Dispatcher request failed" }));
    }
  });
  return { server, idle: () => queue };
}

export async function executeWorkflows(
  event: DispatchEvent,
  selected: string[],
  workspace: string,
  token: string,
): Promise<number> {
  const directory = await mkdtemp(join(tmpdir(), "mock-dispatch-"));
  try {
    const file = join(directory, "event.json");
    await writeFile(file, JSON.stringify(event.payload), { mode: 0o600 });
    const args = [
      event.name,
      "--workflows",
      selected[0],
      "--eventpath",
      file,
      "--github-instance",
      "github.emulator.test",
      "--replace-ghe-action-with-github-com",
      "*",
      "--secret",
      `GITHUB_TOKEN=${token}`,
      "--env",
      `GH_TOKEN=${token}`,
      "--env",
      `GH_ENTERPRISE_TOKEN=${token}`,
      "--env",
      "GH_HOST=github.emulator.test",
      // Checkout uses the simulated GitHub hostname. Resolve the seeded repository
      // from the read-only workspace rather than requiring mock smart-HTTP Git.
      "--env",
      "GIT_CONFIG_COUNT=2",
      "--env",
      `GIT_CONFIG_KEY_0=url.file://${workspace}.insteadOf`,
      "--env",
      "GIT_CONFIG_VALUE_0=https://github.emulator.test/moyarich/console",
      "--env",
      "GIT_CONFIG_KEY_1=protocol.file.allow",
      "--env",
      "GIT_CONFIG_VALUE_1=always",
      "--secret-file",
      "/dev/null",
      "--env-file",
      "/dev/null",
      "--var-file",
      "/dev/null",
      "--network",
      process.env.DISPATCH_NETWORK || "github_emulator_default",
      "--platform",
      `ubuntu-latest=${process.env.DISPATCH_IMAGE || "github-emulator:dispatcher"}`,
      "--pull=false",
      "--container-architecture",
      process.arch === "arm64" ? "linux/arm64" : "linux/amd64",
    ];
    const repositories: unknown = JSON.parse(
      process.env.DISPATCH_LOCAL_REPOSITORIES || "[]",
    );
    if (
      !Array.isArray(repositories) ||
      repositories.some((value) => typeof value !== "string")
    )
      throw new Error(
        "DISPATCH_LOCAL_REPOSITORIES must be a JSON array of act repository mappings",
      );
    for (const repository of repositories)
      args.push("--local-repository", repository);
    const volume = process.env.DISPATCH_CA_VOLUME;
    if (volume)
      args.push(
        "--container-options",
        `--volume ${volume}:/proxy-data:ro`,
        ...["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "GIT_SSL_CAINFO"].flatMap(
          (key) => [
            "--env",
            `${key}=/proxy-data/caddy/pki/authorities/local/root.crt`,
          ],
        ),
      );
    console.log(
      `[dispatcher] Running ${event.name}:${event.payload.action || ""}`,
    );
    const errors: unknown[] = [];
    for (const workflow of selected) {
      args[2] = workflow;
      try {
        await new Promise<void>((accept, reject) => {
          const child = spawn("act", args, {
            cwd: workspace,
            stdio: "inherit",
            timeout: 15 * 60 * 1000,
            env: {
              ...process.env,
              GITHUB_TOKEN: token,
              GH_TOKEN: token,
              GH_ENTERPRISE_TOKEN: token,
            },
          });
          child.once("error", reject);
          child.once("exit", (code) =>
            code === 0 ? accept() : reject(new Error(`act exited ${code}`)),
          );
        });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "One or more matching workflows failed");
    return selected.length;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const workspace = resolve(process.env.DISPATCH_WORKSPACE || "/workspace");
  const token = process.env.TOKEN || "local-test-token";
  const dispatcher = createDispatcher({
    upstream: process.env.DISPATCH_UPSTREAM || "http://github-emulator:4001",
    repository: process.env.REPO || "moyarich/release-smoke-test",
    token,
    enabled: process.env.DISPATCH_ENABLED === "1",
    async run(event) {
      const selected = workflows(workspace, event);
      if (!selected.length) {
        console.log(
          `[dispatcher] No workflows match ${event.name}:${event.payload.action || ""}`,
        );
        return 0;
      }
      return executeWorkflows(event, selected, workspace, token);
    },
  });
  dispatcher.server.listen(
    Number(process.env.DISPATCH_PORT || 4002),
    "0.0.0.0",
    () =>
      console.log(
        `[dispatcher] Listening; dispatch ${process.env.DISPATCH_ENABLED === "1" ? "enabled" : "disabled"}`,
      ),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void main();
