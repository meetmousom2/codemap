/**
 * Import resolver — resolves import paths to actual file paths.
 * Language-agnostic interface with TypeScript and Python implementations.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, dirname, relative, extname } from "node:path";
import type { FileNode, Import, ReExport, Edge, Language } from "./types";

/** Resolver interface — each language provides its own */
export interface ImportResolver {
  language: Language;
  resolveImport(importSource: string, fromFile: string, rootPath: string): string | null;
}

/** Registered resolvers by language */
const resolvers = new Map<Language, ImportResolver>();

export function registerResolver(resolver: ImportResolver): void {
  resolvers.set(resolver.language, resolver);
}

// ============================================================
// TypeScript resolver
// ============================================================

interface TsConfig {
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

let cachedTsConfig: TsConfig | null = null;
let cachedTsConfigRoot: string | null = null;

async function loadTsConfig(rootPath: string): Promise<TsConfig | null> {
  if (cachedTsConfigRoot === rootPath && cachedTsConfig !== null) return cachedTsConfig;

  const tsConfigPath = join(rootPath, "tsconfig.json");
  if (!existsSync(tsConfigPath)) {
    cachedTsConfig = null;
    cachedTsConfigRoot = rootPath;
    return null;
  }

  try {
    const content = await Bun.file(tsConfigPath).text();
    // Strip comments (// and /* */) before parsing
    const stripped = content
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/,\s*([\]}])/g, "$1"); // trailing commas
    cachedTsConfig = JSON.parse(stripped);
    cachedTsConfigRoot = rootPath;
    return cachedTsConfig;
  } catch {
    cachedTsConfig = null;
    cachedTsConfigRoot = rootPath;
    return null;
  }
}

/** Try to resolve a file path with TypeScript extensions */
function resolveWithExtensions(basePath: string): string | null {
  const extensions = [".ts", ".tsx", ".d.ts", ".js", ".jsx"];

  // Exact match
  if (existsSync(basePath)) {
    const ext = extname(basePath);
    if (extensions.includes(ext) || ext === "") {
      if (ext === "") {
        // Might be a directory — check for index file
        return resolveIndexFile(basePath);
      }
      return basePath;
    }
  }

  // Try adding extensions
  for (const ext of extensions) {
    const withExt = basePath + ext;
    if (existsSync(withExt)) return withExt;
  }

  // Try as directory with index file
  return resolveIndexFile(basePath);
}

/** Try to resolve a directory to its index file */
function resolveIndexFile(dirPath: string): string | null {
  const indexExtensions = ["index.ts", "index.tsx", "index.js", "index.jsx"];
  for (const indexFile of indexExtensions) {
    const indexPath = join(dirPath, indexFile);
    if (existsSync(indexPath)) return indexPath;
  }
  return null;
}

/** Resolve a TypeScript path alias using tsconfig.json paths */
function resolvePathAlias(
  importSource: string,
  tsConfig: TsConfig,
  rootPath: string,
): string | null {
  const paths = tsConfig.compilerOptions?.paths;
  if (!paths) return null;

  const baseUrl = tsConfig.compilerOptions?.baseUrl ?? ".";
  const baseDir = resolve(rootPath, baseUrl);

  for (const [pattern, targets] of Object.entries(paths)) {
    // Handle exact match patterns (no wildcard)
    if (!pattern.includes("*")) {
      if (importSource === pattern && targets.length > 0) {
        const resolved = resolveWithExtensions(resolve(baseDir, targets[0]!));
        if (resolved) return resolved;
      }
      continue;
    }

    // Handle wildcard patterns like "@yuzu/platform/*"
    const prefix = pattern.slice(0, pattern.indexOf("*"));
    const suffix = pattern.slice(pattern.indexOf("*") + 1);

    if (importSource.startsWith(prefix) && (suffix === "" || importSource.endsWith(suffix))) {
      const wildcardMatch = importSource.slice(prefix.length, suffix ? -suffix.length : undefined);

      for (const target of targets) {
        const resolvedTarget = target.replace("*", wildcardMatch);
        const resolved = resolveWithExtensions(resolve(baseDir, resolvedTarget));
        if (resolved) return resolved;
      }
    }
  }

  return null;
}

/** TypeScript import resolver */
export function createTypescriptResolver(): ImportResolver {
  return {
    language: "typescript",
    resolveImport(importSource: string, fromFile: string, rootPath: string): string | null {
      // External packages
      if (!importSource.startsWith(".") && !importSource.startsWith("/")) {
        // Try path alias
        const tsConfig = cachedTsConfig;
        if (tsConfig) {
          const aliased = resolvePathAlias(importSource, tsConfig, rootPath);
          if (aliased) return relative(rootPath, aliased);
        }
        return null; // external package
      }

      // Relative import
      const fromDir = dirname(resolve(rootPath, fromFile));
      const targetPath = resolve(fromDir, importSource);
      const resolved = resolveWithExtensions(targetPath);
      return resolved ? relative(rootPath, resolved) : null;
    },
  };
}

// ============================================================
// Python resolver
// ============================================================

