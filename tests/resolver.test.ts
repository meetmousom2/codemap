import { test, expect, describe, beforeAll, beforeEach } from "bun:test";
import {
  initResolvers,
  resolveFileImports,
  buildEdges,
  resetResolverCache,
} from "../src/resolver";
import type { FileNode } from "../src/types";
import { resolve } from "node:path";

const TS_FIXTURE = resolve(import.meta.dir, "fixtures/sample-project");
const PY_FIXTURE = resolve(import.meta.dir, "fixtures/python-project");

beforeEach(() => {
  resetResolverCache();
});

function makeFileNode(
  path: string,
  language: "typescript" | "python",
  imports: FileNode["imports"] = [],
  reExports: FileNode["reExports"] = [],
): FileNode {
  return {
    path,
    language,
    exports: [],
    imports,
    classes: [],
    functions: [],
    types: [],
    enums: [],
    reExports,
  };
}

describe("TypeScript resolver", () => {
  test("resolves relative imports", async () => {
    await initResolvers(TS_FIXTURE);
    const file = makeFileNode("src/service.ts", "typescript", [
      {
        source: "./types",
        resolvedPath: null,
        namedImports: ["User"],
        isExternal: false,
      },
    ]);

    resolveFileImports(file, TS_FIXTURE);
    expect(file.imports[0]!.resolvedPath).toBe("src/types.ts");
  });

  test("resolves index.ts barrel imports", async () => {
    await initResolvers(TS_FIXTURE);
    const file = makeFileNode("src/service.ts", "typescript", [
      {
        source: "./",
        resolvedPath: null,
        namedImports: ["hello"],
        isExternal: false,
      },
    ]);

    resolveFileImports(file, TS_FIXTURE);
    expect(file.imports[0]!.resolvedPath).toBe("src/index.ts");
  });

  test("resolves tsconfig path aliases", async () => {
    await initResolvers(TS_FIXTURE);
    const file = makeFileNode("src/service.ts", "typescript", [
      {
        source: "@lib/utils",
        resolvedPath: null,
        namedImports: ["VERSION"],
        isExternal: true, // starts with @ so initially marked external
      },
    ]);

    resolveFileImports(file, TS_FIXTURE);
    expect(file.imports[0]!.resolvedPath).toBe("src/utils.ts");
    expect(file.imports[0]!.isExternal).toBe(false);
  });

  test("resolves exact path alias", async () => {
    await initResolvers(TS_FIXTURE);
    const file = makeFileNode("src/service.ts", "typescript", [
      {
        source: "@utils",
        resolvedPath: null,
        namedImports: ["VERSION"],
        isExternal: true,
      },
    ]);

    resolveFileImports(file, TS_FIXTURE);
    expect(file.imports[0]!.resolvedPath).toBe("src/utils.ts");
  });

  test("leaves npm packages unresolved", async () => {
    await initResolvers(TS_FIXTURE);
    const file = makeFileNode("src/index.ts", "typescript", [
      {
        source: "lodash",
        resolvedPath: null,
        namedImports: ["map"],
        isExternal: true,
      },
    ]);

    resolveFileImports(file, TS_FIXTURE);
    expect(file.imports[0]!.resolvedPath).toBeNull();
    expect(file.imports[0]!.isExternal).toBe(true);
  });

  test("resolves re-export paths", async () => {
    await initResolvers(TS_FIXTURE);
    const file = makeFileNode("src/barrel.ts", "typescript", [], [
      {
        source: "./types",
        resolvedPath: null,
        names: [],
        isNamespaceReExport: true,
      },
      {
        source: "./service",
        resolvedPath: null,
        names: ["UserService"],
        isNamespaceReExport: false,
      },
    ]);

    resolveFileImports(file, TS_FIXTURE);
    expect(file.reExports[0]!.resolvedPath).toBe("src/types.ts");
    expect(file.reExports[1]!.resolvedPath).toBe("src/service.ts");
  });
});

describe("Python resolver", () => {
  test("resolves absolute imports", async () => {
    await initResolvers(PY_FIXTURE);
    const file = makeFileNode("main.py", "python", [
      {
        source: "mypackage.utils",
        resolvedPath: null,
        namedImports: ["helper"],
        isExternal: false,
      },
    ]);

    resolveFileImports(file, PY_FIXTURE);
    expect(file.imports[0]!.resolvedPath).toBe("mypackage/utils.py");
  });

  test("resolves package imports via __init__.py", async () => {
    await initResolvers(PY_FIXTURE);
    const file = makeFileNode("main.py", "python", [
      {
        source: "mypackage",
        resolvedPath: null,
        namedImports: [],
        namespaceImport: "mypackage",
        isExternal: false,
      },
    ]);

    resolveFileImports(file, PY_FIXTURE);
    expect(file.imports[0]!.resolvedPath).toBe("mypackage/__init__.py");
  });

  test("resolves relative imports (from .. import x)", async () => {
    await initResolvers(PY_FIXTURE);
    const file = makeFileNode("mypackage/sub/module.py", "python", [
      {
        source: "..utils",
        resolvedPath: null,
        namedImports: ["helper"],
        isExternal: false,
      },
    ]);

    resolveFileImports(file, PY_FIXTURE);
    expect(file.imports[0]!.resolvedPath).toBe("mypackage/utils.py");
  });
});

describe("buildEdges", () => {
  test("creates edges from resolved imports", () => {
    const files: FileNode[] = [
      makeFileNode("src/service.ts", "typescript", [
        {
          source: "./types",
          resolvedPath: "src/types.ts",
          namedImports: ["User", "Config"],
          isExternal: false,
        },
      ]),
      makeFileNode("src/barrel.ts", "typescript", [], [
        {
          source: "./types",
          resolvedPath: "src/types.ts",
          names: [],
          isNamespaceReExport: true,
        },
      ]),
    ];

    const edges = buildEdges(files);
    expect(edges.length).toBe(2);

    const serviceEdge = edges.find((e) => e.from === "src/service.ts");
    expect(serviceEdge).toBeDefined();
    expect(serviceEdge!.to).toBe("src/types.ts");
    expect(serviceEdge!.importedNames).toEqual(["User", "Config"]);

    const barrelEdge = edges.find((e) => e.from === "src/barrel.ts");
    expect(barrelEdge).toBeDefined();
    expect(barrelEdge!.to).toBe("src/types.ts");
    expect(barrelEdge!.importedNames).toEqual(["*"]);
  });

  test("skips unresolved imports", () => {
    const files: FileNode[] = [
      makeFileNode("src/index.ts", "typescript", [
        {
          source: "lodash",
          resolvedPath: null,
          namedImports: ["map"],
          isExternal: true,
        },
      ]),
    ];

    const edges = buildEdges(files);
    expect(edges.length).toBe(0);
  });
});
