#!/usr/bin/env bash
start_emulator_cli() (
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cli-common.sh"
local CLI_KIND CLI_NAME CLI_DIR CLI_ACTION CLI_VERBOSE=0
cli_prepare server "$(basename "${BASH_SOURCE[0]}")" "$@" || return $?
[[ "$CLI_ACTION" == run ]] || return 0
if [[ "$CLI_VERBOSE" == 1 ]]; then cli_config; fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMU_PORT="${EMU_PORT:-4001}"
REPO="${REPO:-moyarich/release-smoke-test}"
TOKEN="${TOKEN:-local-test-token}"
BASE_BRANCH="${BASE_BRANCH:-main}"
MANIFEST_PATH="${MANIFEST_PATH:-packages/core/package.json}"
OLD_VERSION="${OLD_VERSION:-1.0.0}"
RUN_DIR="$(mktemp -d)"
EMU_PID=""
cleanup() {
  if [[ -n "$EMU_PID" ]]; then
    kill "$EMU_PID" 2>/dev/null || true
    wait "$EMU_PID" 2>/dev/null || true
  fi
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT
trap 'exit 0' TERM INT

jq -n --arg owner "${REPO%%/*}" --arg name "${REPO#*/}" --arg token "$TOKEN" --arg branch "$BASE_BRANCH" \
  '{tokens:{($token):{login:$owner,scopes:["repo","user"]}},github:{users:[{login:$owner}],repos:[{owner:$owner,name:$name,auto_init:true,default_branch:$branch}]}}' > "$RUN_DIR/seed.json"

"$ROOT_DIR/node_modules/.bin/emulate" start --service github --port "$EMU_PORT" --host "${EMU_HOST:-0.0.0.0}" --seed "$RUN_DIR/seed.json" &
EMU_PID=$!

ready=0
for ((i=0; i<60; i++)); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$EMU_PORT/repos/$REPO" -H "Authorization: Bearer $TOKEN" 2>/dev/null; then
    ready=1
    break
  fi
  kill -0 "$EMU_PID" 2>/dev/null || { wait "$EMU_PID"; exit 1; }
  sleep 1
done
[[ "$ready" == 1 ]] || { echo 'Emulator startup timed out' >&2; exit 1; }

jq -n --arg branch "$BASE_BRANCH" \
  --arg content "$(jq -n --arg version "$OLD_VERSION" '{name:"@example/core",version:$version}' | base64 | tr -d '\n')" \
  '{message:"Seed test package",branch:$branch,content:$content}' > "$RUN_DIR/manifest.json"
curl -fsS -o /dev/null -X PUT "http://127.0.0.1:$EMU_PORT/repos/$REPO/contents/$MANIFEST_PATH" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary @"$RUN_DIR/manifest.json"
PUBLIC_API="${PUBLIC_API:-http://localhost:$EMU_PORT}"
printf '\nGitHub emulator ready\n'
printf '  API base URL: %s\n' "$PUBLIC_API"
printf '  Repository:   %s/repos/%s\n' "$PUBLIC_API" "$REPO"
printf '  [seeded repository endpoint](%s/repos/%s)\n' "$PUBLIC_API" "$REPO"
printf '  Package:      %s/repos/%s/contents/%s\n' "$PUBLIC_API" "$REPO" "$MANIFEST_PATH"
printf '  This is a GitHub API server with no homepage. GET / returns 404 Not Found.\n'
printf '  Authenticate requests with an Authorization: Bearer header.\n'
if [[ "$TOKEN" == "local-test-token" ]]; then
  printf "  Example: curl -H 'Authorization: Bearer local-test-token' %s/repos/%s\n" "$PUBLIC_API" "$REPO"
else
  printf '  Using your configured TOKEN (value omitted from logs).\n'
  printf '  Example: curl -H "Authorization: Bearer $TOKEN" %s/repos/%s\n' "$PUBLIC_API" "$REPO"
fi
printf '  From Docker containers on your Mac: http://host.docker.internal:%s\n' "${HOST_PORT:-$EMU_PORT}"
if [[ -n "${GH_HOST:-}" ]]; then
  printf '  HTTPS proxy (Compose): https://%s inside the Docker network.\n' "$GH_HOST"
  printf '  Use npm run docker:shell for configured gh API/search commands.\n'
fi
printf '  State is in memory and resets when the emulator restarts.\n\n'
wait "$EMU_PID"
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  start_emulator_cli "$@"
fi
