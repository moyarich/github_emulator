import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { githubAction } from "./vite-plugin.js";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../..");
export default defineConfig({
  build: {
    target: "node24",
    outDir: resolve(root, "dist/github-emulator"),
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: {
        "start-emulator": resolve(directory, "src/start-emulator.ts"),
        "finalize-emulator": resolve(directory, "src/finalize-emulator.ts"),
        "prepare-workflow": resolve(directory, "src/prepare-workflow.ts"),
        "emulate-pr-merge": resolve(directory, "src/emulate-pr-merge.ts"),
        "finalize-pr-merge": resolve(directory, "src/finalize-pr-merge.ts"),
        "dispatch-merge-event": resolve(directory, "src/dispatch-merge-event.ts"),
        "verify-mock-releases": resolve(directory, "src/verify-mock-releases.ts"),
      },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      external: (id) => id.startsWith("node:") || builtinModules.includes(id),
    },
  },
  plugins: [githubAction()],
});
