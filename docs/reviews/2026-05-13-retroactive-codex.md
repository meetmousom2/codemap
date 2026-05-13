# Retroactive Codex review — PRs #24–#28

**Date:** 2026-05-13
**kbmd issue:** #221
**Reviewer:** Codex CLI (codex-cli 0.125.0-alpha.3) via `codex review --commit <sha>`
**Reason for retro review:** PRs #24–#28 merged on `main` before devd PR #66 enabled adversarial Codex review by default (the local `scripts/devd-verify.sh` stub plus `devd-issue.sh` not passing `--code-review` meant none of these PRs got adversarial review at merge time).

## Summary

| PR | Title | High | Medium | Low | Status |
|----|-------|------|--------|-----|--------|
| #24 | Eval harness + ground truth pipeline | 2 | 0 | 0 | 2 followups filed |
| #25 | eval/types.ts Retriever interface | 0 | 0 | 0 | Clean — no findings |
| #26 | Python parser + import resolver | 0 | 2 | 0 | Consolidated |
| #27 | Go parser + import resolver | 0 | 2 | 0 | Consolidated |
| #28 | Competitor adapters | 0 | 2 | 0 | Consolidated |
| **Total** | | **2** | **6** | **0** | |

**Followup issues filed:**
- kbmd #228 — codemap: Fix eval ground-truth filter to drop Changesets release PRs (high)
- kbmd #229 — codemap: `refresh.sh` single-repo path nukes all other eval/data (high)
- kbmd #230 — Codex retro review — medium findings (PRs #26/#27/#28) (medium, consolidated)

**Already fixed by other PRs:** No findings here overlap with PR #31 (FTS5 fix), #32 (ranker fix), or #33 (eval writeup) — those PRs touch `src/ranker.ts`, `src/embeddings.ts`, `tests/ranker.test.ts`, README, and `eval/scripts/run-lookup.ts`; none of the files flagged below.

## Method

For each merge commit on `main`, ran:

```bash
codex review --commit <merge-sha> --title "<pr-title>"
```

Severity mapping: Codex `[P1]` → high; Codex `[P2]` → medium; nits/style → low. No `[P3]`/low findings surfaced in any review.

Raw outputs preserved at `/tmp/codex-retro/pr{24,25,26,27,28}.txt` for the duration of the audit session.

---

## PR #24 — Eval harness + ground truth pipeline

**Merge commit:** `a852b67`
**Files touched (excerpt):** `eval/scripts/mine-prs.ts`, `eval/scripts/refresh.sh`, `eval/scripts/setup-test-repos.sh`, `eval/data/*.jsonl`

### High

