import { afterEach, beforeEach, expect, it } from "vitest";
import { createEmulator, type Emulator } from "emulate";

let emulator: Emulator;
const repository = "workflow/release-test";
const manifestPath = "packages/core/package.json";

beforeEach(async () => {
  emulator = await createEmulator({
    service: "github",
    port: 0,
    seed: {
      tokens: { "test-token": { login: "workflow", scopes: ["repo", "user"] } },
      github: {
        users: [{ login: "workflow" }],
        repos: [
          {
            owner: "workflow",
            name: "release-test",
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
});

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${emulator.url}/repos/${repository}${path}`, {
    method,
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true);
  return response.json();
}

it("merges the release branch's package update into main", async () => {
  const content = (version: string) =>
    Buffer.from(JSON.stringify({ name: "@example/core", version })).toString(
      "base64",
    );
  await api(`/contents/${manifestPath}`, "PUT", {
    message: "Seed package",
    branch: "main",
    content: content("1.0.0"),
  });
  const head = await api("/git/ref/heads/main");
  await api("/git/refs", "POST", {
    ref: "refs/heads/release/test",
    sha: head.object.sha,
  });
  const original = await api(`/contents/${manifestPath}?ref=release/test`);
  await api(`/contents/${manifestPath}`, "PUT", {
    message: "Prepare release",
    branch: "release/test",
    sha: original.sha,
    content: content("1.1.0"),
  });
  const pr = await api("/pulls", "POST", {
    title: "Prepare release",
    head: "release/test",
    base: "main",
  });
  expect(
    await api(`/pulls/${pr.number}/merge`, "PUT", { merge_method: "merge" }),
  ).toMatchObject({ merged: true });
  expect(await api(`/pulls/${pr.number}`)).toMatchObject({ merged: true });
  const merged = await api(`/contents/${manifestPath}?ref=main`);
  expect(
    JSON.parse(Buffer.from(merged.content, "base64").toString()),
  ).toMatchObject({ version: "1.1.0" });
});

it("resets mutations back to the seeded repository", async () => {
  await api("/issues", "POST", { title: "Disposable fixture" });
  expect(await api("/issues")).toHaveLength(1);
  emulator.reset();
  expect(await api("/issues")).toEqual([]);
  expect(await api("")).toMatchObject({ full_name: repository });
});
