/**
 * Octokit equivalent of smoke-test-api.sh.
 *
 * Node >= 24: node --experimental-strip-types test/api.smoke-test.ts
 * Set API or GITHUB_API_URL to target a running emulator (including Portless).
 * By default, launches the emulator if the local API is unavailable.
 */
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const env = process.env;
const port = env.EMULATE_PORT ?? "4001";
const baseUrl =
  env.API ??
  env.GITHUB_API_URL ??
  (env.USE_PORTLESS === "1"
    ? "https://github.emulate.localhost"
    : `http://localhost:${port}`);
const repository = env.REPO ?? "moyarich/release-smoke-test";
const [owner, repo] = repository.split("/");
const token = env.TOKEN ?? env.GITHUB_TOKEN ?? "local-test-token";
const baseBranch = env.BASE_BRANCH ?? "main";
const releaseBranch =
  env.RELEASE_BRANCH ??
  `release/prepare-${Math.floor(Date.now() / 1000)}-${process.pid}`;
const manifestPath = env.MANIFEST_PATH ?? "packages/core/package.json";
const oldVersion = env.OLD_VERSION ?? "1.0.0";
const newVersion = env.NEW_VERSION ?? "1.1.0";
const workflowFile = env.WORKFLOW_FILE;
const runAct = env.RUN_ACT === "1";
const updatePrBody = env.UPDATE_PR_BODY === "1";
const keepEmulator = env.KEEP_EMULATOR === "1";

