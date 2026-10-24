#!/usr/bin/env bash
# Compatibility wrapper for local callers of the shared CLI helpers.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../packages/emulate-github/scripts" && pwd)/cli-common.sh"
