#!/usr/bin/env bash
#
# github_emulator.sh
#
# Drives a full "release PR" scenario against the local GitHub emulator:
#   1. start emulator          5. merge PR
#   2. create release branch   6. verify merged state
#   3. open PR                 7. (optional) replay the merged-PR event through nektos/act
#   4. modify PR branch
#
# Overridable via environment variables, e.g.:
#   NEW_VERSION=2.0.0 RUN_ACT=1 ./scripts/github_emulator.sh

release_smoke_cli() (
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cli-common.sh"
local CLI_KIND CLI_NAME CLI_DIR CLI_ACTION CLI_VERBOSE=0
cli_prepare smoke-test "$(basename "${BASH_SOURCE[0]}")" "$@" || return $?
[[ "$CLI_ACTION" == run ]] || return 0
if [[ "$CLI_VERBOSE" == 1 ]]; then cli_config; fi

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EMU_PORT="${EMU_PORT:-4001}"
export API="${API:-http://localhost:$EMU_PORT}"
export REPO="${REPO:-moyarich/release-smoke-test}"   # seeded in the emulator
export TOKEN="${TOKEN:-local-test-token}"

BASE_BRANCH="${BASE_BRANCH:-main}"
RELEASE_BRANCH="${RELEASE_BRANCH:-release/prepare-$(date +%s)-$$}"
MANIFEST_PATH="${MANIFEST_PATH:-packages/core/package.json}"
OLD_VERSION="${OLD_VERSION:-1.0.0}"
NEW_VERSION="${NEW_VERSION:-1.1.0}"

UPDATE_PR_BODY="${UPDATE_PR_BODY:-0}"   # 1 = also PATCH the PR description
RUN_ACT="${RUN_ACT:-0}"                 # 1 = run the workflow through nektos/act
WORKFLOW_FILE="${WORKFLOW_FILE:-.github/workflows/smoke-test_release-approved-pr.yml}"
KEEP_EMULATOR="${KEEP_EMULATOR:-0}"     # 1 = leave emulator running afterwards

EMU_LOG="${EMU_LOG:-/tmp/emulate-github.log}"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/github-emulator.XXXXXX")"
PR_JSON_FILE="$RUN_DIR/release-pr.json"
EVENT_FILE="$RUN_DIR/merged-pr-event.json"

PR_NUMBER=""
EMU_PID=""

# ----------------------------------------------------------------------------
# Colors & logging helpers
# ----------------------------------------------------------------------------
if [[ -t 1 ]]; then
  RESET=$'\033[0m';  BOLD=$'\033[1m'
  RED=$'\033[31m';   GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  BLUE=$'\033[34m';  MAGENTA=$'\033[35m'; CYAN=$'\033[36m'; GRAY=$'\033[90m'
else
  RESET=""; BOLD=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; MAGENTA=""; CYAN=""; GRAY=""
fi

# step <color> <number> <title>
step() {
  local color=$1 num=$2 title=$3
  printf '\n%s%s━━━ Step %s: %s ━━━%s\n' "$BOLD" "$color" "$num" "$title" "$RESET"
}
info() { printf '%s  ➜ %s%s\n' "$GRAY" "$*" "$RESET"; }
ok()   { printf '%s  ✔ %s%s\n' "$GREEN" "$*" "$RESET"; }
warn() { printf '%s  ⚠ %s%s\n' "$YELLOW" "$*" "$RESET"; }
fail() { printf '%s  ✘ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

# ----------------------------------------------------------------------------
# Utilities
# ----------------------------------------------------------------------------
require_cmds() {
  local missing=()
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
  ((${#missing[@]} == 0)) || fail "Missing required command(s): ${missing[*]}"
}

# api <METHOD> <PATH> [extra curl args...]
api() {
  local method=$1 path=$2; shift 2
  curl -fsS -X "$method" "$API$path" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "$@"
}

# api_json <METHOD> <PATH> <JSON body>
api_json() {
  local method=$1 path=$2 body=$3
  api "$method" "$path" -H "Content-Type: application/json" -d "$body"
}

b64_encode() { base64 | tr -d '\n'; }
b64_decode() { tr -d '\n' | base64 --decode; }

cleanup() {
  if [[ -n "$EMU_PID" && "$KEEP_EMULATOR" != "1" ]]; then
    printf '\n%s  ➜ Stopping emulator (pid %s)%s\n' "$GRAY" "$EMU_PID" "$RESET"
    kill "$EMU_PID" 2>/dev/null || true
    wait "$EMU_PID" 2>/dev/null || true
  fi
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT

# ----------------------------------------------------------------------------
# Step 1: Start the GitHub emulator
# ----------------------------------------------------------------------------
emulator_is_up() { curl -fsS -o /dev/null --max-time 2 "$API/repos/$REPO" -H "Authorization: Bearer $TOKEN" 2>/dev/null; }

start_emulator() {
  step "$BLUE" 1 "Start the GitHub emulator"

  if emulator_is_up; then
    warn "Emulator already responding at $API; reusing it"
    return
  fi

  local EMULATE_BIN
  EMULATE_BIN="$(cli_emulate_bin "$PACKAGE_DIR")" || return $?
  [[ "$API" == "http://localhost:$EMU_PORT" || "$API" == "http://127.0.0.1:$EMU_PORT" ]] || fail "No repository found at external API $API; start and seed that emulator first"
  jq -n --arg owner "${REPO%%/*}" --arg name "${REPO#*/}" --arg token "$TOKEN" --arg branch "$BASE_BRANCH" \
    '{tokens:{($token):{login:$owner,scopes:["repo","user"]}},github:{users:[{login:$owner}],repos:[{owner:$owner,name:$name,auto_init:true,default_branch:$branch}]}}' > "$RUN_DIR/seed.json"
  info "Starting local GitHub emulator (log: $EMU_LOG)"
  "$EMULATE_BIN" start --service github --port "$EMU_PORT" --host "${EMU_HOST:-127.0.0.1}" --seed "$RUN_DIR/seed.json" >"$EMU_LOG" 2>&1 &
  EMU_PID=$!

  info "Waiting for $API ..."
  local i
  for i in $(seq 1 60); do
    if emulator_is_up; then
      ok "Emulator is up"
      api_json PUT "/repos/$REPO/contents/$MANIFEST_PATH" "$(jq -n --arg branch "$BASE_BRANCH" --arg content "$(jq -n --arg v "$OLD_VERSION" '{name:"@example/core",version:$v}' | b64_encode)" '{message:"Seed test package",branch:$branch,content:$content}')" >/dev/null
      return
    fi
    kill -0 "$EMU_PID" 2>/dev/null || { tail -n 20 "$EMU_LOG" >&2; fail "Emulator exited early"; }
    sleep 1
  done
  tail -n 20 "$EMU_LOG" >&2
  fail "Emulator did not become ready within 60s"
}

verify_seeded_repo() {
  info "Checking seeded repository $REPO"
  api GET "/repos/$REPO" | jq -e '.full_name' >/dev/null \
    || fail "Repository $REPO not found; make sure it is seeded in the emulator"
  ok "Repository $REPO exists"
}

# ----------------------------------------------------------------------------
# Step 2: Create the release branch
# ----------------------------------------------------------------------------
create_release_branch() {
  step "$MAGENTA" 2 "Create the $RELEASE_BRANCH branch"

  local sha
  sha=$(api GET "/repos/$REPO/git/ref/heads/$BASE_BRANCH" | jq -r '.object.sha')
  [[ -n "$sha" && "$sha" != "null" ]] || fail "Could not resolve $BASE_BRANCH head SHA"
  info "$BASE_BRANCH is at $sha"

  api_json POST "/repos/$REPO/git/refs" \
    "$(jq -n --arg ref "refs/heads/$RELEASE_BRANCH" --arg sha "$sha" '{ref:$ref, sha:$sha}')" \
    | jq -c '{ref, sha: .object.sha}'
  ok "Created branch $RELEASE_BRANCH"
}

# ----------------------------------------------------------------------------
# Step 3: Create the simulated PR
# ----------------------------------------------------------------------------
write_pr_payload() {
  jq -n --arg head "$RELEASE_BRANCH" --arg base "$BASE_BRANCH" \
    --arg body '<!-- release-preparation:start -->
```json
{"schemaVersion":1,"packages":[{"name":"@example/core","directory":"packages/core"}]}
```
<!-- release-preparation:end -->' \
    '{title:"release: prepare core",head:$head,base:$base,body:$body}' > "$PR_JSON_FILE"
}

create_pr() {
  step "$CYAN" 4 "Create the simulated pull request"

  write_pr_payload
  info "Payload written to $PR_JSON_FILE"

  local resp
  resp=$(api POST "/repos/$REPO/pulls" \
    -H "Content-Type: application/json" \
    --data-binary @"$PR_JSON_FILE")

  PR_NUMBER=$(jq -r '.number' <<<"$resp")
  [[ -n "$PR_NUMBER" && "$PR_NUMBER" != "null" ]] || fail "PR creation returned no number: $resp"

  jq -c '{number, title, state, head: .head.ref, base: .base.ref}' <<<"$resp"
  ok "Created PR #$PR_NUMBER"
}

# ----------------------------------------------------------------------------
# Step 4: Modify the PR branch (and optionally the PR description)
# ----------------------------------------------------------------------------
modify_branch() {
  step "$YELLOW" 3 "Modify $MANIFEST_PATH on $RELEASE_BRANCH"

  # The Contents API needs the existing file's blob SHA to update it.
  local current blob_sha content old_ver new_content
  current=$(api GET "/repos/$REPO/contents/$MANIFEST_PATH?ref=$RELEASE_BRANCH")
  blob_sha=$(jq -r '.sha' <<<"$current")
  content=$(jq -r '.content' <<<"$current" | b64_decode)
  old_ver=$(jq -r '.version' <<<"$content")

  info "Current version: $old_ver (blob $blob_sha)"
  [[ "$old_ver" == "$OLD_VERSION" ]] || warn "Expected $OLD_VERSION but found $old_ver"

  new_content=$(jq --arg v "$NEW_VERSION" '.version = $v' <<<"$content")

  local body
  body=$(jq -n \
    --arg message "chore(release): bump @example/core to $NEW_VERSION" \
    --arg content "$(printf '%s\n' "$new_content" | b64_encode)" \
    --arg sha "$blob_sha" \
    --arg branch "$RELEASE_BRANCH" \
    '{message:$message, content:$content, sha:$sha, branch:$branch}')

  api_json PUT "/repos/$REPO/contents/$MANIFEST_PATH" "$body" \
    | jq -c '{commit: .commit.sha, path: .content.path}'
  ok "Bumped version $old_ver → $NEW_VERSION on $RELEASE_BRANCH"
}

update_pr_description() {
  [[ "$UPDATE_PR_BODY" == "1" ]] || { info "Skipping PR description update (UPDATE_PR_BODY=0)"; return; }

  info "Updating PR #$PR_NUMBER description"
  local existing updated
  existing=$(api GET "/repos/$REPO/pulls/$PR_NUMBER" | jq -r '.body')
  # Append a note outside the release-preparation markers so the machine-readable block is untouched.
  updated="${existing}"$'\n\n'"Bumps @example/core to ${NEW_VERSION}."

  api_json PATCH "/repos/$REPO/pulls/$PR_NUMBER" "$(jq -n --arg body "$updated" '{body:$body}')" \
    | jq -c '{number, updated_at}'
  ok "PR description updated"
}

# ----------------------------------------------------------------------------
# Step 5: Merge the simulated PR
# ----------------------------------------------------------------------------
merge_pr() {
  step "$GREEN" 5 "Merge PR #$PR_NUMBER"

  api_json PUT "/repos/$REPO/pulls/$PR_NUMBER/merge" '{"merge_method":"merge"}' | jq -ce 'select(.merged == true)'
  ok "Merge request accepted"
}

# ----------------------------------------------------------------------------
# Step 6: Verify the final merged state
# ----------------------------------------------------------------------------
verify_merged_state() {
  step "$RED" 6 "Verify merged state"

  info "Reading merged PR"
  local pr
  pr=$(api GET "/repos/$REPO/pulls/$PR_NUMBER")
  jq '{merged, merge_commit_sha, body}' <<<"$pr"
  [[ "$(jq -r '.merged' <<<"$pr")" == "true" ]] || fail "PR #$PR_NUMBER is not marked merged"
  ok "PR is merged"

  info "Reading $MANIFEST_PATH from $BASE_BRANCH"
  local manifest version
  manifest=$(api GET "/repos/$REPO/contents/$MANIFEST_PATH?ref=$BASE_BRANCH" | jq -r '.content' | b64_decode)
  jq . <<<"$manifest"
  version=$(jq -r '.version' <<<"$manifest")
  [[ "$version" == "$NEW_VERSION" ]] \
    || fail "Expected $BASE_BRANCH version $NEW_VERSION but found $version"
  ok "$BASE_BRANCH has @example/core@$version"

  # Keep the PR for the act step.
  MERGED_PR_JSON="$pr"
}

# ----------------------------------------------------------------------------
# Step 7: Replay the merged-PR event through nektos/act
# ----------------------------------------------------------------------------
build_event_payload() {
  local repo_json
  repo_json=$(api GET "/repos/$REPO")
  jq -n \
    --argjson pr "$MERGED_PR_JSON" \
    --argjson repo "$repo_json" \
    '{action:"closed", number:$pr.number, pull_request:$pr, repository:$repo}' \
    > "$EVENT_FILE"
  info "Event payload written to $EVENT_FILE"
}

run_act() {
  step "$BLUE" 7 "Test $(basename "$WORKFLOW_FILE") with nektos/act"

  if [[ "$RUN_ACT" != "1" ]]; then
    warn "Skipped (set RUN_ACT=1 to enable)"
    return
  fi
  command -v act >/dev/null 2>&1 || fail "'act' is not installed (https://github.com/nektos/act)"
  [[ -f "$WORKFLOW_FILE" ]] || fail "Workflow not found: $WORKFLOW_FILE (run from the repo checkout or set WORKFLOW_FILE)"

  build_event_payload
  act pull_request -W "$WORKFLOW_FILE" -e "$EVENT_FILE"
  ok "act finished"
}

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
main() {
  require_cmds curl jq base64

  start_emulator
  verify_seeded_repo
  create_release_branch
  # emulate 0.12.3 snapshots the head SHA when a PR is opened.
  # Commit first so merging includes the package update.
  modify_branch
  create_pr
  update_pr_description
  merge_pr
  verify_merged_state
  run_act

  printf '\n%s%s✔ Release smoke test completed successfully%s\n' "$BOLD" "$GREEN" "$RESET"
}

main "$@"
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  release_smoke_cli "$@"
fi
