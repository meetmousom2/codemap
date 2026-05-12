#!/usr/bin/env bun
// mine-prs.ts — fetch merged PRs from a GitHub repo, filter to small focused
// changes (1–5 files, no dependabot, no docs-only, no version bumps), and emit
// a JSONL ground-truth file at `eval/data/<owner__repo>.jsonl`.
//
// Usage:
//   bun run eval/scripts/mine-prs.ts <owner/repo> [--target N] [--max-pages N]
//
// Requires the `gh` CLI to be authenticated (`gh auth status`). All requests
// are cached under `eval/cache/<owner__repo>/` so reruns are cheap; delete the
// cache directory (or run `eval/scripts/refresh.sh`) to re-pull fresh data.

import { spawn } from "bun";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

interface PRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  user: { login: string } | null;
  merged_at: string | null;
  html_url: string;
  base?: { ref: string };
  head?: { ref: string };
}

interface PROutput {
  repo: string;
  number: number;
  title: string;
  body: string;
  files_changed: string[];
  merged_at: string;
  url: string;
}

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const EVAL_ROOT = resolve(SCRIPT_DIR, "..");

const DEFAULTS = {
  target: 100,
  maxPages: 30,
  perPage: 100,
  maxFiles: 5,
  filesConcurrency: 6,
};

function parseArgs(argv: string[]): { repo: string; target: number; maxPages: number } {
  const positional: string[] = [];
  let target = DEFAULTS.target;
  let maxPages = DEFAULTS.maxPages;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--target") {
      target = Number(argv[++i]);
    } else if (a === "--max-pages") {
      maxPages = Number(argv[++i]);
    } else if (a.startsWith("--target=")) {
      target = Number(a.slice("--target=".length));
    } else if (a.startsWith("--max-pages=")) {
      maxPages = Number(a.slice("--max-pages=".length));
    } else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else {
      positional.push(a);
    }
  }
  const repo = positional[0];
  if (!repo || !repo.includes("/")) {
    printHelp();
    process.exit(1);
  }
  return { repo, target, maxPages };
}

function printHelp(): void {
  console.error(
    "Usage: bun run eval/scripts/mine-prs.ts <owner/repo> [--target N] [--max-pages N]",
  );
}

function slugify(repo: string): string {
  return repo.replace("/", "__").toLowerCase();
}

async function ghApi<T>(path: string): Promise<T> {
  // Use spawn directly so we control argv (avoid shell quoting issues).
  for (let attempt = 0; attempt < 4; attempt++) {
    const proc = spawn({
      cmd: ["gh", "api", "-H", "Accept: application/vnd.github+json", path],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code === 0) {
      return JSON.parse(stdout) as T;
    }
    const msg = stderr || stdout;
    // Rate-limit / abuse-detection: back off and retry.
    if (/rate limit|secondary rate|abuse/i.test(msg) && attempt < 3) {
      const waitS = 30 * (attempt + 1);
      console.error(`  rate-limited on ${path}; sleeping ${waitS}s and retrying`);
      await Bun.sleep(waitS * 1000);
      continue;
    }
    throw new Error(`gh api ${path} failed (exit ${code}): ${msg.trim()}`);
  }
  throw new Error(`gh api ${path} failed after retries`);
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    return (await file.json()) as T;
  } catch {
    return null;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(data));
}

async function getCached<T>(path: string, fetcher: () => Promise<T>): Promise<T> {
  const cached = await readJsonIfExists<T>(path);
  if (cached !== null) return cached;
  const data = await fetcher();
  await writeJson(path, data);
  return data;
}

function isBotUser(login: string | undefined): boolean {
  if (!login) return false;
  const l = login.toLowerCase();
  return (
    l === "dependabot[bot]" ||
    l.startsWith("dependabot") ||
    l.startsWith("renovate") ||
    l === "renovate[bot]" ||
    l === "github-actions[bot]" ||
    l === "snyk-bot" ||
    l === "pre-commit-ci[bot]"
  );
}

function looksLikeVersionBumpTitle(title: string): boolean {
  const t = title.toLowerCase().trim();
  if (/^chore\(release\)/.test(t)) return true;
  if (/^chore: release/.test(t)) return true;
  if (/^chore: version bump/.test(t)) return true;
  if (/^release v?\d/.test(t)) return true;
  if (/^bump version/.test(t)) return true;
  if (/^v\d+\.\d+\.\d+/.test(t)) return true;
  if (/version packages/.test(t)) return true; // changesets bot
  if (/^publish( |$)/.test(t) && /\d/.test(t)) return true;
  return false;
}

