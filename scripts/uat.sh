#!/usr/bin/env bash
# UAT for Task #222 — verifies the contract criteria for the FTS5
# tokenize() fix end-to-end (tokenize behaviour + rankFiles non-throw +
# CLI query against a built graph when available).
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO_ROOT"

echo "UAT: tokenize/rankFiles behaviour"
bun run - <<'TS'
import { tokenize, rankFiles } from "./src/ranker";
import type { CodeGraph } from "./src/types";

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL ${label}: got ${a}, expected ${e}`);
    process.exit(1);
  }
  console.log(`PASS ${label}`);
}

assertEqual(
  tokenize("fix(editor): prevent duplicate lasso"),
  ["fix", "editor", "prevent", "duplicate", "lasso"],
  "tokenize conventional-commit prefix",
);

assertEqual(
  tokenize("foo[bar]:baz,qux"),
  ["foo", "bar", "baz", "qux"],
  "tokenize brackets/colons/commas",
);

assertEqual(
  tokenize("type<T>"),
  ["type"],
  "tokenize filters single-char generic param",
);

const graph: CodeGraph = {
  root: "/tmp/uat-222",
  files: [
    {
      path: "src/editor.ts",
      language: "typescript",
      exports: [
        { name: "something", kind: "function", signature: "function something(): void", isDefault: false },
      ],
      imports: [],
      classes: [],
      functions: [
        { name: "something", signature: "function something(): void", params: [], returnType: "void", isAsync: false, isGenerator: false, typeParameters: [] },
      ],
      types: [],
      enums: [],
      reExports: [],
    },
  ],
  edges: [],
  modules: [],
  generatedAt: new Date().toISOString(),
};

try {
  const ranked = rankFiles(graph, "fix(editor): something");
  if (ranked.length === 0) {
    console.error("FAIL rankFiles punctuation query returned no results");
    process.exit(1);
  }
  console.log("PASS rankFiles does not throw on punctuation-heavy query");
} catch (err) {
  console.error("FAIL rankFiles threw:", err);
  process.exit(1);
}
TS

EVAL_REPO="/tmp/eval-excalidraw"
if [ -f "$EVAL_REPO/.codemap/graph.json" ]; then
  echo "UAT: CLI query against $EVAL_REPO"
  OUTPUT=$(bun run src/index.ts query "fix(editor): foo" "$EVAL_REPO" 2>&1)
  if [ -z "$OUTPUT" ] || ! echo "$OUTPUT" | grep -q '^## '; then
    echo "FAIL CLI query returned empty result set" >&2
    echo "$OUTPUT" | tail -c 600 >&2
    exit 1
  fi
  echo "PASS CLI query returned ranked files"
else
  echo "SKIP CLI query — $EVAL_REPO/.codemap/graph.json not present"
fi

echo "UAT: all checks passed"
