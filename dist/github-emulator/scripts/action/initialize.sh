#!/usr/bin/env bash
set -euo pipefail
{
  echo "REPO=$INPUT_REPOSITORY"
  echo "PR_NUMBER=$INPUT_PR_NUMBER"
  echo "TARGET_WORKFLOW=$INPUT_WORKFLOW"
  echo "TOKEN=$INPUT_TOKEN"
  echo "COMPOSE_PROJECT_NAME=pr-merge-${RUN_ID}-${RUN_ATTEMPT}"
  echo 'EMULATOR_PORT=0'
  echo 'HTTPS_PORT=0'
} >> "$GITHUB_ENV"
