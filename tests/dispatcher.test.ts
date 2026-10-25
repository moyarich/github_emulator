import { afterEach, expect, it } from "vitest";
import { createEmulator } from "emulate";
import {
  createDispatcher,
  type DispatchEvent,
  activity,
  matchesTrigger,
} from "../packages/emulate-github/dispatcher/index.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("forwards mock API changes, dispatches successful activities and custom events, and ignores reads and failures", async () => {
  const emulator = await createEmulator({
    service: "github",
    port: 0,
    seed: {
      tokens: { test: { login: "tester", scopes: ["repo"] } },
      github: {
        users: [{ login: "tester" }],
        repos: [{ owner: "tester", name: "project", auto_init: true }],
      },
    },
  });
  cleanup.push(() => emulator.close());
  const events: DispatchEvent[] = [];
  const dispatcher = createDispatcher({
    upstream: emulator.url,
    repository: "tester/project",
    token: "test",
    enabled: true,
    run: async (event) => {
      events.push(event);
      return 1;
    },
  });
  await new Promise<void>((done) =>
    dispatcher.server.listen(0, "127.0.0.1", done),
  );
  cleanup.push(
    () =>
      new Promise<void>((done, reject) =>
        dispatcher.server.close((error) => (error ? reject(error) : done())),
      ),
  );
  const address = dispatcher.server.address();
  if (!address || typeof address === "string")
    throw new Error("No dispatcher address");
  const base = `http://127.0.0.1:${address.port}/repos/tester/project`;
  const api = (path: string, body?: unknown) =>
    fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  expect((await api("")).ok).toBe(true);
  const issue = await api("/issues", { title: "Mock issue" });
  expect(issue.status).toBe(201);
  expect((await api("/pulls", { title: "Invalid PR" })).ok).toBe(false);
  expect(
    (
      await api("/dispatches", {
        event_type: "test",
        client_payload: { version: "1" },
      })
    ).status,
  ).toBe(204);
  await dispatcher.idle();
  expect(events.map((event) => [event.name, event.payload.action])).toEqual([
    ["issues", "opened"],
    ["repository_dispatch", "test"],
  ]);
  const statusUrl = `http://127.0.0.1:${address.port}/_dispatcher/status`;
  expect((await fetch(statusUrl)).status).toBe(401);
  const status = await fetch(statusUrl, {
    headers: { Authorization: "Bearer test" },
  });
  expect(await status.json()).toMatchObject({
    accepted: 2,
    pending: 0,
    completed: 2,
    failed: 0,
    workflows: 2,
  });
  expect(events[0].payload.repository.full_name).toBe("tester/project");
  expect(events[1].payload.client_payload).toEqual({ version: "1" });
  expect((await (await api("/issues")).json()).length).toBe(1);
});

it("queues a merged PR with closed activity and merged metadata", () => {
  const event = activity(
    "PUT",
    "/repos/a/b/pulls/3/merge",
    {},
    { merged: true, sha: "abc" },
    { number: 3, head: { ref: "feature" } },
  );
  expect(event).toMatchObject({
    name: "pull_request",
    payload: {
      action: "closed",
      number: 3,
      pull_request: { merged: true, state: "closed", merge_commit_sha: "abc" },
    },
  });
  expect(
    activity("PUT", "/repos/a/b/pulls/3/merge", {}, { merged: false }),
  ).toBeUndefined();
});

it("matches workflow event types and PR base branches before running act", () => {
  const event = {
    name: "pull_request",
    payload: { action: "closed", pull_request: { base: { ref: "main" } } },
  };
  expect(
    matchesTrigger(
      { pull_request: { types: ["closed"], branches: ["main"] } },
      event,
    ),
  ).toBe(true);
  expect(matchesTrigger({ pull_request: { types: ["opened"] } }, event)).toBe(
    false,
  );
  expect(matchesTrigger({ pull_request: {} }, event)).toBe(false);
  expect(
    matchesTrigger(
      { pull_request: { types: ["closed"], branches: ["develop"] } },
      event,
    ),
  ).toBe(false);
  expect(
    matchesTrigger(
      { repository_dispatch: { types: ["deploy"] } },
      { name: "repository_dispatch", payload: { action: "probe" } },
    ),
  ).toBe(false);
  expect(
    matchesTrigger("issues", { name: "issues", payload: { action: "opened" } }),
  ).toBe(true);
});

it("emits a published release when a draft is finalized, but not when a draft is edited", () => {
  expect(
    activity(
      "PATCH",
      "/repos/a/b/releases/1",
      { draft: false },
      { id: 1, draft: false },
      { draft: true },
    ),
  ).toMatchObject({
    name: "release",
    payload: { action: "published", release: { id: 1 } },
  });
  expect(
    activity(
      "PATCH",
      "/repos/a/b/releases/1",
      { name: "Edited" },
      { id: 1, draft: true },
      { draft: true },
    ),
  ).toBeUndefined();
});
