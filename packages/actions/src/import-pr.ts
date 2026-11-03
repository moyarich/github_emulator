import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execute } from "./shared.js";
import { requestJson, type HttpClient } from "./pr-merge-api.js";
import type { PrMergeConfig } from "./pr-merge-config.js";

/** Source pull request fields required to construct an isolated replay. */
export interface SourcePullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  head: { sha: string; ref: string; repo: { full_name: string } };
  base: { ref: string; repo: { full_name: string } };
}

/** Resolved checkout and source event for subsequent emulation stages. */
export interface ImportedPullRequest {
  workspace: string;
  repository: string;
  sha: string;
  ref: string;
  baseBranch: string;
  sourceEventFile: string;
  snapshotFile: string;
  eventFile: string;
}

/** Imports a PR checkout without mutating the real repository or PR. */
export async function importPullRequest(
  config: PrMergeConfig,
  temporaryDirectory: string,
  command: typeof execute = execute,
  http: HttpClient = fetch,
): Promise<ImportedPullRequest> {
  const pr = await requestJson<SourcePullRequest>(
    `https://api.github.com/repos/${config.repository}/pulls/${config.prNumber}`,
    config.githubToken, {}, http,
  );
  if (pr.base.repo.full_name !== config.repository || pr.head.repo.full_name !== config.repository)
    throw new Error("Fork pull requests are not supported");
  if (pr.base.ref !== config.baseBranch || !pr.head.ref.startsWith("release/prepare-"))
    throw new Error("Unexpected release PR branch or base");
  const workspace = join(temporaryDirectory, "source");
  await command("git", ["clone", "--no-checkout", `https://github.com/${config.repository}.git`, workspace]);
  await command("git", ["-C", workspace, "fetch", "--no-tags", "origin", `refs/pull/${pr.number}/head`]);
  await command("git", ["-C", workspace, "checkout", "--detach", "FETCH_HEAD"]);
  const sha = await command("git", ["-C", workspace, "rev-parse", "HEAD"], { capture: true });
  if (sha !== pr.head.sha) throw new Error("Checked out PR SHA does not match GitHub");
  if (config.workflow && !existsSync(join(workspace, config.workflow)))
    throw new Error(`Workflow not found: ${config.workflow}`);
  const sourceEventFile = join(temporaryDirectory, "source-event.json");
  writeFileSync(sourceEventFile, JSON.stringify({
    action: "opened", number: pr.number,
    pull_request: { ...pr, merged: false, state: "open" },
    repository: pr.base.repo,
  }), { mode: 0o600 });
  return {
    workspace, repository: config.repository, sha, ref: `refs/heads/${pr.head.ref}`, baseBranch: pr.base.ref,
    sourceEventFile, snapshotFile: join(temporaryDirectory, "mock-snapshot.json"),
    eventFile: join(temporaryDirectory, "mock-event.json"),
  };
}
