import { e as execute } from "./shared-BiJx6WeG.js";
function composeArguments(project, files) {
  return ["compose", "-p", project, ...files.flatMap((file) => ["-f", file])];
}
async function stopServices(project, files, command = execute, env) {
  await command("docker", [...composeArguments(project, files), "down", "--volumes", "--remove-orphans"], { env });
}
async function readServiceLogs(project, files, command = execute, env) {
  return command("docker", [...composeArguments(project, files), "logs", "--no-color"], { capture: true, env });
}
export {
  composeArguments as c,
  readServiceLogs as r,
  stopServices as s
};
