/**
 * Ranker — ranks files and symbols by relevance to a query.
 * Uses keyword matching + simplified PageRank on the dependency graph.
 */

import type { CodeGraph, FileNode, Edge } from "./types";
import { summarizeFile } from "./summarizer";

interface RankedFile {
  file: FileNode;
  score: number;
  matchedTerms: string[];
}

/**
 * Rank files by relevance to a query string.
 * Combines keyword matching (direct relevance) with graph importance (PageRank).
 */
export function rankFiles(graph: CodeGraph, query: string): RankedFile[] {
  const queryTerms = tokenize(query);
  const pageRankScores = computePageRank(graph.edges, graph.files.map((f) => f.path));

  const ranked: RankedFile[] = [];

  for (const file of graph.files) {
    const { score: keywordScore, matchedTerms } = scoreKeywordMatch(file, queryTerms);
    const prScore = pageRankScores.get(file.path) ?? 0;

    // Keyword match is primary signal, PageRank is secondary (importance boost)
    // Files with keyword matches get boosted by their graph importance
    const score = keywordScore > 0
      ? keywordScore * (1 + prScore * 10)
      : prScore * 0.1; // small baseline for important files with no keyword match

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

function tokenize(text: string): string[] {
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
 * Score how well a file matches the query terms.
 * Checks: file path, export names, class names, function names, JSDoc, type names.
 */
function scoreKeywordMatch(
  file: FileNode,
  queryTerms: string[],
): { score: number; matchedTerms: string[] } {
  const matchedTerms: string[] = [];
  let score = 0;

  // Build searchable text from the file's metadata
  const searchableFields: { text: string; weight: number }[] = [
    // File path (low weight — broad match)
    { text: file.path.toLowerCase(), weight: 1 },
    // Export names (high weight — these are the key identifiers)
    ...file.exports.map((e) => ({ text: e.name.toLowerCase(), weight: 5 })),
    // Class names (high weight)
    ...file.classes.map((c) => ({ text: c.name.toLowerCase(), weight: 5 })),
    // Method names (medium weight)
    ...file.classes.flatMap((c) =>
      c.methods.map((m) => ({ text: m.name.toLowerCase(), weight: 3 })),
    ),
    // Function names (high weight)
    ...file.functions.map((f) => ({ text: f.name.toLowerCase(), weight: 5 })),
    // Type/interface names (medium weight)
    ...file.types.map((t) => ({ text: t.name.toLowerCase(), weight: 4 })),
    // JSDoc (low weight — contextual match)
    ...file.exports
      .filter((e) => e.jsdoc)
      .map((e) => ({ text: e.jsdoc!.toLowerCase(), weight: 2 })),
    ...file.classes
      .filter((c) => c.jsdoc)
      .map((c) => ({ text: c.jsdoc!.toLowerCase(), weight: 2 })),
    ...file.functions
      .filter((f) => f.jsdoc)
      .map((f) => ({ text: f.jsdoc!.toLowerCase(), weight: 2 })),
    // Extends/implements (medium weight — relationship queries)
    ...file.classes
      .filter((c) => c.extends)
      .map((c) => ({ text: c.extends!.toLowerCase(), weight: 3 })),
    ...file.classes.flatMap((c) =>
      c.implements.map((i) => ({ text: i.toLowerCase(), weight: 3 })),
    ),
  ];

  for (const term of queryTerms) {
    let termMatched = false;
    for (const field of searchableFields) {
      if (field.text.includes(term)) {
        score += field.weight;
        termMatched = true;
        break; // Don't double-count same term in multiple fields
      }
    }
    if (termMatched && !matchedTerms.includes(term)) matchedTerms.push(term);
  }

  // Penalize files with very many exports (types files) — they match too broadly
  const exportCount = file.exports.length + file.types.length;
  if (exportCount > 20) {
    score *= 0.5;
  }

  return { score, matchedTerms };
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

  // Build adjacency list (from → [to])
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
 * Render ranked results as compact markdown for LLM consumption.
 * Includes file summary, key exports, and why it matched.
 */
export function renderRankedResults(
  ranked: RankedFile[],
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
