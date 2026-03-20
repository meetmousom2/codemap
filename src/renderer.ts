/**
 * Renderer — generates CODEMAP.md and optional per-module detail files.
 *
 * Two modes:
 * - Small repos (<300 files): single CODEMAP.md with full detail
 * - Large repos (≥300 files): compact CODEMAP.md index + codemap/<module>.md for large modules
 *
 * Large modules (5+ files) get a separate detail file.
 * Small modules are inlined in the index with key exports.
 */

import type { CodeGraph, FileNode, ModuleInfo, Edge } from "./types";
import { summarizeFile } from "./summarizer";
import { buildCallGraph, summarizeCallGraph } from "./call-graph";
import { computeModuleEdges } from "./graph";

const LAYERED_THRESHOLD = 300;
const LARGE_MODULE_THRESHOLD = 5; // modules with 5+ files get separate detail files

type CallMaps = {
  calledBy: Map<string, { file: string; name: string }[]>;
  calls: Map<string, { file: string; name: string }[]>;
};

/**
 * Render output for a code graph.
 * Returns a map of filePath → content.
 */
export function renderAll(graph: CodeGraph): Map<string, string> {
  const callMaps = summarizeCallGraph(buildCallGraph(graph.files, graph.edges));
  const output = new Map<string, string>();

  if (graph.files.length < LAYERED_THRESHOLD) {
    output.set("CODEMAP.md", renderFullCodemap(graph, callMaps));
  } else {
    // Group small modules into parents
    const grouped = groupModules(graph.modules, graph.files);
    output.set("CODEMAP.md", renderIndex(graph, grouped, callMaps));

    // Only generate detail files for large modules
    for (const mod of grouped) {
      if (mod.files.length < LARGE_MODULE_THRESHOLD) continue;
      const moduleFiles = graph.files
        .filter((f) => mod.files.includes(f.path))
        .sort((a, b) => a.path.localeCompare(b.path));
      const modulePath = sanitizeModulePath(mod.path);
      output.set(`codemap/${modulePath}.md`, renderModuleDetail(mod, moduleFiles, graph.edges, callMaps));
    }
  }

  return output;
}

