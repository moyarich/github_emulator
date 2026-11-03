import { execute } from "./shared.js";
import { composeArguments } from "./compose-services.js";
import type { ImportedPullRequest } from "./import-pr.js";
import type { DispatcherRuntime } from "./start-dispatcher.js";

/** Prepare repository objects and an open PR event inside the isolated emulator. */
export async function prepareMockPullRequest(
  source: ImportedPullRequest,
  runtime: DispatcherRuntime,
  token: string,
  command: typeof execute = execute,
): Promise<void> {
  const environment: Record<string, string> = {
    GITHUB_WORKSPACE: source.workspace,
    REPO: source.repository,
    TOKEN: token,
    BASE_BRANCH: source.baseBranch,
    SOURCE_SHA: source.sha,
    SOURCE_REF: source.ref,
    SOURCE_EVENT_FILE: source.sourceEventFile,
    MOCK_SNAPSHOT_FILE: source.snapshotFile,
    MOCK_EVENT_FILE: source.eventFile,
    SELECTED_EVENT: "pull_request",
    MOCK_API_URL: "http://127.0.0.1:4001",
  };
  for (const phase of ["repository", "event"]) {
    const args = [...composeArguments(runtime.project, runtime.files), "exec", "-T",
      "--workdir", source.workspace];
    for (const [key, value] of Object.entries({ ...environment, PREPARE_PHASE: phase }))
      args.push("--env", `${key}=${value}`);
    args.push("github-emulator", "node", "/emulator-checkout/dist/github-emulator/prepare-workflow.js");
    await command("docker", args);
  }
}
