/**
 * Graph — builds dependency graph and module groupings from parsed files.
 * Detects circular dependencies and computes module-level edges.
 */

import { dirname } from "node:path";
import type { FileNode, Edge, ModuleInfo, CodeGraph } from "./types";
import { buildEdges, resolveFileImports, initResolvers } from "./resolver";
import { scan } from "./scanner";
import { parseFiles, registerPlugin, initParser } from "./parser";
import { registerTypescript } from "./languages/typescript";

/**
 * Group files into modules by directory.
 * A module = a directory containing source files.
 */
export function groupIntoModules(files: FileNode[]): ModuleInfo[] {
  const moduleMap = new Map<string, string[]>();

  for (const file of files) {
    const dir = dirname(file.path);
    const existing = moduleMap.get(dir);
    if (existing) {
      existing.push(file.path);
    } else {
      moduleMap.set(dir, [file.path]);
    }
  }

  const modules: ModuleInfo[] = [];
  for (const [dir, filePaths] of moduleMap) {
    // Module name = last directory segment, or "root" for top-level
    const name = dir === "." ? "root" : dir.split("/").pop() ?? dir;
    modules.push({
      name,
      path: dir,
      files: filePaths.sort(),
    });
  }

  return modules.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Detect circular dependencies in the edge graph.
 * Returns arrays of file paths that form cycles.
 */
export function detectCircularDeps(edges: Edge[]): string[][] {
  // Build adjacency list
  const adj = new Map<string, Set<string>>();
  for (const edge of edges) {
    const neighbors = adj.get(edge.from);
    if (neighbors) {
      neighbors.add(edge.to);
    } else {
      adj.set(edge.from, new Set([edge.to]));
    }
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string): void {
    if (inStack.has(node)) {
      // Found a cycle — extract it
      const cycleStart = stack.indexOf(node);
      if (cycleStart >= 0) {
        cycles.push(stack.slice(cycleStart));
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    stack.push(node);

    const neighbors = adj.get(node);
    if (neighbors) {
      for (const neighbor of neighbors) {
        dfs(neighbor);
      }
    }

    stack.pop();
    inStack.delete(node);
  }

  // Run DFS from all nodes
  for (const node of adj.keys()) {
    dfs(node);
  }

  return cycles;
}

/**
 * Compute module-level dependency edges (directory → directory).
 */
export function computeModuleEdges(
  edges: Edge[],
  modules: ModuleInfo[],
): { from: string; to: string; count: number }[] {
  // Map file → module path
  const fileToModule = new Map<string, string>();
  for (const mod of modules) {
    for (const file of mod.files) {
      fileToModule.set(file, mod.path);
    }
  }

  // Aggregate edges at module level
  const moduleEdgeMap = new Map<string, number>();
  for (const edge of edges) {
    const fromMod = fileToModule.get(edge.from);
    const toMod = fileToModule.get(edge.to);
    if (!fromMod || !toMod || fromMod === toMod) continue; // skip intra-module

    const key = `${fromMod}→${toMod}`;
    moduleEdgeMap.set(key, (moduleEdgeMap.get(key) ?? 0) + 1);
  }

  const result: { from: string; to: string; count: number }[] = [];
  for (const [key, count] of moduleEdgeMap) {
    const [from, to] = key.split("→") as [string, string];
    result.push({ from, to, count });
  }

  return result.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/**
 * Build the complete code graph for a project.
 * This is the main orchestration function.
 */
export async function buildCodeGraph(
  rootPath: string,
  options: { include?: string[]; exclude?: string[] } = {},
): Promise<CodeGraph> {
  // 1. Initialize
  await initParser();
  const tsPlugin = await registerTypescript();
  registerPlugin(tsPlugin);
  await initResolvers(rootPath);

  // 2. Scan for source files
  const filePaths = await scan(rootPath, options);

  // 3. Parse all files
  const files = await parseFiles(rootPath, filePaths);

  // 4. Resolve imports
  for (const file of files) {
    resolveFileImports(file, rootPath);
  }

  // 5. Build dependency edges
  const edges = buildEdges(files);

  // 6. Group into modules
  const modules = groupIntoModules(files);

  // 7. Get git commit hash
  let commitHash: string | undefined;
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
      cwd: rootPath,
    });
    commitHash = proc.stdout.toString().trim() || undefined;
  } catch {
    // Not a git repo
  }

  return {
    root: rootPath,
    files,
    edges,
    modules,
    commitHash,
    generatedAt: new Date().toISOString(),
  };
}
