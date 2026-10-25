import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configuration,
  writeRunnerFile,
} from "../packages/actions/src/shared.ts";
import { cleanup } from "../packages/actions/src/post.ts";

describe("emulator action", () => {
  it("defaults to a server seeded for the caller repository", () => {
    expect(
      configuration({ GITHUB_REPOSITORY: "moya/workflow-under-test" }),
    ).toMatchObject({
      repository: "moya/workflow-under-test",
      token: "local-test-token",
      exportEnv: true,
    });
  });
  it("rejects invalid configuration before building containers", () => {
    expect(() => configuration({ INPUT_REPOSITORY: "invalid" })).toThrow(
      "owner/name",
    );
    expect(() => configuration({ "INPUT_EXPORT-ENV": "yes" })).toThrow(
      "export-env",
    );
  });
  it("has no release-scenario configuration", () => {
    const config = configuration({ "INPUT_SEED-FILE": "fixtures/github.yaml" });
    expect(config.seedFile).toBe("fixtures/github.yaml");
    for (const key of [
      "mode",
      "manifestPath",
      "oldVersion",
      "newVersion",
      "updateBody",
    ])
      expect(config).not.toHaveProperty(key);
  });
  it("writes multiline runner values without allowing value lines to become keys", () => {
    const directory = mkdtempSync(join(tmpdir(), "emulator-action-test-"));
    try {
      const file = join(directory, "output");
      writeRunnerFile(file, "token", "first\nOTHER=value");
      const text = readFileSync(file, "utf8");
      const marker = text.split("\n")[0].split("<<")[1];
      expect(text).toBe(`token<<${marker}\nfirst\nOTHER=value\n${marker}\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("removes only the container recorded for this invocation", async () => {
    const command = vi
      .fn()
      .mockResolvedValueOnce("test-container")
      .mockResolvedValueOnce("");
    await cleanup({ "STATE_container-id": "test-container" }, command);
    expect(command.mock.calls[1]).toEqual([
      "docker",
      ["rm", "--force", "test-container"],
    ]);
  });
  it("does nothing when no server was started or it was already removed", async () => {
    const command = vi.fn().mockResolvedValue("");
    await cleanup({}, command);
    expect(command).not.toHaveBeenCalled();
    await cleanup({ "STATE_container-id": "gone" }, command);
    expect(command).toHaveBeenCalledTimes(1);
  });
});
