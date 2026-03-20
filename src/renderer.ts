/**
 * Renderer — generates CODEMAP.md from the code graph.
 * Single file output: module index, per-file sections, dependency graph.
 */

import type { CodeGraph, FileNode, ModuleInfo, Edge } from "./types";
import { summarizeFile } from "./summarizer";
import { buildCallGraph, summarizeCallGraph, type CallReference } from "./call-graph";
import { computeModuleEdges } from "./graph";

/**
 * Render a full CODEMAP.md from the code graph.
 */
export function renderCodemap(graph: CodeGraph): string {
  const { calledBy, calls } = summarizeCallGraph(buildCallGraph(graph.files, graph.edges));
  const lines: string[] = [];

  // Header
  lines.push("# Codemap");
  lines.push(`Generated: ${graph.generatedAt} | Files: ${graph.files.length} | Commit: ${graph.commitHash ?? "unknown"}`);
  lines.push("");

  // Module Index
  lines.push("## Module Index");
  lines.push("| Module | Path | Files | Summary |");
  lines.push("|--------|------|-------|---------|");
  for (const mod of graph.modules) {
    const summary = mod.summary ?? "";
    lines.push(`| ${mod.name} | ${mod.path} | ${mod.files.length} | ${summary} |`);
  }
  lines.push("");

  // Per-module sections
  for (const mod of graph.modules) {
    lines.push(`## ${mod.name}`);
    lines.push(`> ${mod.path}/`);
    lines.push("");

    const moduleFiles = graph.files
      .filter((f) => mod.files.includes(f.path))
      .sort((a, b) => a.path.localeCompare(b.path));

    for (const file of moduleFiles) {
      renderFile(lines, file, calledBy, calls);
    }
  }

  // Dependency Graph
  lines.push("## Dependency Graph");
  lines.push("");

  const moduleEdges = computeModuleEdges(graph.edges, graph.modules);
  if (moduleEdges.length > 0) {
    lines.push("### Module Dependencies");
    lines.push("```");
    for (const edge of moduleEdges) {
      lines.push(`${edge.from} → ${edge.to} (${edge.count} import${edge.count !== 1 ? "s" : ""})`);
    }
    lines.push("```");
    lines.push("");
  }

  // File-level edges (compact)
  if (graph.edges.length > 0) {
    lines.push("### File Dependencies");
    lines.push("```");
    // Group by source file
    const edgesByFile = new Map<string, Edge[]>();
    for (const edge of graph.edges) {
      const existing = edgesByFile.get(edge.from);
      if (existing) existing.push(edge);
      else edgesByFile.set(edge.from, [edge]);
    }
    for (const [file, edges] of [...edgesByFile].sort((a, b) => a[0].localeCompare(b[0]))) {
      const targets = edges.map((e) => e.to).sort();
      lines.push(`${file} → ${targets.join(", ")}`);
    }
    lines.push("```");
  }

  return lines.join("\n") + "\n";
}

