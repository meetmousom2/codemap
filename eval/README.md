# Eval harness — ground truth pipeline

This directory holds the reproducible data pipeline that mines merged GitHub
pull requests and turns them into ground-truth tuples for evaluating codemap
queries. There are no adapters or scoring yet — this issue (#213) only
delivers the data.

## Layout

```
eval/
├── README.md
├── scripts/
│   ├── mine-prs.ts   # mine one repo → eval/data/<owner__repo>.jsonl
│   └── refresh.sh    # wipe cache + re-pull all five repos
├── data/             # committed JSONL ground truth (one row per PR)
└── cache/            # local API response cache (gitignored, safe to delete)
```

Each row in a `data/*.jsonl` file is a self-contained JSON object:

```json
{
  "repo": "inngest/inngest-js",
  "number": 1234,
  "title": "fix: retry backoff overflow on long durations",
  "body": "Closes #1230 ...",
  "files_changed": ["packages/inngest/src/step.ts", "..."],
  "merged_at": "2026-03-09T14:22:11Z",
  "url": "https://github.com/inngest/inngest-js/pull/1234"
}
```

## Ground-truth repos

| Slug                     | Repo                       |
| ------------------------ | -------------------------- |
| `inngest__inngest-js`    | `inngest/inngest-js`       |
| `mastra-ai__mastra`      | `mastra-ai/mastra`         |
| `tanstack__query`        | `TanStack/query`           |
| `calcom__cal.com`        | `calcom/cal.com`           |
| `excalidraw__excalidraw` | `excalidraw/excalidraw`    |

Each file targets ~100 PRs; the combined dataset is ~500 PRs.

## Filters applied

A PR is kept only if **all** of the following hold:

- Merged (not just closed).
- Author is a human (excludes `dependabot`, `renovate`, `github-actions`,
  `snyk-bot`, `pre-commit-ci`).
- Title is not a version-bump pattern (e.g. `chore(release):`,
  `Version Packages`, `v1.2.3`).
- Changes between 1 and 5 files inclusive.
- Not docs-only (all files matching `*.md|*.mdx|*.rst|*.txt|*.adoc` or under
  `docs/`, `website/`, `documentation/`, `examples/`).
- Not a pure version-bump diff (all files matching `package.json`,
  lockfiles, `CHANGELOG.md`, etc.).

These rules live in `eval/scripts/mine-prs.ts` and are the single source of
truth — update them there if the heuristics need tweaking.

## How to reproduce from scratch

Requirements:

- [`bun`](https://bun.sh) ≥ 1.0
- [`gh`](https://cli.github.com) authenticated (`gh auth status` should be
  green). The script uses `gh api` so no token plumbing is needed.

Refresh everything (deletes `cache/` and `data/`, then re-pulls):

```sh
eval/scripts/refresh.sh
```

Refresh a single repo:

```sh
eval/scripts/refresh.sh inngest
```

Mine one repo without wiping the cache (uses cached pages/file lists where
available):

```sh
bun run eval/scripts/mine-prs.ts inngest/inngest-js
```

Useful flags on `mine-prs.ts`:

- `--target N` — number of kept PRs to aim for (default 100).
- `--max-pages N` — cap on `pulls` API pages scanned (default 30, i.e.
  3,000 closed PRs).

## Caching

`eval/cache/<owner__repo>/pages/<n>.json` stores each `pulls` list page,
and `eval/cache/<owner__repo>/files/<pr-number>.json` stores each PR's
file list. Reruns reuse these blindly, so once a PR is on disk it never
hits the GitHub API again. To force a re-fetch:

```sh
rm -rf eval/cache/<owner__repo>
```

or run `eval/scripts/refresh.sh` for the nuclear option.

The cache directory is gitignored; only `eval/data/*.jsonl` is committed.

## Rate limits

`gh api` uses your authenticated rate limit (5,000 requests/hour for a
personal token). A cold refresh of all five repos issues roughly 600–1,200
calls (one per page + one per kept-candidate PR). The script retries with
backoff if GitHub returns a rate-limit error.
