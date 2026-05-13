#!/usr/bin/env bun
/**
 * Lookup eval harness — runs the 50-query natural-language lookup benchmark
 * (`eval/data/lookup-truth-*.jsonl`) against four retrieval adapters:
 *
 *   - codemap  (this repo's CLI)
 *   - grep     (ripgrep baseline)
 *   - embedding(MiniLM-L6-v2 via Transformers.js, one chunk per file capped at
 *              4096 chars, file embeddings cached per repo so the run cost is
 *              O(files + queries) not O(files × queries))
 *   - aider-full (Aider's `--show-repo-map` PageRank-ordered file list,
 *                 returned in full — no per-query re-ranking)
 *
 * Outputs P@5 / R@5 / F1@5 / tokens / hits, aggregated and per repo.
 *
 * Prerequisites — run `eval/scripts/setup-test-repos.sh` first to clone the
 * four target repos into `/tmp/eval-*` and `/tmp/fastapi`. The aider-full
 * adapter shells out to the `aider` CLI, so `pip install aider-chat` (or
 * equivalent) is required to reproduce the aider numbers. The script will
 * skip missing repos and a missing `aider` binary with a warning rather
 * than aborting the whole run.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "@huggingface/transformers";
import { codemap } from "../adapters/codemap";
import { grep } from "../adapters/grep";
import type { Retriever } from "../types";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, "..", "data");

console.log("Loading MiniLM embedder (Xenova/all-MiniLM-L6-v2)...");
const extractor = await pipeline(
  "feature-extraction",
  "Xenova/all-MiniLM-L6-v2",
);
async function embedOne(text: string): Promise<number[]> {
  const out = await (extractor as unknown as (
    text: string,
    opts: { pooling: string; normalize: boolean },
  ) => Promise<{ data: Float32Array }>)(text, { pooling: "mean", normalize: true });
  return Array.from(out.data);
}
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", ".git", ".next", ".nuxt",
  ".turbo", ".cache", "coverage", "__pycache__", ".venv", "venv",
  ".tox", ".mypy_cache", ".pytest_cache", ".codemap", ".gitnexus",
  ".worktrees", ".idea", ".vscode", "docs_src", "tests", "docs",
]);
const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go",
]);
const CHUNK_CHARS = 4096;
/** File cap to keep MiniLM runs tractable on large repos. */
const MAX_FILES = 800;

function* walk(root: string, current: string = root): Generator<string> {
  let entries;
  try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(current, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(root, full);
    } else if (e.isFile()) {
      const ext = e.name.slice(e.name.lastIndexOf("."));
      if (SOURCE_EXTS.has(ext)) yield full;
    }
  }
}

const EMBED_CACHE: Record<string, Array<{ path: string; vec: number[] }>> = {};

async function ensureRepoEmbedded(repoPath: string): Promise<void> {
  if (EMBED_CACHE[repoPath]) return;
  const files: string[] = [];
  for (const p of walk(repoPath)) {
    files.push(p);
    if (files.length >= MAX_FILES) break;
  }
  console.log(`  embedding ${files.length} files in ${repoPath}...`);
  const results: Array<{ path: string; vec: number[] }> = [];
  for (const filePath of files) {
    let text;
    try {
      text = readFileSync(filePath, "utf-8").slice(0, CHUNK_CHARS);
      if (!text.trim()) continue;
    } catch { continue; }
    try {
      const vec = await embedOne(text);
      results.push({ path: relative(repoPath, filePath), vec });
    } catch { /* skip files that fail to embed */ }
  }
  EMBED_CACHE[repoPath] = results;
  console.log(`  done: ${results.length} embedded`);
}

const embedding: Retriever = {
  name: "embedding",
  async query(q, repoPath, k) {
    await ensureRepoEmbedded(repoPath);
    const start = Date.now();
    const qvec = await embedOne(q);
    const scored = EMBED_CACHE[repoPath]!.map((f) => ({
      path: f.path, score: cosine(qvec, f.vec),
    }));
    scored.sort((a, b) => b.score - a.score);
    return {
      files: scored.slice(0, k).map((s) => s.path),
      tokens: k * 500,
      ms: Date.now() - start,
    };
  },
};

/**
 * aider-full — invokes `aider --show-repo-map` once per repo, caches the
 * stdout, and returns the full PageRank-ordered file list (no per-query
 * re-ranking). Tokens are counted from the full repomap text length.
 *
 * If the `aider` CLI is not installed, the cache returns an empty result
 * for that repo and the adapter's contribution to the run is skipped.
 */
const AIDER_CACHE: Record<string, { files: string[]; tokens: number }> = {};
const HEADER_RE = /^([\w./\-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|cs|php)):\s*$/;

async function buildAiderMap(repoPath: string): Promise<{ files: string[]; tokens: number }> {
  if (AIDER_CACHE[repoPath]) return AIDER_CACHE[repoPath]!;
  let stdout = "";
  try {
    const proc = Bun.spawn(
      ["aider", "--show-repo-map", "--no-gitignore", "--no-git", "--yes-always"],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    );
    stdout = await new Response(proc.stdout).text();
    await proc.exited;
  } catch {
    console.warn(`  aider not available — aider-full will return empty for ${repoPath}`);
    AIDER_CACHE[repoPath] = { files: [], tokens: 0 };
    return AIDER_CACHE[repoPath]!;
  }
  const set = new Set<string>(); const ord: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(HEADER_RE);
    if (m && m[1] && !set.has(m[1])) { set.add(m[1]); ord.push(m[1]); }
  }
  AIDER_CACHE[repoPath] = { files: ord, tokens: Math.ceil(stdout.length / 4) };
  return AIDER_CACHE[repoPath]!;
}

