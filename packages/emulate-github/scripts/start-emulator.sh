#!/usr/bin/env bash
# emulator_step <color> <number> <title>
emulator_step() {
  local color=$1 num=$2 title=$3
  printf '\n%s%s━━━ Step %s: %s ━━━%s\n' "$BOLD" "$color" "$num" "$title" "$RESET"
}
emulator_info() { printf '%s  ➜ %s%s\n' "$GRAY" "$*" "$RESET"; }
emulator_ok()   { printf '%s  ✔ %s%s\n' "$GREEN" "$*" "$RESET"; }
emulator_warn() { printf '%s  ⚠ %s%s\n' "$YELLOW" "$*" "$RESET"; }
emulator_fail() { printf '%s  ✘ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }


# -----------------------------------------------------------------------------
# Utilities
# -----------------------------------------------------------------------------

emulator_die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

# -----------------------------------------------------------------------------
# Pure functions: values and configuration
# -----------------------------------------------------------------------------

emulator_resolve_secrets_path() {
  local run_dir="$1"
  printf '%s\n' "${GENERATED_SECRETS_FILE:-$run_dir/.emulate-secrets.json}"
}

emulator_resolve_base_url() {
  if [[ -n "${EMULATE_BASE_URL:-}" ]]; then
    printf '%s\n' "$EMULATE_BASE_URL"
  elif [[ "${USE_PORTLESS:-0}" == 1 ]]; then
    printf '%s\n' 'https://github.emulate.localhost'
  else
    printf '%s\n' "${EMULATOR_PUBLIC_URL:-http://localhost:$EMULATE_PORT}"
  fi
}

emulator_generate_package_json() {
  jq -n \
    --arg version "$OLD_VERSION" \
    '{
      name: "@example/core",
      version: $version
    }'
}

emulator_generate_package_request() {
  local content

  content="$(emulator_generate_package_json | base64 | tr -d '\n')"

  jq -n \
    --arg branch "$BASE_BRANCH" \
    --arg content "$content" \
    '{
      message: "Seed test package",
      branch: $branch,
      content: $content
    }'
}

# -----------------------------------------------------------------------------
# Filesystem operations
# -----------------------------------------------------------------------------

emulator_prepare_seed() {
  local seed_path="$1" template="$2"
  if [[ -n "$SEED_SOURCE" ]]; then
    [[ -f "$SEED_SOURCE" ]] || emulator_die "Seed file not found: $SEED_SOURCE"
    cp -- "$SEED_SOURCE" "$seed_path"
    return
  fi
  if [[ ! -f "$template" ]]; then
    (cd "$(dirname "$seed_path")" && emulate init --service github)
    template="$seed_path"
  fi
  env REPO="$REPO" TOKEN="$TOKEN" BASE_BRANCH="$BASE_BRANCH" node - "$template" "$seed_path" <<'JS'
const fs = require('node:fs');
const YAML = require('yaml');
const [source, destination] = process.argv.slice(2);
const [owner, name] = process.env.REPO.split('/', 2);
const config = YAML.parse(fs.readFileSync(source, 'utf8')) ?? {};
config.tokens ??= {};
config.tokens[process.env.TOKEN] = {login: owner, scopes: ['repo', 'user']};
config.github ??= {};
config.github.users ??= [];
if (!config.github.users.some(user => user.login === owner)) {
  config.github.users.push({login: owner});
}
config.github.repos ??= [];
let repo = config.github.repos.find(repo => repo.owner === owner && repo.name === name);
if (!repo) {
  repo = {owner, name, auto_init: true};
  config.github.repos.push(repo);
}
repo.default_branch = process.env.BASE_BRANCH;
fs.writeFileSync(destination, YAML.stringify(config));
JS
}

# -----------------------------------------------------------------------------
# GitHub API operations
# -----------------------------------------------------------------------------

