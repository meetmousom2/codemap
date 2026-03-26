import { test, expect, describe } from "bun:test";
import { cosineSimilarity, buildFileText, computeContentHash, buildIncrementalEmbeddings } from "../src/embeddings";
import type { FileNode } from "../src/types";

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

describe("cosineSimilarity", () => {
  test("identical vectors return 1", () => {
    const v = [1, 0, 0, 1];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  test("orthogonal vectors return 0", () => {
    const a = [1, 0, 0, 0];
    const b = [0, 1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  test("opposite vectors return -1", () => {
    const a = [1, 0];
    const b = [-1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  test("zero vector returns 0", () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  test("similar vectors return high similarity", () => {
    const a = [1, 2, 3];
    const b = [1, 2, 4];
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.9);
    expect(sim).toBeLessThanOrEqual(1.0);
  });
});

describe("buildFileText", () => {
  test("includes file path", () => {
    const file = makeFile("src/auth/login.ts");
    const text = buildFileText(file);
    expect(text).toContain("src/auth/login.ts");
  });

  test("includes export names", () => {
    const file = makeFile("src/utils.ts", {
      exports: [
        { name: "validateEmail", kind: "function", signature: "function validateEmail()", isDefault: false },
        { name: "sanitizeInput", kind: "function", signature: "function sanitizeInput()", isDefault: false },
      ],
    });
    const text = buildFileText(file);
    expect(text).toContain("validateEmail");
    expect(text).toContain("sanitizeInput");
  });

  test("includes class names and methods", () => {
    const file = makeFile("src/agent.ts", {
      classes: [{
        name: "NiraAgent",
        extends: "BaseAgent",
        methods: [
          { name: "chat", signature: "chat()", returnType: "void", params: [], isStatic: false, isAsync: true, isAbstract: false, visibility: "public" as const },
        ],
        properties: [],
        implements: ["Runnable"],
        isAbstract: false,
        typeParameters: [],
        jsdoc: "LLM agent runtime for orchestration",
      }],
    });
    const text = buildFileText(file);
    expect(text).toContain("NiraAgent");
    expect(text).toContain("BaseAgent");
    expect(text).toContain("chat");
    expect(text).toContain("LLM agent runtime");
  });

  test("includes JSDoc from exports", () => {
    const file = makeFile("src/config.ts", {
      exports: [
        { name: "loadConfig", kind: "function", signature: "function loadConfig()", isDefault: false, jsdoc: "Load configuration from disk" },
      ],
    });
    const text = buildFileText(file);
    expect(text).toContain("Load configuration from disk");
  });

  test("includes function names", () => {
    const file = makeFile("src/helpers.ts", {
      functions: [{
        name: "retryWithBackoff",
        signature: "function retryWithBackoff()",
        params: [],
        returnType: "Promise<void>",
        isAsync: true,
        isGenerator: false,
        typeParameters: [],
        jsdoc: "Retry a function with exponential backoff",
      }],
    });
    const text = buildFileText(file);
    expect(text).toContain("retryWithBackoff");
    expect(text).toContain("Retry a function with exponential backoff");
  });
});

describe("computeContentHash", () => {
  test("returns a string hash", () => {
    const file = makeFile("src/foo.ts", {
      exports: [{ name: "foo", kind: "function", signature: "function foo()", isDefault: false }],
    });
    const hash = computeContentHash(file);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  test("same content produces same hash", () => {
    const file1 = makeFile("src/foo.ts", {
      exports: [{ name: "foo", kind: "function", signature: "function foo()", isDefault: false }],
    });
    const file2 = makeFile("src/foo.ts", {
      exports: [{ name: "foo", kind: "function", signature: "function foo()", isDefault: false }],
    });
    expect(computeContentHash(file1)).toBe(computeContentHash(file2));
  });

  test("different content produces different hash", () => {
    const file1 = makeFile("src/foo.ts", {
      exports: [{ name: "foo", kind: "function", signature: "function foo()", isDefault: false }],
    });
    const file2 = makeFile("src/foo.ts", {
      exports: [{ name: "bar", kind: "function", signature: "function bar()", isDefault: false }],
    });
    expect(computeContentHash(file1)).not.toBe(computeContentHash(file2));
  });
});

describe("buildIncrementalEmbeddings", () => {
  // Mock embedder that returns a deterministic vector based on text content
  function mockEmbedder(text: string): number[] {
    let a = 0, b = 0, c = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      a += code * (i + 1);
      b += code * (i + 2);
      c += code * (i + 3);
    }
    const norm = Math.sqrt(a * a + b * b + c * c) || 1;
    return [a / norm, b / norm, c / norm];
  }

  test("builds all embeddings when no cache exists", async () => {
    const files = [
      makeFile("src/a.ts", { exports: [{ name: "a", kind: "function", signature: "a()", isDefault: false }] }),
      makeFile("src/b.ts", { exports: [{ name: "b", kind: "function", signature: "b()", isDefault: false }] }),
    ];

    const result = await buildIncrementalEmbeddings(files, null, "abc123", mockEmbedder);

    expect(result.commitHash).toBe("abc123");
    expect(Object.keys(result.files)).toHaveLength(2);
    expect(result.files["src/a.ts"]).toBeDefined();
    expect(result.files["src/b.ts"]).toBeDefined();
    expect(result.files["src/a.ts"]!.embedding).toHaveLength(3);
    expect(result.files["src/a.ts"]!.contentHash.length).toBeGreaterThan(0);
    expect(result.embeddedCount).toBe(2);
  });

  test("skips files with unchanged content hash", async () => {
    const files = [
      makeFile("src/a.ts", { exports: [{ name: "a", kind: "function", signature: "a()", isDefault: false }] }),
      makeFile("src/b.ts", { exports: [{ name: "b", kind: "function", signature: "b()", isDefault: false }] }),
    ];

    const initial = await buildIncrementalEmbeddings(files, null, "abc123", mockEmbedder);

    const result = await buildIncrementalEmbeddings(files, initial, "def456", mockEmbedder);

    expect(result.commitHash).toBe("def456");
    expect(Object.keys(result.files)).toHaveLength(2);
    expect(result.embeddedCount).toBe(0);
    expect(result.files["src/a.ts"]!.embedding).toEqual(initial.files["src/a.ts"]!.embedding);
  });

  test("re-embeds files with changed content", async () => {
    const filesV1 = [
      makeFile("src/a.ts", { exports: [{ name: "a", kind: "function", signature: "a()", isDefault: false }] }),
      makeFile("src/b.ts", { exports: [{ name: "b", kind: "function", signature: "b()", isDefault: false }] }),
    ];

    const initial = await buildIncrementalEmbeddings(filesV1, null, "abc123", mockEmbedder);

    const filesV2 = [
      makeFile("src/a.ts", { exports: [{ name: "a", kind: "function", signature: "a()", isDefault: false }] }),
      makeFile("src/b.ts", { exports: [{ name: "bChanged", kind: "function", signature: "bChanged()", isDefault: false }] }),
    ];

    const result = await buildIncrementalEmbeddings(filesV2, initial, "def456", mockEmbedder);

    expect(result.commitHash).toBe("def456");
    expect(result.embeddedCount).toBe(1);
    expect(result.files["src/a.ts"]!.embedding).toEqual(initial.files["src/a.ts"]!.embedding);
    expect(result.files["src/b.ts"]!.embedding).not.toEqual(initial.files["src/b.ts"]!.embedding);
  });

  test("adds new files", async () => {
    const filesV1 = [
      makeFile("src/a.ts", { exports: [{ name: "a", kind: "function", signature: "a()", isDefault: false }] }),
    ];

    const initial = await buildIncrementalEmbeddings(filesV1, null, "abc123", mockEmbedder);
    expect(Object.keys(initial.files)).toHaveLength(1);

    const filesV2 = [
      makeFile("src/a.ts", { exports: [{ name: "a", kind: "function", signature: "a()", isDefault: false }] }),
      makeFile("src/c.ts", { exports: [{ name: "c", kind: "function", signature: "c()", isDefault: false }] }),
    ];

    const result = await buildIncrementalEmbeddings(filesV2, initial, "def456", mockEmbedder);

    expect(Object.keys(result.files)).toHaveLength(2);
    expect(result.files["src/c.ts"]).toBeDefined();
    expect(result.embeddedCount).toBe(1);
  });

  test("prunes deleted files", async () => {
    const filesV1 = [
      makeFile("src/a.ts", { exports: [{ name: "a", kind: "function", signature: "a()", isDefault: false }] }),
      makeFile("src/b.ts", { exports: [{ name: "b", kind: "function", signature: "b()", isDefault: false }] }),
    ];

    const initial = await buildIncrementalEmbeddings(filesV1, null, "abc123", mockEmbedder);
    expect(Object.keys(initial.files)).toHaveLength(2);

    const filesV2 = [
      makeFile("src/a.ts", { exports: [{ name: "a", kind: "function", signature: "a()", isDefault: false }] }),
    ];

    const result = await buildIncrementalEmbeddings(filesV2, initial, "def456", mockEmbedder);

    expect(Object.keys(result.files)).toHaveLength(1);
    expect(result.files["src/b.ts"]).toBeUndefined();
    expect(result.embeddedCount).toBe(0);
  });
});
