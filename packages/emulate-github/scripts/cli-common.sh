#!/usr/bin/env bash
# Shared CLI helpers; sourced by the local entry-point scripts.

cli_usage() {
  local action
  case "$CLI_KIND" in
    server) action=start ;;
    smoke-test) action=test ;;
  esac
  cat <<USAGE
Usage: bash $CLI_NAME [$action|help|docs|config|menu] [options]

Commands:
  $action     $(if [[ "$CLI_KIND" == server ]]; then printf 'Start the persistent GitHub API server'; else printf 'Run the release PR smoke test'; fi)
  help      Show usage and environment settings (--help, -h)
  docs      Print the full CLI guide (--docs)
  config    Show effective settings, without revealing the token
  menu      Choose a command interactively with fzf (--menu)

Options (override environment settings):
  --repo OWNER/NAME     --token VALUE          --port PORT
  --host ADDRESS        --base-branch NAME     --manifest-path PATH
  --old-version VERSION --verbose, -v
$(if [[ "$CLI_KIND" == server ]]; then
  printf '  --public-api URL      --host-port PORT       --gh-host HOST\n  --portless            Use emulate native Portless HTTPS integration'
else
  printf '  --api URL             --release-branch NAME  --new-version VERSION\n  --workflow-file PATH  --log PATH\n  --update-pr-body      --run-act               --keep-emulator'
fi)

Environment:
  REPO           Repository owner/name (moyarich/release-smoke-test)
  TOKEN          Local API token (local-test-token); never shown by config
  EMU_PORT       Local API port (4001)
  EMU_HOST       Listen address ($(if [[ "$CLI_KIND" == server ]]; then printf 0.0.0.0; else printf 127.0.0.1; fi))
  BASE_BRANCH    Base branch (main)
  MANIFEST_PATH  Package file (packages/core/package.json)
  OLD_VERSION    Seed/expected package version (1.0.0)
USAGE
  if [[ "$CLI_KIND" == smoke-test ]]; then
    cat <<'USAGE'
  API            Existing API URL (http://localhost:$EMU_PORT)
  RELEASE_BRANCH Release branch (automatically generated if empty)
  NEW_VERSION    Target package version (1.1.0)
  UPDATE_PR_BODY Set to 1 to append a version note (0)
  RUN_ACT        Set to 1 to replay the merged-PR event with act (0)
  WORKFLOW_FILE  Workflow path (.github/workflows/release-approved-pr.yml)
  KEEP_EMULATOR  Set to 1 to keep a server started by this test (0)
  EMU_LOG        Server log file (/tmp/emulate-github.log)
USAGE
  else
    cat <<'USAGE'
  PUBLIC_API     URL advertised in logs (http://localhost:$EMU_PORT)
  HOST_PORT      Mac-facing port advertised in logs ($EMU_PORT)
  GH_HOST        Optional HTTPS proxy hostname advertised in logs
USAGE
  fi
  printf '\nRequirements: Node.js 24+, npm install in this package (or npm ci at workspace root), curl, jq, base64.\n'
  printf 'Optional: fzf for menu; act and Docker for workflow replay.\n'
  printf '\nNo command: open fzf in a terminal if available; otherwise show help.\n'
  printf '\nExamples:\n  bash %s --help\n  bash %s menu\n' "$CLI_NAME" "$CLI_NAME"
  if [[ "$CLI_KIND" == server ]]; then
    printf '  EMU_PORT=4010 bash %s start\n' "$CLI_NAME"
    printf '\nRuns in the foreground; Ctrl+C stops it. State resets on restart.\n'
  else
    printf '  NEW_VERSION=2.0.0 UPDATE_PR_BODY=1 bash %s test\n' "$CLI_NAME"
    printf '\nCreates and merges a PR; changes the target repository package version.\n'
  fi
}

cli_config() {
  printf 'Mode: %s\nRepository: %s\nAPI: %s\nListen host: %s\nBase branch: %s\nManifest: %s\nInitial/expected version: %s\nToken: [hidden]\n' \
    "$CLI_KIND" "${REPO:-moyarich/release-smoke-test}" \
    "${API:-http://localhost:${EMU_PORT:-4001}}" \
    "${EMU_HOST:-$(if [[ "$CLI_KIND" == server ]]; then printf 0.0.0.0; else printf 127.0.0.1; fi)}" \
    "${BASE_BRANCH:-main}" "${MANIFEST_PATH:-packages/core/package.json}" "${OLD_VERSION:-1.0.0}"
  if [[ "$CLI_KIND" == smoke-test ]]; then
    printf 'Release branch: %s\nTarget version: %s\nUpdate PR body: %s\nRun act: %s\nWorkflow: %s\nKeep emulator: %s\nLog file: %s\n' \
      "${RELEASE_BRANCH:-[generated per run]}" "${NEW_VERSION:-1.1.0}" "${UPDATE_PR_BODY:-0}" \
      "${RUN_ACT:-0}" "${WORKFLOW_FILE:-.github/workflows/release-approved-pr.yml}" \
      "${KEEP_EMULATOR:-0}" "${EMU_LOG:-/tmp/emulate-github.log}"
  else
    printf 'Public API: %s\nHost port: %s\nHTTPS host: %s\n' \
      "${PUBLIC_API:-http://localhost:${EMU_PORT:-4001}}" "${HOST_PORT:-${EMU_PORT:-4001}}" "${GH_HOST:-[not configured]}"
  fi
}

cli_menu() {
  command -v fzf >/dev/null 2>&1 || { printf 'menu requires fzf; use --help.\n' >&2; return 2; }
  [[ -t 0 && -t 1 ]] || { printf 'menu requires an interactive terminal.\n' >&2; return 2; }
  local action selection
  case "$CLI_KIND" in server) action=start ;; smoke-test) action=test ;; esac
  selection=$(printf '%s\n' "$action" help docs config exit | fzf --prompt="$CLI_NAME > " --height=40% --reverse) || return 0
  case "$selection" in exit|'') return 0 ;; *) cli_dispatch "$selection" ;; esac
}

