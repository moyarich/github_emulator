import { existsSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { i as input, e as execute, w as writeRunnerFile } from "./shared-BiJx6WeG.js";
import { r as requestJson } from "./pr-merge-api-CuDrsZrg.js";
import { c as composeArguments, s as stopServices, r as readServiceLogs } from "./compose-services-Cb-WMZ74.js";
function prMergeConfiguration(env = process.env) {
  const repository = input("repository", env.GITHUB_REPOSITORY ?? "", env);
  const rawNumber = input("pr-number", "", env);
  const workflow = input("workflow", "", env);
  const githubToken = input("github-token", "", env);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("repository must be owner/name");
  if (!/^[1-9]\d*$/.test(rawNumber)) throw new Error("pr-number must be a positive integer");
  if (!Number.isSafeInteger(Number(rawNumber))) throw new Error("pr-number is too large");
  if (workflow && !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(workflow))
    throw new Error("workflow must be a .github/workflows YAML path");
  if (!githubToken) throw new Error("github-token is required for PR emulation");
  return {
    repository,
    prNumber: Number(rawNumber),
    baseBranch: input("base-branch", "main", env),
    workflow: workflow || void 0,
    token: input("token", "local-test-token", env),
    githubToken
  };
}
async function importPullRequest(config, temporaryDirectory, command = execute, http = fetch) {
  const pr = await requestJson(
    `https://api.github.com/repos/${config.repository}/pulls/${config.prNumber}`,
    config.githubToken,
    {},
    http
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
    action: "opened",
    number: pr.number,
    pull_request: { ...pr, merged: false, state: "open" },
    repository: pr.base.repo
  }), { mode: 384 });
  return {
    workspace,
    repository: config.repository,
    sha,
    ref: `refs/heads/${pr.head.ref}`,
    baseBranch: pr.base.ref,
    sourceEventFile,
    snapshotFile: join(temporaryDirectory, "mock-snapshot.json"),
    eventFile: join(temporaryDirectory, "mock-event.json")
  };
}
async function setupSandbox(distribution, temporaryDirectory, projectName, githubToken, command = execute) {
  const image = `github-emulator-test:${projectName}`;
  await command("docker", [
    "build",
    "-f",
    join(distribution, "docker/Dockerfile"),
    "--target",
    "mock-github",
    "-t",
    image,
    distribution
  ]);
  await command("docker", ["compose", "-p", projectName, "-f", join(distribution, "compose.yaml"), "build", "github-proxy"], {
    env: { ...process.env, COMPOSE_PROJECT_NAME: projectName, EMULATOR_PORT: "0", HTTPS_PORT: "0" }
  });
  const actDirectory = join(temporaryDirectory, "act");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(actDirectory, { recursive: true });
  await command("gh", [
    "release",
    "download",
    "v0.2.95",
    "--repo",
    "nektos/act",
    "--pattern",
    "act_Linux_x86_64.tar.gz",
    "--dir",
    actDirectory
  ], {
    env: { ...process.env, GH_TOKEN: githubToken }
  });
  await command("tar", ["xzf", join(actDirectory, "act_Linux_x86_64.tar.gz"), "-C", actDirectory, "act"]);
  return actDirectory;
}
function dispatcherOverride(source, actionRoot, temporaryDirectory, image, githubToken) {
  const quote = (value) => JSON.stringify(value);
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
    ""
  ].join("\n");
}
async function startDispatcher(source, actionRoot, temporaryDirectory, project, githubToken, token, command = execute) {
  const image = `github-emulator-test:${project}`;
  const override = join(temporaryDirectory, "mock-service.yaml");
  writeFileSync(override, dispatcherOverride(source, actionRoot, temporaryDirectory, image, githubToken), { mode: 384 });
  const distribution = join(actionRoot, "dist/github-emulator");
  const files = [join(distribution, "compose.yaml"), join(distribution, "compose.dispatcher.yaml"), override];
  const environment = {
    ...process.env,
    COMPOSE_PROJECT_NAME: project,
    DISPATCH_WORKSPACE: source.workspace,
    REPO: source.repository,
    TOKEN: token,
    BASE_BRANCH: source.baseBranch,
    EMULATOR_PORT: "0",
    HTTPS_PORT: "0"
  };
  try {
    await command("docker", [...composeArguments(project, files), "up", "--detach", "--wait", "--no-build"], { env: environment });
  } catch (error) {
    await stopServices(project, files, command, environment).catch((cleanupError) => {
      console.error("Could not clean up partially started services:", cleanupError);
    });
    throw error;
  }
  return { project, files, image, environment };
}
async function prepareMockPullRequest(source, runtime, token, command = execute) {
  const environment = {
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
    MOCK_API_URL: "http://127.0.0.1:4001"
  };
  for (const phase of ["repository", "event"]) {
    const args = [
      ...composeArguments(runtime.project, runtime.files),
      "exec",
      "-T",
      "--workdir",
      source.workspace
    ];
    for (const [key, value] of Object.entries({ ...environment, PREPARE_PHASE: phase }))
      args.push("--env", `${key}=${value}`);
    args.push("github-emulator", "node", "/emulator-checkout/dist/github-emulator/prepare-workflow.js");
    await command("docker", args, { env: runtime.environment });
  }
}
async function emulatePrMerge(environment = process.env) {
  if (environment.RUNNER_OS !== "Linux") throw new Error("PR merge emulation requires Linux");
  const config = prMergeConfiguration(environment);
  const temp = environment.RUNNER_TEMP;
  if (!temp) throw new Error("RUNNER_TEMP is required");
  const distribution = dirname(fileURLToPath(import.meta.url));
  const root = resolve(distribution, "../..");
  const project = `pr-merge-${randomUUID().slice(0, 12)}`;
  const state = { project, files: [] };
  const statePath = join(temp, "pr-merge-state.json");
  writeFileSync(statePath, JSON.stringify(state), { mode: 384 });
  writeRunnerFile(environment.GITHUB_STATE, "pr-merge-state", statePath);
  try {
    const source = await importPullRequest(config, temp);
    const actDirectory = await setupSandbox(distribution, temp, project, config.githubToken);
    const runtime = await startDispatcher(source, root, temp, project, config.githubToken, config.token);
    state.files = runtime.files;
    state.environment = {
      COMPOSE_PROJECT_NAME: project,
      DISPATCH_WORKSPACE: source.workspace,
      REPO: source.repository,
      BASE_BRANCH: source.baseBranch,
      EMULATOR_PORT: "0",
      HTTPS_PORT: "0"
    };
    writeFileSync(statePath, JSON.stringify(state), { mode: 384 });
    runtime.environment = { ...runtime.environment, PATH: `${actDirectory}:${runtime.environment.PATH ?? ""}` };
    await prepareMockPullRequest(source, runtime, config.token);
    await execute("docker", [
      ...composeArguments(project, runtime.files),
      "exec",
      "-T",
      "-e",
      `REPO=${config.repository}`,
      "-e",
      `TOKEN=${config.token}`,
      "github-dispatcher",
      "node",
      "/emulator-checkout/dist/github-emulator/dispatch-merge-event.js"
    ], { env: runtime.environment });
    const releaseJson = await execute("docker", [
      ...composeArguments(project, runtime.files),
      "exec",
      "-T",
      "-e",
      `REPO=${config.repository}`,
      "-e",
      `TOKEN=${config.token}`,
      "github-dispatcher",
      "node",
      "/emulator-checkout/dist/github-emulator/verify-mock-releases.js"
    ], { capture: true, env: runtime.environment });
    const releases = JSON.parse(releaseJson);
    if (environment.GITHUB_STEP_SUMMARY)
      appendFileSync(
        environment.GITHUB_STEP_SUMMARY,
        `## Emulated PR ${config.repository}#${config.prNumber}
No real merge or publish occurred.
` + releases.map((release) => `- ${release.tag_name} (draft)`).join("\n") + "\n"
      );
  } catch (error) {
    if (state.files.length) {
      try {
        const logs = await readServiceLogs(project, state.files, execute, state.environment);
        writeFileSync(join(temp, "pr-merge.log"), logs, { mode: 384 });
      } catch (diagnosticError) {
        console.error("Could not capture diagnostics:", diagnosticError);
      }
    }
    throw error;
  }
}
emulatePrMerge().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
export {
  emulatePrMerge
};
