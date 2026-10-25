import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface Repository {
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
}
interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  merged: boolean;
  state: string;
  head: { ref: string; repo: Repository };
  base: { ref: string; repo: Repository };
}
interface SourceEvent {
  action?: string;
  repository?: Repository;
  pull_request?: PullRequest;
  ref?: string;
  [key: string]: unknown;
}
interface Prepared {
  sourceSha: string;
  mockSha: string;
  files: number;
  event: SourceEvent;
}

export async function prepareWorkflow(options: {
  workspace: string;
  sourceSha: string;
  sourceRef: string;
  repository: string;
  baseBranch: string;
  apiUrl: string;
  token: string;
  eventName: string;
  sourceEvent: SourceEvent;
  phase?: "repository" | "event";
  snapshot?: Omit<Prepared, "event">;
}): Promise<Prepared> {
  const { workspace, repository, apiUrl, token, sourceEvent, eventName } =
    options;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("Repository must be owner/name");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: workspace, maxBuffer: 128 * 1024 * 1024 });
  const sourceSha = git(
    "rev-parse",
    "--verify",
    `${options.sourceSha}^{commit}`,
  )
    .toString()
    .trim();
  async function api<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${apiUrl}/repos/${repository}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(
        `${method} ${path}: ${response.status} ${await response.text()}`,
      );
    return response.json() as Promise<T>;
  }
  let commit: { sha: string };
  let files = options.snapshot?.files || 0;
  if (options.phase === "event") {
    if (!options.snapshot || options.snapshot.sourceSha !== sourceSha)
      throw new Error(
        "Event preparation requires the imported repository snapshot for this commit",
      );
    commit = { sha: options.snapshot.mockSha };
  } else {
    const entries: { path: string; mode: string; type: string; sha: string }[] =
      [];
    // Read Git objects, not working-tree files: untracked secrets and build outputs stay out.
    for (const line of git("ls-tree", "-r", "-z", sourceSha)
      .toString()
      .split("\0")
      .filter(Boolean)) {
      const separator = line.indexOf("\t");
      const [mode, type, object] = line.slice(0, separator).split(" ");
      const path = line.slice(separator + 1);
      if (type === "commit") {
        entries.push({ path, mode, type, sha: object });
        continue;
      }
      if (type !== "blob") throw new Error(`Unsupported Git object: ${type}`);
      const blob = await api<{ sha: string }>("/git/blobs", "POST", {
        content: git("cat-file", "blob", object).toString("base64"),
        encoding: "base64",
      });
      entries.push({ path, mode, type, sha: blob.sha });
    }
    const tree = await api<{ sha: string }>("/git/trees", "POST", {
      tree: entries,
    });
    commit = await api<{ sha: string }>("/git/commits", "POST", {
      message: `Import checkout ${sourceSha}`,
      tree: tree.sha,
      parents: [],
    });
    files = entries.length;
  }
  async function setRef(ref: string) {
    const existing = await fetch(
      `${apiUrl}/repos/${repository}/git/ref/${ref}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (existing.status === 404)
      await api("/git/refs", "POST", { ref: `refs/${ref}`, sha: commit.sha });
    else if (existing.ok)
      await api(`/git/refs/${ref}`, "PATCH", { sha: commit.sha, force: true });
    else throw new Error(`Cannot inspect ref ${ref}: ${existing.status}`);
  }
  await setRef(`heads/${options.baseBranch}`);
  if (options.phase === "repository")
    return { sourceSha, mockSha: commit.sha, files, event: sourceEvent };
  const pr = sourceEvent.pull_request;
  if (eventName === "pull_request" && !pr)
    throw new Error(
      "A pull_request test requires a PR number or an event fixture with pull_request metadata",
    );
  await setRef(`heads/${options.baseBranch}`);
  const ref = options.sourceRef || `refs/heads/${options.baseBranch}`;
  if (ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/"))
    await setRef(ref.slice(5));
  const mockRepository = await api<Repository>("");
  const event: SourceEvent = {
    ...sourceEvent,
    repository: mockRepository,
    ref,
  };
  if (eventName === "pull_request" && pr) {
    if (pr.head.repo.full_name !== pr.base.repo.full_name)
      throw new Error(
        "Fork PR replay requires a fixture with a separately seeded fork repository",
      );
    await setRef(`heads/${pr.base.ref}`);
    await setRef(`heads/${pr.head.ref}`);
    const created = await api<PullRequest>("/pulls", "POST", {
      title: pr.title,
      body: pr.body || "",
      head: pr.head.ref,
      base: pr.base.ref,
    });
    if (pr.merged)
      await api(`/pulls/${created.number}/merge`, "PUT", {
        merge_method: "merge",
      });
    else if (pr.state === "closed")
      await api(`/pulls/${created.number}`, "PATCH", { state: "closed" });
    const mockPr = await api<PullRequest>(`/pulls/${created.number}`);
    event.action =
      sourceEvent.action || (pr.state === "closed" ? "closed" : "opened");
    event.number = mockPr.number;
    event.pull_request = mockPr;
  } else if (eventName === "push") {
    event.after = commit.sha;
    event.before = "0".repeat(40);
    event.deleted = false;
    event.created = true;
    const commits = [
      { id: commit.sha, message: `Import checkout ${sourceSha}` },
    ];
    event.commits = commits;
    event.head_commit = commits[0];
  }
  // The emulator creates its own commit identities; retain provenance separately.
  event._emulate = {
    source_repository: sourceEvent.repository?.full_name,
    source_sha: sourceSha,
    source_ref: options.sourceRef,
    mock_sha: commit.sha,
  };
  return { sourceSha, mockSha: commit.sha, files, event };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const env = process.env;
  prepareWorkflow({
    workspace: env.GITHUB_WORKSPACE || process.cwd(),
    sourceSha: env.SOURCE_SHA || "HEAD",
    sourceRef: env.SOURCE_REF || "refs/heads/main",
    repository: env.REPO || "",
    baseBranch: env.BASE_BRANCH || "main",
    apiUrl: env.MOCK_API_URL || "",
    token: env.TOKEN || "",
    eventName: env.SELECTED_EVENT || "workflow_dispatch",
    sourceEvent: JSON.parse(readFileSync(env.SOURCE_EVENT_FILE || "", "utf8")),
    phase:
      env.PREPARE_PHASE === "repository"
        ? "repository"
        : env.PREPARE_PHASE === "event"
          ? "event"
          : undefined,
    snapshot:
      env.PREPARE_PHASE === "event"
        ? JSON.parse(readFileSync(env.MOCK_SNAPSHOT_FILE || "", "utf8"))
        : undefined,
  })
    .then((prepared) => {
      writeFileSync(
        (env.PREPARE_PHASE === "repository"
          ? env.MOCK_SNAPSHOT_FILE
          : env.MOCK_EVENT_FILE) || "",
        JSON.stringify(
          env.PREPARE_PHASE === "repository"
            ? {
                sourceSha: prepared.sourceSha,
                mockSha: prepared.mockSha,
                files: prepared.files,
              }
            : prepared.event,
          null,
          2,
        ),
        { mode: 0o600 },
      );
      console.log(
        `${env.PREPARE_PHASE === "event" ? "Prepared event for" : "Imported"} ${prepared.files} tracked files from ${prepared.sourceSha}; mock commit ${prepared.mockSha}`,
      );
    })
    .catch((error: Error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
