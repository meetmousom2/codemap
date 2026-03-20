#!/usr/bin/env bun
/**
 * codemap - AST-based codebase knowledge graph generator.
 * CLI entry point. Run with: bun run src/index.ts [path] [options]
 */

import type { CliOptions } from "./types";

function printUsage(): void {
  console.log(`codemap — AST-based codebase knowledge graph generator

Usage:
  codemap <path> [options]

Arguments:
  path                        Root directory to analyze

Options:
  --output, -o <file>         Output file path (default: CODEMAP.md)
  --include <glob>            Include glob pattern (can be repeated)
  --exclude <glob>            Exclude glob pattern (can be repeated)
  --check                     Check if CODEMAP.md is stale
  --install-hook              Install git post-merge hook
  --help, -h                  Show this help message

Examples:
  codemap .
  codemap . --output docs/CODEMAP.md
  codemap . --include "src/**" --exclude "**/*.test.ts"
  codemap . --check`);
}

function parseArgs(args: string[]): CliOptions | null {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (!options) {
    printUsage();
    process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
  }

  // Resolve path to absolute
  const { resolve } = await import("node:path");
  const rootPath = resolve(options.path);

  // Verify the path exists
  const { existsSync } = await import("node:fs");
  if (!existsSync(rootPath)) {
    console.error(`Error: Path '${rootPath}' does not exist`);
    process.exit(1);
  }

  console.log(`codemap: analyzing ${rootPath}`);
  console.log(`  output:  ${options.output}`);
  if (options.include.length > 0) console.log(`  include: ${options.include.join(", ")}`);
  if (options.exclude.length > 0) console.log(`  exclude: ${options.exclude.join(", ")}`);
  if (options.check) console.log(`  mode:    check (stale detection)`);

  // TODO: Wire up scanner, parser, graph, renderer in later epics
  console.log("\nScanner, parser, and renderer not yet implemented.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
