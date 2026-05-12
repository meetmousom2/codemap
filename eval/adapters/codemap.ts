/**
 * codemap adapter — shells out to the local codemap CLI and parses the
 * markdown output back into a ranked file list.
 *
 * The CLI prints one `## <repo-relative-path>` heading per ranked file (see
 * `src/ranker.ts:renderRankedResults`), so we walk stdout linewise and pull
 * the first whitespace-delimited token after each `## `.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Retriever } from "../types";

const HERE = dirname(fileURLToPath(import.meta.url));
const CODEMAP_CLI = resolve(HERE, "..", "..", "src", "index.ts");

function parseRankedFiles(stdout: string, k: number): string[] {
  const files: string[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^##\s+(\S+)/);
    if (!match || !match[1]) continue;
    files.push(match[1]);
    if (files.length >= k) break;
  }
  return files;
}

export const codemap: Retriever = {
  name: "codemap",
  async query(question, repoPath, k) {
    const start = Date.now();
    const proc = Bun.spawn(
      ["bun", CODEMAP_CLI, "query", question, repoPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return {
      files: parseRankedFiles(stdout, k),
      tokens: Math.ceil(stdout.length / 4),
      ms: Date.now() - start,
    };
  },
};

export default codemap;