cli_dispatch() {
  case "$1" in
    run) CLI_ACTION=run ;;
    start) [[ "$CLI_KIND" == server ]] || { printf 'Use test for this script.\n' >&2; return 2; }; CLI_ACTION=run ;;
    test) [[ "$CLI_KIND" == smoke-test ]] || { printf 'Use start for this script.\n' >&2; return 2; }; CLI_ACTION=run ;;
    help|--help|-h) cli_usage ;;
    config) cli_config ;;
    docs|--docs) cat "$CLI_DIR/../docs/cli.md" ;;
    menu|--menu) cli_menu ;;
    *) printf 'Unknown command: %s. Use --help.\n' "$1" >&2; return 2 ;;
  esac
}

# Flag/value pairs consume two arguments; switches consume one. Validate the
# complete request before dispatch so errors cannot start or mutate a server.
cli_prepare() {
  CLI_KIND=$1
  CLI_NAME=$2
  shift 2
  CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  CLI_ACTION=stop
  local command='' option variable value
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo|--token|--port|--host|--base-branch|--manifest-path|--old-version|--public-api|--host-port|--gh-host|--api|--release-branch|--new-version|--workflow-file|--log)
        option=$1
        [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || { printf 'Missing value for %s.\n' "$option" >&2; return 2; }
        value=$2
        case "$option" in
          --repo) variable=REPO ;;
          --token) variable=TOKEN ;;
          --port) variable=EMU_PORT ;;
          --host) variable=EMU_HOST ;;
          --base-branch) variable=BASE_BRANCH ;;
          --manifest-path) variable=MANIFEST_PATH ;;
          --old-version) variable=OLD_VERSION ;;
          --public-api) variable=PUBLIC_API ;;
          --host-port) variable=HOST_PORT ;;
          --gh-host) variable=GH_HOST ;;
          --api) variable=API ;;
          --release-branch) variable=RELEASE_BRANCH ;;
          --new-version) variable=NEW_VERSION ;;
          --workflow-file) variable=WORKFLOW_FILE ;;
          --log) variable=EMU_LOG ;;
        esac
        case "$option" in
          --public-api|--host-port|--gh-host) [[ "$CLI_KIND" == server ]] || { printf '%s is a server option.\n' "$option" >&2; return 2; } ;;
          --api|--release-branch|--new-version|--workflow-file|--log) [[ "$CLI_KIND" == smoke-test ]] || { printf '%s is a test option.\n' "$option" >&2; return 2; } ;;
        esac
        case "$option" in
          --port|--host-port) [[ "$value" =~ ^[0-9]{1,5}$ ]] && ((10#$value >= 1 && 10#$value <= 65535)) || { printf '%s must be a port from 1 to 65535.\n' "$option" >&2; return 2; } ;;
          --repo) [[ "$value" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { printf 'Repository must be owner/name.\n' >&2; return 2; } ;;
          --api|--public-api) [[ "$value" == http://* || "$value" == https://* ]] || { printf '%s requires an HTTP(S) URL.\n' "$option" >&2; return 2; } ;;
        esac
        printf -v "$variable" '%s' "$value"
        shift 2
        ;;
      --update-pr-body|--run-act|--keep-emulator)
        [[ "$CLI_KIND" == smoke-test ]] || { printf '%s is a test option.\n' "$1" >&2; return 2; }
        case "$1" in --update-pr-body) UPDATE_PR_BODY=1 ;; --run-act) RUN_ACT=1 ;; --keep-emulator) KEEP_EMULATOR=1 ;; esac
        shift
        ;;
      --portless)
        [[ "$CLI_KIND" == server ]] || { printf '%s is a server option.\n' "$1" >&2; return 2; }
        USE_PORTLESS=1
        shift
        ;;
      --verbose|-v) CLI_VERBOSE=1; shift ;;
      start|test|run|help|--help|-h|docs|--docs|config|menu|--menu)
        [[ -z "$command" ]] || { printf 'Specify only one command.\n' >&2; return 2; }
        command=$1
        shift
        ;;
      *) printf 'Unknown argument: %s. Use --help.\n' "$1" >&2; return 2 ;;
    esac
  done
  if [[ -z "$command" ]]; then
    if [[ -t 0 && -t 1 ]] && command -v fzf >/dev/null 2>&1; then command=menu; else command=help; fi
  fi
  cli_dispatch "$command"
}

# Resolve the declared package dependency through Node, including npm workspace
# hoisting. No filesystem path outside this workspace is assumed.
cli_emulate_bin() (
  cd "$1" || return 1
  local executable
  executable=$(node --input-type=module -e '
    import { fileURLToPath } from "node:url";
    console.log(fileURLToPath(new URL("./index.js", import.meta.resolve("emulate"))));
  ') || { printf 'Install dependencies in this package with npm install first.\n' >&2; return 1; }
  [[ -f "$executable" ]] || { printf 'emulate CLI is missing; reinstall package dependencies.\n' >&2; return 1; }
  printf '%s\n' "$executable"
)
