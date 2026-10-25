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
        main: resolve(directory, "src/main.ts"),
        post: resolve(directory, "src/post.ts"),
        "prepare-workflow": resolve(directory, "src/prepare-workflow.ts"),
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
