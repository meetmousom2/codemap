/**
 * Aider repomap adapter — shells out to `aider --show-repo-map` and ranks
 * the emitted file sections against the question.
 *
 * Aider's repomap is a PageRank-ordered text dump that groups symbols by
 * the file they belong to:
 *
 *   src/foo.ts:
 *   ⋮...
 *   │export function bar(): number { ... }
 *   ⋮...
 *
 *   src/baz.py:
 *   ...
 *
 * We parse the file headers, then re-rank by counting question keywords
 * inside each file's section. Sections that match zero keywords keep their
 * original PageRank order as a tiebreaker tail.
 */

import { tokenize } from "../../src/ranker";
import type { Retriever } from "../types";

interface FileSection {
  path: string;
  body: string;
}

const HEADER_RE = /^([\w./\-]+\.[A-Za-z0-9]+):\s*$/;

function parseRepoMap(stdout: string): FileSection[] {
  const sections: FileSection[] = [];
  let current: FileSection | null = null;
  for (const line of stdout.split("\n")) {
    const match = line.match(HEADER_RE);
    if (match && match[1]) {
      if (current) sections.push(current);
      current = { path: match[1], body: "" };
    } else if (current) {
      current.body += line + "\n";
    }
  }
  if (current) sections.push(current);
  return sections;
}

function countMatches(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

function rank(sections: FileSection[], keywords: string[], k: number): string[] {
  const scored = sections.map((section, idx) => {
    const text = (section.path + "\n" + section.body).toLowerCase();
    let score = 0;
    for (const kw of keywords) score += countMatches(text, kw);
    return { path: section.path, score, idx };
  });
  const matched = scored.filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.idx - b.idx);
  const unmatched = scored.filter((s) => s.score === 0); // preserve aider's order
  return [...matched, ...unmatched].slice(0, k).map((s) => s.path);
}

export const aider: Retriever = {
  name: "aider",
  async query(question, repoPath, k) {
    const start = Date.now();
    const proc = Bun.spawn(
      ["aider", "--show-repo-map", "--no-gitignore", "--no-git", "--yes-always"],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const sections = parseRepoMap(stdout);
    return {
      files: rank(sections, tokenize(question), k),
      tokens: Math.ceil(stdout.length / 4),
      ms: Date.now() - start,
    };
  },
};

export default aider;
