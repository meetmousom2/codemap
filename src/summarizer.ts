/**
 * Auto-summarizer — generates one-line summaries per file and per module.
 * Derived from AST structure (export names, JSDoc, class info). No LLM needed.
 */

import type { FileNode, ModuleInfo } from "./types";

/**
 * Generate a one-line summary for a file from its AST content.
 *
 * Priority:
 * 1. First JSDoc comment found on any export
 * 2. Primary class name + "class" + extends info
 * 3. List of export names
 * 4. File name as fallback
 */
export function summarizeFile(file: FileNode): string {
  // If there's a class with JSDoc, use that
  for (const cls of file.classes) {
    if (cls.jsdoc) {
      const firstLine = cls.jsdoc.split("\n")[0]!;
      const ext = cls.extends ? ` (extends ${cls.extends})` : "";
      return `${firstLine}${ext}`;
    }
  }

  // If there's a primary class, describe it
  if (file.classes.length > 0) {
    const cls = file.classes[0]!;
    const ext = cls.extends ? ` extends ${cls.extends}` : "";
    const methodCount = cls.methods.length;
    return `${cls.name} class${ext} — ${methodCount} method${methodCount !== 1 ? "s" : ""}`;
  }

  // If there's a function with JSDoc, use that
  for (const fn of file.functions) {
    if (fn.jsdoc) return fn.jsdoc.split("\n")[0]!;
  }

  // Check exports for JSDoc
  for (const exp of file.exports) {
    if (exp.jsdoc) return exp.jsdoc.split("\n")[0]!;
  }

  // Fall back to listing export names
  if (file.exports.length > 0) {
    const names = file.exports
      .filter((e) => !e.isDefault)
      .map((e) => e.name)
      .slice(0, 5);
    const suffix = file.exports.length > 5 ? ` + ${file.exports.length - 5} more` : "";
    if (names.length > 0) {
      return `Exports: ${names.join(", ")}${suffix}`;
    }
  }

  // Check types/interfaces
  if (file.types.length > 0) {
    const names = file.types.map((t) => t.name).slice(0, 5);
    return `Types: ${names.join(", ")}`;
  }

  // Re-exports only
  if (file.reExports.length > 0) {
    const sources = file.reExports.map((r) => r.source).slice(0, 3);
    return `Barrel re-exports from ${sources.join(", ")}`;
  }

  // Last resort
  const fileName = file.path.split("/").pop() ?? file.path;
  return fileName;
}

/**
 * Generate a one-line summary for a module from its files.
 */
export function summarizeModule(module: ModuleInfo, files: FileNode[]): string {
  const moduleFiles = files.filter((f) => module.files.includes(f.path));

  // Collect all unique class names and function names
  const classNames: string[] = [];
  const functionNames: string[] = [];
  const typeNames: string[] = [];

  for (const file of moduleFiles) {
    for (const cls of file.classes) classNames.push(cls.name);
    for (const fn of file.functions) functionNames.push(fn.name);
    for (const t of file.types) typeNames.push(t.name);
  }

  // If there are classes, lead with those
  if (classNames.length > 0) {
    const names = classNames.slice(0, 3).join(", ");
    const extra = classNames.length > 3 ? ` + ${classNames.length - 3} more` : "";
    return `${names}${extra}`;
  }

  // If there are functions
  if (functionNames.length > 0) {
    const names = functionNames.slice(0, 4).join(", ");
    const extra = functionNames.length > 4 ? ` + ${functionNames.length - 4} more` : "";
    return `${names}${extra}`;
  }

  // Types
  if (typeNames.length > 0) {
    const names = typeNames.slice(0, 4).join(", ");
    return `Types: ${names}`;
  }

  return `${moduleFiles.length} file${moduleFiles.length !== 1 ? "s" : ""}`;
}

/**
 * Add summaries to all modules in place.
 */
export function addSummaries(modules: ModuleInfo[], files: FileNode[]): void {
  for (const mod of modules) {
    mod.summary = summarizeModule(mod, files);
  }
}
