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
// Public API
// ============================================================

/**
 * Initialize resolvers for a project. Loads tsconfig.json etc.
 */
export async function initResolvers(rootPath: string): Promise<void> {
  await loadTsConfig(rootPath);

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
      // Still try path aliases for TypeScript
      if (fileNode.language === "typescript") {
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
  resolvers.clear();
}
