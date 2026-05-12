// Shared eval-harness types.
//
// The `Retriever` interface is the contract every comparative adapter
// (codemap, GitNexus, Aider repomap, embedding-based, grep) must implement
// so the harness can run them uniformly against the JSONL ground-truth
// dataset in `eval/data/`. See issue #214 for the adapter implementations.

/**
 * A single retriever adapter. Given a natural-language question and the
 * absolute path to a checked-out repo, return the ranked list of files
 * the adapter considers most relevant, along with a few cost metrics.
 *
 * `k` is the upper bound on the number of files to return. Adapters MAY
 * return fewer (e.g. nothing found) but MUST NOT return more.
 */
export interface Retriever {
  /** Human-readable adapter name, e.g. "codemap", "grep", "embedding". */
  name: string;
  /**
   * Run a query against `repoPath` and return at most `k` candidate files.
   *
   * @param question  Natural-language query (typically the PR title/body).
   * @param repoPath  Absolute path to a checked-out copy of the target repo.
   * @param k         Maximum number of files to return.
   * @returns         Ranked files (best first), total tokens consumed, and
   *                  wall-clock time in milliseconds.
   */
  query(
    question: string,
    repoPath: string,
    k: number,
  ): Promise<RetrieverResult>;
}

export interface RetrieverResult {
  /** Repo-relative file paths, ranked best-first. */
  files: string[];
  /** Total tokens the adapter consumed answering this query. */
  tokens: number;
  /** Wall-clock latency in milliseconds. */
  ms: number;
}

/**
 * One PR record as emitted by `eval/scripts/mine-prs.ts` into
 * `eval/data/<owner>__<repo>.jsonl`. Each JSONL line parses to this shape.
 */
export interface GroundTruthPR {
  /** "owner/repo", e.g. "inngest/inngest-js". */
  repo: string;
  /** PR number. */
  number: number;
  /** PR title — used as the retriever question. */
  title: string;
  /** PR body (may be empty). */
  body: string;
  /** Repo-relative paths of files changed by the PR (1–5). */
  files_changed: string[];
  /** ISO-8601 merge timestamp. */
  merged_at: string;
  /** PR html_url. */
  url: string;
}
