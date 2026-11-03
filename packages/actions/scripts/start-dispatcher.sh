#!/usr/bin/env bash
export GITHUB_DEPENDENCY_TOKEN="${GH_TOKEN}"
cat > "$RUNNER_TEMP/mock-service.yaml" <<'YAML'
services:
  github-emulator:
    image: github-emulator-test:${COMPOSE_PROJECT_NAME}
    volumes:
      - ${DISPATCH_WORKSPACE}:${DISPATCH_WORKSPACE}:ro
      - ${ACTION_PATH}:/emulator-checkout:ro
      - ${RUNNER_TEMP}:${RUNNER_TEMP}
    environment:
      BOOTSTRAP_REPOSITORY: "0"
      GIT_CONFIG_COUNT: "1"
      GIT_CONFIG_KEY_0: safe.directory
      GIT_CONFIG_VALUE_0: ${DISPATCH_WORKSPACE}
  github-dispatcher:
    image: github-emulator-test:${COMPOSE_PROJECT_NAME}
    volumes:
      - ${DISPATCH_WORKSPACE}:${DISPATCH_WORKSPACE}:ro
      - ${ACTION_PATH}:/emulator-checkout:ro
    environment:
      DISPATCH_IMAGE: github-emulator-test:${COMPOSE_PROJECT_NAME}
      DISPATCH_WORKSPACE: ${DISPATCH_WORKSPACE}
      DISPATCH_SOURCE_SHA: ${SOURCE_SHA}
      DISPATCH_REPOSITORY: ${REPO}
      DISPATCH_WORKFLOWS: .github/workflows
      DISPATCH_GITHUB_TOKEN: ${GITHUB_DEPENDENCY_TOKEN}
YAML
export COMPOSE_FILE="$ACTION_PATH/dist/github-emulator/compose.yaml:$ACTION_PATH/dist/github-emulator/compose.dispatcher.yaml:$RUNNER_TEMP/mock-service.yaml"
echo "COMPOSE_FILE=$COMPOSE_FILE" >> "$GITHUB_ENV"
echo "ACTION_PATH=$ACTION_PATH" >> "$GITHUB_ENV"
echo "GITHUB_DEPENDENCY_TOKEN=$GITHUB_DEPENDENCY_TOKEN" >> "$GITHUB_ENV"
docker compose up --detach --wait --no-build
