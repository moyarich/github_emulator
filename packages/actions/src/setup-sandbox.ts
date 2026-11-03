import { join } from "node:path";
import { execute } from "./shared.js";

/** Builds the isolated mock GitHub image and installs the act runner. */
export async function setupSandbox(
  distribution: string,
  temporaryDirectory: string,
  projectName: string,
  command: typeof execute = execute,
): Promise<string> {
  const image = `github-emulator-test:${projectName}`;
  await command("docker", ["build", "-f", join(distribution, "docker/Dockerfile"),
    "--target", "mock-github", "-t", image, distribution]);
  await command("docker", ["compose", "-f", join(distribution, "compose.yaml"), "build", "github-proxy"]);
  const actDirectory = join(temporaryDirectory, "act");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(actDirectory, { recursive: true });
  await command("gh", ["release", "download", "v0.2.95", "--repo", "nektos/act",
    "--pattern", "act_Linux_x86_64.tar.gz", "--dir", actDirectory]);
  await command("tar", ["xzf", join(actDirectory, "act_Linux_x86_64.tar.gz"), "-C", actDirectory, "act"]);
  return actDirectory;
}
