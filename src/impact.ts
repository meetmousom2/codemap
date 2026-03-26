/**
 * Impact — blast radius analysis for a symbol.
 * Traces backward through import edges and call graph references
 * to answer "what files/functions use this symbol?"
 */

import type { CodeGraph, Export } from "./types";
import { buildCallGraph, summarizeCallGraph } from "./call-graph";

type CallSummary = ReturnType<typeof summarizeCallGraph>;

/**
 * Search all files' exports for matching symbol name.
 * Returns all matches (symbol may exist in multiple files).
 */
export function findSymbol(
  graph: CodeGraph,
  symbolName: string,
): { file: string; export: Export }[] {
  const results: { file: string; export: Export }[] = [];

  for (const file of graph.files) {
    for (const exp of file.exports) {
      if (exp.name === symbolName) {
        results.push({ file: file.path, export: exp });
      }
    }
  }

  return results;
}

/**
 * Find all edges where `to === filePath` and `importedNames` includes symbolName.
 * Follow re-exports: if an importing file re-exports the symbol, recursively trace that file too.
 */
export function traceImporters(
  graph: CodeGraph,
  filePath: string,
  symbolName: string,
): { file: string; importedAs: string }[] {
  const results: { file: string; importedAs: string }[] = [];
  const visited = new Set<string>();

  function trace(targetFile: string, targetSymbol: string): void {
    if (visited.has(targetFile)) return;
    visited.add(targetFile);

    // Find all edges pointing to targetFile that import targetSymbol
    for (const edge of graph.edges) {
      if (edge.to !== targetFile) continue;
      if (!edge.importedNames.includes(targetSymbol)) continue;

      results.push({ file: edge.from, importedAs: targetSymbol });

      // Check if the importing file re-exports this symbol
      const importingFile = graph.files.find((f) => f.path === edge.from);
      if (!importingFile) continue;

      const reExportsSymbol = importingFile.reExports.some((re) => {
        if (re.resolvedPath !== targetFile) return false;
        // Wildcard re-export (export *) or named re-export including the symbol
        return re.names.length === 0 || re.names.includes(targetSymbol);
      });

      if (reExportsSymbol) {
        // This file re-exports the symbol, so trace importers of this file too
        trace(edge.from, targetSymbol);
      }
    }
  }

  trace(filePath, symbolName);
  return results;
}

/**
 * Look up calledBy map for the symbol.
 */
export function traceCallers(
  callSummary: CallSummary,
  filePath: string,
  symbolName: string,
): { callerFile: string; callerName: string }[] {
  const key = `${filePath}:${symbolName}`;
  const callers = callSummary.calledBy.get(key);
  if (!callers) return [];

  return callers.map((c) => ({ callerFile: c.file, callerName: c.name }));
}

/**
 * Main function: find all definitions, trace importers and callers, render compact markdown.
 */
export function renderImpact(graph: CodeGraph, symbolName: string): string {
  const definitions = findSymbol(graph, symbolName);

  if (definitions.length === 0) {
    return `Error: symbol "${symbolName}" not found in graph. Try searching with \`codemap query "${symbolName}"\` to find related symbols.`;
  }

  // Build call summary
  const callRefs = buildCallGraph(graph.files, graph.edges);
  const callSummary = summarizeCallGraph(callRefs);

  const lines: string[] = [];
  lines.push(`## Impact: ${symbolName}`);
  lines.push("");

  // Defined in
  lines.push("### Defined in");
  for (const def of definitions) {
    const sig = def.export.signature.replace(/\n\s*/g, " ");
    lines.push(`- ${def.file} — ${sig}`);
  }
  lines.push("");

  // Collect all importers and callers across all definitions
  const allImporters: { file: string; importedAs: string; fromFile: string }[] = [];
  const allCallers: { callerFile: string; callerName: string; fromFile: string }[] = [];

  for (const def of definitions) {
    const importers = traceImporters(graph, def.file, symbolName);
    for (const imp of importers) {
      allImporters.push({ ...imp, fromFile: def.file });
    }

    const callers = traceCallers(callSummary, def.file, symbolName);
    for (const caller of callers) {
      allCallers.push({ ...caller, fromFile: def.file });
    }
  }

  // Deduplicate importers by file
  const seenImporters = new Set<string>();
  const uniqueImporters = allImporters.filter((imp) => {
    if (seenImporters.has(imp.file)) return false;
    seenImporters.add(imp.file);
    return true;
  });

  if (uniqueImporters.length > 0) {
    lines.push("### Imported by");
    for (const imp of uniqueImporters) {
      lines.push(`- ${imp.file} — imported as ${imp.importedAs}`);
    }
    lines.push("");
  }

  // Deduplicate callers
  const seenCallers = new Set<string>();
  const uniqueCallers = allCallers.filter((c) => {
    const key = `${c.callerFile}:${c.callerName}`;
    if (seenCallers.has(key)) return false;
    seenCallers.add(key);
    return true;
  });

  if (uniqueCallers.length > 0) {
    lines.push("### Called by");
    for (const caller of uniqueCallers) {
      lines.push(`- ${caller.callerFile}:${caller.callerName} — calls ${symbolName}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
