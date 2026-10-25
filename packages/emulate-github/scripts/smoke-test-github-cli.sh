#!/usr/bin/env bash
#
# github_emulator.sh
#
# Runs a release PR smoke test against a local GitHub emulator
# using the GitHub CLI (gh).
#
# Example:
#   NEW_VERSION=2.0.0 RUN_ACT=1 ./scripts/github_emulator.sh

set -euo pipefail

# Resolve the directory containing this script.
current_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Source the emulator script.
source "$current_dir/start-emulator.sh"

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

readonly EMULATE_PORT="${EMULATE_PORT:-4001}"
readonly API="${API:-http://localhost:$EMULATE_PORT}"
readonly REPO="${REPO:-moyarich/release-smoke-test}"
readonly TOKEN="${TOKEN:-local-test-token}"

readonly BASE_BRANCH="${BASE_BRANCH:-main}"
readonly RELEASE_BRANCH="${RELEASE_BRANCH:-release/prepare-$(date +%s)-$$}"
readonly MANIFEST_PATH="${MANIFEST_PATH:-packages/core/package.json}"
readonly OLD_VERSION="${OLD_VERSION:-1.0.0}"
readonly NEW_VERSION="${NEW_VERSION:-1.1.0}"

readonly UPDATE_PR_BODY="${UPDATE_PR_BODY:-0}"
readonly RUN_ACT="${RUN_ACT:-0}"
readonly WORKFLOW_FILE="${WORKFLOW_FILE:-.github/workflows/smoke-test_release-approved-pr.yml}"
readonly KEEP_EMULATOR="${KEEP_EMULATOR:-0}"
readonly EMU_LOG="${EMU_LOG:-/tmp/emulate-github.log}"
readonly EMU_HOST="${EMU_HOST:-127.0.0.1}"
readonly SEED_SOURCE="${CONFIG_FILE:-${SEED_FILE:-}}"

# -----------------------------------------------------------------------------
# Logging
# -----------------------------------------------------------------------------

info() { printf '  ➜ %s\n' "$*" >&2; }
ok()   { printf '  ✔ %s\n' "$*" >&2; }
warn() { printf '  ⚠ %s\n' "$*" >&2; }

fail() {
  printf '  ✘ %s\n' "$*" >&2
  exit 1
}

step() {
  printf '\n━━━ Step %s: %s ━━━\n' "$1" "$2" >&2
}

# -----------------------------------------------------------------------------
# Utilities
# -----------------------------------------------------------------------------