**H-24.1 — `mine-prs.ts` version-bump filter misses Changesets release PRs**
- Location: `eval/scripts/mine-prs.ts:185` (`VERSION_FILE` regex)
- Detail: For repos using [Changesets](https://github.com/changesets/changesets) (e.g. `inngest/inngest-js`), pure release PRs include `.changeset/*.md` files alongside `package.json`/`CHANGELOG.md`. The current `VERSION_FILE` regex doesn't cover `.changeset/*`, so `isVersionBumpFiles` returns false and the release PR survives filtering.
- Evidence: committed `eval/data/inngest__inngest-js.jsonl` contains multiple "Release @latest" rows whose `files_changed` is just changeset + changelog + `package.json`. Visible in the Codex review output.
- **Filed as:** kbmd #228.

**H-24.2 — `refresh.sh` deletes all eval/data even when filtered to one repo**
- Location: `eval/scripts/refresh.sh:34-35`
- Detail: Script accepts a single-repo filter argument per its docs, but executes `rm -rf "$EVAL_DIR/cache" "$EVAL_DIR/data"` unconditionally before regenerating only the matching repo. Running `eval/scripts/refresh.sh inngest` therefore destroys every other repo's `*.jsonl` ground truth — a data-loss footgun.
- **Filed as:** kbmd #229.

### Medium / Low

None.

---

## PR #25 — eval/types.ts Retriever interface

**Merge commit:** `fefb5db`
**Files touched:** `eval/types.ts`, `eval/README.md`

### Findings

None. Codex verdict: "The commit only adds shared TypeScript interfaces and README documentation, and the declared `GroundTruthPR` shape matches the existing `mine-prs.ts` JSONL output. I did not find a discrete correctness, compatibility, or maintainability issue introduced by this change."

Skipping — no followup needed.

---

## PR #26 — Python parser + import resolver

**Merge commit:** `2264ff8` (force-rewritten from the original `1847d2d` after a separate history fix)
**Files touched (excerpt):** `src/languages/python.ts`, `src/resolver.ts`, `tests/parser-python.test.ts`, `tests/fixtures/python-project/**`

### High

None.

### Medium

**M-26.1 — Python parser includes the source module as an imported name**
- Location: `src/languages/python.ts:531-536`
- Detail: For absolute `from <module> import <names>`, the loop currently includes the module itself in `namedImports`. Repro:
  ```
  from typing import Optional, List
  → namedImports: ['typing', 'Optional', 'List']
  ```
  Pollutes dependency-edge metadata and ranker/search signals with symbols the file never actually imports.
- **Filed in:** kbmd #230 (M1).

**M-26.2 — Bare relative submodule imports resolve to package `__init__.py` instead of the submodule**
- Location: `src/resolver.ts:280-282`
- Detail: For `from . import utils` or `from .. import service`, the resolver always points to the package's `__init__.py`, even when `utils.py` / `service.py` exists as a sibling submodule. Python's actual import semantics load the submodule, so the graph misses the real file dependency.
- **Filed in:** kbmd #230 (M2).

### Low

None.

---

## PR #27 — Go parser + import resolver

**Merge commit:** `5c21157` (force-rewritten from `5c5a3a0`)
**Files touched (excerpt):** `src/languages/go.ts`, `src/resolver.ts`, `tests/parser-go.test.ts`, fixtures

### High

None.

### Medium

**M-27.1 — Generic receiver type names break method attachment**
- Location: `src/languages/go.ts:243`
- Detail: Go 1.18+ generic receivers like `func (b *Box[T]) Get()` are stored with receiver name `Box[T]`, but the matching struct decl is stored as `Box`. `methodsByReceiver.get(cls.name)` lookup misses, so generic types have no method sets and exports render as `Box[T].Get` instead of attaching to `Box`.
- **Filed in:** kbmd #230 (M3).

**M-27.2 — Unresolved third-party Go imports incorrectly marked as internal**
- Location: `src/languages/go.ts:404`
- Detail: For non-vendored third-party imports like `github.com/pkg/errors`, the parser sets `isExternal: false` because the first segment contains a dot (the heuristic is "dot in first segment = local module path"). When the resolver can't resolve it locally, nothing flips it back, so unresolved external Go deps render as non-external. Inconsistent with the TS/Python behaviour where absolute package imports stay external unless the resolver flips them to in-tree.
- **Filed in:** kbmd #230 (M4).

### Low

None.

---

## PR #28 — Competitor adapters

**Merge commit:** `8ff329e` (force-rewritten from `821a847`)
**Files touched (excerpt):** `eval/adapters/{codemap,grep,embedding,aider}.ts`, `eval/scripts/run-eval.ts`

### High

None.

### Medium

**M-28.1 — Embedding adapter has no per-repo cache; re-embeds every chunk on every query**
- Location: `eval/adapters/embedding.ts:146`
- Detail: The eval harness fires ~100 PR titles against the same repo. The adapter re-embeds every source chunk on every single query, so cost scales as repos × queries × files. With the default `Xenova/multilingual-e5-large` and large target repos (cal.com, excalidraw), this turns the benchmark into hours / OOM and effectively prevents anyone from running the embedding comparison.
- Fix sketch: cache per-repo (and ideally per-commit-sha) chunk embeddings on disk; only embed the new query per call.
- **Filed in:** kbmd #230 (M5).

**M-28.2 — E5 model used without required `query:` / `passage:` prefixes**
- Location: `eval/adapters/embedding.ts:142-146`
- Detail: `Xenova/multilingual-e5-large` (the documented default backend) is trained with `query: ...` for queries and `passage: ...` for documents. Embedding the raw PR title and raw chunks without prefixes puts both sides outside the model's training format and measurably degrades ranking accuracy. This is purely a benchmark-validity issue (the embedding adapter is a competitor baseline in the eval) — but it makes the comparison unfair.
- Fix sketch: prepend `query: ` and `passage: ` only on the default E5 path, gated on the configured model name.
- **Filed in:** kbmd #230 (M6).

### Low

None.

---

## Codex CLI gotchas observed during the audit

- `codex review --commit <sha>` works directly against squash-merge commits — no need for `gh pr diff | codex review --stdin`.
- Codex emitted benign `ERROR codex_core::session: failed to record rollout items: thread ... not found` lines to stderr after each review. They appear to be a rollout-recording artefact and did not affect the review output.
- All five reviews completed inside a single Codex session without hitting quota — no opencode fallback needed this run. Fallback pattern from devd PR #50 remains documented for future audits.

## Followup PR

This report is being committed as the audit deliverable for kbmd #221 — PR will be opened against `main` from branch `221-retro-codex-review`. The three followup kbmd issues (#228, #229, #230) own the actual code fixes.
