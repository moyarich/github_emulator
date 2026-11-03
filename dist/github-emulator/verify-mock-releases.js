import { r as requestJson } from "./pr-merge-api-CuDrsZrg.js";
async function verifyDraftReleases(repository, token, apiBase = "http://127.0.0.1:4001", http = fetch) {
  const releases = await requestJson(
    `${apiBase}/repos/${repository}/releases`,
    token,
    {},
    http
  );
  if (!releases.length || releases.some((release) => !release.draft))
    throw new Error("Expected one or more draft-only releases");
  return releases;
}
async function verifyMockReleases(environment = process.env) {
  const repository = environment.REPO;
  const token = environment.TOKEN;
  if (!repository || !token) throw new Error("REPO and TOKEN are required");
  const releases = await verifyDraftReleases(repository, token, "http://github-emulator:4001");
  console.log(JSON.stringify(releases));
}
verifyMockReleases().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
export {
  verifyMockReleases
};
