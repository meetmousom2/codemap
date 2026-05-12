#!/usr/bin/env bash
# refresh.sh — wipe the local cache and re-pull fresh PR data for the five
# ground-truth repos. Safe to run any time; uses `gh api` so it relies on the
# host's existing GitHub auth (`gh auth status`).
#
# Usage:
#   eval/scripts/refresh.sh           # refresh all repos
#   eval/scripts/refresh.sh inngest   # refresh only repos whose slug matches
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EVAL_DIR/.." && pwd)"

REPOS=(
  "inngest/inngest-js"
  "mastra-ai/mastra"
  "TanStack/query"
  "calcom/cal.com"
  "excalidraw/excalidraw"
)

FILTER="${1:-}"

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI not found on PATH" >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "error: gh is not authenticated; run 'gh auth login' first" >&2
  exit 1
fi

echo "wiping eval/cache and eval/data ..."
rm -rf "$EVAL_DIR/cache" "$EVAL_DIR/data"
mkdir -p "$EVAL_DIR/cache" "$EVAL_DIR/data"

cd "$REPO_ROOT"

for repo in "${REPOS[@]}"; do
  if [[ -n "$FILTER" && "$repo" != *"$FILTER"* ]]; then
    continue
  fi
  echo ""
  echo "=== $repo ==="
  bun run eval/scripts/mine-prs.ts "$repo"
done

echo ""
echo "refresh complete. JSONL files:"
ls -la "$EVAL_DIR/data"
echo ""
echo "totals:"
wc -l "$EVAL_DIR/data/"*.jsonl