/** Python import resolver */
export function createPythonResolver(): ImportResolver {
  return {
    language: "python",
    resolveImport(importSource: string, fromFile: string, rootPath: string): string | null {
      // Handle relative imports (from . import x, from .. import y)
      if (importSource.startsWith(".")) {
        const dots = importSource.match(/^\.+/)?.[0].length ?? 0;
        const fromDir = dirname(resolve(rootPath, fromFile));

        // Go up 'dots - 1' directories (one dot = current package)
        let targetDir = fromDir;
        for (let i = 1; i < dots; i++) {
          targetDir = dirname(targetDir);
        }

        const modulePart = importSource.slice(dots);
        if (modulePart) {
          const modulePath = modulePart.replace(/\./g, "/");
          return resolvePythonModule(join(targetDir, modulePath), rootPath);
        }

        // from . import x — resolve to __init__.py in current dir
        const initPath = join(targetDir, "__init__.py");
        if (existsSync(initPath)) return relative(rootPath, initPath);
        return null;
      }

      // Absolute import — try from project root
      const modulePath = importSource.replace(/\./g, "/");
      return resolvePythonModule(join(rootPath, modulePath), rootPath);
    },
  };
}

/** Try to resolve a Python module path */
function resolvePythonModule(basePath: string, rootPath: string): string | null {
  // Try as a .py file
  const pyFile = basePath + ".py";
  if (existsSync(pyFile)) return relative(rootPath, pyFile);

  // Try as a package (directory with __init__.py)
  const initFile = join(basePath, "__init__.py");
  if (existsSync(initFile)) return relative(rootPath, initFile);

  return null;
}

// ============================================================
// Go resolver
// ============================================================

/**
 * Go module info parsed from `go.mod`.
 *
 * `modulePath` is the import path of the module root (e.g. "github.com/spf13/cobra").
 * Imports whose source starts with `modulePath + "/"` (or equals `modulePath`)
 * map to a local file path. Everything else is treated as a third-party or
 * stdlib dependency and left unresolved.
 */
interface GoModInfo {
  /** Root import path declared by `module ...` in go.mod. */
  modulePath: string;
  /** Whether a `vendor/` directory exists at the repo root. */
  hasVendor: boolean;
}

let cachedGoMod: GoModInfo | null = null;
let cachedGoModRoot: string | null = null;

async function loadGoMod(rootPath: string): Promise<GoModInfo | null> {
  if (cachedGoModRoot === rootPath && cachedGoMod !== null) return cachedGoMod;

  const goModPath = join(rootPath, "go.mod");
  if (!existsSync(goModPath)) {
    cachedGoMod = null;
    cachedGoModRoot = rootPath;
    return null;
  }

  try {
    const content = await Bun.file(goModPath).text();
    // First non-empty, non-comment `module <path>` line wins.
    let modulePath = "";
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//")) continue;
      const match = line.match(/^module\s+(\S+)/);
      if (match) {
        modulePath = match[1]!;
        break;
      }
    }
    if (!modulePath) {
      cachedGoMod = null;
      cachedGoModRoot = rootPath;
      return null;
    }

    const hasVendor = existsSync(join(rootPath, "vendor"));
    cachedGoMod = { modulePath, hasVendor };
    cachedGoModRoot = rootPath;
    return cachedGoMod;
  } catch {
    cachedGoMod = null;
    cachedGoModRoot = rootPath;
    return null;
  }
}

/**
 * Pick a representative `.go` file inside `dir` to act as the resolved target
 * for a package import. Go imports name a package (a directory of files), not
 * a single file. We prefer a file matching the directory's base name; failing
 * that we take the lexicographically first non-test `.go` file; failing that
 * any `.go` file. Returns an absolute path or null if no file qualifies.
 */
function pickPackageFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let stats;
  try {
    stats = statSync(dir);
  } catch {
    return null;
  }
  if (!stats.isDirectory()) return null;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  const goFiles = entries.filter((f) => f.endsWith(".go"));
  if (goFiles.length === 0) return null;

  const base = dir.split("/").pop() ?? "";
  const preferred = `${base}.go`;
  if (goFiles.includes(preferred)) return join(dir, preferred);

  const nonTest = goFiles.filter((f) => !f.endsWith("_test.go")).sort();
  if (nonTest.length > 0) return join(dir, nonTest[0]!);

  return join(dir, goFiles.sort()[0]!);
}

/**
 * Enforce Go's `internal/` package visibility rule: a package whose import
 * path contains an `internal/` segment can only be imported from packages
 * sharing the same parent of that `internal/` segment. We compute the
 * importer's relative path within the module to make the check.
 *
 * Example: `github.com/foo/bar/internal/secret` is importable from
 * `github.com/foo/bar/...` but NOT from `github.com/other/...`.
 */
