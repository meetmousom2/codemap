/**
 * Smoke tests for the five comparative retrievers (issue #214).
 *
 * Each test points its adapter at a clean copy of `tests/fixtures/sample-project`
 * and asserts the returned `files` array is non-empty. Adapters that depend on
 * external CLIs (`gitnexus`, `aider`) skip when their binary is not on PATH so
 * the suite stays green in environments where those tools aren't installed.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { codemap } from "../eval/adapters/codemap";
import { gitnexus } from "../eval/adapters/gitnexus";
import { aider } from "../eval/adapters/aider";
import { grep } from "../eval/adapters/grep";
import { createEmbeddingRetriever } from "../eval/adapters/embedding";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "fixtures", "sample-project");

function hasBinary(binary: string): boolean {
  const proc = Bun.spawnSync(["which", binary], { stdout: "pipe", stderr: "pipe" });
  return proc.exitCode === 0 && proc.stdout.toString().trim().length > 0;
}

/**
 * Deterministic stub embedder. Produces an 8-dim bag-of-chars vector so that
 * (a) two different strings get two different vectors and (b) cosine similarity
 * is well-defined. We don't care about *quality* of ranking here — just that
 * the chunk → embed → rank pipeline executes end-to-end without the
 * Transformers.js model download.
 */
function stubEmbedder(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((text) => {
      const vec = new Array(8).fill(0);
      for (let i = 0; i < text.length; i++) {
        vec[i % 8] += text.charCodeAt(i);
      }
      return vec;
    }),
  );
}

let REPO: string;

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "codemap-adapter-smoke-"));
  cpSync(FIXTURE, REPO, { recursive: true });
});

afterAll(() => {
  rmSync(REPO, { recursive: true, force: true });
});

describe("retriever adapters", () => {
  test("codemap returns ranked files", async () => {
    const result = await codemap.query("user service", REPO, 5);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.length).toBeLessThanOrEqual(5);
    expect(result.ms).toBeGreaterThanOrEqual(0);
    expect(result.tokens).toBeGreaterThanOrEqual(0);
  }, 60_000);

  test.skipIf(!hasBinary("rg"))("grep returns ranked files", async () => {
    const result = await grep.query("user service", REPO, 5);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.length).toBeLessThanOrEqual(5);
  }, 15_000);

  test("embedding returns ranked files", async () => {
    const retriever = createEmbeddingRetriever({ embedder: stubEmbedder });
    const result = await retriever.query("user service", REPO, 5);
    expect(retriever.name).toBe("embedding");
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.length).toBeLessThanOrEqual(5);
  }, 15_000);

  test.skipIf(!hasBinary("gitnexus"))("gitnexus returns ranked files", async () => {
    const result = await gitnexus.query("user service", REPO, 5);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.length).toBeLessThanOrEqual(5);
  }, 180_000);

  test.skipIf(!hasBinary("aider"))("aider returns ranked files", async () => {
    const result = await aider.query("user service", REPO, 5);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.length).toBeLessThanOrEqual(5);
  }, 60_000);
});