/** Sanitize module path for filename */
function sanitizeModulePath(path: string): string {
  if (path === ".") return "root";
  return path.replace(/\//g, "--");
}

/**
 * Group small modules (<5 files) into their parent directory.
 * Returns a reduced list of modules where small leaf dirs are merged up.
 */
function groupModules(modules: ModuleInfo[], files: FileNode[]): ModuleInfo[] {
  // Build parent→children map
  const byPath = new Map<string, ModuleInfo>();
  for (const mod of modules) byPath.set(mod.path, mod);

  // Find modules that are too small and should merge into parent
  const merged = new Set<string>();
  const result = new Map<string, ModuleInfo>();

  // Sort deepest first so we merge bottom-up
  const sorted = [...modules].sort((a, b) => b.path.split("/").length - a.path.split("/").length);

  for (const mod of sorted) {
    if (merged.has(mod.path)) continue;

    if (mod.files.length < LARGE_MODULE_THRESHOLD) {
      // Find parent
      const parentPath = mod.path.includes("/")
        ? mod.path.slice(0, mod.path.lastIndexOf("/"))
        : ".";
      const parent = result.get(parentPath) ?? byPath.get(parentPath);

      if (parent && parent.path !== mod.path) {
        // Merge into parent
        const mergedParent = result.get(parentPath) ?? { ...parent, files: [...parent.files] };
        for (const f of mod.files) {
          if (!mergedParent.files.includes(f)) mergedParent.files.push(f);
        }
        result.set(parentPath, mergedParent);
        merged.add(mod.path);
        continue;
      }
    }

    // Keep as-is
    if (!result.has(mod.path)) {
      result.set(mod.path, { ...mod, files: [...mod.files] });
    }
  }

  return [...result.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// ============================================================
// Index renderer — tree format, compact
// ============================================================

function renderIndex(graph: CodeGraph, modules: ModuleInfo[], callMaps: CallMaps): string {
  const lines: string[] = [];

  lines.push("# Codemap");
  lines.push(`Generated: ${graph.generatedAt} | Files: ${graph.files.length} | Commit: ${graph.commitHash ?? "unknown"}`);
  lines.push("");
  lines.push("> Read `codemap/<module>.md` for full detail on any module marked with →.");
  lines.push("");
  lines.push("## Modules");
  lines.push("");

  // Build tree structure for display
  const tree = buildModuleTree(modules, graph.files);
  for (const line of tree) {
    lines.push(line);
  }
  lines.push("");

  // Module-level dependency graph
  const moduleEdges = computeModuleEdges(graph.edges, modules);
  if (moduleEdges.length > 0) {
    lines.push("## Dependencies");
    lines.push("```");
    for (const edge of moduleEdges) {
      lines.push(`${edge.from} → ${edge.to} (${edge.count})`);
    }
    lines.push("```");
  }

  return lines.join("\n") + "\n";
}

/**
 * Build a tree-format listing of modules.
 * Large modules link to detail files. Small modules show key exports inline.
 */
function buildModuleTree(modules: ModuleInfo[], files: FileNode[]): string[] {
  const lines: string[] = [];

  // Group by top-level directory for visual organization
  const groups = new Map<string, ModuleInfo[]>();
  for (const mod of modules) {
    const topLevel = mod.path.split("/")[0] ?? ".";
    const group = groups.get(topLevel) ?? [];
    group.push(mod);
    groups.set(topLevel, group);
  }

  for (const [topLevel, mods] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (topLevel !== "." && mods.length > 1) {
      lines.push(`### ${topLevel}/`);
    }

    for (const mod of mods) {
      const moduleFiles = files.filter((f) => mod.files.includes(f.path));
      const isLarge = mod.files.length >= LARGE_MODULE_THRESHOLD;
      const modulePath = sanitizeModulePath(mod.path);

      // Collect key exports
      const classNames: string[] = [];
      const fnNames: string[] = [];
      const typeNames: string[] = [];

      for (const file of moduleFiles) {
        for (const cls of file.classes) {
          const ext = cls.extends ? ` (${cls.extends})` : "";
          classNames.push(`${cls.name}${ext}`);
        }
        for (const exp of file.exports) {
          if (exp.kind === "function" && !classNames.some((c) => c.startsWith(exp.name))) {
            fnNames.push(exp.name);
          }
        }
        for (const t of file.types) typeNames.push(t.name);
      }

      // Build summary
      const parts: string[] = [];
      if (classNames.length > 0) parts.push(classNames.slice(0, 3).join(", "));
      if (fnNames.length > 0) parts.push(fnNames.slice(0, 3).join(", "));
      if (typeNames.length > 0) parts.push(`types: ${typeNames.slice(0, 3).join(", ")}`);

      const summary = parts.join(" | ");
      const fileCount = mod.files.length;

      if (isLarge) {
        // Large module — link to detail file
        lines.push(`**${mod.path}/** (${fileCount} files) → [detail](codemap/${modulePath}.md)`);
        if (summary) lines.push(`  ${summary}`);
      } else {
        // Small module — inline key exports
        lines.push(`**${mod.path}/** (${fileCount} files)`);
        if (summary) lines.push(`  ${summary}`);

        // For small modules, also show per-file one-liners
        for (const file of moduleFiles) {
          const fileName = file.path.split("/").pop() ?? file.path;
          const fileSummary = summarizeFile(file);
          lines.push(`  - ${fileName}: ${fileSummary}`);
        }
      }
      lines.push("");
    }
  }

  return lines;
}

// ============================================================
// Module detail renderer
// ============================================================

function renderModuleDetail(
  mod: ModuleInfo,
  files: FileNode[],
  allEdges: Edge[],
  callMaps: CallMaps,
): string {
  const lines: string[] = [];

  lines.push(`# ${mod.name}`);
  lines.push(`> ${mod.path}/ — ${mod.summary ?? ""}`);
  lines.push("");

  lines.push("## Files");
  for (const file of files) {
    const fileName = file.path.split("/").pop() ?? file.path;
    lines.push(`- **${fileName}** — ${summarizeFile(file)}`);
  }
  lines.push("");

  for (const file of files) {
    renderFile(lines, file, callMaps.calledBy, callMaps.calls);
  }

  const moduleFileSet = new Set(files.map((f) => f.path));
  const relevantEdges = allEdges.filter(
    (e) => moduleFileSet.has(e.from) || moduleFileSet.has(e.to),
  );

  if (relevantEdges.length > 0) {
    lines.push("## Dependencies");
    lines.push("```");
    const edgesByFile = new Map<string, string[]>();
    for (const edge of relevantEdges) {
      if (moduleFileSet.has(edge.from)) {
        const targets = edgesByFile.get(edge.from) ?? [];
        targets.push(edge.to);
        edgesByFile.set(edge.from, targets);
      }
    }
    for (const [file, targets] of [...edgesByFile].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`${file} → ${[...new Set(targets)].sort().join(", ")}`);
    }
    lines.push("```");
  }

  return lines.join("\n") + "\n";
}

// ============================================================
// Full single-file renderer (for small repos)
// ============================================================

function renderFullCodemap(graph: CodeGraph, callMaps: CallMaps): string {
  const lines: string[] = [];

  lines.push("# Codemap");
  lines.push(`Generated: ${graph.generatedAt} | Files: ${graph.files.length} | Commit: ${graph.commitHash ?? "unknown"}`);
  lines.push("");

  lines.push("## Module Index");
  lines.push("| Module | Path | Files | Summary |");
  lines.push("|--------|------|-------|---------|");
  for (const mod of graph.modules) {
    lines.push(`| ${mod.name} | ${mod.path} | ${mod.files.length} | ${mod.summary ?? ""} |`);
  }
  lines.push("");

  for (const mod of graph.modules) {
    lines.push(`## ${mod.name}`);
    lines.push(`> ${mod.path}/`);
    lines.push("");

    const moduleFiles = graph.files
      .filter((f) => mod.files.includes(f.path))
      .sort((a, b) => a.path.localeCompare(b.path));

    for (const file of moduleFiles) {
      renderFile(lines, file, callMaps.calledBy, callMaps.calls);
    }
  }

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

  if (graph.edges.length > 0) {
    lines.push("### File Dependencies");
    lines.push("```");
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

// ============================================================
// File detail renderer (shared)
// ============================================================

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

  for (const cls of file.classes) {
    const ext = cls.extends ? ` extends ${cls.extends}` : "";
    const impl = cls.implements.length > 0 ? ` implements ${cls.implements.join(", ")}` : "";
    const abs = cls.isAbstract ? "abstract " : "";
    lines.push(`**${abs}class ${cls.name}${ext}${impl}**`);

    for (const prop of cls.properties) {
      const vis = prop.visibility !== "public" ? `${prop.visibility} ` : "";
      const readonly = prop.isReadonly ? "readonly " : "";
      const stat = prop.isStatic ? "static " : "";
      const opt = prop.isOptional ? "?" : "";
      lines.push(`- ${vis}${stat}${readonly}${prop.name}${opt}: ${prop.type}`);
    }

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
    lines.push("");
  }

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

  if (file.types.length > 0) {
    lines.push("**Types:**");
    for (const t of file.types) {
      const ext = t.extends.length > 0 ? ` extends ${t.extends.join(", ")}` : "";
      lines.push(`- ${t.kind} ${t.name}${ext}`);
      for (const p of t.properties) {
        const opt = p.isOptional ? "?" : "";
        lines.push(`  - ${p.name}${opt}: ${p.type}`);
      }
    }
    lines.push("");
  }

  if (file.enums.length > 0) {
    lines.push("**Enums:**");
    for (const e of file.enums) {
      const constMark = e.isConst ? "const " : "";
      const members = e.members.map((m) => m.value ? `${m.name}=${m.value}` : m.name).join(", ");
      lines.push(`- ${constMark}enum ${e.name} { ${members} }`);
    }
    lines.push("");
  }

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

  const fileCalledBy: string[] = [];
  const fileCalls: string[] = [];

  for (const exp of file.exports) {
    const key = `${file.path}:${exp.name}`;
    const callers = calledBy.get(key);
    if (callers) {
      for (const c of callers) fileCalledBy.push(`${c.file} → ${c.name}`);
    }
    const callees = calls.get(key);
    if (callees) {
      for (const c of callees) fileCalls.push(`${c.file}:${c.name}`);
    }
  }

  if (fileCalledBy.length > 0) {
    lines.push(`**Called by:** ${[...new Set(fileCalledBy)].join(", ")}`);
  }
  if (fileCalls.length > 0) {
    lines.push(`**Calls:** ${[...new Set(fileCalls)].join(", ")}`);
  }
  if (fileCalledBy.length > 0 || fileCalls.length > 0) lines.push("");

  lines.push("---");
  lines.push("");
}
