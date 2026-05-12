/**
 * Import resolver — resolves import paths to actual file paths.
 * Language-agnostic interface with TypeScript and Python implementations.
 */

import { existsSync } from "node:fs";
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

/**
 * Cached Python source roots for the current project. Source roots are
 * directories from which absolute imports are resolved (analogous to entries
 * on PYTHONPATH). Common candidates: project root, `src/`, packages directly
 * containing `__init__.py`, and `packages` declared in pyproject.toml.
 */
let cachedPySourceRoots: string[] | null = null;
let cachedPyRoot: string | null = null;

/**
 * Detect Python source roots by looking at common project layouts.
 *
 * Priority order (first hit wins per candidate):
 *   1. `<root>/src` if it exists (standard "src layout").
 *   2. The project root itself.
 *   3. Sibling directories of `pyproject.toml`/`setup.py`/`setup.cfg` whose
 *      name matches a Python package (contains `__init__.py`).
 *
 * Returns roots as absolute paths, ordered most-specific to least-specific.
 */
async function detectPythonSourceRoots(rootPath: string): Promise<string[]> {
  const roots: string[] = [];
  const absRoot = resolve(rootPath);

  // 1. src/ layout
  const srcDir = join(absRoot, "src");
  if (existsSync(srcDir)) roots.push(srcDir);

  // 2. project root
  roots.push(absRoot);

  // 3. Look for pyproject.toml packages declaration (best-effort, regex parse —
  //    we don't ship a TOML parser). Falls back gracefully if not present.
  const pyprojectPath = join(absRoot, "pyproject.toml");
  if (existsSync(pyprojectPath)) {
    try {
      const content = await Bun.file(pyprojectPath).text();
      // Match: packages = ["pkg1", "pkg2"] OR packages = [{include = "pkg"}, ...]
      const simpleMatch = content.match(/^\s*packages\s*=\s*\[([\s\S]*?)\]/m);
      if (simpleMatch) {
        const inner = simpleMatch[1]!;
        // Pull out quoted strings (handles both plain list and {include = "x"} form)
        const stringMatches = inner.matchAll(/["']([^"']+)["']/g);
        for (const m of stringMatches) {
          const pkg = m[1]!;
          // The string could be a package name ("foo"), a path ("src/foo"), or
          // include directive value. Resolve relative to root.
          const candidateDir = pkg.includes("/")
            ? resolve(absRoot, pkg, "..") // parent of the package dir
            : absRoot;
          if (existsSync(candidateDir) && !roots.includes(candidateDir)) {
            roots.push(candidateDir);
          }
        }
      }
      // poetry: tool.poetry.packages = [{include = "x", from = "src"}]
      const poetryMatches = content.matchAll(
        /\{\s*include\s*=\s*["']([^"']+)["'](?:\s*,\s*from\s*=\s*["']([^"']+)["'])?/g,
      );
      for (const m of poetryMatches) {
        const from = m[2];
        if (from) {
          const dir = resolve(absRoot, from);
          if (existsSync(dir) && !roots.includes(dir)) roots.push(dir);
        }
      }
    } catch {
      // Ignore malformed pyproject.toml
    }
  }

  return roots;
}

/** Lazy-load the source root cache. */
async function getPythonSourceRoots(rootPath: string): Promise<string[]> {
  if (cachedPyRoot === rootPath && cachedPySourceRoots) return cachedPySourceRoots;
  cachedPySourceRoots = await detectPythonSourceRoots(rootPath);
  cachedPyRoot = rootPath;
  return cachedPySourceRoots;
}

/** Synchronous accessor (used inside resolveImport which is sync). */
function pythonSourceRootsSync(rootPath: string): string[] {
  if (cachedPyRoot === rootPath && cachedPySourceRoots) return cachedPySourceRoots;
  // Fallback if initResolvers was not called: just the project root.
  return [resolve(rootPath)];
}

/** Python import resolver */
export function createPythonResolver(): ImportResolver {
  return {
    language: "python",
    resolveImport(importSource: string, fromFile: string, rootPath: string): string | null {
      // Handle relative imports (from . import x, from .. import y)
      if (importSource.startsWith(".")) {
        const dots = importSource.match(/^\.+/)?.[0].length ?? 0;
        const fromDir = dirname(resolve(rootPath, fromFile));

        // One dot = current package; each additional dot = one level up.
        let targetDir = fromDir;
        for (let i = 1; i < dots; i++) {
          targetDir = dirname(targetDir);
        }

        const modulePart = importSource.slice(dots);
        if (modulePart) {
          const modulePath = modulePart.replace(/\./g, "/");
          return resolvePythonModule(join(targetDir, modulePath), rootPath);
        }

        // `from . import x` — bare name resolves to the package's __init__.py.
        const initPath = join(targetDir, "__init__.py");
        if (existsSync(initPath)) return relative(rootPath, initPath);
        // PEP 420 namespace package: directory with no __init__.py — return null
        // since we have no concrete file to point at.
        return null;
      }

      // Absolute import — try each source root in turn.
      const modulePath = importSource.replace(/\./g, "/");
      const sourceRoots = pythonSourceRootsSync(rootPath);
      for (const root of sourceRoots) {
        const resolved = resolvePythonModule(join(root, modulePath), rootPath);
        if (resolved) return resolved;
      }
      return null;
    },
  };
}

/**
 * Try to resolve a Python module path. Order:
 *   1. `<basePath>.py` — module file.
 *   2. `<basePath>/__init__.py` — regular package.
 *   3. `<basePath>/` directory existing (PEP 420 namespace package) — returns
 *      null because there is no canonical file, but signals the package exists.
 *      Resolver consumers should not treat this as a hit; we return null to be
 *      explicit. Best-effort: namespace packages aren't represented as edges.
 */
function resolvePythonModule(basePath: string, rootPath: string): string | null {
  const pyFile = basePath + ".py";
  if (existsSync(pyFile)) return relative(rootPath, pyFile);

  const initFile = join(basePath, "__init__.py");
  if (existsSync(initFile)) return relative(rootPath, initFile);

  // PEP 420 namespace package — directory exists but no __init__.py.
  // We treat this as unresolved (returns null) because the codemap graph is
  // file-oriented and there is no concrete file to attach edges to.
  return null;
}

// ============================================================
// Public API
// ============================================================

/**
 * Initialize resolvers for a project. Loads tsconfig.json and detects Python
 * source roots from `pyproject.toml`, `src/` layout, etc.
 */
export async function initResolvers(rootPath: string): Promise<void> {
  await loadTsConfig(rootPath);
  await getPythonSourceRoots(rootPath);

  registerResolver(createTypescriptResolver());
  registerResolver(createPythonResolver());
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
      // Try resolution for both languages — in TS, this picks up tsconfig path
      // aliases; in Python, the parser marks absolute imports as external
      // because it doesn't know about source roots yet, and the resolver flips
      // the flag if the module is in-tree.
      if (fileNode.language === "typescript" || fileNode.language === "python") {
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
  cachedPySourceRoots = null;
  cachedPyRoot = null;
  resolvers.clear();
}
