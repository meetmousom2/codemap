/**
 * Ranker — ranks files and symbols by relevance to a query.
 * Uses BM25 via bun:sqlite FTS5 + simplified PageRank on the dependency graph.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { CodeGraph, FileNode, Edge } from "./types";
import { summarizeFile } from "./summarizer";

interface RankedFile {
  file: FileNode;
  score: number;
  matchedTerms: string[];
}

/**
 * Split a camelCase/PascalCase identifier into space-separated words for FTS indexing.
 * "DatabaseConnection" -> "DatabaseConnection database connection"
 * Includes the original so exact matches still work.
 */
function expandName(name: string): string {
  const split = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  if (split === name) return name;
  return `${name} ${split}`;
}

/** Expand a list of names, joining with spaces. */
function expandNames(names: string[]): string {
  return names.map(expandName).join(" ");
}

/**
 * Rank files by relevance to a query string.
 * Combines BM25 (via FTS5) with graph importance (PageRank).
 */
export function rankFiles(graph: CodeGraph, query: string): RankedFile[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const pageRankScores = computePageRank(graph.edges, graph.files.map((f) => f.path));

  // Build FTS5 index and score with BM25
  const bm25Scores = scoreBM25(graph.files, queryTerms);

  // Normalize BM25 scores to [0, 1] range so they combine well with PageRank
  let maxBM25 = 0;
  for (const entry of bm25Scores.values()) {
    if (entry.score > maxBM25) maxBM25 = entry.score;
  }

  const ranked: RankedFile[] = [];

  for (const file of graph.files) {
    const bm25Result = bm25Scores.get(file.path);
    const prScore = pageRankScores.get(file.path) ?? 0;

    let score: number;
    let matchedTerms: string[];

    if (bm25Result && bm25Result.score > 0) {
      // Normalize to [0, 1] range
      let bm25Score = maxBM25 > 0 ? bm25Result.score / maxBM25 : 0;

      // Penalize files with very many exports (types files) — they match too broadly
      const exportCount = file.exports.length + file.types.length;
      if (exportCount > 20) {
        bm25Score *= 0.5;
      }

      // BM25 is primary signal, PageRank is secondary (importance boost)
      score = bm25Score * (1 + prScore * 10);
      matchedTerms = bm25Result.matchedTerms;
    } else {
      score = prScore * 0.01; // tiny baseline for important files with no BM25 match
      matchedTerms = [];
    }

    if (score > 0) {
      ranked.push({ file, score, matchedTerms });
    }
  }

  return ranked.sort((a, b) => b.score - a.score);
}

/**
 * Tokenize a query into searchable terms.
 * Splits on spaces, camelCase, underscores, hyphens.
 */
const STOP_WORDS = new Set([
  "is", "it", "the", "a", "an", "in", "on", "at", "to", "for", "of", "by",
  "and", "or", "not", "no", "do", "does", "did", "has", "have", "had",
  "what", "where", "how", "when", "which", "who", "why",
  "be", "am", "are", "was", "were", "been",
  "this", "that", "with", "from", "as", "if", "but",
  "can", "will", "would", "could", "should",
  "get", "set", "use", "used", "using",
]);