emulator_api() {
  local method="$1"
  local path="$2"
  shift 2

  curl -fsS --max-time 2 -o /dev/null \
    -X "$method" \
    -H "Authorization: Bearer $TOKEN" \
    "${GITHUB_EMULATOR_URL:-${API:-http://127.0.0.1:${EMULATE_PORT:-4001}}}${path}" \
    "$@"
}

emulator_bootstrap_repository() {
  [[ "${BOOTSTRAP_REPOSITORY:-1}" == 1 ]] || return 0
  [[ -z "$SEED_SOURCE" ]] || return 0

  emulator_generate_package_request |
    emulator_api PUT "/repos/$REPO/contents/$MANIFEST_PATH" \
      -H 'Content-Type: application/json' \
      --data-binary @-
}

# -----------------------------------------------------------------------------
# Emulator lifecycle
# -----------------------------------------------------------------------------
# npx emulate start --service github --portless --generated-secrets-file .emulate-secrets.json

# ----------------------------------------------------------------------------
# Step 1: Start the GitHub emulator
# ----------------------------------------------------------------------------
emulator_is_up() { curl -fsS -o /dev/null --max-time 2 "${GITHUB_EMULATOR_URL:-${API:-http://127.0.0.1:${EMULATE_PORT:-4001}}}/repos/$REPO" -H "Authorization: Bearer $TOKEN" 2>/dev/null; }

emulator_start_emulator() {
  local seed_path="$1"
  local secrets_path="$2"

  local -a args=(
    --service github
    --port "$EMULATE_PORT"
    --host "$EMU_HOST"
    --generated-secrets-file "$secrets_path"
  )

  if [[ "${USE_PORTLESS:-0}" == 1 ]]; then
    portless proxy start >&2
    args+=(--portless)
  fi

  cd -- "$(dirname -- "$seed_path")"
  exec emulate start "${args[@]}"
}

emulator_wait_for_emulator() {
  local pid="$1"
  local attempt

  for ((attempt = 0; attempt < 60; attempt++)); do
    if emulator_api GET "/repos/$REPO" 2>/dev/null; then
      return 0
    fi

    if ! kill -0 "$pid" 2>/dev/null; then
      printf 'Emulator exited before becoming ready\n' >&2
      return 1
    fi

    sleep 1
  done

  printf 'Emulator startup timed out\n' >&2
  return 1
}

emulator_cleanup() {
  local pid="$1"
  local run_dir="$2"

  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi

  if [[ -n "$run_dir" ]]; then
    rm -rf -- "$run_dir"
  fi
}

# -----------------------------------------------------------------------------
# Presentation
# -----------------------------------------------------------------------------

emulator_print_auth_instructions() {
  local base_url="$1"

  printf '  Authenticate requests with an Authorization: Bearer header.\n'

  if [[ "$TOKEN" == 'local-test-token' ]]; then
    printf "  Example: curl -H 'Authorization: Bearer local-test-token' %s/repos/%s\n" \
      "$base_url" "$REPO"
  else
    printf '  Using your configured TOKEN (value omitted from logs).\n'
    printf '  Example: curl -H "Authorization: Bearer $TOKEN" %s/repos/%s\n' \
      "$base_url" "$REPO"
  fi
}

emulator_print_docker_instructions() {
  printf '  From Docker containers on your Mac: http://host.docker.internal:%s\n' \
    "${EMULATOR_PORT:-$EMULATE_PORT}"

  if [[ -n "${GH_HOST:-}" ]]; then
    printf '  HTTPS proxy (Compose): https://%s inside the Docker network.\n' \
      "$GH_HOST"
    printf '  Use npm run docker:shell for configured gh API/search commands.\n'
  fi
}

