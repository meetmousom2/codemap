/**
 * GitNexus adapter — shells out to the `gitnexus` CLI from the `gitnexus`
 * npm package. Two steps: `gitnexus analyze` to (re)build the local index,
 * then `gitnexus query` to retrieve ranked symbols which we collapse into
 * a per-file ranking.
 *
 * The `gitnexus query` command writes a single JSON object to stdout with
 * `process_symbols` and `definitions` arrays; each entry carries a
 * `filePath`. We deduplicate while preserving rank order.
 *
 * LICENSE NOTE: gitnexus ships under PolyForm Noncommercial 1.0.0 — see
 * `eval/adapters/README.md`.
 */

import type { Retriever } from "../types";

interface GitNexusSymbol {
  filePath?: string;
}

interface GitNexusQueryResult {
  process_symbols?: GitNexusSymbol[];
  definitions?: GitNexusSymbol[];
}

function parseFiles(stdout: string, k: number): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: GitNexusQueryResult;
  try {
    parsed = JSON.parse(trimmed) as GitNexusQueryResult;
  } catch {
    return [];
  }
  const ordered: GitNexusSymbol[] = [
    ...(parsed.process_symbols ?? []),
    ...(parsed.definitions ?? []),
  ];
  const seen = new Set<string>();
  const files: string[] = [];
  for (const sym of ordered) {
    const path = sym.filePath;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    files.push(path);
    if (files.length >= k) break;
  }
  return files;
}

async function run(cmd: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}

export const gitnexus: Retriever = {
  name: "gitnexus",
  async query(question, repoPath, k) {
    const start = Date.now();
    // analyze is idempotent — it no-ops when the index is fresh, so we
    // always run it before query to make the adapter callable on cold repos.
    await run(["gitnexus", "analyze", "--skip-embeddings"], repoPath);
    const stdout = await run(
      ["gitnexus", "query", question, "--limit", String(k)],
      repoPath,
    );
    return {
      files: parseFiles(stdout, k),
      tokens: Math.ceil(stdout.length / 4),
      ms: Date.now() - start,
    };
  },
};

export default gitnexus;
