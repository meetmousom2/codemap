#!/usr/bin/env bash
# Shallow-clone the four target repos used by eval/scripts/run-lookup.ts.
# Idempotent: re-running skips repos that already exist locally.
set -euo pipefail

clone_if_missing() {
  local url="$1"
  local dest="$2"
  if [ -d "$dest/.git" ]; then
    echo "✓ $dest already cloned — skipping"
  else
    echo "→ cloning $url → $dest"
    git clone --depth 1 "$url" "$dest"
  fi
}

clone_if_missing https://github.com/inngest/inngest-js     /tmp/eval-inngest-js
clone_if_missing https://github.com/excalidraw/excalidraw  /tmp/eval-excalidraw
clone_if_missing https://github.com/TanStack/query         /tmp/eval-tanstack-query
clone_if_missing https://github.com/tiangolo/fastapi       /tmp/fastapi

echo
echo "Done. Run the eval with:"
echo "  bun run eval/scripts/run-lookup.ts"