function isInternalVisible(
  importSource: string,
  modulePath: string,
  fromFileRel: string,
): boolean {
  const idx = importSource.indexOf("/internal/");
  const trailing = importSource.endsWith("/internal");
  if (idx < 0 && !trailing) return true; // not an internal package

  // The parent path (everything before "/internal").
  const parentImportPath = trailing
    ? importSource.slice(0, importSource.length - "/internal".length)
    : importSource.slice(0, idx);

  // Convert parent import path back into a repo-relative directory.
  // - If parentImportPath === modulePath, the parent is the repo root ("").
  // - If parentImportPath starts with modulePath + "/", strip that prefix.
  // - Otherwise the internal package lives in another module we can't see —
  //   conservatively treat as not visible.
  let parentDir: string | null = null;
  if (parentImportPath === modulePath) parentDir = "";
  else if (parentImportPath.startsWith(modulePath + "/"))
    parentDir = parentImportPath.slice(modulePath.length + 1);
  else return false;

  // Importer must live inside `parentDir` (or be in `parentDir` itself).
  const fromDir = dirname(fromFileRel);
  if (parentDir === "") return true; // any package in this module can see
  return fromDir === parentDir || fromDir.startsWith(parentDir + "/");
}

/**
 * Go import resolver. Resolution order:
 *   1. Standard library / unknown external — return null.
 *   2. Module-local import (import source starts with module path) — map to
 *      `<rootPath>/<relative dir>/<file>.go`, honoring `internal/` rules.
 *   3. Vendored import — `<rootPath>/vendor/<import source>/<file>.go`.
 */
export function createGoResolver(): ImportResolver {
  return {
    language: "go",
    resolveImport(importSource: string, fromFile: string, rootPath: string): string | null {
      const mod = cachedGoMod;

      // Module-local first.
      if (mod) {
        const isLocal =
          importSource === mod.modulePath ||
          importSource.startsWith(mod.modulePath + "/");
        if (isLocal) {
          if (!isInternalVisible(importSource, mod.modulePath, fromFile)) {
            return null;
          }
          const relPath =
            importSource === mod.modulePath
              ? ""
              : importSource.slice(mod.modulePath.length + 1);
          const dirAbs = join(rootPath, relPath);
          const picked = pickPackageFile(dirAbs);
          return picked ? relative(rootPath, picked) : null;
        }

        // Vendored fallback.
        if (mod.hasVendor) {
          const vendorDir = join(rootPath, "vendor", importSource);
          const picked = pickPackageFile(vendorDir);
          if (picked) return relative(rootPath, picked);
        }
      }

      // Stdlib (no dot in first segment) and unrecognized external — unresolved.
      return null;
    },
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * Initialize resolvers for a project. Loads tsconfig.json, go.mod, etc.
 */
export async function initResolvers(rootPath: string): Promise<void> {
  await loadTsConfig(rootPath);
  await loadGoMod(rootPath);

  registerResolver(createTypescriptResolver());
  registerResolver(createPythonResolver());
  registerResolver(createGoResolver());
}

/**
 * Resolve all imports in a FileNode to actual file paths.
 * Mutates the imports' resolvedPath field.
 */
export function resolveFileImports(
  fileNode: FileNode,
  rootPath: string,
): void {
  const resolver = resolvers.get(fileNode.language);
  if (!resolver) return;

  for (const imp of fileNode.imports) {
    if (imp.isExternal) {
      // Still try aliases / module-local resolution for TypeScript and Go.
      // (Go imports always look like absolute paths from the file's POV — the
      // resolver decides whether they're stdlib, vendored, or module-local.)
      if (fileNode.language === "typescript" || fileNode.language === "go") {
        const resolved = resolver.resolveImport(imp.source, fileNode.path, rootPath);
        if (resolved) {
          imp.resolvedPath = resolved;
          imp.isExternal = false;
        }
      }
      continue;
    }

    imp.resolvedPath = resolver.resolveImport(imp.source, fileNode.path, rootPath);
  }

  // Also resolve re-export paths
  for (const reExport of fileNode.reExports) {
    reExport.resolvedPath = resolver.resolveImport(reExport.source, fileNode.path, rootPath);
  }
}

/**
 * Build dependency edges from resolved imports across all files.
 */
export function buildEdges(files: FileNode[]): Edge[] {
  const edges: Edge[] = [];

  for (const file of files) {
    for (const imp of file.imports) {
      if (imp.resolvedPath) {
        const importedNames = [
          ...(imp.defaultImport ? [imp.defaultImport] : []),
          ...imp.namedImports,
          ...(imp.namespaceImport ? [imp.namespaceImport] : []),
        ];
        edges.push({
          from: file.path,
          to: imp.resolvedPath,
          importedNames,
        });
      }
    }

    // Re-exports also create edges
    for (const reExport of file.reExports) {
      if (reExport.resolvedPath) {
        edges.push({
          from: file.path,
          to: reExport.resolvedPath,
          importedNames: reExport.names.length > 0 ? reExport.names : ["*"],
        });
      }
    }
  }

  return edges;
}

/** Reset cached config (for testing) */
export function resetResolverCache(): void {
  cachedTsConfig = null;
  cachedTsConfigRoot = null;
  cachedGoMod = null;
  cachedGoModRoot = null;
  resolvers.clear();
}
