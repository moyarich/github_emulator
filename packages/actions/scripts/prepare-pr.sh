#!/usr/bin/env bash
set -euo pipefail
for phase in repository event; do
  docker compose exec -T --workdir "$DISPATCH_WORKSPACE" \
    --env GITHUB_WORKSPACE="$DISPATCH_WORKSPACE" \
    --env REPO --env TOKEN --env BASE_BRANCH --env SOURCE_SHA \
    --env SOURCE_REF --env SOURCE_EVENT_FILE --env MOCK_SNAPSHOT_FILE \
    --env MOCK_EVENT_FILE --env SELECTED_EVENT --env MOCK_API_URL \
    --env PREPARE_PHASE="$phase" github-emulator \
    node /emulator-checkout/dist/github-emulator/prepare-workflow.js
done
docker compose exec -T --env MOCK_EVENT_FILE github-emulator \
  node -e 'const fs = require("node:fs"); const event = JSON.parse(fs.readFileSync(process.env.MOCK_EVENT_FILE, "utf8")); if (event.pull_request?.merged !== false) process.exit(1);'
