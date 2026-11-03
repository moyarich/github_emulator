#!/usr/bin/env bash
docker compose down --volumes --remove-orphans || true
: # No external dependency cache: act resolves actions and reusable workflows
