/**
 * Embedding adapter — chunks every source file at 1024 tokens, embeds the
 * chunks with an `e5`-family model (default: `Xenova/multilingual-e5-large`
 * via Transformers.js), and ranks files by max cosine similarity of any
 * chunk against the question embedding.
 *
 * The embedder is injectable so tests can substitute a deterministic stub
 * without downloading the ~1 GB e5-large weights, and so callers can plug
 * in a remote API (voyage-3, OpenAI, etc.) instead of the local model.
 */

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { cosineSimilarity } from "../../src/embeddings";
import type { Retriever } from "../types";

const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", ".git", ".next", ".nuxt",
  ".turbo", ".cache", "coverage", "__pycache__", ".venv", "venv",
  ".tox", ".mypy_cache", ".pytest_cache", ".codemap", ".gitnexus",
  ".worktrees", ".idea", ".vscode",
]);

const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py",
  ".go", ".rs", ".java", ".rb", ".cs", ".php",
]);

/** 1024 tokens × ~4 chars/token ≈ 4096 chars per chunk. */
const CHUNK_TOKENS = 1024;
const CHARS_PER_TOKEN = 4;
const CHUNK_CHARS = CHUNK_TOKENS * CHARS_PER_TOKEN;

/** Default Transformers.js model id. e5-large per the issue spec. */
export const DEFAULT_MODEL = "Xenova/multilingual-e5-large";

export type Embedder = (texts: string[]) => Promise<number[][]>;

export interface EmbeddingOptions {
  /** Replace the embedder entirely — handy for tests and remote API backends. */
  embedder?: Embedder;
  /** Transformers.js model id when the default embedder is used. */
  model?: string;
}

interface ExtractorCache {
  model: string;
  extractor: (text: string, opts: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>;
}

let cachedExtractor: ExtractorCache | null = null;

async function loadTransformerEmbedder(model: string): Promise<Embedder> {
  if (!cachedExtractor || cachedExtractor.model !== model) {
    const { pipeline } = await import("@huggingface/transformers");
    const extractor = await pipeline("feature-extraction", model);
    cachedExtractor = { model, extractor: extractor as ExtractorCache["extractor"] };
  }
  const extractor = cachedExtractor.extractor;
  return async (texts) => {
    const vectors: number[][] = [];
    for (const text of texts) {
      const output = await extractor(text, { pooling: "mean", normalize: true });
      vectors.push(Array.from(output.data));
    }
    return vectors;
  };
}

async function* walkFiles(root: string, current: string = root): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkFiles(root, fullPath);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".");
      if (dot < 0) continue;
      if (SOURCE_EXTS.has(entry.name.slice(dot))) yield fullPath;
    }
  }
}

function chunkText(text: string): string[] {
  if (text.length === 0) return [];
  if (text.length <= CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_CHARS) {
    chunks.push(text.slice(i, i + CHUNK_CHARS));
  }
  return chunks;
}

/**
 * Build a Retriever that scores files by max chunk cosine similarity.
 *
 * Pass `options.embedder` (a `(texts) => number[][]` function) to inject
 * a stub or a remote backend; otherwise the local Transformers.js pipeline
 * is loaded lazily on first query.
 */
export function createEmbeddingRetriever(options: EmbeddingOptions = {}): Retriever {
  const modelName = options.model ?? DEFAULT_MODEL;
  let embedderPromise: Promise<Embedder> | null = null;

  const getEmbedder = async (): Promise<Embedder> => {
    if (options.embedder) return options.embedder;
    if (!embedderPromise) embedderPromise = loadTransformerEmbedder(modelName);
    return embedderPromise;
  };

  return {
    name: "embedding",
    async query(question, repoPath, k) {
      const start = Date.now();
      const embedder = await getEmbedder();

      const chunks: { path: string; text: string }[] = [];
      for await (const absPath of walkFiles(repoPath)) {
        let content: string;
        try {
          content = readFileSync(absPath, "utf-8");
        } catch {
          continue;
        }
        const rel = relative(repoPath, absPath);
        for (const piece of chunkText(content)) {
          chunks.push({ path: rel, text: piece });
        }
      }

      if (chunks.length === 0) {
        return { files: [], tokens: 0, ms: Date.now() - start };
      }

      const [queryVec] = await embedder([question]);
      if (!queryVec) {
        return { files: [], tokens: 0, ms: Date.now() - start };
      }
      const chunkVecs = await embedder(chunks.map((c) => c.text));

      const bestPerFile = new Map<string, number>();
      for (let i = 0; i < chunks.length; i++) {
        const vec = chunkVecs[i];
        const chunk = chunks[i];
        if (!vec || !chunk) continue;
        const score = cosineSimilarity(queryVec, vec);
        const prev = bestPerFile.get(chunk.path);
        if (prev === undefined || score > prev) bestPerFile.set(chunk.path, score);
      }

      const totalChars =
        question.length + chunks.reduce((acc, c) => acc + c.text.length, 0);

      return {
        files: [...bestPerFile.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, k)
          .map(([path]) => path),
        tokens: Math.ceil(totalChars / CHARS_PER_TOKEN),
        ms: Date.now() - start,
      };
    },
  };
}

export const embedding: Retriever = createEmbeddingRetriever();

export default embedding;
