#!/usr/bin/env bash
docker compose logs --no-color > "$RUNNER_TEMP/pr-merge.log" 2>&1 || true
echo "::group::Mock GitHub dispatcher diagnostics"
docker compose logs --no-color github-dispatcher || true
echo "::endgroup::"
