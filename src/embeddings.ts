/**
 * Semantic embeddings — optional semantic search using Transformers.js.
 * Uses all-MiniLM-L6-v2 (384-dim) via ONNX WASM, runs entirely in-process.
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

interface EmbeddingsCache {
  commitHash: string;
  files: Record<string, { embedding: number[]; contentHash: string }>;
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
 * Embed all files in the graph, returning a map of filePath -> embedding vector.
 */
async function embedFiles(
  files: FileNode[],
  rootPath: string,
): Promise<Map<string, number[]>> {
  const model = await loadModel(rootPath);
  const result = new Map<string, number[]>();

  for (const file of files) {
    const text = buildFileText(file);
    const output = await model(text, { pooling: "mean", normalize: true });
    const embedding = Array.from(output.data as Float32Array).slice(0, 384);
    result.set(file.path, embedding);
  }

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
 * 1. Load or build embeddings cache
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

  // Load or build embeddings
  let fileEmbeddings: Map<string, number[]>;
  const cached = await loadEmbeddingsCache(rootPath);

  if (cached && cached.commitHash === commitHash) {
    // Use cached embeddings
    fileEmbeddings = new Map(Object.entries(cached.files).map(
      ([path, entry]) => [path, entry.embedding],
    ));
  } else {
    // Build fresh embeddings
    console.error("codemap: building semantic index (first run)...");
    fileEmbeddings = await embedFiles(graph.files, rootPath);

    // Save cache
    const cacheData: EmbeddingsCache = {
      commitHash: commitHash ?? "unknown",
      files: {},
    };
    for (const [path, embedding] of fileEmbeddings) {
      cacheData.files[path] = { embedding, contentHash: "" };
    }
    await saveEmbeddingsCache(rootPath, cacheData);
  }

  // Embed the query
  const queryEmbedding = await embedText(query, rootPath);

  // Compute PageRank
  const pageRankScores = computePageRank(
    graph.edges,
    graph.files.map((f) => f.path),
  );

  // Score and rank
  const ranked: RankedFile[] = [];

  for (const file of graph.files) {
    const embedding = fileEmbeddings.get(file.path);
    if (!embedding) continue;

    const cosSim = cosineSimilarity(queryEmbedding, embedding);
    const prScore = pageRankScores.get(file.path) ?? 0;

    // Combine: cosine similarity boosted by PageRank importance
    const score = cosSim * (1 + prScore * 10);

    if (score > 0) {
      ranked.push({ file, score, matchedTerms: [] });
    }
  }

  return ranked
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
