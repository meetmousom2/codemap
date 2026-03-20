#!/usr/bin/env bun
/**
 * codemap — AST-based codebase knowledge graph generator.
 *
 * Builds a cached knowledge graph of any TypeScript/Python codebase,
 * then answers structural questions about it instantly.
 *
 * AI agents: use `codemap query "your question"` to get relevant context
 * about the codebase without grepping. The graph is cached and rebuilds
 * automatically when the code changes.
 *
 * Usage:
 *   codemap [path]                    Build/update the cached graph
 *   codemap query "question"          Query the graph for relevant files/symbols
 *   codemap query "question" [path]   Query a specific repo
 *   codemap --check [path]            Check if cache is stale (exit 1 if stale)
 *   codemap --install-hook [path]     Install git post-merge hook
 *
 * Examples:
 *   codemap                           # build graph for current repo
 *   codemap query "where is auth?"    # find auth-related files
 *   codemap query "how does retry work in workflows?"
 *   codemap ../other-repo             # build graph for another repo
 *
 * The graph is saved to .codemap/graph.json and rebuilds when HEAD changes.
 * Results are printed to stdout as compact markdown — ready for LLM consumption.
 */

import { resolve, join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { CliOptions, CodeGraph } from "./types";
import { buildCodeGraph } from "./graph";
import { addSummaries } from "./summarizer";
import { rankFiles, renderRankedResults, tokenize } from "./ranker";

interface ParsedArgs {
  command: "init" | "build" | "query" | "check" | "install-hook" | "help";
  path: string;
  query?: string;
  include: string[];
  exclude: string[];
}

function printUsage(): void {
  console.log(`codemap — AST-based codebase knowledge graph for AI agents

COMMANDS
  codemap [path]                    Init: build graph + update .gitignore + add agent instructions
  codemap init [path]               Same as above (explicit)
  codemap query "question" [path]   Query the graph — returns relevant files and symbols
  codemap build [path]              Build/update the cached graph only (no init setup)
  codemap --check [path]            Exit 0 if cache is fresh, 1 if stale
  codemap --install-hook [path]     Install git post-merge hook to auto-rebuild

OPTIONS
  --include <glob>    Include only matching files (repeatable)
  --exclude <glob>    Exclude matching files (repeatable)
  -h, --help          Show this help

EXAMPLES
  codemap                                     # build graph for .
  codemap query "where is memory stored?"     # find memory-related code
  codemap query "how does tool registration work?"
  codemap query "PostgreSQL storage adapter"
  codemap --check                             # CI freshness check

SETUP (one-time)
  npx @yuzu-team/codemap                Builds graph, updates .gitignore, adds instructions
                                        to CLAUDE.md/AGENTS.md, installs post-merge hook.
                                        Run this once per repo. Everything is automatic.

AI AGENT INSTRUCTIONS
  If .codemap/ doesn't exist, run \`npx @yuzu-team/codemap\` first to set up.
  Then use \`codemap query "your question"\` before grepping the codebase.
  It returns a ranked list of the most relevant files with their exports,
  classes, methods, and dependencies — typically 10-15 files in ~200 lines.
  The graph caches at .codemap/graph.json and auto-rebuilds when HEAD changes.

  Workflow:
    1. codemap query "question"  → read stdout for relevant context
    2. Read specific source files only if you need implementation details
    3. Never grep blindly — query first, then drill in`);
}

function parseArgs(args: string[]): ParsedArgs | null {
  if (args.length === 0) {
    return { command: "init", path: ".", include: [], exclude: [] };
  }

  // init command
  if (args[0] === "init") {
    const path = args[1] ?? ".";
    return { command: "init", path, include: [], exclude: [] };
  }

  if (args.includes("--help") || args.includes("-h")) {
    return { command: "help", path: ".", include: [], exclude: [] };
  }

  // build command (explicit)
  if (args[0] === "build") {
    const path = args[1] ?? ".";
    return { command: "build", path, include: [], exclude: [] };
  }

  // Check for --check
  if (args.includes("--check")) {
    const remaining = args.filter((a) => a !== "--check");
    const path = remaining.find((a) => !a.startsWith("-")) ?? ".";
    return { command: "check", path, include: [], exclude: [] };
  }

  // Check for --install-hook
  if (args.includes("--install-hook")) {
    const remaining = args.filter((a) => a !== "--install-hook");
    const path = remaining.find((a) => !a.startsWith("-")) ?? ".";
    return { command: "install-hook", path, include: [], exclude: [] };
  }

  // Check for query command
  if (args[0] === "query") {
    if (args.length < 2) {
      console.error("Error: query requires a question string");
      return null;
    }
    const query = args[1]!;
    const path = args[2] ?? ".";
    return { command: "query", path, query, include: [], exclude: [] };
  }

  // Default: build command with optional path and flags
  const result: ParsedArgs = { command: "build", path: ".", include: [], exclude: [] };

  let i = 0;
  if (args[0] && !args[0].startsWith("-")) {
    result.path = args[0];
    i = 1;
  }

  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--include" && i + 1 < args.length) {
      result.include.push(args[++i]!);
    } else if (arg === "--exclude" && i + 1 < args.length) {
      result.exclude.push(args[++i]!);
    } else if (!arg.startsWith("-")) {
      result.path = arg;
    }
    i++;
  }

  return result;
}

