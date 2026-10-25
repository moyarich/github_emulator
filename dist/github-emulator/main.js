import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { c as configuration, e as execute, w as writeRunnerFile, r as removeContainer } from "./shared-DfBJ5eiR.js";
async function run(environment = process.env) {
  const config = configuration(environment);
  if (environment.RUNNER_OS !== "Linux")
    throw new Error("Use a Linux runner with Docker available");
  const distribution = dirname(fileURLToPath(import.meta.url));
  const image = `github-emulator-action:${randomUUID()}`;
  let seed;
  if (config.seedFile) {
    seed = resolve(
      environment.GITHUB_WORKSPACE || process.cwd(),
      config.seedFile
    );
    if (!existsSync(seed) || !statSync(seed).isFile())
      throw new Error(`Seed file not found: ${seed}`);
  }
  await execute("docker", ["info"], { capture: true });
  await execute("docker", [
    "build",
    "--file",
    join(distribution, "docker/Dockerfile"),
    "--target",
    "mock-github",
    "--tag",
    image,
    distribution
  ]);
  const options = ["--init"];
  for (const [name, value] of Object.entries({
    REPO: config.repository,
    TOKEN: config.token,
    BASE_BRANCH: config.baseBranch,
    BOOTSTRAP_REPOSITORY: "0"
  }))
    options.push("--env", `${name}=${value}`);
  if (seed)
    options.push(
      "--volume",
      `${seed}:/run/emulator-seed:ro`,
      "--env",
      "SEED_FILE=/run/emulator-seed"
    );
  const container = await execute(
    "docker",
    ["run", "--detach", ...options, "--publish", "127.0.0.1::4001", image],
    { capture: true }
  );
  try {
    writeRunnerFile(environment.GITHUB_STATE, "container-id", container);
    const address = await execute("docker", ["port", container, "4001/tcp"], {
      capture: true
    });
    let api = `http://${address}`;
    const endpoints = [api];
    if (environment.ACT === "true")
      endpoints.push(`http://host.docker.internal:${new URL(api).port}`);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      for (const endpoint of endpoints) {
        try {
          const response = await fetch(
            `${endpoint}/repos/${config.repository}`,
            {
              headers: { Authorization: `Bearer ${config.token}` },
              signal: AbortSignal.timeout(2e3)
            }
          );
          if (response.ok) {
            api = endpoint;
            ready = true;
            break;
          }
        } catch {
        }
      }
      if (ready) break;
      const running = await execute(
        "docker",
        ["inspect", "--format", "{{.State.Running}}", container],
        { capture: true }
      );
      if (running !== "true") break;
      await setTimeout(1e3);
    }
    if (!ready)
      throw new Error(
        "Emulator startup timed out; check the seed file, repository and token"
      );
    for (const [name, value] of Object.entries({
      "api-url": api,
      token: config.token,
      repository: config.repository,
      "container-id": container
    })) {
      writeRunnerFile(environment.GITHUB_OUTPUT, name, value);
    }
    if (config.exportEnv) {
      writeRunnerFile(environment.GITHUB_ENV, "GH_EMULATOR_API_URL", api);
      writeRunnerFile(
        environment.GITHUB_ENV,
        "GH_EMULATOR_TOKEN",
        config.token
      );
    }
    console.log(`GitHub emulator ready: ${api}/repos/${config.repository}`);
    console.log(
      "Configure workflow clients with this API URL and the local token. Post-job cleanup is automatic."
    );
  } catch (error) {
    await execute("docker", ["logs", container]).catch(() => {
    });
    await removeContainer(container).catch(() => {
    });
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
export {
  run
};
