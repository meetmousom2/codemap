/**
 * grep adapter — naive ripgrep baseline.
 *
 * Tokenises the question (reusing codemap's `tokenize`, which already drops
 * English stopwords) and ranks files by:
 *   - body match count from `rg --count-matches -i -e '(kw1|kw2|...)'`, plus
 *   - a `5×` boost per unique keyword that appears in the file's path.
 *
 * Path matches are scored higher because matching `auth/login.ts` against
 * "auth flow" is a much stronger signal than a stray hit somewhere in a
 * 1 kLoC file.
 */

import { tokenize } from "../../src/ranker";
import type { Retriever } from "../types";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runRipgrep(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["rg", ...args], {
    cwd, stdout: "pipe", stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}

/**
 * Parse `rg --count-matches` output. Each line is `path:count`; the path may
 * itself contain `:` on disk, so split on the LAST colon to be safe.
 */
function parseCountMatches(out: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const idx = line.lastIndexOf(":");
    if (idx <= 0) continue;
    const path = line.slice(0, idx);
    const count = parseInt(line.slice(idx + 1), 10);
    if (!path || !Number.isFinite(count) || count <= 0) continue;
    result.set(path, (result.get(path) ?? 0) + count);
  }
  return result;
}

async function listAllFiles(cwd: string): Promise<string[]> {
  const out = await runRipgrep(["--files"], cwd);
  return out.split("\n").filter((l) => l.length > 0);
}

const PATH_BOOST_PER_KEYWORD = 5;

export const grep: Retriever = {
  name: "grep",
  async query(question, repoPath, k) {
    const start = Date.now();
    const keywords = tokenize(question);
    if (keywords.length === 0) {
      return { files: [], tokens: 0, ms: Date.now() - start };
    }
    const pattern = keywords.map(escapeRegex).join("|");

    const [contentOut, allFiles] = await Promise.all([
      runRipgrep(["--count-matches", "-i", "-e", pattern], repoPath),
      listAllFiles(repoPath),
    ]);

    const contentScores = parseCountMatches(contentOut);

    const combined = new Map<string, number>(contentScores);
    for (const file of allFiles) {
      const lower = file.toLowerCase();
      let hits = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) hits++;
      }
      if (hits > 0) {
        combined.set(file, (combined.get(file) ?? 0) + hits * PATH_BOOST_PER_KEYWORD);
      }
    }

    return {
      files: [...combined.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, k)
        .map(([f]) => f),
      tokens: keywords.reduce((acc, kw) => acc + Math.ceil(kw.length / 4), 0),
      ms: Date.now() - start,
    };
  },
};

export default grep;
