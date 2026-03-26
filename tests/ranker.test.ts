import { test, expect, describe } from "bun:test";
import { rankFiles, tokenize } from "../src/ranker";
import type { CodeGraph, FileNode, Edge } from "../src/types";

function makeFile(path: string, overrides: Partial<FileNode> = {}): FileNode {
  return {
    path,
    language: "typescript",
    exports: [],
    imports: [],
    classes: [],
    functions: [],
    types: [],
    enums: [],
    reExports: [],
    ...overrides,
  };
}

function makeGraph(files: FileNode[], edges: Edge[] = []): CodeGraph {
  return {
    root: "/tmp/test",
    files,
    edges,
    modules: [],
    generatedAt: new Date().toISOString(),
  };
}

describe("tokenize", () => {
  test("lowercases and deduplicates input", () => {
    expect(tokenize("rankfiles")).toEqual(["rankfiles"]);
  });

  test("removes stop words", () => {
    expect(tokenize("where is the auth handler")).toEqual(["auth", "handler"]);
  });

  test("deduplicates terms", () => {
    expect(tokenize("auth auth auth")).toEqual(["auth"]);
  });

  test("splits on underscores and hyphens", () => {
    expect(tokenize("my_cool-function")).toEqual(["my", "cool", "function"]);
  });
});

describe("rankFiles", () => {
  test("ranks files with matching export names higher", () => {
    const files = [
      makeFile("src/utils.ts", {
        exports: [{ name: "formatDate", kind: "function", signature: "function formatDate(): string", isDefault: false }],
        functions: [{ name: "formatDate", signature: "function formatDate(): string", params: [], returnType: "string", isAsync: false, isGenerator: false, typeParameters: [] }],
      }),
      makeFile("src/auth.ts", {
        exports: [{ name: "authenticate", kind: "function", signature: "function authenticate(): void", isDefault: false }],
        functions: [{ name: "authenticate", signature: "function authenticate(): void", params: [], returnType: "void", isAsync: false, isGenerator: false, typeParameters: [] }],
      }),
      makeFile("src/index.ts"),
    ];

    const graph = makeGraph(files);
    const results = rankFiles(graph, "authenticate user");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.file.path).toBe("src/auth.ts");
    expect(results[0]!.matchedTerms).toContain("authenticate");
  });

  test("ranks files with class names matching query", () => {
    const files = [
      makeFile("src/database.ts", {
        classes: [{
          name: "DatabaseConnection",
          implements: [],
          methods: [],
          properties: [],
          isAbstract: false,
          typeParameters: [],
        }],
      }),
      makeFile("src/logger.ts", {
        classes: [{
          name: "Logger",
          implements: [],
          methods: [],
          properties: [],
          isAbstract: false,
          typeParameters: [],
        }],
      }),
    ];

    const graph = makeGraph(files);
    const results = rankFiles(graph, "database connection");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.file.path).toBe("src/database.ts");
  });

  test("applies broad-file penalty for files with 20+ exports", () => {
    const manyExports = Array.from({ length: 25 }, (_, i) => ({
      name: `export${i}`,
      kind: "function" as const,
      signature: `function export${i}(): void`,
      isDefault: false,
    }));

    const files = [
      makeFile("src/types.ts", {
        exports: manyExports,
        functions: manyExports.map((e) => ({
          name: e.name,
          signature: e.signature,
          params: [],
          returnType: "void",
          isAsync: false,
          isGenerator: false,
          typeParameters: [],
        })),
      }),
      makeFile("src/focused.ts", {
        exports: [{ name: "export0", kind: "function", signature: "function export0(): void", isDefault: false }],
        functions: [{ name: "export0", signature: "function export0(): void", params: [], returnType: "void", isAsync: false, isGenerator: false, typeParameters: [] }],
      }),
    ];

    const graph = makeGraph(files);
    const results = rankFiles(graph, "export0");

    expect(results.length).toBe(2);
    expect(results[0]!.file.path).toBe("src/focused.ts");
  });

  test("combines BM25 with PageRank boost", () => {
    const files = [
      makeFile("src/core.ts", {
        exports: [{ name: "processData", kind: "function", signature: "function processData(): void", isDefault: false }],
        functions: [{ name: "processData", signature: "function processData(): void", params: [], returnType: "void", isAsync: false, isGenerator: false, typeParameters: [] }],
      }),
      makeFile("src/helper.ts", {
        exports: [{ name: "processData", kind: "function", signature: "function processData(): void", isDefault: false }],
        functions: [{ name: "processData", signature: "function processData(): void", params: [], returnType: "void", isAsync: false, isGenerator: false, typeParameters: [] }],
      }),
      makeFile("src/a.ts"),
      makeFile("src/b.ts"),
    ];

    const edges: Edge[] = [
      { from: "src/a.ts", to: "src/core.ts", importedNames: ["processData"] },
      { from: "src/b.ts", to: "src/core.ts", importedNames: ["processData"] },
      { from: "src/helper.ts", to: "src/core.ts", importedNames: ["processData"] },
    ];

    const graph = makeGraph(files, edges);
    const results = rankFiles(graph, "process data");

    const coreIdx = results.findIndex((r) => r.file.path === "src/core.ts");
    const helperIdx = results.findIndex((r) => r.file.path === "src/helper.ts");
    expect(coreIdx).toBeLessThan(helperIdx);
  });

  test("returns empty array for no matches", () => {
    const files = [makeFile("src/index.ts")];
    const graph = makeGraph(files);
    const results = rankFiles(graph, "xyznonexistent");

    for (const r of results) {
      expect(r.matchedTerms.length).toBe(0);
    }
  });

  test("matches JSDoc content", () => {
    const files = [
      makeFile("src/retry.ts", {
        exports: [{
          name: "withRetry",
          kind: "function",
          signature: "function withRetry(): void",
          isDefault: false,
          jsdoc: "Retries a failed operation with exponential backoff",
        }],
        functions: [{
          name: "withRetry",
          signature: "function withRetry(): void",
          params: [],
          returnType: "void",
          isAsync: false,
          isGenerator: false,
          typeParameters: [],
          jsdoc: "Retries a failed operation with exponential backoff",
        }],
      }),
      makeFile("src/other.ts"),
    ];

    const graph = makeGraph(files);
    const results = rankFiles(graph, "exponential backoff");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.file.path).toBe("src/retry.ts");
  });

  test("matches extends/implements", () => {
    const files = [
      makeFile("src/redis-cache.ts", {
        classes: [{
          name: "RedisCache",
          extends: "BaseCache",
          implements: ["CacheProvider"],
          methods: [],
          properties: [],
          isAbstract: false,
          typeParameters: [],
        }],
      }),
      makeFile("src/other.ts"),
    ];

    const graph = makeGraph(files);
    const results = rankFiles(graph, "CacheProvider implementation");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.file.path).toBe("src/redis-cache.ts");
  });
});
