/**
 * Skeleton & Deps — renders compact file skeleton and dependency views.
 * Both commands operate on the cached graph (no rebuild).
 */

import type { CodeGraph, FileNode, Edge } from "./types";

/**
 * Find a FileNode by partial path match (match against end of path).
 */
function findFile(graph: CodeGraph, query: string): FileNode | null {
  // Try exact match first
  const exact = graph.files.find((f) => f.path === query);
  if (exact) return exact;

  // Partial match: query matches the end of the file path
  const matches = graph.files.filter((f) => f.path.endsWith(query));
  if (matches.length === 1) return matches[0]!;

  // If multiple matches, try with path separator prefix for precision
  const withSep = graph.files.filter(
    (f) => f.path.endsWith("/" + query) || f.path === query,
  );
  if (withSep.length === 1) return withSep[0]!;

  // Return first partial match if any
  if (matches.length > 0) return matches[0]!;

  return null;
}

/**
 * Render a compact skeleton of a file: exports, classes, types, enums.
 */
export function renderSkeleton(graph: CodeGraph, filePath: string): string {
  const file = findFile(graph, filePath);
  if (!file) {
    return `Error: file "${filePath}" not found in graph. Available files:\n${graph.files.map((f) => `  ${f.path}`).join("\n")}`;
  }

  const lines: string[] = [];
  lines.push(`## ${file.path}`);
  lines.push("");

  // Exports
  if (file.exports.length > 0) {
    lines.push("### Exports");
    for (const exp of file.exports) {
      const sig = exp.signature.replace(/\n\s*/g, " ");
      const defaultMark = exp.isDefault ? " (default)" : "";
      lines.push(`- export ${sig}${defaultMark}`);
    }
    lines.push("");
  }

  // Classes
  if (file.classes.length > 0) {
    lines.push("### Classes");
    for (const cls of file.classes) {
      const abs = cls.isAbstract ? "abstract " : "";
      const ext = cls.extends ? ` extends ${cls.extends}` : "";
      const impl =
        cls.implements.length > 0
          ? ` implements ${cls.implements.join(", ")}`
          : "";
      lines.push(`**${abs}class ${cls.name}${ext}${impl}**`);

      for (const method of cls.methods) {
        const vis =
          method.visibility !== "public" ? `${method.visibility} ` : "";
        const stat = method.isStatic ? "static " : "";
        const async_ = method.isAsync ? "async " : "";
        const abs_ = method.isAbstract ? "abstract " : "";
        const params = method.params
          .map((p) => {
            const opt = p.isOptional ? "?" : "";
            const rest = p.isRest ? "..." : "";
            return `${rest}${p.name}${opt}: ${p.type}`;
          })
          .join(", ");
        lines.push(
          `- ${vis}${stat}${async_}${abs_}${method.name}(${params}): ${method.returnType}`,
        );
      }
      lines.push("");
    }
  }

  // Types
  if (file.types.length > 0) {
    lines.push("### Types");
    for (const t of file.types) {
      const ext =
        t.extends.length > 0 ? ` extends ${t.extends.join(", ")}` : "";
      lines.push(`- ${t.kind} ${t.name}${ext}`);
    }
    lines.push("");
  }

  // Enums
  if (file.enums.length > 0) {
    lines.push("### Enums");
    for (const e of file.enums) {
      const constMark = e.isConst ? "const " : "";
      const members = e.members
        .map((m) => (m.value ? `${m.name}=${m.value}` : m.name))
        .join(", ");
      lines.push(`- ${constMark}enum ${e.name} { ${members} }`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Render dependency information for a file: imports from + imported by.
 */
export function renderDeps(graph: CodeGraph, filePath: string): string {
  const file = findFile(graph, filePath);
  if (!file) {
    return `Error: file "${filePath}" not found in graph. Available files:\n${graph.files.map((f) => `  ${f.path}`).join("\n")}`;
  }

  const lines: string[] = [];
  lines.push(`## Dependencies: ${file.path}`);
  lines.push("");

  // Forward deps: files this file imports from (local only)
  const localImports = file.imports.filter(
    (imp) => imp.resolvedPath && !imp.isExternal,
  );
  if (localImports.length > 0) {
    lines.push("### Imports from");
    for (const imp of localImports) {
      const names = [
        ...(imp.defaultImport ? [imp.defaultImport] : []),
        ...imp.namedImports,
        ...(imp.namespaceImport ? [`* as ${imp.namespaceImport}`] : []),
      ];
      lines.push(`- ${imp.resolvedPath} — ${names.join(", ")}`);
    }
    lines.push("");
  }

  // Reverse deps: files that import this file
  const importedBy = graph.edges.filter((e) => e.to === file.path);
  if (importedBy.length > 0) {
    lines.push("### Imported by");
    for (const edge of importedBy) {
      lines.push(`- ${edge.from} — ${edge.importedNames.join(", ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
