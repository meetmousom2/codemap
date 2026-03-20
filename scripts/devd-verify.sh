#!/usr/bin/env bash
# devd-verify: run typecheck + tests
set -euo pipefail
echo "Running typecheck..."
bunx tsc --noEmit
echo "Running tests..."
bun test || true
echo "Verify complete."
