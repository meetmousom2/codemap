import { test, expect, describe } from "bun:test";
import { findSymbol, traceImporters, traceCallers, renderImpact } from "../src/impact";
import type { FileNode, CodeGraph, Edge } from "../src/types";
import type { CallReference } from "../src/call-graph";
import { summarizeCallGraph } from "../src/call-graph";

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

describe("findSymbol", () => {
  test("finds exported symbol by name", () => {
    const file = makeFile("src/auth/handler.ts", {
      exports: [
        { name: "handleAuth", kind: "function", signature: "async function handleAuth(req: Request): Promise<Response>", isDefault: false },
      ],
    });
    const graph = makeGraph([file]);
    const results = findSymbol(graph, "handleAuth");

    expect(results).toHaveLength(1);
    expect(results[0]!.file).toBe("src/auth/handler.ts");
    expect(results[0]!.export.name).toBe("handleAuth");
  });

  test("finds symbol in multiple files", () => {
    const file1 = makeFile("src/auth/handler.ts", {
      exports: [
        { name: "validate", kind: "function", signature: "function validate(token: string): boolean", isDefault: false },
      ],
    });
    const file2 = makeFile("src/forms/validator.ts", {
      exports: [
        { name: "validate", kind: "function", signature: "function validate(input: FormData): boolean", isDefault: false },
      ],
    });
    const graph = makeGraph([file1, file2]);
    const results = findSymbol(graph, "validate");

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.file)).toContain("src/auth/handler.ts");
    expect(results.map((r) => r.file)).toContain("src/forms/validator.ts");
  });

  test("returns empty array when symbol not found", () => {
    const graph = makeGraph([makeFile("src/foo.ts")]);
    const results = findSymbol(graph, "nonexistent");

    expect(results).toHaveLength(0);
  });
});

describe("traceImporters", () => {
  test("finds direct importers of a symbol", () => {
    const handler = makeFile("src/auth/handler.ts", {
      exports: [
        { name: "handleAuth", kind: "function", signature: "function handleAuth(): void", isDefault: false },
      ],
    });
    const api = makeFile("src/routes/api.ts");
    const index = makeFile("src/index.ts");

    const edges: Edge[] = [
      { from: "src/routes/api.ts", to: "src/auth/handler.ts", importedNames: ["handleAuth"] },
      { from: "src/index.ts", to: "src/auth/handler.ts", importedNames: ["handleAuth"] },
    ];

    const graph = makeGraph([handler, api, index], edges);
    const importers = traceImporters(graph, "src/auth/handler.ts", "handleAuth");

    expect(importers).toHaveLength(2);
    expect(importers.map((i) => i.file)).toContain("src/routes/api.ts");
    expect(importers.map((i) => i.file)).toContain("src/index.ts");
  });

  test("follows re-export chains", () => {
    const handler = makeFile("src/auth/handler.ts", {
      exports: [
        { name: "handleAuth", kind: "function", signature: "function handleAuth(): void", isDefault: false },
      ],
    });
    const barrel = makeFile("src/auth/index.ts", {
      reExports: [
        { source: "./handler", resolvedPath: "src/auth/handler.ts", names: ["handleAuth"], isNamespaceReExport: false },
      ],
      exports: [
        { name: "handleAuth", kind: "re-export", signature: "re-export handleAuth", isDefault: false },
      ],
    });
    const consumer = makeFile("src/app.ts");

    const edges: Edge[] = [
      { from: "src/auth/index.ts", to: "src/auth/handler.ts", importedNames: ["handleAuth"] },
      { from: "src/app.ts", to: "src/auth/index.ts", importedNames: ["handleAuth"] },
    ];

    const graph = makeGraph([handler, barrel, consumer], edges);
    const importers = traceImporters(graph, "src/auth/handler.ts", "handleAuth");

    expect(importers.map((i) => i.file)).toContain("src/auth/index.ts");
    expect(importers.map((i) => i.file)).toContain("src/app.ts");
  });

  test("follows wildcard re-exports (export *)", () => {
    const handler = makeFile("src/auth/handler.ts", {
      exports: [
        { name: "handleAuth", kind: "function", signature: "function handleAuth(): void", isDefault: false },
      ],
    });
    const barrel = makeFile("src/auth/index.ts", {
      reExports: [
        { source: "./handler", resolvedPath: "src/auth/handler.ts", names: [], isNamespaceReExport: false },
      ],
      exports: [
        { name: "handleAuth", kind: "re-export", signature: "re-export handleAuth", isDefault: false },
      ],
    });
    const consumer = makeFile("src/app.ts");

    const edges: Edge[] = [
      { from: "src/auth/index.ts", to: "src/auth/handler.ts", importedNames: ["handleAuth"] },
      { from: "src/app.ts", to: "src/auth/index.ts", importedNames: ["handleAuth"] },
    ];

    const graph = makeGraph([handler, barrel, consumer], edges);
    const importers = traceImporters(graph, "src/auth/handler.ts", "handleAuth");

    expect(importers.map((i) => i.file)).toContain("src/auth/index.ts");
    expect(importers.map((i) => i.file)).toContain("src/app.ts");
  });

  test("returns empty array when no importers", () => {
    const file = makeFile("src/standalone.ts", {
      exports: [
        { name: "helper", kind: "function", signature: "function helper(): void", isDefault: false },
      ],
    });
    const graph = makeGraph([file]);
    const importers = traceImporters(graph, "src/standalone.ts", "helper");

    expect(importers).toHaveLength(0);
  });
});

