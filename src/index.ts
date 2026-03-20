#!/usr/bin/env bun
/**
 * codemap — AST-based codebase knowledge graph generator.
 * Generates CODEMAP.md from any TypeScript/Python codebase.
 *
 * Usage: npx @yuzu-team/codemap [path] [options]
 */

import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import type { CliOptions } from "./types";
import { buildCodeGraph } from "./graph";
import { addSummaries } from "./summarizer";
import { renderCodemap } from "./renderer";

function printUsage(): void {
  console.log(`codemap — AST-based codebase knowledge graph generator

Usage:
  codemap [path] [options]

Arguments:
  path                        Root directory to analyze (default: .)

Options:
  --output, -o <file>         Output file path (default: CODEMAP.md)
  --include <glob>            Include glob pattern (can be repeated)
  --exclude <glob>            Exclude glob pattern (can be repeated)
  --check                     Check if CODEMAP.md is stale (exit 1 if stale)
  --install-hook              Install git post-merge hook
  --help, -h                  Show this help message

Examples:
  codemap                                     # current directory
  codemap .                                   # explicit current directory
  codemap ../other-repo                       # another repo
  codemap . -o docs/CODEMAP.md                # custom output
  codemap . --exclude "**/*.test.ts"          # skip test files
  codemap . --check                           # CI staleness check`);
}

function parseArgs(args: string[]): CliOptions | null {
  if (args.includes("--help") || args.includes("-h")) {
    return null;
  }

  const options: CliOptions = {
    path: ".",
    output: "CODEMAP.md",
    include: [],
    exclude: [],
    check: false,
    installHook: false,
  };

  let i = 0;

  // First non-flag argument is the path
  if (args[0] && !args[0].startsWith("-")) {
    options.path = args[0];
    i = 1;
  }

  while (i < args.length) {
    const arg = args[i]!;

    switch (arg) {
      case "--output":
      case "-o":
        i++;
        if (i >= args.length) {
          console.error("Error: --output requires a value");
          return null;
        }
        options.output = args[i]!;
        break;

      case "--include":
        i++;
        if (i >= args.length) {
          console.error("Error: --include requires a value");
          return null;
        }
        options.include.push(args[i]!);
        break;

      case "--exclude":
        i++;
        if (i >= args.length) {
          console.error("Error: --exclude requires a value");
          return null;
        }
        options.exclude.push(args[i]!);
        break;

      case "--check":
        options.check = true;
        break;

      case "--install-hook":
        options.installHook = true;
        break;

      default:
        console.error(`Error: Unknown option '${arg}'`);
        return null;
    }

    i++;
  }

  return options;
}

async function checkStale(rootPath: string, outputPath: string): Promise<boolean> {
  const fullOutputPath = resolve(rootPath, outputPath);
  if (!existsSync(fullOutputPath)) {
    console.log("CODEMAP.md does not exist — stale");
    return true;
  }

  const content = await Bun.file(fullOutputPath).text();
  const commitMatch = content.match(/Commit: (\w+)/);
  if (!commitMatch) {
    console.log("CODEMAP.md has no commit hash — stale");
    return true;
  }

  const mapCommit = commitMatch[1];
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: rootPath });
    const headCommit = proc.stdout.toString().trim();
    if (mapCommit === headCommit) {
      console.log(`CODEMAP.md is fresh (commit: ${headCommit})`);
      return false;
    } else {
      console.log(`CODEMAP.md is stale (map: ${mapCommit}, HEAD: ${headCommit})`);
      return true;
    }
  } catch {
    console.log("Not a git repo — cannot check staleness");
    return true;
  }
}

async function installHook(rootPath: string): Promise<void> {
  const hookDir = join(rootPath, ".git", "hooks");
  if (!existsSync(hookDir)) {
    console.error("Error: .git/hooks not found. Is this a git repo?");
    process.exit(1);
  }

  const hookPath = join(hookDir, "post-merge");
  const hookCommand = "#!/bin/sh\nbunx @yuzu-team/codemap .\n";

  if (existsSync(hookPath)) {
    const existing = await Bun.file(hookPath).text();
    if (existing.includes("codemap")) {
      console.log("Post-merge hook already installed.");
      return;
    }
    // Append to existing hook
    await Bun.write(hookPath, existing + "\n" + hookCommand);
  } else {
    await Bun.write(hookPath, hookCommand);
  }

  // Make executable
  Bun.spawnSync(["chmod", "+x", hookPath]);
  console.log(`Post-merge hook installed at ${hookPath}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (!options) {
    printUsage();
    process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
  }

  const rootPath = resolve(options.path);

  if (!existsSync(rootPath)) {
    console.error(`Error: Path '${rootPath}' does not exist`);
    process.exit(1);
  }

  // --install-hook
  if (options.installHook) {
    await installHook(rootPath);
    return;
  }

  // --check
  if (options.check) {
    const stale = await checkStale(rootPath, options.output);
    process.exit(stale ? 1 : 0);
  }

  // Generate
  const startTime = Date.now();
  console.log(`codemap: analyzing ${rootPath}`);

  const graph = await buildCodeGraph(rootPath, {
    include: options.include,
    exclude: options.exclude,
  });

  addSummaries(graph.modules, graph.files);

  const markdown = renderCodemap(graph);
  const outputPath = resolve(rootPath, options.output);
  await Bun.write(outputPath, markdown);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  ${graph.files.length} files, ${graph.modules.length} modules, ${graph.edges.length} edges`);
  console.log(`  Written to ${options.output} (${elapsed}s)`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
