# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- Renamed package from `@yuzu-team/codemap` to `@codemap-cli/codemap`. Install with `npx @codemap-cli/codemap`.
  - Note: the original target was the `@codemap` org (name `cli`), but npm refused the `@codemap` org ("creation denied, contact support"), so we chose `@codemap-cli/codemap` instead.

## [0.2.0] - 2026-04

### Added
- Hybrid BM25 + semantic embeddings ranking as the default query mode.
- BM25 ranking via `bun:sqlite` FTS5 replacing the previous keyword scorer.
- Path and directory boosting plus test/example penalty for BM25 ranking quality.
- `--budget` flag for token-aware output with progressive degradation.
- JIT semantic embeddings with incremental updates.
- Semantic search powered by Transformers.js embeddings.
- `codemap impact <symbol>` command for blast-radius analysis.
- `codemap skeleton` and `codemap deps` commands for skeleton-based dependency rendering.
- Incremental content-hash rebuilds.

## [0.1.x] - 2026-03

### Added
- Initial release: AST-based knowledge graph for TypeScript codebases.
- Tree-sitter parser with a language plugin system.
- Scanner that walks the repo, finds `.ts`/`.tsx` files, and respects `.gitignore`.
- Import resolver for TypeScript and Python (tsconfig path aliases, barrel imports).
- Dependency graph, call graph, and auto-summarizer.
- PageRank-based ranking over the knowledge graph.
- CLI commands: `init`, `query`, `build`, and `--check`.
- Renderer that generates `CODEMAP.md`.
- Git post-merge hook installer for graph freshness.
- Query-aware codemap with dynamic ranked context per question.

### Fixed
- Scanner skips `.worktrees` directories and query output shows key matching lines.

[Unreleased]: https://github.com/yuzu-team/codemap/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/yuzu-team/codemap/compare/v0.1.1...v0.2.0
[0.1.x]: https://github.com/yuzu-team/codemap/releases/tag/v0.1.1