const DOCS_EXTENSIONS = /\.(md|mdx|rst|txt|adoc)$/i;
const DOCS_DIRS = /(^|\/)(docs?|website|documentation|examples?)\//i;

function isDocsOnly(files: PRFile[]): boolean {
  if (files.length === 0) return false;
  return files.every(
    (f) => DOCS_EXTENSIONS.test(f.filename) || DOCS_DIRS.test(f.filename),
  );
}

const VERSION_FILE = /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|bun\.lockb|composer\.lock|gemfile\.lock|cargo\.lock|changelog\.md|version|version\.txt)$/i;

function isVersionBumpFiles(files: PRFile[]): boolean {
  if (files.length === 0) return false;
  return files.every((f) => VERSION_FILE.test(f.filename));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function mineRepo(
  repo: string,
  target: number,
  maxPages: number,
): Promise<{ collected: PROutput[]; scanned: number }> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`invalid repo: ${repo}`);
  const slug = slugify(repo);
  const cacheDir = join(EVAL_ROOT, "cache", slug);
  const outPath = join(EVAL_ROOT, "data", `${slug}.jsonl`);

  const collected: PROutput[] = [];
  let scanned = 0;

  for (let page = 1; page <= maxPages; page++) {
    if (collected.length >= target) break;
    const pagePath = join(cacheDir, "pages", `${page}.json`);
    const prs = await getCached<PullRequest[]>(pagePath, () =>
      ghApi<PullRequest[]>(
        `repos/${owner}/${name}/pulls?state=closed&sort=updated&direction=desc&per_page=${DEFAULTS.perPage}&page=${page}`,
      ),
    );
    if (prs.length === 0) break;

    // Pre-filter cheaply by title/author/merge status to avoid wasted file fetches.
    const candidates = prs.filter((pr) => {
      scanned++;
      if (!pr.merged_at) return false;
      if (isBotUser(pr.user?.login)) return false;
      if (looksLikeVersionBumpTitle(pr.title)) return false;
      return true;
    });

    // Fetch files for the candidates in parallel.
    const enriched = await mapWithConcurrency(
      candidates,
      DEFAULTS.filesConcurrency,
      async (pr) => {
        const filesPath = join(cacheDir, "files", `${pr.number}.json`);
        const files = await getCached<PRFile[]>(filesPath, () =>
          ghApi<PRFile[]>(
            `repos/${owner}/${name}/pulls/${pr.number}/files?per_page=100`,
          ),
        );
        return { pr, files };
      },
    );

    for (const { pr, files } of enriched) {
      if (collected.length >= target) break;
      if (files.length === 0 || files.length > DEFAULTS.maxFiles) continue;
      if (isDocsOnly(files)) continue;
      if (isVersionBumpFiles(files)) continue;
      collected.push({
        repo,
        number: pr.number,
        title: pr.title,
        body: pr.body ?? "",
        files_changed: files.map((f) => f.filename),
        merged_at: pr.merged_at!,
        url: pr.html_url,
      });
    }
    console.error(
      `  page ${page}: scanned=${prs.length} candidates=${candidates.length} kept_total=${collected.length}`,
    );
  }

  await mkdir(dirname(outPath), { recursive: true });
  const body = collected.map((p) => JSON.stringify(p)).join("\n") + (collected.length ? "\n" : "");
  await Bun.write(outPath, body);

  return { collected, scanned };
}

async function main(): Promise<void> {
  const { repo, target, maxPages } = parseArgs(process.argv.slice(2));
  console.error(`mining ${repo} → target=${target} pages<=${maxPages}`);
  const start = Date.now();
  const { collected, scanned } = await mineRepo(repo, target, maxPages);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.error(
    `done: ${collected.length} PRs kept (scanned ${scanned}) in ${elapsed}s → eval/data/${slugify(repo)}.jsonl`,
  );
  if (collected.length < target * 0.5) {
    console.error(
      `warning: collected ${collected.length} PRs is well below target ${target}; consider raising --max-pages`,
    );
  }
}

main().catch((err) => {
  console.error("error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
