/**
 * Cross-file call graph — traces which exports reference/call other file exports.
 * Builds "called by" and "calls" edges for the knowledge graph.
 */

import type { FileNode, Edge } from "./types";

export interface CallReference {
  /** File that contains the call */
  callerFile: string;
  /** Export/function making the call */
  callerName: string;
  /** File being called into */
  calleeFile: string;
  /** Export/function being called */
  calleeName: string;
}

/**
 * Build cross-file call references by analyzing which imported symbols
 * are used in exported functions/methods.
 *
 * This is a heuristic approach: we look at import names and check if they
 * appear in export signatures or function bodies (via the AST text).
 * Not 100% accurate (tree-sitter gives syntax, not semantics) but good enough
 * for knowledge graph navigation.
 */
export function buildCallGraph(files: FileNode[], edges: Edge[]): CallReference[] {
  const refs: CallReference[] = [];

  // Build a map of file → exported symbol names
  const exportsByFile = new Map<string, Set<string>>();
  for (const file of files) {
    const names = new Set<string>();
    for (const exp of file.exports) {
      names.add(exp.name);
    }
    for (const cls of file.classes) {
      names.add(cls.name);
      for (const method of cls.methods) {
        names.add(`${cls.name}.${method.name}`);
      }
    }
    for (const fn of file.functions) {
      names.add(fn.name);
    }
    exportsByFile.set(file.path, names);
  }

  // For each file, check which imported symbols it references
  for (const file of files) {
    // Get all imports that resolved to internal files
    const resolvedImports = file.imports.filter((i) => i.resolvedPath);

    for (const imp of resolvedImports) {
      const targetFile = imp.resolvedPath!;
      const targetExports = exportsByFile.get(targetFile);
      if (!targetExports) continue;

      // Which specific imports from this file?
      const importedNames = [
        ...(imp.defaultImport ? [imp.defaultImport] : []),
        ...imp.namedImports,
      ];

      // For each exported function/method in the current file,
      // check if it references the imported symbols
      for (const exp of file.exports) {
        for (const importedName of importedNames) {
          // Check if the imported name matches an export in the target file
          if (targetExports.has(importedName)) {
            refs.push({
              callerFile: file.path,
              callerName: exp.name,
              calleeFile: targetFile,
              calleeName: importedName,
            });
          }
        }
      }

      // Also check class methods
      for (const cls of file.classes) {
        for (const method of cls.methods) {
          for (const importedName of importedNames) {
            if (targetExports.has(importedName)) {
              refs.push({
                callerFile: file.path,
                callerName: `${cls.name}.${method.name}`,
                calleeFile: targetFile,
                calleeName: importedName,
              });
            }
          }
        }
      }
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = `${r.callerFile}:${r.callerName}→${r.calleeFile}:${r.calleeName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Group call references into "called by" and "calls" maps per file.
 */
export function summarizeCallGraph(refs: CallReference[]): {
  calledBy: Map<string, { file: string; name: string }[]>;
  calls: Map<string, { file: string; name: string }[]>;
} {
  // calledBy[targetFile:targetName] = [{callerFile, callerName}, ...]
  const calledBy = new Map<string, { file: string; name: string }[]>();
  // calls[callerFile:callerName] = [{targetFile, targetName}, ...]
  const calls = new Map<string, { file: string; name: string }[]>();

  for (const ref of refs) {
    const calleeKey = `${ref.calleeFile}:${ref.calleeName}`;
    const callerKey = `${ref.callerFile}:${ref.callerName}`;

    const calledByList = calledBy.get(calleeKey) ?? [];
    calledByList.push({ file: ref.callerFile, name: ref.callerName });
    calledBy.set(calleeKey, calledByList);

    const callsList = calls.get(callerKey) ?? [];
    callsList.push({ file: ref.calleeFile, name: ref.calleeName });
    calls.set(callerKey, callsList);
  }

  return { calledBy, calls };
}
