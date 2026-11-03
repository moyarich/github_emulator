import { join } from "node:path";
import { execute } from "./shared.js";

/** Builds the isolated mock GitHub image and installs the act runner. */
export async function setupSandbox(
  distribution: string,
  temporaryDirectory: string,
  projectName: string,
  githubToken: string,
  command: typeof execute = execute,
): Promise<string> {
  const image = `github-emulator-test:${projectName}`;
  await command("docker", ["build", "-f", join(distribution, "docker/Dockerfile"),
    "--target", "mock-github", "-t", image, distribution]);
  await command("docker", ["compose", "-p", projectName, "-f", join(distribution, "compose.yaml"), "build", "github-proxy"], {
    env: { ...process.env, COMPOSE_PROJECT_NAME: projectName, EMULATOR_PORT: "0", HTTPS_PORT: "0" },
  });
  const actDirectory = join(temporaryDirectory, "act");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(actDirectory, { recursive: true });
  await command("gh", ["release", "download", "v0.2.95", "--repo", "nektos/act",
    "--pattern", "act_Linux_x86_64.tar.gz", "--dir", actDirectory], {
      env: { ...process.env, GH_TOKEN: githubToken },
    });
  await command("tar", ["xzf", join(actDirectory, "act_Linux_x86_64.tar.gz"), "-C", actDirectory, "act"]);
  return actDirectory;
}