const CACHE_DIR = ".codemap";
const CACHE_FILE = "graph.json";

async function getCacheDir(rootPath: string): Promise<string> {
  const dir = join(rootPath, CACHE_DIR);
  await mkdir(dir, { recursive: true });
  return dir;
}

function getHeadCommit(rootPath: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: rootPath });
    return proc.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

async function loadCachedGraph(rootPath: string): Promise<CodeGraph | null> {
  const cachePath = join(rootPath, CACHE_DIR, CACHE_FILE);
  if (!existsSync(cachePath)) return null;

  try {
    const content = await Bun.file(cachePath).text();
    const graph = JSON.parse(content) as CodeGraph;

    // Check if cache is fresh
    const headCommit = getHeadCommit(rootPath);
    if (headCommit && graph.commitHash === headCommit) {
      return graph;
    }

    return null; // stale
  } catch {
    return null;
  }
}

async function saveGraph(rootPath: string, graph: CodeGraph): Promise<void> {
  const cacheDir = await getCacheDir(rootPath);
  const cachePath = join(cacheDir, CACHE_FILE);
  await Bun.write(cachePath, JSON.stringify(graph));
}

async function ensureGraph(
  rootPath: string,
  options: { include?: string[]; exclude?: string[] } = {},
): Promise<CodeGraph> {
  // Try cache first
  const cached = await loadCachedGraph(rootPath);
  if (cached) {
    return cached;
  }

  // Build fresh
  const startTime = Date.now();
  console.error(`codemap: building graph for ${rootPath}...`);
  const graph = await buildCodeGraph(rootPath, options);
  addSummaries(graph.modules, graph.files);
  await saveGraph(rootPath, graph);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`codemap: ${graph.files.length} files, ${graph.modules.length} modules, ${graph.edges.length} edges (${elapsed}s)`);

  return graph;
}

async function checkStale(rootPath: string): Promise<boolean> {
  const cached = await loadCachedGraph(rootPath);
  if (!cached) {
    console.log("No cached graph — stale");
    return true;
  }
  console.log(`Graph is fresh (commit: ${cached.commitHash})`);
  return false;
}

async function installHook(rootPath: string): Promise<void> {
  const hookDir = join(rootPath, ".git", "hooks");
  if (!existsSync(hookDir)) {
    console.error("Error: .git/hooks not found. Is this a git repo?");
    process.exit(1);
  }

  const hookPath = join(hookDir, "post-merge");
  const hookCommand = '#!/bin/sh\nnpx @yuzu-team/codemap "$(git rev-parse --show-toplevel)"\n';

  if (existsSync(hookPath)) {
    const existing = await Bun.file(hookPath).text();
    if (existing.includes("codemap")) {
      console.log("Post-merge hook already installed.");
      return;
    }
    await Bun.write(hookPath, existing + "\n" + hookCommand);
  } else {
    await Bun.write(hookPath, hookCommand);
  }

  Bun.spawnSync(["chmod", "+x", hookPath]);
  console.log(`  Post-merge hook installed`);
}

const CODEMAP_INSTRUCTION = `## Before exploring code
Run \`npx @yuzu-team/codemap query "your question"\` before grepping the codebase.
Returns ranked relevant files with exports, classes, methods, and dependencies (~200 lines).
`;

/**
 * Full init: build graph + gitignore + agent instructions + hook.
 * This is the one-command setup for any repo.
 */
