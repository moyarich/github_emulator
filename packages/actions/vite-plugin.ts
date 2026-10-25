import { cpSync, copyFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

export function githubAction(): Plugin {
  const directory = dirname(fileURLToPath(import.meta.url));
  const root = resolve(directory, "../..");
  const packageDirectory = resolve(root, "packages/emulate-github");
  return {
    name: "github-action",
    apply: "build",
    writeBundle(output) {
      if (!output.dir) throw new Error("An output directory is required");
      for (const folder of ["scripts", "docker", "dispatcher"]) {
        cpSync(resolve(packageDirectory, folder), resolve(output.dir, folder), {
          recursive: true,
          filter: (source) => basename(source) !== ".DS_Store",
        });
      }
      for (const file of [
        "compose.yaml",
        "compose.dispatcher.yaml",
        ".dockerignore",
      ]) {
        copyFileSync(
          resolve(packageDirectory, file),
          resolve(output.dir, file),
        );
      }
      copyFileSync(
        resolve(directory, "actions/setup-github-emulator/action.yml"),
        resolve(root, "action.yml"),
      );
    },
  };
}
