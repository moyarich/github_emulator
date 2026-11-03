#!/usr/bin/env bash
set -euo pipefail
curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:4001/repos/$REPO/releases" > "$RUNNER_TEMP/mock-releases.json"
jq -e 'length > 0 and all(.[]; .draft == true)' "$RUNNER_TEMP/mock-releases.json"
{
  echo "## Emulated PR $REPO#$PR_NUMBER"
  echo "No real PR merge or publish occurred."
  jq -r '.[] | "- " + .tag_name + " (draft)"' "$RUNNER_TEMP/mock-releases.json"
} >> "$GITHUB_STEP_SUMMARY"
