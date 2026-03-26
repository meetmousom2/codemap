import { test, expect, describe } from "bun:test";
import { cosineSimilarity, buildFileText } from "../src/embeddings";
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
