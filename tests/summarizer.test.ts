import { test, expect, describe } from "bun:test";
import { summarizeFile, summarizeModule } from "../src/summarizer";
import type { FileNode, ModuleInfo } from "../src/types";

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

describe("summarizeFile", () => {
  test("uses JSDoc from class", () => {
    const file = makeFile("agent.ts", {
      classes: [{
        name: "Agent",
        jsdoc: "LLM agent runtime",
        methods: [],
        properties: [],
        implements: [],
        isAbstract: false,
        typeParameters: [],
      }],
    });
    expect(summarizeFile(file)).toBe("LLM agent runtime");
  });

  test("uses class name + extends when no JSDoc", () => {
    const file = makeFile("agent.ts", {
      classes: [{
        name: "NiraAgent",
        extends: "MastraAgent",
        methods: [
          { name: "chat", signature: "chat()", returnType: "void", params: [], isStatic: false, isAsync: false, isAbstract: false, visibility: "public" as const },
          { name: "stop", signature: "stop()", returnType: "void", params: [], isStatic: false, isAsync: false, isAbstract: false, visibility: "public" as const },
        ],
        properties: [],
        implements: [],
        isAbstract: false,
        typeParameters: [],
      }],
    });
    expect(summarizeFile(file)).toBe("NiraAgent class extends MastraAgent — 2 methods");
  });

  test("uses function JSDoc", () => {
    const file = makeFile("utils.ts", {
      functions: [{
        name: "validateEmail",
        jsdoc: "Validate an email address",
        signature: "validateEmail(email: string): boolean",
        params: [],
        returnType: "boolean",
        isAsync: false,
        isGenerator: false,
        typeParameters: [],
      }],
    });
    expect(summarizeFile(file)).toBe("Validate an email address");
  });

  test("lists export names", () => {
    const file = makeFile("constants.ts", {
      exports: [
        { name: "VERSION", kind: "const", signature: "const VERSION", isDefault: false },
        { name: "MAX_RETRIES", kind: "const", signature: "const MAX_RETRIES", isDefault: false },
      ],
    });
    expect(summarizeFile(file)).toBe("Exports: VERSION, MAX_RETRIES");
  });

  test("describes barrel re-exports", () => {
    const file = makeFile("index.ts", {
      reExports: [
        { source: "./types", resolvedPath: null, names: [], isNamespaceReExport: true },
        { source: "./utils", resolvedPath: null, names: ["helper"], isNamespaceReExport: false },
      ],
    });
    expect(summarizeFile(file)).toBe("Barrel re-exports from ./types, ./utils");
  });

  test("lists types when no exports", () => {
    const file = makeFile("types.ts", {
      types: [
        { name: "User", kind: "interface", properties: [], extends: [], typeParameters: [] },
        { name: "Config", kind: "type", properties: [], extends: [], typeParameters: [] },
      ],
    });
    expect(summarizeFile(file)).toBe("Types: User, Config");
  });
});

describe("summarizeModule", () => {
  test("lists class names", () => {
    const module: ModuleInfo = { name: "agent", path: "src/agent", files: ["src/agent/agent.ts"] };
    const files = [
      makeFile("src/agent/agent.ts", {
        classes: [{
          name: "NiraAgent",
          methods: [],
          properties: [],
          implements: [],
          isAbstract: false,
          typeParameters: [],
        }],
      }),
    ];
    expect(summarizeModule(module, files)).toBe("NiraAgent");
  });

  test("falls back to file count", () => {
    const module: ModuleInfo = { name: "empty", path: "src/empty", files: ["src/empty/a.ts", "src/empty/b.ts"] };
    const files = [makeFile("src/empty/a.ts"), makeFile("src/empty/b.ts")];
    expect(summarizeModule(module, files)).toBe("2 files");
  });
});