emulator_print_banner() {
  local base_url="$1"

  printf '\nGitHub emulator ready\n'
  printf '  API base URL: %s\n' "$base_url"
  printf '  Repository:   %s/repos/%s\n' "$base_url" "$REPO"

  if [[ -z "$SEED_SOURCE" && "${BOOTSTRAP_REPOSITORY:-1}" == 1 ]]; then
    printf '  Package:      %s/repos/%s/contents/%s\n' \
      "$base_url" "$REPO" "$MANIFEST_PATH"
  else
    printf '  Release fixture bootstrap skipped.\n'
  fi

  printf '  This is a GitHub API server with no homepage. GET / returns 404 Not Found.\n'

  emulator_print_auth_instructions "$base_url"
  emulator_print_docker_instructions

  printf '  State is in memory and resets when the emulator restarts.\n\n'
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

# Shared files contain literal KEY=value assignments, not executable shell code.
emulator_read_env() {
  python3 - "$1" "$2" <<'PYTHON'
import re
import shlex
import sys
from pathlib import Path

source, destination = map(Path, sys.argv[1:])
allowed = set("REPO TOKEN BASE_BRANCH CONFIG_FILE SEED_FILE MANIFEST_PATH OLD_VERSION EMULATE_BASE_URL EMULATOR_PUBLIC_URL BOOTSTRAP_REPOSITORY EMULATE_PORT EMU_HOST USE_PORTLESS GENERATED_SECRETS_FILE".split())
lines = []
for number, line in enumerate(source.read_text().splitlines() if sys.argv[1] and source.exists() else [], 1):
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("export "):
        line = line[7:].strip()
    key, separator, raw = line.partition("=")
    key = key.strip()
    if not separator or key not in allowed:
        raise SystemExit(f"Invalid configuration key at line {number}: {key}")
    value = shlex.split(raw, comments=True)
    if len(value) > 1:
        raise SystemExit(f"Quote values containing spaces at line {number}")
    lines.append(f"export {key}={shlex.quote(value[0] if value else '')}")
destination.write_text("\n".join(lines) + "\n")
PYTHON
}

emulator_validate_seed() {
  local seed_path="$1" secrets_path="$2"
  [[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && -n "$TOKEN" ]] || return 1
  git check-ref-format "refs/heads/$BASE_BRANCH" >/dev/null || return 1
  [[ ! -e "$secrets_path" ]] || { printf 'Generated secrets destination already exists\n' >&2; return 1; }
  env REPO="$REPO" TOKEN="$TOKEN" node - "$seed_path" <<'JS' > "$seed_path.json"
const fs = require('node:fs');
const YAML = require('yaml');
const config = YAML.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!config || typeof config !== 'object') throw new Error('Invalid YAML seed');
const [owner, name] = process.env.REPO.split('/', 2);
if (!Object.hasOwn(config.tokens ?? {}, process.env.TOKEN)) {
  throw new Error('Seed must contain the configured TOKEN');
}
if (!(config.github?.repos ?? []).some(repo => repo.owner === owner && repo.name === name)) {
  throw new Error('Seed must contain the configured REPO');
}
process.stdout.write(JSON.stringify(config));
JS
  node --input-type=module - "$(command -v emulate)" "$seed_path.json" <<'JS'
import {readFileSync, realpathSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {pathToFileURL} from "node:url";
const {createEmulator} = await import(pathToFileURL(resolve(dirname(realpathSync(process.argv[2])), "api.js")).href);
const instance = await createEmulator({service: "github", port: 0, hostname: "127.0.0.1", seed: JSON.parse(readFileSync(process.argv[3], "utf8"))});
await instance.close();
JS
}

emulator_reload() (
  set -euo pipefail
  local control="${EMULATOR_CONTROL_DIR:-/tmp/github-emulator-control-${EMULATE_PORT:-4001}}"
  [[ -f "$control/pid" ]] || emulator_die "No supervised emulator is running"
  mkdir "$control/reload.lock" 2>/dev/null || emulator_die "Another reload is already in progress"
  trap 'rmdir "$control/reload.lock" 2>/dev/null || true' EXIT
  local pid previous serial result attempt
  pid="$(cat "$control/pid")"
  read -r previous result < "$control/status"
  kill -HUP "$pid"
  for ((attempt=0; attempt<450; attempt++)); do
    if [[ -f "$control/status" ]]; then
      read -r serial result < "$control/status"
      if [[ "$serial" != "$previous" ]]; then
        [[ "$result" == success ]] || emulator_die "Reload rejected; the existing emulator is unchanged. Check container logs."
        printf 'Configuration reloaded; in-memory state reset.\n'
        return
      fi
    fi
    kill -0 "$pid" 2>/dev/null || emulator_die "Emulator supervisor stopped during reload"
    sleep 0.2
  done
  emulator_die "Timed out waiting for configuration reload"
)

emulator_main() {
  set -euo pipefail
  local EMULATE_PORT="${EMULATE_PORT:-4001}" TOKEN="${TOKEN:-local-test-token}"
  local USE_PORTLESS="${USE_PORTLESS:-0}" EMU_HOST="${EMU_HOST:-0.0.0.0}"
  local REPO="${REPO:-moyarich/release-smoke-test}" BASE_BRANCH="${BASE_BRANCH:-main}"
  local MANIFEST_PATH="${MANIFEST_PATH:-packages/core/package.json}" OLD_VERSION="${OLD_VERSION:-1.0.0}"
  local CONFIG_FILE="${CONFIG_FILE:-}" SEED_FILE="${SEED_FILE:-}" SEED_SOURCE=""
  local EMULATE_BASE_URL="${EMULATE_BASE_URL:-}" EMULATOR_PUBLIC_URL="${EMULATOR_PUBLIC_URL:-}"
  local BOOTSTRAP_REPOSITORY="${BOOTSTRAP_REPOSITORY:-1}" GENERATED_SECRETS_FILE="${GENERATED_SECRETS_FILE:-}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      start) shift ;;
      --portless) USE_PORTLESS=1; shift ;;
      -h|--help)
        printf 'Usage: start-emulator.sh [start | reload] [--portless]\nConfiguration: REPO TOKEN EMULATE_PORT CONFIG_FILE SEED_FILE EMULATE_BASE_URL EMULATOR_ENV_FILE\n'
        return ;;
      *) emulator_die "Unknown option: $1" ;;
    esac
  done
  local GITHUB_EMULATOR_URL="${GITHUB_EMULATOR_URL:-http://127.0.0.1:$EMULATE_PORT}"
  local RESET="" BOLD="" RED="" GREEN="" YELLOW="" BLUE="" MAGENTA="" CYAN="" GRAY=""
  local run_dir="" seed_path secrets_path base_url emu_pid="" exit_code=0
  local template="$PWD/emulate.config.yaml" reload_requested=0 serial=0 generation=0
  local env_file="${EMULATOR_ENV_FILE:-}" candidate_dir candidate_env key
  local control="${EMULATOR_CONTROL_DIR:-/tmp/github-emulator-control-$EMULATE_PORT}"
  for command in emulate curl jq python3 git node; do
    command -v "$command" >/dev/null || emulator_die "Missing command: $command (run through npm start or the Docker image)"
  done
  run_dir="$(mktemp -d "${TMPDIR:-/tmp}/github-emulator.XXXXXX")"
  trap 'emulator_cleanup "$emu_pid" "$run_dir"; if [[ -f "$control/pid" && "$(cat "$control/pid")" == "$$" ]]; then rm -rf "$control"; fi' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'reload_requested=1' HUP
  for key in REPO TOKEN BASE_BRANCH CONFIG_FILE SEED_FILE MANIFEST_PATH OLD_VERSION EMULATE_BASE_URL EMULATOR_PUBLIC_URL BOOTSTRAP_REPOSITORY EMULATE_PORT EMU_HOST USE_PORTLESS GENERATED_SECRETS_FILE; do
    printf '%s=%q\n' "$key" "${!key}" >> "$run_dir/base.env"
  done
  touch "$run_dir/active.env"
  local network_port="$EMULATE_PORT" network_host="$EMU_HOST" network_portless="$USE_PORTLESS"
  while :; do
    generation=$((generation + 1))
    candidate_dir="$run_dir/generation.$generation"
    mkdir -p "$candidate_dir"
    candidate_env="$candidate_dir/runtime.env"
    # Normalize before sourcing so malformed files cannot execute shell commands.
    if ! emulator_read_env "$env_file" "$candidate_env"; then
      [[ "$generation" != 1 ]] || return 1
      printf 'Reload rejected: invalid environment file\n' >&2
    else
      source "$run_dir/base.env"
      source "$candidate_env"
      SEED_SOURCE="${CONFIG_FILE:-${SEED_FILE:-}}"
      seed_path="$candidate_dir/emulate.config.yaml"
      secrets_path="${GENERATED_SECRETS_FILE:-$candidate_dir/.emulate-secrets.json}"
      [[ "$secrets_path" == /* ]] || secrets_path="$PWD/$secrets_path"
      export EMULATE_BASE_URL
      if [[ "$EMULATE_PORT" == "$network_port" && "$EMU_HOST" == "$network_host" && "$USE_PORTLESS" == "$network_portless" ]] &&
        (emulator_prepare_seed "$seed_path" "$template" && emulator_validate_seed "$seed_path" "$secrets_path"); then
        if [[ -n "$emu_pid" ]]; then
          kill "$emu_pid" 2>/dev/null || true
          wait "$emu_pid" 2>/dev/null || true
        elif emulator_is_up; then
          emulator_warn "Emulator already responding at $GITHUB_EMULATOR_URL; reusing it without reload supervision"
          emulator_cleanup "" "$run_dir"
          trap - EXIT INT TERM HUP
          return
        fi
        cp "$candidate_env" "$run_dir/active.env"
        emulator_start_emulator "$seed_path" "$secrets_path" &
        emu_pid=$!
        emulator_wait_for_emulator "$emu_pid"
        emulator_bootstrap_repository
        base_url="$(emulator_resolve_base_url)"
        emulator_print_banner "$base_url"
        mkdir -p "$control"
        chmod 700 "$control"
        printf '%s\n' "$$" > "$control/pid"
        printf 'GITHUB_EMULATOR_URL=%q\nREPO=%q\nTOKEN=%q\n' "$GITHUB_EMULATOR_URL" "$REPO" "$TOKEN" > "$control/health.env.tmp"
        chmod 600 "$control/health.env.tmp"
        mv "$control/health.env.tmp" "$control/health.env"
        printf '%s success\n' "$serial" > "$control/status.tmp"
        mv "$control/status.tmp" "$control/status"
      else
        [[ "$generation" != 1 ]] || return 1
        printf 'Reload rejected: invalid seed or network changes require a container restart\n' >&2
      fi
    fi
    source "$run_dir/base.env"
    source "$run_dir/active.env"
    SEED_SOURCE="${CONFIG_FILE:-${SEED_FILE:-}}"
    if [[ "$generation" != 1 && "$(head -n 1 "$control/status" | cut -d ' ' -f 1)" != "$serial" ]]; then
      printf '%s rejected\n' "$serial" > "$control/status.tmp"
      mv "$control/status.tmp" "$control/status"
    fi
    reload_requested=0
    exit_code=0
    wait "$emu_pid" || exit_code=$?
    if [[ "$reload_requested" == 1 ]]; then
      serial=$((serial + 1))
      continue
    fi
    break
  done
  emulator_cleanup "$emu_pid" "$run_dir"
  rm -rf "$control"
  trap - EXIT INT TERM HUP
  return "$exit_code"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [[ "${1:-}" == reload ]]; then
    shift
    [[ $# == 0 ]] || emulator_die "reload does not accept arguments; edit EMULATOR_ENV_FILE instead"
    emulator_reload
  else
    emulator_main "$@"
  fi
fi
