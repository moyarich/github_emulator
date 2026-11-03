import { execute } from "./shared.js";

/** Construct Docker Compose arguments without invoking a subprocess. */
export function composeArguments(project: string, files: readonly string[]): string[] {
  return ["compose", "-p", project, ...files.flatMap((file) => ["-f", file])];
}

/** Stop and remove the isolated emulator services and volumes. */
export async function stopServices(project: string, files: readonly string[], command: typeof execute = execute, env?: NodeJS.ProcessEnv): Promise<void> {
  await command("docker", [...composeArguments(project, files), "down", "--volumes", "--remove-orphans"], { env });
}

/** Read diagnostic logs from the isolated emulator services. */
export async function readServiceLogs(project: string, files: readonly string[], command: typeof execute = execute, env?: NodeJS.ProcessEnv): Promise<string> {
  return command("docker", [...composeArguments(project, files), "logs", "--no-color"], { capture: true, env });
}
