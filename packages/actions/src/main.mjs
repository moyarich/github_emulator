import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  configuration,
  execute,
  removeContainer,
  writeRunnerFile,
} from "./shared.mjs";

export async function run(environment = process.env) {
  const config = configuration(environment);
  if (environment.RUNNER_OS !== "Linux")
    throw new Error("Use a Linux runner with Docker available");
  const docker = join(dirname(fileURLToPath(import.meta.url)), "docker");
  const image = `github-emulator-action:${randomUUID()}`;
  let seed;
  if (config.seedFile) {
    seed = resolve(
      environment.GITHUB_WORKSPACE || process.cwd(),
      config.seedFile,
    );
    if (!existsSync(seed) || !statSync(seed).isFile())
      throw new Error(`Seed file not found: ${seed}`);
  }
  await execute("docker", ["info"], { capture: true });
  await execute("docker", [
    "build",
    "--file",
    join(docker, "Dockerfile"),
    "--target",
    config.mode,
    "--tag",
    image,
    docker,
  ]);
  const options = ["--init"];
  for (const [name, value] of Object.entries({
    REPO: config.repository,
    TOKEN: config.token,
    BASE_BRANCH: config.baseBranch,
    MANIFEST_PATH: config.manifestPath,
    OLD_VERSION: config.oldVersion,
    NEW_VERSION: config.newVersion,
    UPDATE_PR_BODY: config.updateBody,
    RUN_ACT: "0",
    KEEP_EMULATOR: "0",
  }))
    options.push("--env", `${name}=${value}`);
  if (config.mode === "smoke-test") {
    await execute("docker", ["run", "--rm", ...options, image]);
    return;
  }
  if (seed)
    options.push(
      "--volume",
      `${seed}:/run/emulator-seed:ro`,
      "--env",
      "SEED_FILE=/run/emulator-seed",
    );
  const container = await execute(
    "docker",
    ["run", "--detach", ...options, "--publish", "127.0.0.1::4001", image],
    { capture: true },
  );
  try {
    writeRunnerFile(environment.GITHUB_STATE, "container-id", container);
    const address = await execute("docker", ["port", container, "4001/tcp"], {
      capture: true,
    });
    const api = `http://${address}`;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await fetch(`${api}/repos/${config.repository}`, {
          headers: { Authorization: `Bearer ${config.token}` },
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* The server may still be starting. */
      }
      const running = await execute(
        "docker",
        ["inspect", "--format", "{{.State.Running}}", container],
        { capture: true },
      );
      if (running !== "true") break;
      await delay(1000);
    }
    if (!ready)
      throw new Error(
        "Emulator startup timed out; check the seed file, repository and token",
      );
    // The default server announces readiness only after its manifest is seeded.
    if (!seed) {
      let seeded = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const response = await fetch(
          `${api}/repos/${config.repository}/contents/${config.manifestPath}`,
          {
            headers: { Authorization: `Bearer ${config.token}` },
            signal: AbortSignal.timeout(2000),
          },
        );
        if (response.ok) {
          seeded = true;
          break;
        }
        await delay(1000);
      }
      if (!seeded) throw new Error("Default package manifest was not seeded");
    }
    for (const [name, value] of Object.entries({
      "api-url": api,
      token: config.token,
      repository: config.repository,
      "container-id": container,
    })) {
      writeRunnerFile(environment.GITHUB_OUTPUT, name, value);
    }
    if (config.exportEnv) {
      writeRunnerFile(environment.GITHUB_ENV, "GH_EMULATOR_API_URL", api);
      writeRunnerFile(
        environment.GITHUB_ENV,
        "GH_EMULATOR_TOKEN",
        config.token,
      );
    }
    console.log(`GitHub emulator ready: ${api}/repos/${config.repository}`);
    console.log(
      "Configure workflow clients with this API URL and the local token. Post-job cleanup is automatic.",
    );
  } catch (error) {
    await execute("docker", ["logs", container]).catch(() => {});
    await removeContainer(container).catch(() => {});
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
