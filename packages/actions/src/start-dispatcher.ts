import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execute } from "./shared.js";
import { composeArguments } from "./compose-services.js";
import type { ImportedPullRequest } from "./import-pr.js";

/** Compose runtime paths for the isolated emulation environment. */
export interface DispatcherRuntime {
  project: string;
  files: string[];
  image: string;
}

/** Generate the service override without starting containers. */
export function dispatcherOverride(source: ImportedPullRequest, actionRoot: string, temporaryDirectory: string, image: string, githubToken: string): string {
  const quote = (value: string) => JSON.stringify(value);
  return [
    "services:",
    "  github-emulator:",
    `    image: ${quote(image)}`,
    "    volumes:",
    `      - ${quote(source.workspace + ":" + source.workspace + ":ro")}`,
    `      - ${quote(actionRoot + ":/emulator-checkout:ro")}`,
    `      - ${quote(temporaryDirectory + ":" + temporaryDirectory)}`,
    "    environment:",
    '      BOOTSTRAP_REPOSITORY: "0"',
    '      GIT_CONFIG_COUNT: "1"',
    '      GIT_CONFIG_KEY_0: "safe.directory"',
    `      GIT_CONFIG_VALUE_0: ${quote(source.workspace)}`,
    "  github-dispatcher:",
    `    image: ${quote(image)}`,
    "    volumes:",
    `      - ${quote(source.workspace + ":" + source.workspace + ":ro")}`,
    `      - ${quote(actionRoot + ":/emulator-checkout:ro")}`,
    "    environment:",
    `      DISPATCH_IMAGE: ${quote(image)}`,
    `      DISPATCH_WORKSPACE: ${quote(source.workspace)}`,
    `      DISPATCH_SOURCE_SHA: ${quote(source.sha)}`,
    `      DISPATCH_REPOSITORY: ${quote(source.repository)}`,
    '      DISPATCH_WORKFLOWS: ".github/workflows"',
    `      DISPATCH_GITHUB_TOKEN: ${quote(githubToken)}`,
    "",
  ].join("\n");
}

/** Write the override and launch isolated mock services. */
export async function startDispatcher(
  source: ImportedPullRequest,
  actionRoot: string,
  temporaryDirectory: string,
  project: string,
  githubToken: string,
  command: typeof execute = execute,
): Promise<DispatcherRuntime> {
  const image = `github-emulator-test:${project}`;
  const override = join(temporaryDirectory, "mock-service.yaml");
  writeFileSync(override, dispatcherOverride(source, actionRoot, temporaryDirectory, image, githubToken), { mode: 0o600 });
  const distribution = join(actionRoot, "dist/github-emulator");
  const files = [join(distribution, "compose.yaml"), join(distribution, "compose.dispatcher.yaml"), override];
  await command("docker", [...composeArguments(project, files), "up", "--detach", "--wait", "--no-build"]);
  return { project, files, image };
}
