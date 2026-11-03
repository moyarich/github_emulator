#!/usr/bin/env bash
set -euo pipefail
docker build -f "$ACTION_PATH/dist/github-emulator/docker/Dockerfile" --target mock-github -t "github-emulator-test:$COMPOSE_PROJECT_NAME" "$ACTION_PATH/dist/github-emulator"
docker compose -f "$ACTION_PATH/dist/github-emulator/compose.yaml" build github-proxy
mkdir -p "$RUNNER_TEMP/act"
gh release download v0.2.95 --repo nektos/act --pattern act_Linux_x86_64.tar.gz --dir "$RUNNER_TEMP/act"
tar xzf "$RUNNER_TEMP/act/act_Linux_x86_64.tar.gz" -C "$RUNNER_TEMP/act" act
echo "$RUNNER_TEMP/act" >> "$GITHUB_PATH"
