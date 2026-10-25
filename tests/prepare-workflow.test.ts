import { afterEach, beforeEach, expect, it } from "vitest";
import { createEmulator, type Emulator } from "emulate";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkflow } from "../packages/actions/src/prepare-workflow.js";

let workspace: string;
let emulator: Emulator;
let sourceSha: string;
const repository = "fixture/project";
const token = "fixture-token";

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "mock-checkout-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: workspace });
  git("init", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(workspace, "package.json"), '{"version":"2.0.0"}');
  writeFileSync(join(workspace, "binary.dat"), Buffer.from([0, 255, 128, 1]));
  writeFileSync(join(workspace, "run.sh"), "#!/bin/sh\necho fixture\n");
  chmodSync(join(workspace, "run.sh"), 0o755);
  symlinkSync("package.json", join(workspace, "manifest"));
  git("add", ".");
  git("commit", "-m", "Source checkout");
  sourceSha = git("rev-parse", "HEAD").toString().trim();
  writeFileSync(join(workspace, ".env"), "PRIVATE=must-not-import");
  emulator = await createEmulator({
    service: "github",
    port: 0,
    seed: {
      tokens: { [token]: { login: "fixture", scopes: ["repo", "user"] } },
      github: {
        users: [{ login: "fixture" }],
        repos: [
          {
            owner: "fixture",
            name: "project",
            auto_init: true,
            default_branch: "main",
          },
        ],
      },
    },
  });
});

afterEach(async () => {
  await emulator?.close();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

function options() {
  return {
    workspace,
    sourceSha,
    sourceRef: "refs/heads/main",
    repository,
    baseBranch: "main",
    apiUrl: emulator.url,
    token,
    eventName: "push",
    sourceEvent: {},
  };
}
async function get(path: string) {
  return fetch(`${emulator.url}/repos/${repository}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}
it("imports tracked Git objects, preserving binary data and modes while excluding untracked secrets", async () => {
  const prepared = await prepareWorkflow(options());
  expect(prepared.files).toBe(4);
  expect(prepared.event.after).toBe(prepared.mockSha);
  expect(prepared.event._emulate).toMatchObject({ source_sha: sourceSha });
  const binary = await (await get("/contents/binary.dat")).json();
  expect(Buffer.from(binary.content, "base64")).toEqual(
    Buffer.from([0, 255, 128, 1]),
  );
  expect((await get("/contents/.env")).status).toBe(404);
  const tree = await (
    await get(
      `/git/trees/${(await (await get(`/git/commits/${prepared.mockSha}`)).json()).tree.sha}?recursive=1`,
    )
  ).json();
  expect(tree.tree).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "run.sh", mode: "100755" }),
      expect.objectContaining({ path: "manifest", mode: "120000" }),
    ]),
  );
});
it("creates mock PR state and remaps a merged event to mock repository and commit identities", async () => {
  const repo = {
    full_name: repository,
    name: "project",
    owner: { login: "fixture" },
    default_branch: "main",
  };
  const prepared = await prepareWorkflow({
    ...options(),
    eventName: "pull_request",
    sourceEvent: {
      action: "closed",
      repository: repo,
      pull_request: {
        number: 42,
        title: "Approve release",
        body: "release markers",
        state: "closed",
        merged: true,
        head: { ref: "release/prepare-fixture", repo },
        base: { ref: "main", repo },
      },
    },
  });
  expect(prepared.event).toMatchObject({
    action: "closed",
    number: 1,
    repository: { full_name: repository },
    pull_request: {
      merged: true,
      head: { ref: "release/prepare-fixture" },
      body: "release markers",
    },
  });
  expect((await (await get("/pulls/1")).json()).merged).toBe(true);
});

it("prepares the event in a later phase without importing the repository again", async () => {
  const snapshot = await prepareWorkflow({ ...options(), phase: "repository" });
  expect(snapshot.event).toEqual({});
  const before = await (await get("/commits")).json();
  const prepared = await prepareWorkflow({
    ...options(),
    phase: "event",
    snapshot,
  });
  expect(prepared.mockSha).toBe(snapshot.mockSha);
  expect(prepared.event.after).toBe(snapshot.mockSha);
  expect(prepared.files).toBe(snapshot.files);
  expect(await (await get("/commits")).json()).toEqual(before);
});