function step(number: number, title: string) {
  console.log(`\n━━━ Step ${number}: ${title} ━━━`);
}
function info(message: string) {
  console.log(`  ➜ ${message}`);
}
function ok(message: string) {
  console.log(`  ✔ ${message}`);
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function checkCommand(command: string) {
  const check = spawnSync(command, ["--version"], { stdio: "ignore" });
  assert(!check.error, `Missing required command: ${command}`);
}

async function main() {
  assert(owner && repo, `Invalid REPO: ${repository} (expected owner/repo)`);
  const { Octokit } = await import("@octokit/rest");
  const client = new Octokit({ auth: token, baseUrl });
  const temp = await mkdtemp(join(tmpdir(), "github-emulator-api-"));
  let emulator: ReturnType<typeof spawn> | undefined;

  // The server is independent of this test; aborting the test only stops a server
  // that this invocation started.
  const repoParams = { owner, repo };
  async function isUp(): Promise<boolean> {
    try {
      await client.request("GET /repos/{owner}/{repo}", repoParams);
      return true;
    } catch {
      return false;
    }
  }
  async function waitForEmulator() {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await isUp()) return;
      assert(
        emulator?.exitCode === null && !emulator?.killed,
        "Emulator exited before becoming ready",
      );
      await new Promise((done) => setTimeout(done, 1000));
    }
    throw new Error(`Emulator did not become ready at ${baseUrl}`);
  }
  try {
    step(1, "Start or reuse GitHub emulator");
    if (await isUp()) {
      info(`Reusing emulator at ${baseUrl}`);
    } else {
      const localApi = new Set([
        `http://localhost:${port}`,
        `http://127.0.0.1:${port}`,
      ]);
      assert(
        localApi.has(baseUrl),
        `External emulator unavailable at ${baseUrl}; start Portless first (npm run start:portless)`,
      );
      checkCommand("bash");
      // The wrapper prepares seeded state and bootstraps the manifest itself.
      // It accepts the existing environment settings such as CONFIG_FILE.
      const script = resolve(process.cwd(), "scripts/start-emulator.sh");
      emulator = spawn("bash", [script, "start"], {
        cwd: process.cwd(),
        env: {
          ...env,
          API: baseUrl,
          REPO: repository,
          TOKEN: token,
          EMULATE_PORT: port,
        },
        stdio: ["ignore", "ignore", "inherit"],
      });
      emulator.on("error", (error: Error) =>
        console.error("Emulator failed:", error.message),
      );
      await waitForEmulator();
    }
    const { data: repoData } = await client.request(
      "GET /repos/{owner}/{repo}",
      repoParams,
    );
    assert(
      repoData.full_name === repository,
      `Unexpected seeded repository: ${repoData.full_name}`,
    );
    ok(`Repository ${repository} exists`);

    step(2, `Create the ${releaseBranch} branch`);
    const { data: baseRef } = await client.request(
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      {
        ...repoParams,
        ref: `heads/${baseBranch}`,
      },
    );
    const sha = baseRef.object.sha;
    assert(sha, `Could not resolve ${baseBranch} head SHA`);
    info(`${baseBranch} is at ${sha}`);
    const { data: createdRef } = await client.request(
      "POST /repos/{owner}/{repo}/git/refs",
      {
        ...repoParams,
        ref: `refs/heads/${releaseBranch}`,
        sha,
      },
    );
    console.log({ ref: createdRef.ref, sha: createdRef.object.sha });
    ok(`Created branch ${releaseBranch}`);

    // Preserve the shell test's actual execution ordering: update BEFORE PR
    // creation, because emulate 0.12.3 snapshots the PR head SHA.
    step(3, `Modify ${manifestPath} on ${releaseBranch}`);
    const { data: file } = await client.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        ...repoParams,
        path: manifestPath,
        ref: releaseBranch,
      },
    );
    assert(
      !Array.isArray(file) && file.type === "file" && "content" in file,
      `Expected a file at ${manifestPath}`,
    );
    const original = JSON.parse(
      Buffer.from(file.content, "base64").toString("utf8"),
    );
    info(`Current version: ${original.version} (blob ${file.sha})`);
    if (original.version !== oldVersion)
      info(`Warning: expected ${oldVersion}, found ${original.version}`);
    const updated =
      JSON.stringify({ ...original, version: newVersion }, null, 2) + "\n";
    const { data: commit } = await client.request(
      "PUT /repos/{owner}/{repo}/contents/{path}",
      {
        ...repoParams,
        path: manifestPath,
        message: `chore(release): bump @example/core to ${newVersion}`,
        content: Buffer.from(updated).toString("base64"),
        sha: file.sha,
        branch: releaseBranch,
      },
    );
    console.log({ commit: commit.commit.sha, path: commit.content?.path });
    ok(
      `Bumped version ${original.version} → ${newVersion} on ${releaseBranch}`,
    );

    step(4, "Create the simulated pull request");
    const body = `<!-- release-preparation:start -->
\`\`\`json
{"schemaVersion":1,"packages":[{"name":"@example/core","directory":"packages/core"}]}
\`\`\`
<!-- release-preparation:end -->`;
    const payload = {
      title: "release: prepare core",
      head: releaseBranch,
      base: baseBranch,
      body,
    };
    const prPayloadPath = join(temp, "release-pr.json");
    await writeFile(prPayloadPath, JSON.stringify(payload, null, 2));
    info(`Payload written to ${prPayloadPath}`);
    const { data: createdPr } = await client.request(
      "POST /repos/{owner}/{repo}/pulls",
      {
        ...repoParams,
        ...payload,
      },
    );
    const number = createdPr.number;
    assert(number, "PR creation returned no number");
    console.log({
      number,
      title: createdPr.title,
      state: createdPr.state,
      head: createdPr.head.ref,
      base: createdPr.base.ref,
    });
    ok(`Created PR #${number}`);

    if (updatePrBody) {
      const { data: currentPr } = await client.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          ...repoParams,
          pull_number: number,
        },
      );
      const { data: modifiedPr } = await client.request(
        "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          ...repoParams,
          pull_number: number,
          body: `${currentPr.body ?? ""}\n\nBumps @example/core to ${newVersion}.`,
        },
      );
      console.log({
        number: modifiedPr.number,
        updated_at: modifiedPr.updated_at,
      });
      ok("PR description updated");
    } else info("Skipping PR description update (UPDATE_PR_BODY=0)");

    step(5, `Merge PR #${number}`);
    const { data: merge } = await client.request(
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
      {
        ...repoParams,
        pull_number: number,
        merge_method: "merge",
      },
    );
    assert(merge.merged === true, `Merge not accepted for PR #${number}`);
    ok("Merge request accepted");

    step(6, "Verify merged state");
    const { data: mergedPr } = await client.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        ...repoParams,
        pull_number: number,
      },
    );
    console.log({
      merged: mergedPr.merged,
      merge_commit_sha: mergedPr.merge_commit_sha,
      body: mergedPr.body,
    });
    assert(mergedPr.merged === true, `PR #${number} is not marked merged`);
    const { data: mergedFile } = await client.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        ...repoParams,
        path: manifestPath,
        ref: baseBranch,
      },
    );
    assert(
      !Array.isArray(mergedFile) &&
        mergedFile.type === "file" &&
        "content" in mergedFile,
      `Expected merged file at ${manifestPath}`,
    );
    const manifest = JSON.parse(
      Buffer.from(mergedFile.content, "base64").toString("utf8"),
    );
    console.log(manifest);
    assert(
      manifest.version === newVersion,
      `Expected ${baseBranch} version ${newVersion} but found ${manifest.version}`,
    );
    ok(`${baseBranch} has @example/core@${manifest.version}`);

    step(7, `Replay merged pull_request event with nektos/act`);
    if (!runAct) {
      info("Skipped (set RUN_ACT=1 to enable)");
    } else {
      // Prefer the GitHub CLI extension when installed, but keep standalone act supported.
      const ghAct = spawnSync("gh", ["act", "--help"], { stdio: "ignore" });
      const runner = !ghAct.error && ghAct.status === 0 ? "gh" : "act";
      if (runner === "act") checkCommand("act");
      if (workflowFile) await access(workflowFile);
      const eventFile = join(temp, "merged-pr-event.json");
      await writeFile(
        eventFile,
        JSON.stringify(
          {
            action: "closed",
            number,
            pull_request: mergedPr,
            repository: repoData,
          },
          null,
          2,
        ),
      );
      info(`Event payload written to ${eventFile}`);
      const args = ["pull_request", "-e", eventFile];
      if (workflowFile) args.push("-W", workflowFile);
      if (runner === "gh") args.unshift("act");
      info(`Running ${runner} ${args.join(" ")}`);
      const result = spawnSync(runner, args, {
        stdio: "inherit",
        env: { ...env, API: baseUrl },
      });
      assert(
        !result.error && result.status === 0,
        `act failed (exit code ${result.status})`,
      );
      ok("act finished");
    }
    console.log("\n✔ Release smoke test completed successfully");
  } finally {
    if (emulator && !keepEmulator) {
      emulator.kill("SIGTERM");
    } else if (emulator && keepEmulator) {
      info("KEEP_EMULATOR=1: leaving emulator running");
      emulator.unref();
    }
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error("✘ API smoke test failed:", error);
  process.exitCode = 1;
});
