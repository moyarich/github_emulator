import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(dirname(fileURLToPath(import.meta.url)));
const source = JSON.parse(
  readFileSync(join(app, "moyaforge.sources.json"), "utf8"),
);
const temporary = mkdtempSync(join(tmpdir(), "moyaforge-packages-"));
function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}
try {
  const repository = join(temporary, "source");
  run(
    "git",
    [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      source.repository,
      repository,
    ],
    temporary,
  );
  run(
    "git",
    [
      "sparse-checkout",
      "set",
      ...source.packages.map((name) => `packages/${name}`),
    ],
    repository,
  );
  run("git", ["checkout", source.revision], repository);
  mkdirSync(join(app, "vendor"), { recursive: true });
  for (const name of source.packages) {
    const directory = join(temporary, name);
    cpSync(join(repository, "packages", name), directory, { recursive: true });
    run(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
      directory,
    );
    run(
      "npm",
      [
        "install",
        "--no-save",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "@types/node@^26",
      ],
      directory,
    );
    run("npm", ["run", "build"], directory);
    run(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", join(app, "vendor")],
      directory,
    );
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
