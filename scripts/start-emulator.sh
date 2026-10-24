#!/usr/bin/env bash
# Local convenience wrapper; implementation belongs to its workspace package.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../packages/emulate-github/scripts" && pwd)/start-emulator.sh"
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  start_emulator_cli "$@"
fi
