#!/usr/bin/env bash
set -euo pipefail
[[ -n "$GH_TOKEN" ]] || { echo "github-token is required when pr-number is supplied" >&2; exit 2; }
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
[[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]]
[[ -z "$TARGET_WORKFLOW" || "$TARGET_WORKFLOW" =~ ^\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml$ ]]
gh api "repos/$REPO/pulls/$PR_NUMBER" > "$RUNNER_TEMP/real-pr.json"
jq -e --arg repo "$REPO" --arg base "${INPUT_BASE_BRANCH}" '
  .base.repo.full_name == $repo and .head.repo.full_name == $repo
  and .base.ref == $base and (.head.ref | startswith("release/prepare-"))
' "$RUNNER_TEMP/real-pr.json"
git clone --no-checkout "https://github.com/$REPO.git" "$RUNNER_TEMP/source"
git -C "$RUNNER_TEMP/source" fetch --no-tags origin "refs/pull/$PR_NUMBER/head"
git -C "$RUNNER_TEMP/source" checkout --detach FETCH_HEAD
jq -e --arg sha "$(git -C "$RUNNER_TEMP/source" rev-parse HEAD)" '.head.sha == $sha' "$RUNNER_TEMP/real-pr.json"
if [[ -n "$TARGET_WORKFLOW" ]]; then test -f "$RUNNER_TEMP/source/$TARGET_WORKFLOW"; fi
{
  echo "DISPATCH_WORKSPACE=$RUNNER_TEMP/source"
  echo "SOURCE_SHA=$(git -C "$RUNNER_TEMP/source" rev-parse HEAD)"
  echo "SOURCE_REF=refs/heads/$(jq -r '.head.ref' "$RUNNER_TEMP/real-pr.json")"
  echo "BASE_BRANCH=$(jq -r '.base.ref' "$RUNNER_TEMP/real-pr.json")"
  echo "SOURCE_EVENT_FILE=$RUNNER_TEMP/source-event.json"
  echo "MOCK_SNAPSHOT_FILE=$RUNNER_TEMP/mock-snapshot.json"
  echo "MOCK_EVENT_FILE=$RUNNER_TEMP/mock-event.json"
} >> "$GITHUB_ENV"
jq '{action:"opened",number:.number,pull_request:(. + {merged:false,state:"open"}),repository:.base.repo}' "$RUNNER_TEMP/real-pr.json" > "$RUNNER_TEMP/source-event.json"