require_commands() {
  local command
  local -a missing=()

  for command in "$@"; do
    command -v "$command" >/dev/null 2>&1 ||
      missing+=("$command")
  done

  ((${#missing[@]} == 0)) ||
    fail "Missing commands: ${missing[*]}"
}

encode_base64() {
  base64 | tr -d '\n'
}

decode_base64() {
  tr -d '\n' | base64 -d
}

# -----------------------------------------------------------------------------
# GitHub CLI
# -----------------------------------------------------------------------------

configure_github_cli() {
  local config_dir="$1"

  export GH_CONFIG_DIR="$config_dir"
  export GH_TOKEN="$TOKEN"
  export GH_ENTERPRISE_TOKEN="$TOKEN"
  export GH_PROMPT_DISABLED=1
  export GH_PAGER=cat
  export GH_COLOR_LABELS=0
  export GH_REPO="$REPO"

  # Use absolute API URLs so requests target the emulator.
  # Do not use GH_HOST to select a custom HTTP API endpoint.
  gh config set git_protocol https
  gh config set prompt disabled

  ok "GitHub CLI configured with isolated settings"
}

# gh_api METHOD PATH [gh api options...]
gh_api() {
  local method="$1"
  local path="$2"
  shift 2

  gh api "${API%/}${path}" \
    --method "$method" \
    -H 'Accept: application/vnd.github+json' \
    "$@"
}

# gh_api_json METHOD PATH
# Reads the JSON request body from stdin.
gh_api_json() {
  local method="$1"
  local path="$2"
  shift 2

  gh_api "$method" "$path" \
    -H 'Content-Type: application/json' \
    --input - "$@"
}


get_repository() {
  gh_api GET "/repos/$REPO"
}

get_branch_sha() {
  local branch="$1"

  gh_api GET "/repos/$REPO/git/ref/heads/$branch" \
    --jq '.object.sha'
}

get_manifest() {
  local branch="$1"

  gh_api GET "/repos/$REPO/contents/$MANIFEST_PATH?ref=$branch"
}

get_pull_request() {
  local number="$1"

  gh_api GET "/repos/$REPO/pulls/$number"
}

# -----------------------------------------------------------------------------
# JSON builders (no filesystem or network writes)
# -----------------------------------------------------------------------------


generate_package_json() {
  jq -n \
    --arg version "$OLD_VERSION" \
    '{
      name: "@example/core",
      version: $version
    }'
}

generate_contents_request() {
  local branch="$1"
  local message="$2"
  local content="$3"
  local sha="${4:-}"

  jq -n \
    --arg branch "$branch" \
    --arg message "$message" \
    --arg content "$content" \
    --arg sha "$sha" \
    '{
      message: $message,
      branch: $branch,
      content: $content
    } + if $sha == "" then {} else {sha: $sha} end'
}

generate_pr_request() {
  jq -n \
    --arg head "$RELEASE_BRANCH" \
    --arg base "$BASE_BRANCH" \
    --arg body '<!-- release-preparation:start -->
```json
{"schemaVersion":1,"packages":[{"name":"@example/core","directory":"packages/core"}]}
```
<!-- release-preparation:end -->' \
    '{
      title: "release: prepare core",
      head: $head,
      base: $base,
      body: $body
    }'
}

generate_branch_request() {
  local sha="$1"

  jq -n \
    --arg ref "refs/heads/$RELEASE_BRANCH" \
    --arg sha "$sha" \
    '{ref: $ref, sha: $sha}'
}

generate_merge_request() {
  jq -n '{merge_method: "merge"}'
}

# -----------------------------------------------------------------------------
# Emulator management
# -----------------------------------------------------------------------------

emulator_is_up() {
  gh_api GET "/repos/$REPO" --silent 2>/dev/null
}





verify_repository() {
  local actual

  actual="$(get_repository | jq -r '.full_name')"

  [[ "$actual" == "$REPO" ]] ||
    fail "Expected repository $REPO, got $actual"

  ok "Repository $REPO exists"
}

# -----------------------------------------------------------------------------
# Release branch
# -----------------------------------------------------------------------------

create_release_branch() {
  local base_sha

  base_sha="$(get_branch_sha "$BASE_BRANCH")"

  [[ -n "$base_sha" && "$base_sha" != null ]] ||
    fail "Cannot resolve $BASE_BRANCH"

  info "$BASE_BRANCH is at $base_sha"

  generate_branch_request "$base_sha" |
    gh_api_json POST "/repos/$REPO/git/refs" \
      --jq '{ref, sha: .object.sha}'

  ok "Created branch $RELEASE_BRANCH"
}

modify_release_branch() {
  local current blob_sha content old_version updated encoded

  current="$(get_manifest "$RELEASE_BRANCH")"

  blob_sha="$(jq -r '.sha' <<< "$current")"

  content="$(
    jq -r '.content' <<< "$current" |
      decode_base64
  )"

  old_version="$(jq -r '.version' <<< "$content")"

  [[ "$old_version" == "$OLD_VERSION" ]] ||
    warn "Expected $OLD_VERSION but found $old_version"

  info "Current version: $old_version"
  info "Blob SHA: $blob_sha"

  updated="$(
    jq --arg version "$NEW_VERSION" \
      '.version = $version' <<< "$content"
  )"

  encoded="$(
    printf '%s\n' "$updated" |
      encode_base64
  )"

  generate_contents_request \
    "$RELEASE_BRANCH" \
    "chore(release): bump @example/core to $NEW_VERSION" \
    "$encoded" \
    "$blob_sha" |
    gh_api_json PUT "/repos/$REPO/contents/$MANIFEST_PATH" \
      --jq '{commit: .commit.sha, path: .content.path}'

  ok "Bumped $old_version → $NEW_VERSION"
}

# -----------------------------------------------------------------------------
# Pull requests
# -----------------------------------------------------------------------------

create_pull_request() {
  generate_pr_request |
    gh_api_json POST "/repos/$REPO/pulls" \
      --jq '.number'
}

update_pull_request() {
  local number="$1"

  if [[ "$UPDATE_PR_BODY" != 1 ]]; then
    info "Skipping PR description update"
    return 0
  fi

  local existing updated

  existing="$(
    get_pull_request "$number" |
      jq -r '.body // ""'
  )"

  updated="${existing}"$'\n\n'"Bumps @example/core to ${NEW_VERSION}."

  jq -n --arg body "$updated" '{body: $body}' |
    gh_api_json PATCH "/repos/$REPO/pulls/$number" \
      --jq '{number, updated_at}'

  ok "Updated PR #$number description"
}

merge_pull_request() {
  local number="$1"

  generate_merge_request |
    gh_api_json PUT "/repos/$REPO/pulls/$number/merge" \
      --jq 'select(.merged == true)'

  ok "Merged PR #$number"
}

