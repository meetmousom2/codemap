/**
 * Semantic embeddings — optional semantic search using Transformers.js.
 * Uses all-MiniLM-L6-v2 (384-dim) via ONNX WASM, runs entirely in-process.
 *
 * Supports incremental updates: only re-embeds files whose content changed
 * since the last cached commit.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { CodeGraph, FileNode } from "./types";

/** Re-exported for the ranker interface */
interface RankedFile {
  file: FileNode;
  score: number;
  matchedTerms: string[];
}

// Lazy-loaded pipeline reference
let extractor: any = null;

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const CACHE_DIR_NAME = "models";
const EMBEDDINGS_FILE = "embeddings.json";

export interface EmbeddingsCache {
  commitHash: string;
  files: Record<string, { embedding: number[]; contentHash: string }>;
}

/** Extended cache result that includes the count of newly embedded files. */
export interface EmbeddingsCacheResult extends EmbeddingsCache {
  embeddedCount: number;
}

/**
 * Build a text representation of a file for embedding.
 * Combines path, summary info, exports, classes, functions, and JSDoc.
 */
export function buildFileText(file: FileNode): string {
  const parts: string[] = [];

  // File path (split on / and . for semantic signal)
  parts.push(file.path);

  // Export names and JSDoc
  for (const exp of file.exports) {
    parts.push(exp.name);
    if (exp.jsdoc) parts.push(exp.jsdoc);
  }

  // Class names, extends, methods, JSDoc
  for (const cls of file.classes) {
    parts.push(cls.name);
    if (cls.extends) parts.push(cls.extends);
    for (const impl of cls.implements) parts.push(impl);
    if (cls.jsdoc) parts.push(cls.jsdoc);
    for (const method of cls.methods) {
      parts.push(method.name);
      if (method.jsdoc) parts.push(method.jsdoc);
    }
  }

  // Function names and JSDoc
  for (const fn of file.functions) {
    parts.push(fn.name);
    if (fn.jsdoc) parts.push(fn.jsdoc);
  }

  // Type names
  for (const t of file.types) {
    parts.push(t.name);
    if (t.jsdoc) parts.push(t.jsdoc);
  }

  return parts.join(" ");
}

/**
 * Compute a content hash for a file's text representation.
 * Used to detect whether a file needs re-embedding.
 */
export function computeContentHash(file: FileNode): string {
  const text = buildFileText(file);
  return Bun.hash(text).toString(36);
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Load the sentence-transformers model pipeline.
 * Downloads on first use to .codemap/models/.
 */
async function loadModel(rootPath: string): Promise<any> {
  if (extractor) return extractor;

  const cacheDir = join(rootPath, ".codemap", CACHE_DIR_NAME);
  await mkdir(cacheDir, { recursive: true });

  const { pipeline, env } = await import("@huggingface/transformers");

  // Configure cache directory
  env.cacheDir = cacheDir;
  // Disable remote model hub checks after first download
  env.allowLocalModels = true;

  extractor = await pipeline("feature-extraction", MODEL_ID, {
    cache_dir: cacheDir,
  });

  return extractor;
}

/**
 * Embed a single text string, returning a 384-dim vector.
 */
async function embedText(text: string, rootPath: string): Promise<number[]> {
  const model = await loadModel(rootPath);
  const output = await model(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array).slice(0, 384);
}

/**
 * Build or incrementally update embeddings for a set of files.
 *
 * When existingCache is null, embeds all files from scratch.
 * When existingCache is provided, only re-embeds files whose contentHash changed,
 * adds new files, and prunes deleted files.
 *
 * The embedder parameter allows injection of a mock for testing.
 */
export async function buildIncrementalEmbeddings(
  files: FileNode[],
  existingCache: EmbeddingsCache | null,
  commitHash: string,
  embedder: (text: string) => number[] | Promise<number[]>,
): Promise<EmbeddingsCacheResult> {
  const result: EmbeddingsCacheResult = {
    commitHash,
    files: {},
    embeddedCount: 0,
  };

  const currentPaths = new Set(files.map((f) => f.path));

  for (const file of files) {
    const text = buildFileText(file);
    const contentHash = computeContentHash(file);

    // Check if cached embedding is still valid
    const cached = existingCache?.files[file.path];
    if (cached && cached.contentHash === contentHash) {
      // Reuse cached embedding
      result.files[file.path] = { embedding: cached.embedding, contentHash };
    } else {
      // New or changed file — embed it
      const embedding = await embedder(text);
      result.files[file.path] = { embedding, contentHash };
      result.embeddedCount++;
    }
  }

  // Deleted files are implicitly pruned — we only iterate over current files

  return result;
}

/**
 * Get current HEAD commit hash (short).
 */
function getHeadCommit(rootPath: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: rootPath });
    return proc.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if an embeddings cache file exists (does not load it).
 */
