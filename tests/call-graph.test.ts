import { test, expect, describe } from "bun:test";
import { buildCallGraph, summarizeCallGraph } from "../src/call-graph";
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

describe("buildCallGraph", () => {
  test("detects cross-file calls via imports", () => {
    const files: FileNode[] = [
      makeFile("src/agent.ts", {
        exports: [{ name: "Agent", kind: "class", signature: "class Agent", isDefault: false }],
        imports: [{
          source: "./tupy",
          resolvedPath: "src/tupy.ts",
          namedImports: ["TupyCloud"],
          isExternal: false,
        }],
        classes: [{
          name: "Agent",
          methods: [{ name: "chat", signature: "chat()", returnType: "void", params: [], isStatic: false, isAsync: true, isAbstract: false, visibility: "public" }],
          properties: [],
          implements: [],
          isAbstract: false,
          typeParameters: [],
        }],
      }),
      makeFile("src/tupy.ts", {
        exports: [{ name: "TupyCloud", kind: "class", signature: "class TupyCloud", isDefault: false }],
        classes: [{
          name: "TupyCloud",
          methods: [{ name: "search", signature: "search()", returnType: "void", params: [], isStatic: false, isAsync: true, isAbstract: false, visibility: "public" }],
          properties: [],
          implements: [],
          isAbstract: false,
          typeParameters: [],
        }],
      }),
    ];

    const edges = [{ from: "src/agent.ts", to: "src/tupy.ts", importedNames: ["TupyCloud"] }];
    const refs = buildCallGraph(files, edges);

    expect(refs.length).toBeGreaterThan(0);
    const agentToTupy = refs.find(
      (r) => r.callerFile === "src/agent.ts" && r.calleeFile === "src/tupy.ts",
    );
    expect(agentToTupy).toBeDefined();
    expect(agentToTupy!.calleeName).toBe("TupyCloud");
  });

  test("deduplicates references", () => {
    const files: FileNode[] = [
      makeFile("a.ts", {
        exports: [
          { name: "foo", kind: "function", signature: "foo()", isDefault: false },
          { name: "bar", kind: "function", signature: "bar()", isDefault: false },
        ],
        imports: [{
          source: "./b",
          resolvedPath: "b.ts",
          namedImports: ["helper"],
          isExternal: false,
        }],
      }),
      makeFile("b.ts", {
        exports: [{ name: "helper", kind: "function", signature: "helper()", isDefault: false }],
      }),
    ];

    const edges = [{ from: "a.ts", to: "b.ts", importedNames: ["helper"] }];
    const refs = buildCallGraph(files, edges);

    // Should have 2 refs: foo→helper and bar→helper
    expect(refs.length).toBe(2);
  });
});

describe("summarizeCallGraph", () => {
  test("groups into calledBy and calls maps", () => {
    const refs = [
      { callerFile: "a.ts", callerName: "foo", calleeFile: "b.ts", calleeName: "helper" },
      { callerFile: "c.ts", callerName: "bar", calleeFile: "b.ts", calleeName: "helper" },
    ];

    const { calledBy, calls } = summarizeCallGraph(refs);

    const helperCallers = calledBy.get("b.ts:helper");
    expect(helperCallers).toBeDefined();
    expect(helperCallers!.length).toBe(2);

    const fooCalls = calls.get("a.ts:foo");
    expect(fooCalls).toBeDefined();
    expect(fooCalls!.length).toBe(1);
    expect(fooCalls![0]!.name).toBe("helper");
  });
});
