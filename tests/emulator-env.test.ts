import { afterEach, beforeEach, expect, it } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

let directory: string;
const script = resolve("packages/emulate-github/scripts/start-emulator.sh");
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "emulator-env-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});
function parse(content: string) {
  const input = join(directory, "mock.env");
  const output = join(directory, "normalized.env");
  writeFileSync(input, content);
  const result = spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; emulator_read_env "$2" "$3"',
      "bash",
      script,
      input,
      output,
    ],
    { encoding: "utf8" },
  );
  return { result, output };
}
it("normalizes literal values without executing shell substitutions", () => {
  const marker = join(directory, "should-not-exist");
  const value = `$(touch ${marker})`;
  const { result, output } = parse(
    `export REPO=fixture/project\nTOKEN="${value}"\nBASE_BRANCH=develop # comment\n`,
  );
  expect(result.status).toBe(0);
  const loaded = spawnSync(
    "bash",
    ["-c", 'source "$1"; printf "%s" "$TOKEN"', "bash", output],
    { encoding: "utf8" },
  );
  expect(loaded.stdout).toBe(value);
  expect(existsSync(marker)).toBe(false);
  expect(readFileSync(output, "utf8")).toContain("BASE_BRANCH=develop");
});
it.each([
  "TOKEN='unterminated",
  "UNKNOWN_CONFIG=value",
  "TOKEN=unquoted spaces",
])(
  "rejects invalid configuration before writing normalized settings: %s",
  (content) => {
    const { result, output } = parse(content);
    expect(result.status).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  },
);
it("can be sourced without changing shell options or creating runtime directories", () => {
  const result = spawnSync(
    "bash",
    [
      "-c",
      'before=$-; source "$1"; [[ "$before" == "$-" ]]; [[ -z "${RUN_DIR+x}" ]]',
      "bash",
      script,
    ],
    { encoding: "utf8", env: { ...process.env, TMPDIR: directory } },
  );
  expect(result.status).toBe(0);
});
