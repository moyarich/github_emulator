# Local emulator CLI

Install dependencies once with `npm ci` at the monorepo root. Commands below also run from that root. Requires Bash, Node.js 24+, curl, jq, and base64.

## Persistent server

```sh
bash scripts/start-emulator.sh --help
bash scripts/start-emulator.sh config
bash scripts/start-emulator.sh start
# Root command (passes the explicit action):
npm start
```

The server starts in the foreground, seeds a repository and package, and prints access instructions. Ctrl+C stops it; repository state resets on restart. It listens on all interfaces by default; use `EMU_HOST=127.0.0.1` to restrict local access. Keep a second terminal open for API commands.

```sh
EMU_HOST=127.0.0.1 EMU_PORT=4010 REPO=moyarich/demo \
  bash scripts/start-emulator.sh start
GH_TOKEN=local-test-token gh api http://localhost:4010/repos/moyarich/demo
```

Server environment: `EMU_PORT`, `EMU_HOST`, `REPO`, `TOKEN`, `BASE_BRANCH`, `MANIFEST_PATH`, `OLD_VERSION`, `PUBLIC_API`, `HOST_PORT`, and `GH_HOST`. `--help` lists defaults; `config` shows effective values without printing the token.

## Release smoke test

```sh
bash scripts/github_emulator.sh --help
bash scripts/github_emulator.sh config
NEW_VERSION=2.0.0 UPDATE_PR_BODY=1 \
  bash scripts/github_emulator.sh test
# Root command (passes the explicit action):
npm run test:emulator
```

This creates a branch, commits a package version, opens and optionally edits a PR, merges it, and verifies the resulting version. It modifies the repository selected by `API` and `REPO`. If a matching local server is already up, the test reuses it; otherwise it starts and seeds one, then stops that server on completion. Existing servers need the requested repository and manifest. Leave `RELEASE_BRANCH` unset for a fresh branch each time.

Additional test settings: `API`, `RELEASE_BRANCH`, `NEW_VERSION`, `UPDATE_PR_BODY`, `RUN_ACT`, `WORKFLOW_FILE`, `KEEP_EMULATOR`, and `EMU_LOG`. `KEEP_EMULATOR=1` leaves a test-owned server running. Temporary PR/event files are removed after the test; the emulator log remains at `EMU_LOG`.

For optional act replay, install act and run from the checkout containing the workflow:

```sh
RUN_ACT=1 WORKFLOW_FILE=/absolute/path/to/workflow.yml \
  bash /absolute/path/to/github_emulator/scripts/github_emulator.sh test
```

## Interactive fzf menu

Install fzf separately, then use a real terminal:

```sh
bash scripts/start-emulator.sh menu
bash scripts/github_emulator.sh --menu
```

Select start/test, help, docs, config, or exit. Escape/Ctrl+C cancels without starting anything. Menus are optional; every action has a direct command. Missing fzf or a non-interactive terminal produces an actionable error.

## Command behavior

No arguments opens the fzf menu in an interactive terminal when fzf is installed; otherwise it shows help. Starting work requires `start`, `test`, or `run`. Root `npm start` and `npm run test:emulator` pass explicit actions for automation. `help`, `--help`, and `-h` print usage; `docs` and `--docs` print this guide. Help/docs/config do not start a server, create temporary files, or need API credentials. Unknown commands, duplicate commands, unsupported options, missing values, and invalid ports/repository names exit with status 2. Runtime errors exit nonzero.

Both entry points source `scripts/cli-common.sh` only when invoked, and use functions with case-based dispatch. Flag/value pairs are processed with a while loop and `shift 2`; switches use `shift`. Keep that helper beside the scripts when moving them.

## Docker

Docker server startup is independently defined in `docker/Dockerfile`; it does not call the local CLI scripts. Use `npm run docker:up`, `npm run docker:shell`, and `npm run docker:down`. The separate smoke-test image defines its runtime in the Dockerfile too. Run it with `npm run docker:test`. Local scripts and this guide are excluded from Docker builds.

For proxy trust, gh usage, and Compose settings, see the monorepo README.

## Multiple flags and scoped execution

Commands and options can appear in either order. Flags override environment settings for that invocation only:

```sh
bash scripts/start-emulator.sh start --host 127.0.0.1 --port 4010 --repo moya/demo
bash scripts/start-emulator.sh config --port 4010 --base-branch develop
bash scripts/github_emulator.sh test --port 4011 --new-version 2.0.0 --update-pr-body --verbose
bash scripts/github_emulator.sh --new-version 2.0.0 config
```

Common value flags: `--repo`, `--token`, `--port`, `--host`, `--base-branch`, `--manifest-path`, and `--old-version`. Server value flags: `--public-api`, `--host-port`, `--gh-host`. Test value flags: `--api`, `--release-branch`, `--new-version`, `--workflow-file`, `--log`. Test switches: `--update-pr-body`, `--run-act`, `--keep-emulator`. `--verbose` / `-v` prints redacted configuration before starting work; it does not enable shell tracing.

Source either script to define its entry function without starting work:

```sh
source scripts/start-emulator.sh
start_emulator_cli config --repo moya/demo
source scripts/github_emulator.sh
release_smoke_cli config --new-version 2.0.0
```

Each entry function runs in a subshell so its variables, exports, strict shell settings, traps, and helper definitions do not leak into your calling shell. Parsing and validation happen before temporary files, processes, or API changes. Startup, seeding, and smoke tests still have their documented effects when explicitly requested. `config` and `--verbose` hide the token; use the `TOKEN` environment variable to avoid putting tokens in shell history as flag values.
