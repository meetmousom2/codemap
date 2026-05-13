# codemap

AST-based codebase knowledge graph for AI agents. One command to set up, one command to query. Works with Claude Code, Codex, Cursor, or any AI coding tool.

**Problem:** Every new AI session starts cold. The agent greps blindly, reads wrong files, backtracks. This wastes tool calls and time.

**Solution:** codemap builds a cached knowledge graph from your codebase's AST (tree-sitter), then answers structural questions instantly using keyword matching + PageRank.

## Install

```bash
npx @codemap-cli/codemap
```

That's it. This one command:
1. Parses your codebase (TypeScript, Go)
2. Builds a knowledge graph (cached at `.codemap/graph.json`)
3. Adds `.codemap/` to `.gitignore`
4. Adds agent instructions to `CLAUDE.md` / `AGENTS.md`
5. Installs a git post-merge hook to keep the graph fresh

## Usage

```bash
# Query the codebase (agents call this instead of grepping)
codemap query "where is auth handled?"
codemap query "how does retry work in workflows?"
codemap query "PostgreSQL storage adapter"

# Rebuild the graph manually
codemap build

# Check if graph is stale (for CI)
codemap --check
```

### Example output

```
## packages/core/src/memory/memory.ts [matched: memory, class]
MastraMemory class extends MastraBase — 15 methods

- `abstract class MastraMemory extends MastraBase`
  Abstract base class for conversation memory systems.

**abstract class MastraMemory extends MastraBase**
- async getThreadById(threadId): Promise<StorageThreadType>
- async saveMessages(messages): Promise<MastraDBMessage[]>
- async query(threadId, query): Promise<CoreMessage[]>
...

**Depends on:** packages/core/src/storage, packages/core/src/base
```

## How it works

1. **Scan** — finds all `.ts`, `.tsx`, `.go` files (respects `.gitignore`)
2. **Parse** — extracts AST via tree-sitter: exports, classes, functions, types, imports, JSDoc
3. **Resolve** — resolves imports to file paths (tsconfig aliases)
4. **Graph** — builds dependency edges, detects modules, computes cross-file call references
5. **Rank** — on query, scores files by keyword matching + PageRank on the dependency graph
6. **Return** — outputs ~200 lines of the most relevant files with signatures and relationships

The graph caches at `.codemap/graph.json` and auto-rebuilds when `HEAD` changes.

## Eval results

Benchmarked against ripgrep, Aider repomap, and dense embeddings (MiniLM-L6-v2) on **50 natural-language lookup queries** across 4 open-source repos (3 TypeScript + FastAPI/Python).

| Adapter | F1@5 | Recall | Hit rate | Tokens |
|---------|------|--------|----------|--------|
| **codemap** | **0.328** | **83%** | **45/50 (90%)** | 3,318 |
| Embeddings (MiniLM) | 0.166 | 44% | 24/50 (48%) | 2,500 |
| Aider repomap | 0.022 | 41% | 23/50 (46%) | 7,657 |
| ripgrep | 0.055 | 13% | 8/50 (16%) | 7 |

Per-repo, codemap leads on every test:

| Repo | codemap F1 | embedding F1 | aider F1 | grep F1 |
|------|-----------|--------------|----------|---------|
| tanstack/query (TS) | **0.359** | 0.041 | 0.023 | 0.000 |
| excalidraw/excalidraw (TS) | **0.319** | 0.190 | 0.004 | 0.029 |
| tiangolo/fastapi (Python) | **0.319** | 0.257 | 0.037 | 0.067 |
| inngest/inngest-js (TS) | **0.302** | 0.190 | 0.017 | 0.145 |

Full methodology, eval harness, and per-query results: [`eval/results/2026-05-13-lookup.md`](eval/results/2026-05-13-lookup.md). Reproducible via `bash eval/scripts/setup-test-repos.sh && bun run eval/scripts/run-lookup.ts`.

## Agent integration

codemap works with any AI coding tool. After `npx @codemap-cli/codemap`, the agent instructions are automatically added to your repo's `CLAUDE.md` or `AGENTS.md`:

```markdown
## Before exploring code
Run `npx @codemap-cli/codemap query "your question"` before grepping the codebase.
Returns ranked relevant files with exports, classes, methods, and dependencies (~200 lines).
```

### With Claude Code

Claude reads `CLAUDE.md` automatically. After init, it will call `codemap query` before grepping.

### With Codex / other agents

Codex reads `AGENTS.md`. Same automatic behavior.

### With devd plugin

If you use [devd](https://github.com/meetmousom2/devd), the `/codemap` skill is available and runs proactively before code exploration.

## CLI reference

```
codemap [path]                    Init: build graph + setup agent instructions
codemap init [path]               Same as above (explicit)
codemap query "question" [path]   Query the graph for relevant files
codemap build [path]              Build/update graph only (no init setup)
codemap --check [path]            Exit 0 if fresh, 1 if stale
codemap --install-hook [path]     Install git post-merge hook
codemap --help                    Show help
```

## Language support

| Language | Status |
|----------|--------|
| TypeScript / TSX | Supported |
| Python | Supported |
| Go | Supported |

Python coverage: classes (with methods, properties, decorators), functions
(including async, variadics, default args), PEP 695 `type` aliases,
docstrings (PEP 257), `__all__` filtering, and PEP 8 visibility conventions.
The import resolver handles `__init__.py` package roots, relative imports
(`from .x import y`, `from ..pkg import z`), and absolute imports against
detected source roots (`pyproject.toml`, `src/` layout, Poetry `packages`
declarations). PEP 420 namespace packages are best-effort — files inside one
are still indexed, but imports of a namespace package itself don't produce
an edge (no canonical file to attach it to).

Adding a new language = writing tree-sitter query patterns (~500 lines). The graph, ranker, and CLI are language-agnostic — extend the scanner and add patterns.

### Go notes

Go support parses package clauses, top-level functions, methods (attached to their receiver struct), struct fields, interfaces, type aliases, imports and doc comments. The import resolver reads `go.mod` to map the module path prefix onto local files, honors Go's `internal/` visibility rules, and falls back to `vendor/` for vendored dependencies. Call-graph resolution across interface method-sets is best-effort — dynamic dispatch through interface types is not fully resolved.

## Development

```bash
bun install
bun test          # 152 tests
bun run src/index.ts query "test question" .
```

## License

MIT