# -----------------------------------------------------------------------------
# Verification
# -----------------------------------------------------------------------------

verify_merged_state() {
  local number="$1"
  local pr manifest version

  pr="$(get_pull_request "$number")"

  jq '{number, merged, merge_commit_sha, body}' <<< "$pr"

  [[ "$(jq -r '.merged' <<< "$pr")" == true ]] ||
    fail "PR #$number is not merged"

  ok "PR #$number is merged"

  manifest="$(
    get_manifest "$BASE_BRANCH" |
      jq -r '.content' |
      decode_base64
  )"

  jq . <<< "$manifest"

  version="$(jq -r '.version' <<< "$manifest")"

  [[ "$version" == "$NEW_VERSION" ]] ||
    fail "Expected $NEW_VERSION, found $version"

  ok "$BASE_BRANCH has @example/core@$version"
}

# -----------------------------------------------------------------------------
# GitHub Actions event replay
# -----------------------------------------------------------------------------

generate_merged_event() {
  local number="$1"
  local pr repository

  pr="$(get_pull_request "$number")"
  repository="$(get_repository)"

  jq -n \
    --argjson pr "$pr" \
    --argjson repository "$repository" \
    '{
      action: "closed",
      number: $pr.number,
      pull_request: $pr,
      repository: $repository
    }'
}

run_act() {
  local number="$1"
  local event_file="$2"

  if [[ "$RUN_ACT" != 1 ]]; then
    warn "Skipped act (RUN_ACT=0)"
    return 0
  fi

  require_commands act

  [[ -f "$WORKFLOW_FILE" ]] ||
    fail "Workflow not found: $WORKFLOW_FILE"

  generate_merged_event "$number" > "$event_file"

  info "Event payload: $event_file"

  act pull_request \
    -W "$WORKFLOW_FILE" \
    -e "$event_file"

  ok "act completed"
}

# -----------------------------------------------------------------------------
# Cleanup
# -----------------------------------------------------------------------------


# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

# Run main in a subshell so its EXIT trap and local resource
# variables remain scoped to the scenario.
main() (
  local run_dir config_dir seed_path
  local emu_pid="" pr_number="" exit_code=0

  require_commands gh jq base64

  run_dir="$(mktemp -d "${TMPDIR:-/tmp}/github-emulator.XXXXXX")"
  config_dir="$run_dir/gh-config"
  mkdir -p "$config_dir"

  trap 'emulator_cleanup "$emu_pid" "$run_dir"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  configure_github_cli "$config_dir"

  step 1 "Start GitHub emulator"

  if emulator_is_up; then
    warn "Reusing emulator at $API"
  else
    command -v emulate >/dev/null 2>&1 ||
      fail "Emulator CLI not found on PATH; install workspace dependencies with npm ci"

    case "$API" in
      "http://localhost:$EMULATE_PORT" | \
      "http://127.0.0.1:$EMULATE_PORT") ;;
      *)
        fail "External API unavailable: $API"
        ;;
    esac

    seed_path="$run_dir/emulate.config.yaml"
    emulator_prepare_seed "$seed_path" "$PWD/emulate.config.yaml"

    info "Starting emulator (log: $EMU_LOG)"

    emulator_start_emulator "$seed_path" "$(emulator_resolve_secrets_path "$run_dir")" > "$EMU_LOG" 2>&1 &
    emu_pid=$!

    emulator_wait_for_emulator "$emu_pid" ||
      fail "Emulator did not become ready"

    ok "Emulator started"

    if [[ -z "$SEED_SOURCE" ]]; then
      emulator_bootstrap_repository
    fi
  fi

  verify_repository

  step 2 "Create release branch"
  create_release_branch

  step 3 "Modify release branch"
  modify_release_branch

  step 4 "Create pull request"
  pr_number="$(create_pull_request)"

  [[ "$pr_number" =~ ^[0-9]+$ ]] ||
    fail "Invalid PR number: $pr_number"

  ok "Created PR #$pr_number"

  update_pull_request "$pr_number"

  step 5 "Merge pull request"
  merge_pull_request "$pr_number"

  step 6 "Verify merged state"
  verify_merged_state "$pr_number"

  step 7 "Replay merged event with act"
  run_act "$pr_number" "$run_dir/merged-pr-event.json"

  printf '\n✔ Release smoke test completed successfully\n'

  # Explicitly perform cleanup on the successful path.
  emulator_cleanup "$emu_pid" "$run_dir"
  trap - EXIT INT TERM
)

main "$@"