function renderFile(
  lines: string[],
  file: FileNode,
  calledBy: Map<string, { file: string; name: string }[]>,
  calls: Map<string, { file: string; name: string }[]>,
): void {
  const fileName = file.path.split("/").pop() ?? file.path;
  const summary = summarizeFile(file);
  lines.push(`### ${fileName} — ${summary}`);
  lines.push("");

  // Exports
  if (file.exports.length > 0) {
    lines.push("**Exports:**");
    for (const exp of file.exports) {
      const defaultMark = exp.isDefault ? " (default)" : "";
      const sig = exp.signature.replace(/\n\s*/g, " ");
      lines.push(`- \`${sig}\`${defaultMark}`);
      if (exp.jsdoc) lines.push(`  ${exp.jsdoc.split("\n")[0]}`);
    }
    lines.push("");
  }

  // Classes with methods
  for (const cls of file.classes) {
    const ext = cls.extends ? ` extends ${cls.extends}` : "";
    const impl = cls.implements.length > 0 ? ` implements ${cls.implements.join(", ")}` : "";
    const abs = cls.isAbstract ? "abstract " : "";
    lines.push(`**${abs}class ${cls.name}${ext}${impl}**`);

    if (cls.properties.length > 0) {
      for (const prop of cls.properties) {
        const vis = prop.visibility !== "public" ? `${prop.visibility} ` : "";
        const readonly = prop.isReadonly ? "readonly " : "";
        const stat = prop.isStatic ? "static " : "";
        const opt = prop.isOptional ? "?" : "";
        lines.push(`- ${vis}${stat}${readonly}${prop.name}${opt}: ${prop.type}`);
      }
    }

    if (cls.methods.length > 0) {
      for (const method of cls.methods) {
        const vis = method.visibility !== "public" ? `${method.visibility} ` : "";
        const stat = method.isStatic ? "static " : "";
        const async_ = method.isAsync ? "async " : "";
        const abs_ = method.isAbstract ? "abstract " : "";
        const params = method.params.map((p) => {
          const opt = p.isOptional ? "?" : "";
          const rest = p.isRest ? "..." : "";
          return `${rest}${p.name}${opt}: ${p.type}`;
        }).join(", ");
        lines.push(`- ${vis}${stat}${async_}${abs_}${method.name}(${params}): ${method.returnType}`);
        if (method.jsdoc) lines.push(`  ${method.jsdoc}`);
      }
    }
    lines.push("");
  }

  // Standalone functions
  if (file.functions.length > 0 && file.classes.length === 0) {
    lines.push("**Functions:**");
    for (const fn of file.functions) {
      const async_ = fn.isAsync ? "async " : "";
      const params = fn.params.map((p) => {
        const opt = p.isOptional ? "?" : "";
        return `${p.name}${opt}: ${p.type}`;
      }).join(", ");
      lines.push(`- ${async_}${fn.name}(${params}): ${fn.returnType}`);
      if (fn.jsdoc) lines.push(`  ${fn.jsdoc}`);
    }
    lines.push("");
  }

  // Types
  if (file.types.length > 0) {
    lines.push("**Types:**");
    for (const t of file.types) {
      const ext = t.extends.length > 0 ? ` extends ${t.extends.join(", ")}` : "";
      lines.push(`- ${t.kind} ${t.name}${ext}`);
      if (t.properties.length > 0) {
        for (const p of t.properties) {
          const opt = p.isOptional ? "?" : "";
          lines.push(`  - ${p.name}${opt}: ${p.type}`);
        }
      }
    }
    lines.push("");
  }

  // Enums
  if (file.enums.length > 0) {
    lines.push("**Enums:**");
    for (const e of file.enums) {
      const constMark = e.isConst ? "const " : "";
      const members = e.members.map((m) => m.value ? `${m.name}=${m.value}` : m.name).join(", ");
      lines.push(`- ${constMark}enum ${e.name} { ${members} }`);
    }
    lines.push("");
  }

  // Imports
  if (file.imports.length > 0) {
    lines.push("**Imports:**");
    for (const imp of file.imports) {
      const names = [
        ...(imp.defaultImport ? [imp.defaultImport] : []),
        ...imp.namedImports,
        ...(imp.namespaceImport ? [`* as ${imp.namespaceImport}`] : []),
      ];
      const target = imp.resolvedPath ?? imp.source;
      const external = imp.isExternal ? " (external)" : "";
      lines.push(`- ${names.join(", ")} ← ${target}${external}`);
    }
    lines.push("");
  }

  // Called by / Calls
  const fileCalledBy: string[] = [];
  const fileCalls: string[] = [];

  for (const exp of file.exports) {
    const key = `${file.path}:${exp.name}`;
    const callers = calledBy.get(key);
    if (callers) {
      for (const c of callers) {
        fileCalledBy.push(`${c.file} → ${c.name}`);
      }
    }
    const callees = calls.get(key);
    if (callees) {
      for (const c of callees) {
        fileCalls.push(`${c.file}:${c.name}`);
      }
    }
  }

  if (fileCalledBy.length > 0) {
    lines.push(`**Called by:** ${[...new Set(fileCalledBy)].join(", ")}`);
  }
  if (fileCalls.length > 0) {
    lines.push(`**Calls:** ${[...new Set(fileCalls)].join(", ")}`);
  }

  if (fileCalledBy.length > 0 || fileCalls.length > 0) {
    lines.push("");
  }

  lines.push("---");
  lines.push("");
}