async function initRepo(rootPath: string, options: { include?: string[]; exclude?: string[] }): Promise<void> {
  console.log("codemap init: setting up for", rootPath);
  console.log("");

  // 1. Build graph
  const graph = await ensureGraph(rootPath, options);
  console.log(`  Graph: ${graph.files.length} files, ${graph.modules.length} modules`);

  // 2. Add .codemap/ to .gitignore
  const gitignorePath = join(rootPath, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = await Bun.file(gitignorePath).text();
    if (!content.includes(".codemap")) {
      await Bun.write(gitignorePath, content.trimEnd() + "\n.codemap/\n");
      console.log("  Added .codemap/ to .gitignore");
    } else {
      console.log("  .gitignore already has .codemap/");
    }
  } else {
    await Bun.write(gitignorePath, ".codemap/\n");
    console.log("  Created .gitignore with .codemap/");
  }

  // 3. Add instruction to CLAUDE.md and/or AGENTS.md
  let addedTo: string[] = [];

  for (const file of ["CLAUDE.md", "AGENTS.md"]) {
    const filePath = join(rootPath, file);
    if (existsSync(filePath)) {
      const content = await Bun.file(filePath).text();
      if (content.includes("codemap query")) {
        console.log(`  ${file} already has codemap instructions`);
      } else {
        // Find insertion point: after first heading block (heading + blank lines)
        const lines = content.split("\n");
        let insertIdx = 0;
        // Skip to end of first heading (# line + any immediately following non-blank lines)
        for (let j = 0; j < lines.length; j++) {
          if (lines[j]!.startsWith("#")) {
            insertIdx = j + 1;
            // Skip blank lines after heading
            while (insertIdx < lines.length && lines[insertIdx]!.trim() === "") {
              insertIdx++;
            }
            break;
          }
        }
        lines.splice(insertIdx, 0, "", ...CODEMAP_INSTRUCTION.split("\n"), "");
        await Bun.write(filePath, lines.join("\n"));
        addedTo.push(file);
        console.log(`  Added codemap instructions to ${file}`);
      }
    }
  }

  // If neither CLAUDE.md nor AGENTS.md exists, create AGENTS.md
  if (addedTo.length === 0) {
    const agentsPath = join(rootPath, "AGENTS.md");
    if (!existsSync(agentsPath)) {
      await Bun.write(agentsPath, `# Agent Instructions\n\n${CODEMAP_INSTRUCTION}`);
      console.log("  Created AGENTS.md with codemap instructions");
    }
  }

  // 4. Install post-merge hook
  const hookDir = join(rootPath, ".git", "hooks");
  if (existsSync(hookDir)) {
    await installHook(rootPath);
  } else {
    console.log("  No .git/hooks — skipping post-merge hook");
  }

  console.log("");
  console.log("Done! AI agents will now use codemap automatically.");
  console.log("Run `codemap query \"your question\"` to test it.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);

  if (!parsed) {
    printUsage();
    process.exit(1);
  }

  if (parsed.command === "help") {
    printUsage();
    process.exit(0);
  }

  const rootPath = resolve(parsed.path);

  if (!existsSync(rootPath)) {
    console.error(`Error: Path '${rootPath}' does not exist`);
    process.exit(1);
  }

  switch (parsed.command) {
    case "init": {
      await initRepo(rootPath, { include: parsed.include, exclude: parsed.exclude });
      return;
    }

    case "check": {
      const stale = await checkStale(rootPath);
      process.exit(stale ? 1 : 0);
    }

    case "install-hook": {
      await installHook(rootPath);
      return;
    }

    case "build": {
      const graph = await ensureGraph(rootPath, {
        include: parsed.include,
        exclude: parsed.exclude,
      });
      console.log(`Graph cached at ${CACHE_DIR}/${CACHE_FILE} (commit: ${graph.commitHash})`);
      return;
    }

    case "query": {
      const graph = await ensureGraph(rootPath, {
        include: parsed.include,
        exclude: parsed.exclude,
      });
      const ranked = rankFiles(graph, parsed.query!);
      const queryTerms = tokenize(parsed.query!);
      const output = renderRankedResults(ranked, graph.root, queryTerms);
      // Query results go to stdout (for piping/reading by agents)
      // Build status goes to stderr (already handled by ensureGraph)
      console.log(output);
      return;
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
