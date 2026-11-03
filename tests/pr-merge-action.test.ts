import { describe, expect, it, vi } from "vitest";
import { prMergeConfiguration } from "../packages/actions/src/pr-merge-config.js";
import { dispatcherOverride } from "../packages/actions/src/start-dispatcher.js";
import { composeArguments } from "../packages/actions/src/compose-services.js";
import { triggerMockMerge } from "../packages/actions/src/trigger-merge.js";
import { waitForWorkflows } from "../packages/actions/src/wait-for-workflows.js";
import { verifyDraftReleases } from "../packages/actions/src/verify-releases.js";

describe("PR merge emulator", () => {
  it("validates inputs without side effects", () => {
    expect(() => prMergeConfiguration({ "INPUT_PR-NUMBER": "0", INPUT_REPOSITORY: "a/b", "INPUT_GITHUB-TOKEN": "token" })).toThrow();
    expect(prMergeConfiguration({
      INPUT_REPOSITORY: "a/b", "INPUT_PR-NUMBER": "225", "INPUT_GITHUB-TOKEN": "token",
    })).toMatchObject({ repository: "a/b", prNumber: 225 });
  });
  it("constructs isolated compose arguments", () => {
    expect(composeArguments("test-project", ["/tmp/a.yml"])).toEqual(["compose", "-p", "test-project", "-f", "/tmp/a.yml"]);
  });
  it("generates a dispatcher override from explicit context", () => {
    const source = {
      repository: "a/b", workspace: "/tmp/source", sha: "abc", ref: "refs/heads/release/prepare-1",
      baseBranch: "main", sourceEventFile: "/tmp/source-event.json",
      snapshotFile: "/tmp/snapshot.json", eventFile: "/tmp/event.json",
    };
    const yaml = dispatcherOverride(source, "/tmp/action", "/tmp", "mock:latest", "read-token");
    expect(yaml).toContain('DISPATCH_REPOSITORY: "a/b"');
    expect(yaml).toContain('DISPATCH_IMAGE: "mock:latest"');
  });
  it("triggers only the mock gateway", async () => {
    const http = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [{ number: 225 }] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ merged: true }) });
    expect(await triggerMockMerge("a/b", "token", "http://mock:4001", "http://gateway:4002", http as typeof fetch)).toBe(225);
    expect(http.mock.calls[1][0]).toBe("http://gateway:4002/repos/a/b/pulls/225/merge");
  });
  it("rejects failed workflow dispatch", async () => {
    const http = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      accepted: 1, pending: 0, failed: 1, workflows: 1,
    }) });
    await expect(waitForWorkflows("token", { timeoutMs: 1000 }, http as typeof fetch)).rejects.toThrow("failed");
  });
  it("rejects published releases", async () => {
    const http = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ tag_name: "v1", draft: false }] });
    await expect(verifyDraftReleases("a/b", "token", "http://mock:4001", http as typeof fetch)).rejects.toThrow("draft");
  });
});
