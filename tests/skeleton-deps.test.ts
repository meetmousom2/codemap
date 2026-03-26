import { test, expect, describe } from "bun:test";
import { renderSkeleton, renderDeps } from "../src/skeleton-deps";
import type { FileNode, CodeGraph, Edge } from "../src/types";

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
    root: "/project",
    files,
    edges,
    modules: [],
    generatedAt: new Date().toISOString(),
  };
}

describe("renderSkeleton", () => {
  test("renders exports with signatures", () => {
    const file = makeFile("src/ranker.ts", {
      exports: [
        { name: "rankFiles", kind: "function", signature: "function rankFiles(graph: CodeGraph, query: string): RankedFile[]", isDefault: false },
        { name: "tokenize", kind: "function", signature: "function tokenize(query: string): string[]", isDefault: false },
      ],
    });
    const graph = makeGraph([file]);
    const output = renderSkeleton(graph, "ranker.ts");

    expect(output).toContain("## src/ranker.ts");
    expect(output).toContain("### Exports");
    expect(output).toContain("function rankFiles(graph: CodeGraph, query: string): RankedFile[]");
    expect(output).toContain("function tokenize(query: string): string[]");
  });

  test("renders classes with methods and visibility", () => {
    const file = makeFile("src/engine.ts", {
      classes: [
        {
          name: "Ranker",
          methods: [
            {
              name: "constructor",
              signature: "constructor(graph: CodeGraph)",
              returnType: "void",
              params: [{ name: "graph", type: "CodeGraph", isOptional: false, isRest: false }],
              isStatic: false,
              isAsync: false,
              isAbstract: false,
              visibility: "public",
            },
            {
              name: "rank",
              signature: "rank(query: string): RankedFile[]",
              returnType: "RankedFile[]",
              params: [{ name: "query", type: "string", isOptional: false, isRest: false }],
              isStatic: false,
              isAsync: false,
              isAbstract: false,
              visibility: "public",
            },
            {
              name: "computePageRank",
              signature: "computePageRank(): Map<string, number>",
              returnType: "Map<string, number>",
              params: [],
              isStatic: false,
              isAsync: false,
              isAbstract: false,
              visibility: "private",
            },
          ],
          properties: [],
          implements: [],
          isAbstract: false,
          typeParameters: [],
        },
      ],
    });
    const graph = makeGraph([file]);
    const output = renderSkeleton(graph, "engine.ts");

    expect(output).toContain("## src/engine.ts");
    expect(output).toContain("### Classes");
    expect(output).toContain("**class Ranker**");
    expect(output).toContain("- constructor(graph: CodeGraph)");
    expect(output).toContain("- rank(query: string): RankedFile[]");
    expect(output).toContain("- private computePageRank(): Map<string, number>");
  });

  test("renders types and interfaces", () => {
    const file = makeFile("src/types.ts", {
      types: [
        {
          name: "FileNode",
          kind: "interface",
          properties: [
            { name: "path", type: "string", isOptional: false, isReadonly: false, isStatic: false, visibility: "public" },
          ],
          extends: [],
          typeParameters: [],
        },
        {
          name: "ExportKind",
          kind: "type",
          properties: [],
          extends: [],
          typeParameters: [],
          typeExpression: '"function" | "class" | "type"',
        },
      ],
    });
    const graph = makeGraph([file]);
    const output = renderSkeleton(graph, "types.ts");

    expect(output).toContain("### Types");
    expect(output).toContain("- interface FileNode");
    expect(output).toContain("- type ExportKind");
  });

  test("renders enums", () => {
    const file = makeFile("src/status.ts", {
      enums: [
        { name: "Status", members: [{ name: "Active", value: "1" }, { name: "Inactive", value: "2" }], isConst: true },
      ],
    });
    const graph = makeGraph([file]);
    const output = renderSkeleton(graph, "status.ts");

    expect(output).toContain("### Enums");
    expect(output).toContain("const enum Status");
  });

  test("supports partial path matching", () => {
    const file = makeFile("src/deep/nested/ranker.ts", {
      exports: [
        { name: "rank", kind: "function", signature: "function rank(): void", isDefault: false },
      ],
    });
    const graph = makeGraph([file]);
    const output = renderSkeleton(graph, "nested/ranker.ts");

    expect(output).toContain("## src/deep/nested/ranker.ts");
  });

  test("returns error message for file not found", () => {
    const graph = makeGraph([makeFile("src/foo.ts")]);
    const output = renderSkeleton(graph, "nonexistent.ts");

    expect(output).toContain("Error:");
    expect(output).toContain("nonexistent.ts");
  });
});

describe("renderDeps", () => {
  test("renders imports from (forward deps)", () => {
    const file = makeFile("src/ranker.ts", {
      imports: [
        {
          source: "./types",
          resolvedPath: "src/types.ts",
          namedImports: ["FileNode", "CodeGraph"],
          isExternal: false,
        },
        {
          source: "./call-graph",
          resolvedPath: "src/call-graph.ts",
          namedImports: ["buildCallGraph"],
          isExternal: false,
        },
      ],
    });
    const graph = makeGraph([file]);
    const output = renderDeps(graph, "ranker.ts");

    expect(output).toContain("## Dependencies: src/ranker.ts");
    expect(output).toContain("### Imports from");
    expect(output).toContain("src/types.ts");
    expect(output).toContain("FileNode, CodeGraph");
    expect(output).toContain("src/call-graph.ts");
    expect(output).toContain("buildCallGraph");
  });

  test("renders imported by (reverse deps)", () => {
    const ranker = makeFile("src/ranker.ts");
    const index = makeFile("src/index.ts");
    const renderer = makeFile("src/renderer.ts");

    const edges: Edge[] = [
      { from: "src/index.ts", to: "src/ranker.ts", importedNames: ["rankFiles", "tokenize"] },
      { from: "src/renderer.ts", to: "src/ranker.ts", importedNames: ["tokenize"] },
    ];

    const graph = makeGraph([ranker, index, renderer], edges);
    const output = renderDeps(graph, "ranker.ts");

    expect(output).toContain("### Imported by");
    expect(output).toContain("src/index.ts");
    expect(output).toContain("rankFiles, tokenize");
    expect(output).toContain("src/renderer.ts");
    expect(output).toContain("tokenize");
  });

  test("skips external imports", () => {
    const file = makeFile("src/ranker.ts", {
      imports: [
        {
          source: "node:path",
          resolvedPath: null,
          namedImports: ["join"],
          isExternal: true,
        },
        {
          source: "./types",
          resolvedPath: "src/types.ts",
          namedImports: ["FileNode"],
          isExternal: false,
        },
      ],
    });
    const graph = makeGraph([file]);
    const output = renderDeps(graph, "ranker.ts");

    expect(output).not.toContain("node:path");
    expect(output).toContain("src/types.ts");
  });

  test("returns error message for file not found", () => {
    const graph = makeGraph([makeFile("src/foo.ts")]);
    const output = renderDeps(graph, "nonexistent.ts");

    expect(output).toContain("Error:");
    expect(output).toContain("nonexistent.ts");
  });

  test("shows empty sections gracefully", () => {
    const file = makeFile("src/standalone.ts");
    const graph = makeGraph([file]);
    const output = renderDeps(graph, "standalone.ts");

    expect(output).toContain("## Dependencies: src/standalone.ts");
    expect(output).not.toContain("### Imports from");
    expect(output).not.toContain("### Imported by");
  });
});
