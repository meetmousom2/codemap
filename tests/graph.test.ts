import { test, expect, describe } from "bun:test";
import {
  groupIntoModules,
  detectCircularDeps,
  computeModuleEdges,
} from "../src/graph";
import type { FileNode, Edge, ModuleInfo } from "../src/types";

function makeFile(path: string): FileNode {
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
  };
}

describe("groupIntoModules", () => {
  test("groups files by directory", () => {
    const files = [
      makeFile("src/agent/agent.ts"),
      makeFile("src/agent/tools.ts"),
      makeFile("src/tupy/cloud.ts"),
      makeFile("src/tupy/search.ts"),
      makeFile("src/index.ts"),
    ];

    const modules = groupIntoModules(files);

    expect(modules.length).toBe(3);

    const agent = modules.find((m) => m.path === "src/agent");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("agent");
    expect(agent!.files).toEqual(["src/agent/agent.ts", "src/agent/tools.ts"]);

    const tupy = modules.find((m) => m.path === "src/tupy");
    expect(tupy).toBeDefined();
    expect(tupy!.name).toBe("tupy");

    const src = modules.find((m) => m.path === "src");
    expect(src).toBeDefined();
    expect(src!.files).toEqual(["src/index.ts"]);
  });

  test("handles root-level files", () => {
    const files = [makeFile("index.ts"), makeFile("types.ts")];
    const modules = groupIntoModules(files);

    expect(modules.length).toBe(1);
    expect(modules[0]!.name).toBe("root");
    expect(modules[0]!.path).toBe(".");
  });

  test("returns sorted modules", () => {
    const files = [
      makeFile("z/file.ts"),
      makeFile("a/file.ts"),
      makeFile("m/file.ts"),
    ];

    const modules = groupIntoModules(files);
    expect(modules.map((m) => m.path)).toEqual(["a", "m", "z"]);
  });
});

describe("detectCircularDeps", () => {
  test("detects simple circular dependency", () => {
    const edges: Edge[] = [
      { from: "a.ts", to: "b.ts", importedNames: ["x"] },
      { from: "b.ts", to: "a.ts", importedNames: ["y"] },
    ];

    const cycles = detectCircularDeps(edges);
    expect(cycles.length).toBeGreaterThan(0);
    // One of the cycles should contain both a.ts and b.ts
    const hasCycle = cycles.some(
      (c) => c.includes("a.ts") && c.includes("b.ts"),
    );
    expect(hasCycle).toBe(true);
  });

  test("detects no cycles in acyclic graph", () => {
    const edges: Edge[] = [
      { from: "a.ts", to: "b.ts", importedNames: ["x"] },
      { from: "b.ts", to: "c.ts", importedNames: ["y"] },
    ];

    const cycles = detectCircularDeps(edges);
    expect(cycles.length).toBe(0);
  });

  test("detects three-node cycle", () => {
    const edges: Edge[] = [
      { from: "a.ts", to: "b.ts", importedNames: ["x"] },
      { from: "b.ts", to: "c.ts", importedNames: ["y"] },
      { from: "c.ts", to: "a.ts", importedNames: ["z"] },
    ];

    const cycles = detectCircularDeps(edges);
    expect(cycles.length).toBeGreaterThan(0);
  });
});

describe("computeModuleEdges", () => {
  test("aggregates file edges to module level", () => {
    const edges: Edge[] = [
      { from: "src/agent/agent.ts", to: "src/tupy/cloud.ts", importedNames: ["TupyCloud"] },
      { from: "src/agent/tools.ts", to: "src/tupy/search.ts", importedNames: ["search"] },
      { from: "src/agent/agent.ts", to: "src/agent/tools.ts", importedNames: ["tools"] }, // intra-module
    ];

    const modules: ModuleInfo[] = [
      { name: "agent", path: "src/agent", files: ["src/agent/agent.ts", "src/agent/tools.ts"] },
      { name: "tupy", path: "src/tupy", files: ["src/tupy/cloud.ts", "src/tupy/search.ts"] },
    ];

    const moduleEdges = computeModuleEdges(edges, modules);

    // Should have 1 module-level edge: agent → tupy (count 2)
    expect(moduleEdges.length).toBe(1);
    expect(moduleEdges[0]!.from).toBe("src/agent");
    expect(moduleEdges[0]!.to).toBe("src/tupy");
    expect(moduleEdges[0]!.count).toBe(2);
  });

  test("skips intra-module edges", () => {
    const edges: Edge[] = [
      { from: "src/agent/agent.ts", to: "src/agent/tools.ts", importedNames: ["x"] },
    ];

    const modules: ModuleInfo[] = [
      { name: "agent", path: "src/agent", files: ["src/agent/agent.ts", "src/agent/tools.ts"] },
    ];

    const moduleEdges = computeModuleEdges(edges, modules);
    expect(moduleEdges.length).toBe(0);
  });
});