export function tokenize(text: string): string[] {
  const terms = text
    .toLowerCase()
    // Split camelCase
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    // Split on non-alphanumeric
    .split(/[\s_\-./?"'!]+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

  return [...new Set(terms)];
}

/**
 * Score files using BM25 via an in-memory SQLite FTS5 table.
 * Builds a virtual table with weighted columns from file metadata,
 * then queries it with the tokenized terms.
 */
function scoreBM25(
  files: FileNode[],
  queryTerms: string[],
): Map<string, { score: number; matchedTerms: string[] }> {
  const results = new Map<string, { score: number; matchedTerms: string[] }>();
  if (files.length === 0 || queryTerms.length === 0) return results;

  const db = new Database(":memory:");

  try {
    // Create FTS5 virtual table.
    // Columns: file_path(1), export_names(5), class_names(5), function_names(5),
    //          method_names(3), type_names(4), jsdoc(2), extends_implements(3)
    db.run(`
      CREATE VIRTUAL TABLE files_fts USING fts5(
        file_path,
        export_names,
        class_names,
        function_names,
        method_names,
        type_names,
        jsdoc,
        extends_implements,
        tokenize='unicode61'
      )
    `);

    const insertStmt = db.prepare(`
      INSERT INTO files_fts(file_path, export_names, class_names, function_names, method_names, type_names, jsdoc, extends_implements)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Populate the FTS5 table with camelCase-expanded names
    const insertMany = db.transaction(() => {
      for (const file of files) {
        const exportNames = expandNames(file.exports.map((e) => e.name));
        const classNames = expandNames(file.classes.map((c) => c.name));
        const functionNames = expandNames(file.functions.map((f) => f.name));
        const methodNames = expandNames(
          file.classes.flatMap((c) => c.methods.map((m) => m.name)),
        );
        const typeNames = expandNames(file.types.map((t) => t.name));

        const jsdocParts: string[] = [];
        for (const e of file.exports) if (e.jsdoc) jsdocParts.push(e.jsdoc);
        for (const c of file.classes) if (c.jsdoc) jsdocParts.push(c.jsdoc);
        for (const f of file.functions) if (f.jsdoc) jsdocParts.push(f.jsdoc);
        const jsdoc = jsdocParts.join(" ");

        const extendsParts: string[] = [];
        for (const c of file.classes) {
          if (c.extends) extendsParts.push(c.extends);
          for (const impl of c.implements) extendsParts.push(impl);
        }
        const extendsImplements = expandNames(extendsParts);

        // File path: expand directory and filename parts
        const pathParts = file.path.replace(/[/\\._-]/g, " ");

        insertStmt.run(
          pathParts,
          exportNames,
          classNames,
          functionNames,
          methodNames,
          typeNames,
          jsdoc,
          extendsImplements,
        );
      }
    });

    insertMany();

    // Query FTS5 with BM25 ranking
    // bm25() returns negative scores (more negative = better), with per-column weights
    const ftsQuery = queryTerms.join(" OR ");

    const rows = db.query<{ rowid: number; rank: number }, [string]>(`
      SELECT rowid, bm25(files_fts, 1.0, 5.0, 5.0, 5.0, 3.0, 4.0, 2.0, 3.0) as rank
      FROM files_fts
      WHERE files_fts MATCH ?
      ORDER BY rank
    `).all(ftsQuery);

    // Map rowid back to file (rowids are 1-based, matching insertion order)
    for (const row of rows) {
      const fileIdx = row.rowid - 1;
      if (fileIdx < 0 || fileIdx >= files.length) continue;
      const file = files[fileIdx]!;

      // BM25 returns negative scores; negate to get positive
      const score = -row.rank;

      // Determine matched terms by checking which terms appear in the file's indexed content
      const matchedTerms: string[] = [];
      const indexedText = buildIndexedText(file).toLowerCase();
      for (const term of queryTerms) {
        if (indexedText.includes(term)) {
          matchedTerms.push(term);
        }
      }

      results.set(file.path, { score, matchedTerms });
    }
  } finally {
    db.close();
  }

  return results;
}

/** Build a single string of all indexed content for a file (for matched-term detection). */
function buildIndexedText(file: FileNode): string {
  const parts: string[] = [file.path];
  for (const e of file.exports) parts.push(expandName(e.name));
  for (const c of file.classes) {
    parts.push(expandName(c.name));
    if (c.extends) parts.push(expandName(c.extends));
    for (const impl of c.implements) parts.push(expandName(impl));
    for (const m of c.methods) parts.push(expandName(m.name));
    if (c.jsdoc) parts.push(c.jsdoc);
  }
  for (const f of file.functions) {
    parts.push(expandName(f.name));
    if (f.jsdoc) parts.push(f.jsdoc);
  }
  for (const t of file.types) parts.push(expandName(t.name));
  for (const e of file.exports) if (e.jsdoc) parts.push(e.jsdoc);
  return parts.join(" ");
}

/**
 * Simplified PageRank on the file dependency graph.
 * Files that are imported by many other files get higher scores.
 */
function computePageRank(
  edges: Edge[],
  allFiles: string[],
  iterations: number = 20,
  damping: number = 0.85,
): Map<string, number> {
  const n = allFiles.length;
  if (n === 0) return new Map();

  // Build adjacency list (from -> [to])
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();

  for (const file of allFiles) {
    outgoing.set(file, new Set());
    incoming.set(file, new Set());
  }

  for (const edge of edges) {
    outgoing.get(edge.from)?.add(edge.to);
    incoming.get(edge.to)?.add(edge.from);
  }

  // Initialize scores uniformly
  const scores = new Map<string, number>();
  for (const file of allFiles) {
    scores.set(file, 1 / n);
  }

  // Iterate
  for (let iter = 0; iter < iterations; iter++) {
    const newScores = new Map<string, number>();

    for (const file of allFiles) {
      let inScore = 0;
      const incomingNodes = incoming.get(file);
      if (incomingNodes) {
        for (const src of incomingNodes) {
          const srcOut = outgoing.get(src)?.size ?? 1;
          inScore += (scores.get(src) ?? 0) / srcOut;
        }
      }
      newScores.set(file, (1 - damping) / n + damping * inScore);
    }

    // Update scores
    for (const [file, score] of newScores) {
      scores.set(file, score);
    }
  }

  return scores;
}

/**
 * Extract lines from a source file that match any of the query terms.
 * Returns up to `maxHits` matching lines with line numbers, trimmed.
 */
function extractMatchingLines(
  rootPath: string,
  filePath: string,
  queryTerms: string[],
  maxHits: number = 5,
): string[] {
  if (queryTerms.length === 0) return [];
  let source: string;
  try {
    source = readFileSync(join(rootPath, filePath), "utf-8");
  } catch {
    return [];
  }

  const sourceLines = source.split("\n");
  const hits: string[] = [];

  for (let i = 0; i < sourceLines.length && hits.length < maxHits; i++) {
    const line = sourceLines[i]!;
    const trimmed = line.trim();
    // Skip blank lines, imports, pure type annotations, comments-only lines
    if (
      !trimmed ||
      trimmed.startsWith("import ") ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("export interface") ||
      trimmed.startsWith("export type")
    ) continue;

    const lower = trimmed.toLowerCase();
    for (const term of queryTerms) {
      if (lower.includes(term)) {
        let display = trimmed;
        if (display.length > 120) display = display.slice(0, 117) + "...";
        hits.push(`  L${i + 1}: ${display}`);
        break;
      }
    }
  }
  return hits;
}

/**
 * Render ranked results as compact markdown for LLM consumption.
 * Includes file summary, key exports, matching body lines, and why it matched.
 *
 * @param rootPath - project root, needed to read source files for body line matching
 * @param queryTerms - tokenized query terms for body line extraction
 */
export function renderRankedResults(
  ranked: RankedFile[],
  rootPath?: string,
  queryTerms?: string[],
  maxFiles: number = 10,
  maxLines: number = 200,
): string {
  const lines: string[] = [];
  let fileCount = 0;

  for (const { file, matchedTerms } of ranked) {
    if (fileCount >= maxFiles || lines.length >= maxLines) break;

    const fileName = file.path;
    const summary = summarizeFile(file);
    const matchInfo = matchedTerms.length > 0 ? ` [matched: ${matchedTerms.join(", ")}]` : "";

    lines.push(`## ${fileName}${matchInfo}`);
    lines.push(`${summary}`);
    lines.push("");
    // line count tracked by lines.length

    // Show exports — cap at 10 per file, truncate long signatures
    if (file.exports.length > 0) {
      const exportsToShow = file.exports.slice(0, 10);
      for (const exp of exportsToShow) {
        let sig = exp.signature.replace(/\n\s*/g, " ");
        if (sig.length > 120) sig = sig.slice(0, 117) + "...";
        lines.push(`- \`${sig}\``);
        if (exp.jsdoc) lines.push(`  ${exp.jsdoc.split("\n")[0]}`);
        // tracked
      }
      if (file.exports.length > 10) {
        lines.push(`- _... ${file.exports.length - 10} more exports_`);
        // tracked
      }
      lines.push("");
      // tracked
    }

    // Show class details
    for (const cls of file.classes) {
      const ext = cls.extends ? ` extends ${cls.extends}` : "";
      lines.push(`**class ${cls.name}${ext}**`);
      // tracked

      const methodsToShow = cls.methods.slice(0, 8);
      for (const method of methodsToShow) {
        const async_ = method.isAsync ? "async " : "";
        const params = method.params.map((p) => `${p.name}: ${p.type}`).join(", ");
        lines.push(`- ${async_}${method.name}(${params}): ${method.returnType}`);
      }
      if (cls.methods.length > 8) {
        lines.push(`- _... ${cls.methods.length - 8} more methods_`);
      }
      lines.push("");
      // tracked
    }

    // Show matching body lines from source (implementation details)
    if (rootPath && queryTerms && queryTerms.length > 0) {
      const bodyHits = extractMatchingLines(rootPath, file.path, queryTerms);
      if (bodyHits.length > 0) {
        lines.push("**Key lines:**");
        for (const hit of bodyHits) {
          lines.push(hit);
        }
        lines.push("");
      }
    }

    // Show imports — compact, just unique module dirs
    const internalImports = file.imports.filter((i) => i.resolvedPath);
    if (internalImports.length > 0) {
      const dirs = [...new Set(internalImports.map((i) => {
        const parts = i.resolvedPath!.split("/");
        return parts.slice(0, -1).join("/") || parts[0];
      }))].sort();
      lines.push(`**Depends on:** ${dirs.slice(0, 8).join(", ")}${dirs.length > 8 ? ` +${dirs.length - 8}` : ""}`);
      lines.push("");
      // tracked
    }

    lines.push("---");
    lines.push("");
    fileCount++;
  }

  if (ranked.length > fileCount) {
    lines.push(`_${ranked.length - fileCount} more files matched but were truncated._`);
  }

  return lines.join("\n");
}
