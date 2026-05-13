#!/usr/bin/env bash
# Shallow-clone the four target repos used by eval/scripts/run-lookup.ts at
# pinned commit SHAs so re-running the eval produces identical repository
# state regardless of upstream movement.
#
# SHAs below were captured via `git rev-parse HEAD` in each /tmp/eval-* dir
# immediately after the 2026-05-13 baseline eval run. To refresh for a new
# baseline: re-clone each repo at its default branch HEAD, run the eval to
# generate a new baseline, then update the SHAs here with the new HEADs.
#
# Idempotent: re-running skips repos that are already checked out at the
# pinned SHA.
set -euo pipefail

INNGEST_SHA="ebeb4516037015c0e6f1d417be55009f4a64fb89"
EXCALIDRAW_SHA="0457ac90634b8556feaa9c0e56be94d3f13fd9bd"
TANSTACK_SHA="6840460591008b365d3d65c6b26f1f427a5f06ee"
FASTAPI_SHA="e89a37e50d27f124b77e947b7965b6df75052a35"

clone_at_sha() {
  local url="$1"
  local dest="$2"
  local sha="$3"
  if [ -d "$dest/.git" ]; then
    local current
    current=$(git -C "$dest" rev-parse HEAD)
    if [ "$current" = "$sha" ]; then
      echo "✓ $dest already at pinned SHA — skipping"
      return
    fi
    echo "⚠ $dest exists but at $current (expected $sha) — leaving in place"
    return
  fi
  echo "→ cloning $url@$sha → $dest"
  git init -q "$dest"
  git -C "$dest" remote add origin "$url"
  git -C "$dest" fetch --depth 1 origin "$sha"
  git -C "$dest" checkout --detach "$sha"
}

clone_at_sha https://github.com/inngest/inngest-js     /tmp/eval-inngest-js       "$INNGEST_SHA"
clone_at_sha https://github.com/excalidraw/excalidraw  /tmp/eval-excalidraw       "$EXCALIDRAW_SHA"
clone_at_sha https://github.com/TanStack/query         /tmp/eval-tanstack-query   "$TANSTACK_SHA"
clone_at_sha https://github.com/tiangolo/fastapi       /tmp/fastapi               "$FASTAPI_SHA"

echo
echo "Done. Run the eval with:"
echo "  bun run eval/scripts/run-lookup.ts"
