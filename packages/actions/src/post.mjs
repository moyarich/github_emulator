import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execute, removeContainer } from "./shared.mjs";

export async function cleanup(environment = process.env, command = execute) {
  const container = environment["STATE_container-id"];
  if (!container) return;
  // Callers may also choose to remove the container explicitly.
  const existing = await command(
    "docker",
    ["ps", "--all", "--quiet", "--filter", `id=${container}`],
    { capture: true },
  );
  if (existing) await removeContainer(container, command);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  cleanup().catch((error) => {
    console.error(`Emulator cleanup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