export function hasEmbeddingsCache(rootPath: string): boolean {
  return existsSync(join(rootPath, ".codemap", EMBEDDINGS_FILE));
}

/**
 * Load embeddings cache from disk.
 */
async function loadEmbeddingsCache(rootPath: string): Promise<EmbeddingsCache | null> {
  const cachePath = join(rootPath, ".codemap", EMBEDDINGS_FILE);
  if (!existsSync(cachePath)) return null;

  try {
    const content = await Bun.file(cachePath).text();
    return JSON.parse(content) as EmbeddingsCache;
  } catch {
    return null;
  }
}

/**
 * Save embeddings cache to disk.
 */
async function saveEmbeddingsCache(
  rootPath: string,
  cache: EmbeddingsCache,
): Promise<void> {
  const cachePath = join(rootPath, ".codemap", EMBEDDINGS_FILE);
  await Bun.write(cachePath, JSON.stringify(cache));
}

/**
 * Compute PageRank scores for files (simplified — same logic as ranker.ts).
 */
function computePageRank(
  edges: { from: string; to: string }[],
  allFiles: string[],
  iterations: number = 20,
  damping: number = 0.85,
): Map<string, number> {
  const n = allFiles.length;
  if (n === 0) return new Map();

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

  const scores = new Map<string, number>();
  for (const file of allFiles) {
    scores.set(file, 1 / n);
  }

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
    for (const [file, score] of newScores) {
      scores.set(file, score);
    }
  }

  return scores;
}

/**
 * Rank files semantically using embeddings + PageRank.
 *
 * 1. Load or incrementally update embeddings cache
 * 2. Embed the query
 * 3. Score each file by cosine similarity
 * 4. Combine with PageRank: cosineSim * (1 + prScore * 10)
 * 5. Return top N results as RankedFile[]
 */