const aiderFull: Retriever = {
  name: "aider-full",
  async query(_q, repoPath, _k) {
    const start = Date.now();
    const cached = await buildAiderMap(repoPath);
    return { files: cached.files, tokens: cached.tokens, ms: Date.now() - start };
  },
};

type GT = { title: string; files_changed: string[] };

const REPOS = [
  { slug: "inngest/inngest-js", lang: "TS", jsonl: join(DATA_DIR, "lookup-truth-inngest.jsonl"), path: "/tmp/eval-inngest-js" },
  { slug: "excalidraw/excalidraw", lang: "TS", jsonl: join(DATA_DIR, "lookup-truth-excalidraw.jsonl"), path: "/tmp/eval-excalidraw" },
  { slug: "tanstack/query", lang: "TS", jsonl: join(DATA_DIR, "lookup-truth-tanstack.jsonl"), path: "/tmp/eval-tanstack-query" },
  { slug: "tiangolo/fastapi", lang: "Python", jsonl: join(DATA_DIR, "lookup-truth-fastapi.jsonl"), path: "/tmp/fastapi" },
];
const K = 5;

function metrics(pred: string[], truth: string[]): { p: number; r: number; f1: number } {
  if (pred.length === 0 || truth.length === 0) return { p: 0, r: 0, f1: 0 };
  const t = new Set(truth);
  const hits = pred.filter((f) => t.has(f)).length;
  const p = hits / pred.length, r = hits / truth.length;
  return { p, r, f1: p + r === 0 ? 0 : (2 * p * r) / (p + r) };
}

const aiderAvailable = Bun.which("aider") !== null;
if (!aiderAvailable) {
  console.warn("aider not found — omitting from comparison");
}

const adapters: { adapter: Retriever; topK: number | "all" }[] = [
  { adapter: codemap, topK: K },
  { adapter: grep, topK: K },
  { adapter: embedding, topK: K },
  ...(aiderAvailable ? [{ adapter: aiderFull, topK: "all" as const }] : []),
];

const stats: Record<string, { p: number; r: number; f1: number; tok: number; hits: number; n: number }> =
  Object.fromEntries(adapters.map(({ adapter }) => [adapter.name, { p: 0, r: 0, f1: 0, tok: 0, hits: 0, n: 0 }]));
const perRepo: Record<string, Record<string, { f1: number; r: number; hits: number; n: number }>> = {};

for (const repo of REPOS) {
  if (!existsSync(repo.path)) {
    console.warn(`\n!! Skipping ${repo.slug}: ${repo.path} does not exist (run eval/scripts/setup-test-repos.sh first)`);
    continue;
  }
  const prs = readFileSync(repo.jsonl, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as GT);
  console.log(`\n=== ${repo.slug} (${repo.lang}, ${prs.length} questions) ===`);
  perRepo[repo.slug] = {};
  for (const { adapter, topK } of adapters) {
    process.stdout.write(`  ${adapter.name.padEnd(14)}`);
    let p = 0, r = 0, f = 0, tok = 0, hits = 0;
    for (const pr of prs) {
      try {
        const result = await adapter.query(pr.title, repo.path, topK === "all" ? 999 : topK);
        const files = topK === "all" ? result.files : result.files.slice(0, topK);
        const m = metrics(files, pr.files_changed);
        p += m.p; r += m.r; f += m.f1; tok += result.tokens;
        if (m.f1 > 0) hits++;
      } catch { /* per-query failure should not abort the run */ }
    }
    const n = prs.length;
    console.log(
      `  P=${(p / n).toFixed(3)}  R=${(r / n).toFixed(3)}  ` +
      `F1=${(f / n).toFixed(3)}  tok=${Math.round(tok / n).toString().padStart(5)}  ` +
      `hits=${hits}/${n}`,
    );
    const s = stats[adapter.name]!;
    s.p += p; s.r += r; s.f1 += f; s.tok += tok; s.hits += hits; s.n += n;
    perRepo[repo.slug]![adapter.name] = { f1: f / n, r: r / n, hits, n };
  }
}

console.log(`\n=== Aggregated (50 queries, ${adapters.length} adapters) ===`);
console.log("adapter".padEnd(14) + "  P       R       F1      tokens  hits");
for (const [name, s] of Object.entries(stats)) {
  if (s.n === 0) continue;
  console.log(
    name.padEnd(14) +
    `  ${(s.p / s.n).toFixed(3)}   ${(s.r / s.n).toFixed(3)}   ` +
    `${(s.f1 / s.n).toFixed(3)}   ${Math.round(s.tok / s.n).toString().padStart(5)}   ` +
    `${s.hits}/${s.n}`,
  );
}

console.log("\n=== F1 per repo ===");
const aiderHeader = aiderAvailable ? "aider     " : "";
console.log("repo".padEnd(26) + "lang     codemap   grep      embedding   " + aiderHeader + "hits");
for (const [slug, r] of Object.entries(perRepo)) {
  const lang = REPOS.find((rep) => rep.slug === slug)!.lang;
  const aiderCol = aiderAvailable ? r["aider-full"]!.f1.toFixed(3).padEnd(10) : "";
  console.log(
    slug.padEnd(26) + lang.padEnd(9) +
    r.codemap!.f1.toFixed(3).padEnd(10) +
    r.grep!.f1.toFixed(3).padEnd(10) +
    r.embedding!.f1.toFixed(3).padEnd(12) +
    aiderCol +
    `${r.codemap!.hits}/${r.codemap!.n}`,
  );
}