describe("traceCallers", () => {
  test("finds callers from call summary", () => {
    const refs: CallReference[] = [
      { callerFile: "src/routes/api.ts", callerName: "routeRequest", calleeFile: "src/auth/handler.ts", calleeName: "handleAuth" },
      { callerFile: "src/middleware/auth.ts", callerName: "validateSession", calleeFile: "src/auth/handler.ts", calleeName: "handleAuth" },
    ];
    const summary = summarizeCallGraph(refs);

    const callers = traceCallers(summary, "src/auth/handler.ts", "handleAuth");

    expect(callers).toHaveLength(2);
    expect(callers.map((c) => c.callerName)).toContain("routeRequest");
    expect(callers.map((c) => c.callerName)).toContain("validateSession");
  });

  test("returns empty array when no callers", () => {
    const summary = summarizeCallGraph([]);
    const callers = traceCallers(summary, "src/foo.ts", "bar");

    expect(callers).toHaveLength(0);
  });
});

describe("renderImpact", () => {
  test("renders full impact report for a symbol", () => {
    const handler = makeFile("src/auth/handler.ts", {
      exports: [
        { name: "handleAuth", kind: "function", signature: "async function handleAuth(req: Request): Promise<Response>", isDefault: false },
      ],
    });
    const api = makeFile("src/routes/api.ts", {
      exports: [
        { name: "routeRequest", kind: "function", signature: "function routeRequest(): void", isDefault: false },
      ],
      imports: [{
        source: "../auth/handler",
        resolvedPath: "src/auth/handler.ts",
        namedImports: ["handleAuth"],
        isExternal: false,
      }],
    });
    const middleware = makeFile("src/middleware/auth.ts", {
      exports: [
        { name: "validateSession", kind: "function", signature: "function validateSession(): void", isDefault: false },
      ],
      imports: [{
        source: "../auth/handler",
        resolvedPath: "src/auth/handler.ts",
        namedImports: ["handleAuth"],
        isExternal: false,
      }],
    });

    const edges: Edge[] = [
      { from: "src/routes/api.ts", to: "src/auth/handler.ts", importedNames: ["handleAuth"] },
      { from: "src/middleware/auth.ts", to: "src/auth/handler.ts", importedNames: ["handleAuth"] },
    ];

    const graph = makeGraph([handler, api, middleware], edges);
    const output = renderImpact(graph, "handleAuth");

    expect(output).toContain("## Impact: handleAuth");
    expect(output).toContain("### Defined in");
    expect(output).toContain("src/auth/handler.ts");
    expect(output).toContain("async function handleAuth(req: Request): Promise<Response>");
    expect(output).toContain("### Imported by");
    expect(output).toContain("src/routes/api.ts");
    expect(output).toContain("src/middleware/auth.ts");
    expect(output).toContain("### Called by");
    expect(output).toContain("routeRequest");
    expect(output).toContain("validateSession");
  });

  test("handles ambiguous symbols in multiple files", () => {
    const file1 = makeFile("src/auth/validate.ts", {
      exports: [
        { name: "validate", kind: "function", signature: "function validate(token: string): boolean", isDefault: false },
      ],
    });
    const file2 = makeFile("src/forms/validate.ts", {
      exports: [
        { name: "validate", kind: "function", signature: "function validate(input: FormData): boolean", isDefault: false },
      ],
    });
    const consumer = makeFile("src/app.ts", {
      imports: [{
        source: "./auth/validate",
        resolvedPath: "src/auth/validate.ts",
        namedImports: ["validate"],
        isExternal: false,
      }],
    });

    const edges: Edge[] = [
      { from: "src/app.ts", to: "src/auth/validate.ts", importedNames: ["validate"] },
    ];

    const graph = makeGraph([file1, file2, consumer], edges);
    const output = renderImpact(graph, "validate");

    expect(output).toContain("src/auth/validate.ts");
    expect(output).toContain("src/forms/validate.ts");
  });

  test("returns error when symbol not found", () => {
    const graph = makeGraph([makeFile("src/foo.ts")]);
    const output = renderImpact(graph, "nonexistent");

    expect(output).toContain("Error:");
    expect(output).toContain("nonexistent");
  });

  test("renders re-export chain information", () => {
    const handler = makeFile("src/auth/handler.ts", {
      exports: [
        { name: "handleAuth", kind: "function", signature: "function handleAuth(): void", isDefault: false },
      ],
    });
    const barrel = makeFile("src/auth/index.ts", {
      reExports: [
        { source: "./handler", resolvedPath: "src/auth/handler.ts", names: ["handleAuth"], isNamespaceReExport: false },
      ],
      exports: [
        { name: "handleAuth", kind: "re-export", signature: "re-export handleAuth", isDefault: false },
      ],
    });
    const consumer = makeFile("src/app.ts");

    const edges: Edge[] = [
      { from: "src/auth/index.ts", to: "src/auth/handler.ts", importedNames: ["handleAuth"] },
      { from: "src/app.ts", to: "src/auth/index.ts", importedNames: ["handleAuth"] },
    ];

    const graph = makeGraph([handler, barrel, consumer], edges);
    const output = renderImpact(graph, "handleAuth");

    expect(output).toContain("### Defined in");
    expect(output).toContain("src/auth/handler.ts");
    expect(output).toContain("### Imported by");
    expect(output).toContain("src/auth/index.ts");
    expect(output).toContain("src/app.ts");
  });

  test("shows symbol with no importers or callers", () => {
    const file = makeFile("src/utils.ts", {
      exports: [
        { name: "unused", kind: "function", signature: "function unused(): void", isDefault: false },
      ],
    });
    const graph = makeGraph([file]);
    const output = renderImpact(graph, "unused");

    expect(output).toContain("## Impact: unused");
    expect(output).toContain("### Defined in");
    expect(output).toContain("src/utils.ts");
    expect(output).not.toContain("### Imported by");
    expect(output).not.toContain("### Called by");
  });
});