export async function semanticRank(
  graph: CodeGraph,
  query: string,
  maxResults: number = 20,
): Promise<RankedFile[]> {
  const rootPath = graph.root;
  const commitHash = getHeadCommit(rootPath);

  // Load existing cache (may be null, stale, or fresh)
  const existingCache = await loadEmbeddingsCache(rootPath);

  let fileEmbeddings: Map<string, number[]>;

  if (existingCache && existingCache.commitHash === commitHash) {
    // Cache is fresh — use it directly
    fileEmbeddings = new Map(
      Object.entries(existingCache.files).map(([path, entry]) => [path, entry.embedding]),
    );
  } else {
    // Cache is missing or stale — do incremental update
    if (!existingCache) {
      console.error("codemap: building semantic index (first run)...");
    } else {
      // Stale cache — will do incremental
    }

    const embedder = async (text: string) => embedText(text, rootPath);
    const result = await buildIncrementalEmbeddings(
      graph.files,
      existingCache,
      commitHash ?? "unknown",
      embedder,
    );

    if (existingCache && result.embeddedCount > 0) {
      console.error(`codemap: updating semantic index (${result.embeddedCount} files changed)...`);
    } else if (!existingCache) {
      console.error(`codemap: semantic index built (${result.embeddedCount} files)`);
    }

    // Save updated cache (strip embeddedCount — it's not part of the persisted format)
    const { embeddedCount: _, ...cacheToSave } = result;
    await saveEmbeddingsCache(rootPath, cacheToSave);

    fileEmbeddings = new Map(
      Object.entries(result.files).map(([path, entry]) => [path, entry.embedding]),
    );
  }

  // Embed the query
  const queryEmbedding = await embedText(query, rootPath);

  // Compute PageRank
  const pageRankScores = computePageRank(
    graph.edges,
    graph.files.map((f) => f.path),
  );

  // Patterns for test/example files — penalize so source code ranks higher
  const testPatterns = [
    /\/(e2e|tests?|__tests__|__mocks__|spec|bench|benchmarks?|fixtures?|mocks?)\//,
    /\.(spec|test|e2e)\.(ts|tsx|js|jsx)$/,
  ];
  const examplePatterns = [/\/examples?\//];

  // Score and rank
  const ranked: RankedFile[] = [];

  for (const file of graph.files) {
    const embedding = fileEmbeddings.get(file.path);
    if (!embedding) continue;

    const cosSim = cosineSimilarity(queryEmbedding, embedding);
    const prScore = pageRankScores.get(file.path) ?? 0;

    // Combine: cosine similarity boosted by PageRank importance
    let score = cosSim * (1 + prScore * 10);

    // Penalize test/example files — agents need source code first
    if (testPatterns.some((p) => p.test(file.path))) {
      score *= 0.2;
    } else if (examplePatterns.some((p) => p.test(file.path))) {
      score *= 0.4;
    }

    if (score > 0) {
      ranked.push({ file, score, matchedTerms: [] });
    }
  }

  return ranked
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

/**
 * Hybrid rank: fuse BM25 and semantic results using Reciprocal Rank Fusion (RRF).
 *
 * RRF score for a file = sum over each ranking list of 1/(k + rank_position).
 * k=60 is standard. Files appearing in both lists get boosted; files in only one
 * still contribute. This is simple, parameter-free, and well-studied in IR literature.
 *
 * If embeddings cache doesn't exist, triggers a background build and returns BM25 only.
 */
export async function hybridRank(
  graph: CodeGraph,
  query: string,
  bm25Results: RankedFile[],
  maxResults: number = 20,
): Promise<RankedFile[]> {
  const rootPath = graph.root;

  // If no embeddings cache, build in background and return BM25 only
  if (!hasEmbeddingsCache(rootPath)) {
    // Fire-and-forget: build embeddings for next time
    semanticRank(graph, query, maxResults).catch(() => {});
    console.error("codemap: building semantic index in background for future queries...");
    return bm25Results;
  }

  // Run semantic search
  let semanticResults: RankedFile[];
  try {
    semanticResults = await semanticRank(graph, query, maxResults * 2);
  } catch {
    // Semantic failed — return BM25 only
    return bm25Results;
  }

  // Reciprocal Rank Fusion (k=60)
  const k = 60;
  const rrfScores = new Map<string, { score: number; file: FileNode; matchedTerms: string[] }>();

  // Score from BM25 ranking
  for (let i = 0; i < bm25Results.length; i++) {
    const entry = bm25Results[i]!;
    const path = entry.file.path;
    const existing = rrfScores.get(path);
    const rrfContribution = 1 / (k + i + 1);
    if (existing) {
      existing.score += rrfContribution;
    } else {
      rrfScores.set(path, { score: rrfContribution, file: entry.file, matchedTerms: entry.matchedTerms });
    }
  }

  // Score from semantic ranking
  for (let i = 0; i < semanticResults.length; i++) {
    const entry = semanticResults[i]!;
    const path = entry.file.path;
    const existing = rrfScores.get(path);
    const rrfContribution = 1 / (k + i + 1);
    if (existing) {
      existing.score += rrfContribution;
    } else {
      rrfScores.set(path, { score: rrfContribution, file: entry.file, matchedTerms: [] });
    }
  }

  return [...rrfScores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ file, score, matchedTerms }) => ({ file, score, matchedTerms }));
}
