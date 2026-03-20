/**
 * Scanner - recursively walks a directory to find TypeScript files.
 * Respects .gitignore patterns and supports custom include/exclude globs.
 */

import { readdir, lstat, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import ignore, { type Ignore } from "ignore";

/** Default directories to always skip */
const DEFAULT_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".git",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
]);

/** Default file extensions to scan */
const TS_EXTENSIONS = new Set([".ts", ".tsx"]);

/** Options for the scanner */
export interface ScanOptions {
  /** Include glob patterns - if set, only matching files are included */
  include?: string[];
  /** Exclude glob patterns - matching files are excluded */
  exclude?: string[];
  /** Follow symlinks instead of skipping them (default: false) */
  followSymlinks?: boolean;
}

/**
 * Load and parse a .gitignore file, returning an Ignore instance.
 * Returns null if no .gitignore exists.
 */
async function loadGitignore(rootPath: string): Promise<Ignore | null> {
  const gitignorePath = join(rootPath, ".gitignore");
  const file = Bun.file(gitignorePath);

  if (!(await file.exists())) {
    return null;
  }

  const content = await file.text();
  const ig = ignore();
  ig.add(content);
  return ig;
}

/**
 * Check if a filename has a TypeScript extension.
 */
function isTypeScriptFile(filename: string): boolean {
  for (const ext of TS_EXTENSIONS) {
    if (filename.endsWith(ext)) return true;
  }
  return false;
}

/**
 * Create an Ignore instance for custom include/exclude patterns.
 */
function createExcludeFilter(patterns: string[]): Ignore | null {
  if (patterns.length === 0) return null;
  const ig = ignore();
  ig.add(patterns);
  return ig;
}

/**
 * Check if a relative path matches any of the include patterns.
 * Uses the `ignore` library in reverse: if the path is "ignored" by the include
 * patterns, it means it matches and should be included.
 */
function matchesInclude(relativePath: string, includeFilter: Ignore): boolean {
  // The ignore library filters OUT matching paths, so we use it to check
  // if the path matches the pattern
  return includeFilter.ignores(relativePath);
}

/**
 * Recursively walk a directory and collect TypeScript file paths.
 */
async function walkDirectory(
  dirPath: string,
  rootPath: string,
  gitignore: Ignore | null,
  excludeFilter: Ignore | null,
  followSymlinks: boolean,
  results: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    // Skip directories we can't read
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    const relativePath = relative(rootPath, fullPath);

    // Handle symlinks
    if (entry.isSymbolicLink()) {
      if (!followSymlinks) continue;
      // Resolve symlink target and check if it's within the root (prevent escape)
      try {
        const realTarget = await realpath(fullPath);
        const absRoot = resolve(rootPath);
        if (!realTarget.startsWith(absRoot)) continue; // skip symlinks that escape root
        const targetStat = await lstat(realTarget);
        if (targetStat.isDirectory()) {
          await walkDirectory(fullPath, rootPath, gitignore, excludeFilter, followSymlinks, results);
        } else if (targetStat.isFile() && isTypeScriptFile(entry.name)) {
          results.push(relativePath);
        }
      } catch {
        // Skip broken symlinks
        continue;
      }
      continue;
    }

    // Skip default directories
    if (entry.isDirectory() && DEFAULT_SKIP_DIRS.has(entry.name)) {
      continue;
    }

    // Check .gitignore
    if (gitignore && gitignore.ignores(relativePath)) {
      continue;
    }

    // Check custom exclude patterns
    if (excludeFilter && excludeFilter.ignores(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      await walkDirectory(fullPath, rootPath, gitignore, excludeFilter, followSymlinks, results);
    } else if (entry.isFile() && isTypeScriptFile(entry.name)) {
      results.push(relativePath);
    }
  }
}

/**
 * Scan a directory for TypeScript files.
 *
 * @param rootPath - Absolute path to the project root
 * @param options - Include/exclude glob patterns
 * @returns Sorted list of file paths relative to rootPath
 */
export async function scan(
  rootPath: string,
  options: ScanOptions = {},
): Promise<string[]> {
  const { include = [], exclude = [], followSymlinks = false } = options;
  const absRoot = resolve(rootPath);

  // Load .gitignore
  const gitignore = await loadGitignore(absRoot);

  // Create exclude filter from custom patterns
  const excludeFilter = createExcludeFilter(exclude);

  // Create include filter
  const includeFilter = include.length > 0
    ? createExcludeFilter(include)
    : null;

  // Walk the directory tree
  const allFiles: string[] = [];
  await walkDirectory(absRoot, absRoot, gitignore, excludeFilter, followSymlinks, allFiles);

  // Apply include filter: keep only files that match include patterns
  const filtered = includeFilter
    ? allFiles.filter((f) => matchesInclude(f, includeFilter))
    : allFiles;

  // Sort for deterministic output
  return filtered.sort();
}
