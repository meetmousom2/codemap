import { test, expect, describe, beforeAll } from "bun:test";
import { parseFile, registerPlugin, initParser } from "../src/parser";
import { registerGo } from "../src/languages/go";
import { resolve } from "node:path";

const FIXTURE_ROOT = resolve(import.meta.dir, "fixtures/go-project");

beforeAll(async () => {
  await initParser();
  const plugin = await registerGo();
  registerPlugin(plugin);
});

describe("Go parser - package", () => {
  test("extracts the package clause as a namespace export", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "main.go"),
      "main.go",
    );
    expect(result).not.toBeNull();
    expect(result!.language).toBe("go");

    const pkg = result!.exports.find((e) => e.kind === "namespace");
    expect(pkg).toBeDefined();
    expect(pkg!.name).toBe("main");
    expect(pkg!.signature).toContain("package main");
  });

  test("captures the package doc comment", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "main.go"),
      "main.go",
    );
    const pkg = result!.exports.find((e) => e.kind === "namespace");
    expect(pkg!.jsdoc).toContain("entrypoint of the example");
  });
});

describe("Go parser - functions", () => {
  test("extracts exported top-level functions", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "main.go"),
      "main.go",
    );
    const run = result!.functions.find((f) => f.name === "Run");
    expect(run).toBeDefined();
    expect(run!.returnType).toBe("error");
    expect(run!.signature).toContain("func Run()");
    expect(run!.jsdoc).toBe("Run starts the program.");
  });

  test("appears in the export list when capitalized", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "main.go"),
      "main.go",
    );
    const runExport = result!.exports.find((e) => e.name === "Run");
    expect(runExport).toBeDefined();
    expect(runExport!.kind).toBe("function");
  });

  test("unexported functions do not appear in exports", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "main.go"),
      "main.go",
    );
    // `main` and `goodbye` are lowercase — neither should appear as a function export.
    const fnExports = result!.exports.filter((e) => e.kind === "function");
    expect(fnExports.find((e) => e.name === "main")).toBeUndefined();
    expect(fnExports.find((e) => e.name === "User.goodbye")).toBeUndefined();
  });
});

describe("Go parser - methods", () => {
  test("attaches methods to the struct they receive", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "main.go"),
      "main.go",
    );
    const user = result!.classes.find((c) => c.name === "User");
    expect(user).toBeDefined();
    const hello = user!.methods.find((m) => m.name === "Hello");
    expect(hello).toBeDefined();
    expect(hello!.params.length).toBe(1);
    expect(hello!.params[0]!.name).toBe("name");
    expect(hello!.params[0]!.type).toBe("string");
    expect(hello!.returnType).toBe("string");
  });

  test("strips pointer receivers from receiver type", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "main.go"),
      "main.go",
    );
    const user = result!.classes.find((c) => c.name === "User");
    expect(user!.methods.length).toBeGreaterThanOrEqual(2);
  });

  test("exports show receiver.method form for exported methods", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "main.go"),
      "main.go",
    );
    const hello = result!.exports.find((e) => e.name === "User.Hello");
    expect(hello).toBeDefined();
    expect(hello!.kind).toBe("function");
  });
});

describe("Go parser - types and structs", () => {
  test("extracts struct fields with visibility", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "main.go"),
      "main.go",
    );
    const user = result!.classes.find((c) => c.name === "User");
    expect(user).toBeDefined();

    const id = user!.properties.find((p) => p.name === "ID");
    expect(id).toBeDefined();
    expect(id!.type).toBe("int");
    expect(id!.visibility).toBe("public");

    const priv = user!.properties.find((p) => p.name === "private");
    expect(priv).toBeDefined();
    expect(priv!.visibility).toBe("private");
  });

  test("captures field doc comments", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "main.go"),
      "main.go",
    );
    const user = result!.classes.find((c) => c.name === "User");
    const id = user!.properties.find((p) => p.name === "ID");
    expect(id!.jsdoc).toBe("ID is the primary key.");
  });

  test("exposes struct type doc comment", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "main.go"),
      "main.go",
    );
    const user = result!.classes.find((c) => c.name === "User");
    expect(user!.jsdoc).toContain("registered user");
  });
});

describe("Go parser - interfaces", () => {
  test("extracts interface method-set", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "main.go"),
      "main.go",
    );
    const greeter = result!.types.find((t) => t.name === "Greeter");
    expect(greeter).toBeDefined();
    expect(greeter!.kind).toBe("interface");
    const methodNames = greeter!.properties.map((p) => p.name);
    expect(methodNames).toContain("Hello");
    expect(methodNames).toContain("Goodbye");
  });

  test("interface declaration appears in exports", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "main.go"),
      "main.go",
    );
    const greeter = result!.exports.find((e) => e.name === "Greeter");
    expect(greeter).toBeDefined();
    expect(greeter!.kind).toBe("interface");
  });
});

describe("Go parser - imports", () => {
  test("flags stdlib imports as external", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "main.go"),
      "main.go",
    );
    const fmtImp = result!.imports.find((i) => i.source === "fmt");
    expect(fmtImp).toBeDefined();
    expect(fmtImp!.isExternal).toBe(true);
  });

  test("module-local imports are not flagged stdlib", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "main.go"),
      "main.go",
    );
    const local = result!.imports.find(
      (i) => i.source === "example.com/myrepo/internal/secret",
    );
    expect(local).toBeDefined();
    // First segment has a dot — not stdlib, so isExternal is false.
    expect(local!.isExternal).toBe(false);
  });

  test("records import aliases", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "main.go"),
      "main.go",
    );
    const aliased = result!.imports.find(
      (i) => i.source === "github.com/external/pkg",
    );
    expect(aliased).toBeDefined();
    expect(aliased!.defaultImport).toBe("pkg");
  });
});

describe("Go parser - const exports", () => {
  test("captures top-level const with capitalized name", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "main.go"),
      "main.go",
    );
    const greeting = result!.exports.find((e) => e.name === "Greeting");
    expect(greeting).toBeDefined();
    expect(greeting!.kind).toBe("const");
  });
});
