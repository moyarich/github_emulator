import { verifyDraftReleases } from "./verify-releases.js";

/** Verify that the isolated mock GitHub contains only draft releases. */
export async function verifyMockReleases(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const repository = environment.REPO;
  const token = environment.TOKEN;
  if (!repository || !token) throw new Error("REPO and TOKEN are required");
  const releases = await verifyDraftReleases(repository, token, "http://github-emulator:4001");
  console.log(JSON.stringify(releases));
}

verifyMockReleases().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
