import { requestJson, type HttpClient } from "./pr-merge-api.js";

/** Draft release returned by the isolated mock GitHub API. */
export interface DraftRelease { tag_name: string; draft: boolean }

/** Ensures the emulated merge created only draft releases. */
export async function verifyDraftReleases(
  repository: string, token: string,
  apiBase = "http://127.0.0.1:4001",
  http: HttpClient = fetch,
): Promise<DraftRelease[]> {
  const releases = await requestJson<DraftRelease[]>(
    `${apiBase}/repos/${repository}/releases`, token, {}, http,
  );
  if (!releases.length || releases.some((release) => !release.draft))
    throw new Error("Expected one or more draft-only releases");
  return releases;
}
