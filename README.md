# codemap

AST-based codebase knowledge graph for AI agents. One command to set up, one command to query. Works with Claude Code, Codex, Cursor, or any AI coding tool.

**Problem:** Every new AI session starts cold. The agent greps blindly, reads wrong files, backtracks. This wastes tool calls and time.

**Solution:** codemap builds a cached knowledge graph from your codebase's AST (tree-sitter), then answers structural questions instantly using keyword matching + PageRank.

## Install

```bash
npx @yuzu-team/codemap
```

That's it. This one command:
1. Parses your codebase (TypeScript + Python)
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

1. **Scan** — finds all `.ts`, `.tsx`, `.py` files (respects `.gitignore`)
2. **Parse** — extracts AST via tree-sitter: exports, classes, functions, types, imports, JSDoc
3. **Resolve** — resolves imports to file paths (tsconfig aliases, Python packages)
4. **Graph** — builds dependency edges, detects modules, computes cross-file call references
5. **Rank** — on query, scores files by keyword matching + PageRank on the dependency graph
6. **Return** — outputs ~200 lines of the most relevant files with signatures and relationships

The graph caches at `.codemap/graph.json` and auto-rebuilds when `HEAD` changes.

## Eval results

Tested on 3 repos with 5 questions each. Measured tool calls (Grep/Read/Glob) needed to answer structural questions about the codebase.

| Repo | Files | Without codemap | With codemap | Reduction |
|------|-------|----------------|--------------|-----------|
| yuzu-ai | 202 | 15 calls | 4 calls | **73%** |
| Mastra | 4,102 | 13 calls | 5 calls | **62%** |
| Inngest JS | ~500 | 17 calls | 7 calls | **59%** |

## Agent integration

codemap works with any AI coding tool. After `npx @yuzu-team/codemap`, the agent instructions are automatically added to your repo's `CLAUDE.md` or `AGENTS.md`:

```markdown
## Before exploring code
Run `npx @yuzu-team/codemap query "your question"` before grepping the codebase.
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
| Python | Scanner support (parser coming) |

Adding a new language = writing tree-sitter query patterns (~200 lines). The scanner, graph, ranker, and CLI are language-agnostic.

## Development

```bash
bun install
bun test          # 61 tests
bun run src/index.ts query "test question" .
```

## License

MIT
