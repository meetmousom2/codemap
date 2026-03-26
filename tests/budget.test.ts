import { test, expect, describe } from "bun:test";
import { estimateTokens, renderRankedResults } from "../src/ranker";
import type { FileNode } from "../src/types";

/** Helper to build a minimal RankedFile for testing. */
function makeRankedFile(overrides: Partial<FileNode> & { path: string }): {
  file: FileNode;
  score: number;
  matchedTerms: string[];
} {
  const file: FileNode = {
    path: overrides.path,
    language: "typescript",
    exports: overrides.exports ?? [],
    imports: overrides.imports ?? [],
    classes: overrides.classes ?? [],
    functions: overrides.functions ?? [],
    types: overrides.types ?? [],
    enums: overrides.enums ?? [],
    reExports: overrides.reExports ?? [],
  };
  return { file, score: 1, matchedTerms: ["test"] };
}

/** Build a set of ranked files with enough content to produce multi-level output. */
function makeRankedFiles(count: number) {
  return Array.from({ length: count }, (_, i) =>
    makeRankedFile({
      path: `src/module${i}/handler.ts`,
      exports: [
        {
          name: `handleRequest${i}`,
          kind: "function",
          signature: `export function handleRequest${i}(req: Request): Promise<Response>`,
          jsdoc: `Handles incoming request for module ${i}`,
          isDefault: false,
        },
        {
          name: `Config${i}`,
          kind: "interface",
          signature: `export interface Config${i} { timeout: number; retries: number }`,
          isDefault: false,
        },
      ],
      classes: [
        {
          name: `Service${i}`,
          extends: "BaseService",
          implements: ["Disposable"],
          methods: [
            {
              name: "start",
              signature: "start(): Promise<void>",
              returnType: "Promise<void>",
              params: [],
              isStatic: false,
              isAsync: true,
              isAbstract: false,
              visibility: "public" as const,
            },
            {
              name: "stop",
              signature: "stop(): void",
              returnType: "void",
              params: [],
              isStatic: false,
              isAsync: false,
              isAbstract: false,
              visibility: "public" as const,
            },
          ],
          properties: [],
          isAbstract: false,
          typeParameters: [],
        },
      ],
      imports: [
        {
          source: "./utils",
          resolvedPath: `src/module${i}/utils.ts`,
          namedImports: ["helper"],
          isExternal: false,
        },
      ],
    }),
  );
}

describe("estimateTokens", () => {
  test("returns ceil(length / 4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });
});

describe("renderRankedResults with budget", () => {
  test("no budget returns full output (default behavior unchanged)", () => {
    const ranked = makeRankedFiles(3);
    const output = renderRankedResults(ranked);
    // Should contain class details, exports, and dependencies
    expect(output).toContain("class Service0");
    expect(output).toContain("handleRequest0");
    expect(output).toContain("Depends on:");
  });

  test("generous budget returns full detail (level 3)", () => {
    const ranked = makeRankedFiles(3);
    const output = renderRankedResults(ranked, undefined, undefined, 10, 200, 50000);
    // With a huge budget, should still have class details and dependencies
    expect(output).toContain("class Service0");
    expect(output).toContain("Depends on:");
    expect(output).toContain("handleRequest0");
    expect(estimateTokens(output)).toBeLessThanOrEqual(50000);
  });

  test("tight budget degrades to signatures (level 2)", () => {
    const ranked = makeRankedFiles(5);
    // 5 files at level 3 ~ 481 tokens. At level 2, fewer tokens. Use a budget
    // that can fit a few files at level 2 but not even 1 at level 3.
    const output = renderRankedResults(ranked, undefined, undefined, 10, 200, 100);

    // Level 2: has export signatures but no class method details or dependencies
    expect(output).not.toContain("Depends on:");
    expect(output).not.toContain("async start()");
    expect(output).toContain("handleRequest");
    expect(output).toContain("`export function");
    expect(estimateTokens(output)).toBeLessThanOrEqual(100);
  });

  test("very tight budget degrades to file list (level 1)", () => {
    const ranked = makeRankedFiles(10);
    // Level 1 for 1 file ~ 34 tokens. Budget of 50 should fit 1 file at level 1 only.
    const output = renderRankedResults(ranked, undefined, undefined, 10, 200, 50);

    // Should have file paths but no export signatures
    expect(output).toContain("src/module0/handler.ts");
    expect(output).not.toContain("`export function");
    expect(estimateTokens(output)).toBeLessThanOrEqual(50);
  });

  test("extremely tight budget reduces number of files", () => {
    const ranked = makeRankedFiles(10);
    // Even 1 file at level 1 is ~34 tokens. Budget of 20 forces minimal output.
    const output = renderRankedResults(ranked, undefined, undefined, 10, 200, 20);

    // Should still have at least the first file (even if over budget, it's the fallback)
    const fileHeaders = output.split("\n").filter((l) => l.startsWith("## "));
    expect(fileHeaders.length).toBeLessThanOrEqual(1);
  });

  test("budget with zero ranked files returns empty", () => {
    const output = renderRankedResults([], undefined, undefined, 10, 200, 1000);
    expect(output).toBe("");
  });

  test("budget reduces files before dropping detail level", () => {
    const ranked = makeRankedFiles(5);
    // 5 files at level 3 ~ 481 tokens. 2 files at level 3 ~ 200 tokens.
    // Budget of 250 should fit 2 files at level 3 rather than dropping to level 2.
    const output = renderRankedResults(ranked, undefined, undefined, 10, 200, 250);

    // Should still have full detail (level 3) for some files
    expect(output).toContain("class Service");
    expect(output).toContain("Depends on:");
    expect(estimateTokens(output)).toBeLessThanOrEqual(250);

    // Should have fewer than 5 files
    const fileHeaders = output.split("\n").filter((l) => l.startsWith("## "));
    expect(fileHeaders.length).toBeLessThan(5);
    expect(fileHeaders.length).toBeGreaterThan(0);
  });
});
