/**
 * Parser tests — Python.
 * Covers classes, functions, methods, decorators, imports, type aliases,
 * docstrings, __all__, and visibility conventions.
 */

import { test, expect, describe, beforeAll } from "bun:test";
import { parseFile, registerPlugin, initParser } from "../src/parser";
import { registerPython } from "../src/languages/python";
import { resolve } from "node:path";

const FIXTURE_ROOT = resolve(import.meta.dir, "fixtures/python-project");

beforeAll(async () => {
  await initParser();
  const plugin = await registerPython();
  registerPlugin(plugin);
});

describe("python parser - language detection", () => {
  test("sets language field to python", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "main.py"),
      "main.py",
    );
    expect(result).not.toBeNull();
    expect(result!.language).toBe("python");
  });
});

describe("python parser - imports", () => {
  test("extracts `import x` and `import x as y`", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    expect(result).not.toBeNull();
    const asyncio = result!.imports.find((i) => i.source === "asyncio");
    expect(asyncio).toBeDefined();
    expect(asyncio!.namespaceImport).toBe("asyncio");
  });

  test("extracts `from x import y, z`", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const typing = result!.imports.find((i) => i.source === "typing");
    expect(typing).toBeDefined();
    expect(typing!.namedImports).toContain("Optional");
    expect(typing!.namedImports).toContain("List");
  });

  test("extracts relative imports (from .x import y)", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const rel = result!.imports.find((i) => i.source === ".utils");
    expect(rel).toBeDefined();
    expect(rel!.namedImports).toContain("helper as _helper");
    expect(rel!.isExternal).toBe(false);
  });

  test("extracts double-dotted relative imports (from ..pkg import y)", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const rel = result!.imports.find((i) => i.source === "..external");
    expect(rel).toBeDefined();
    expect(rel!.isExternal).toBe(false);
  });

  test("extracts `from abc import ABC, abstractmethod`", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const abc = result!.imports.find((i) => i.source === "abc");
    expect(abc).toBeDefined();
    expect(abc!.namedImports).toContain("ABC");
    expect(abc!.namedImports).toContain("abstractmethod");
  });
});

describe("python parser - functions", () => {
  test("extracts function with params and return type", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const fn = result!.functions.find((f) => f.name === "validate_email");
    expect(fn).toBeDefined();
    expect(fn!.params.length).toBe(1);
    expect(fn!.params[0]!.name).toBe("email");
    expect(fn!.params[0]!.type).toBe("str");
    expect(fn!.returnType).toBe("bool");
  });

  test("extracts function docstring", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const fn = result!.functions.find((f) => f.name === "validate_email");
    expect(fn!.jsdoc).toContain("Validate an email address");
    expect(fn!.jsdoc).toContain("Naive check");
  });

  test("extracts async function", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const fn = result!.functions.find((f) => f.name === "fetch_all");
    expect(fn).toBeDefined();
    expect(fn!.isAsync).toBe(true);
  });

  test("extracts variadic and keyword params", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const fn = result!.functions.find((f) => f.name === "fetch_all");
    expect(fn).toBeDefined();
    const idsParam = fn!.params.find((p) => p.name === "ids");
    expect(idsParam).toBeDefined();
    expect(idsParam!.isRest).toBe(true);
    const kwargsParam = fn!.params.find((p) => p.name === "kwargs");
    expect(kwargsParam).toBeDefined();
    expect(kwargsParam!.isRest).toBe(true);
  });

  test("extracts default parameter values", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const fn = result!.functions.find((f) => f.name === "fetch_all");
    const batchParam = fn!.params.find((p) => p.name === "batch_size");
    expect(batchParam).toBeDefined();
    expect(batchParam!.isOptional).toBe(true);
    expect(batchParam!.defaultValue).toBe("10");
  });
});

describe("python parser - classes", () => {
  test("extracts class with base", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const cls = result!.classes.find((c) => c.name === "UserService");
    expect(cls).toBeDefined();
    expect(cls!.extends).toBe("BaseService");
  });

  test("detects abstract base class (inherits ABC)", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const cls = result!.classes.find((c) => c.name === "BaseService");
    expect(cls).toBeDefined();
    expect(cls!.isAbstract).toBe(true);
  });

  test("extracts class methods", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const cls = result!.classes.find((c) => c.name === "UserService");
    const getUser = cls!.methods.find((m) => m.name === "get_user");
    expect(getUser).toBeDefined();
    expect(getUser!.isAsync).toBe(true);
    expect(getUser!.params.length).toBe(2); // self + user_id
    expect(getUser!.returnType).toBe("Optional[dict]");
  });

  test("extracts staticmethod and classmethod decorators", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const cls = result!.classes.find((c) => c.name === "UserService");
    const hashPw = cls!.methods.find((m) => m.name === "hash_password");
    expect(hashPw).toBeDefined();
    expect(hashPw!.isStatic).toBe(true);

    const fromEnv = cls!.methods.find((m) => m.name === "from_env");
    expect(fromEnv).toBeDefined();
    expect(fromEnv!.isStatic).toBe(true); // classmethod also marked static
  });

  test("extracts @abstractmethod", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const cls = result!.classes.find((c) => c.name === "BaseService");
    const start = cls!.methods.find((m) => m.name === "start");
    expect(start).toBeDefined();
    expect(start!.isAbstract).toBe(true);
  });

  test("extracts class docstring", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const cls = result!.classes.find((c) => c.name === "UserService");
    expect(cls!.jsdoc).toBe("Concrete user service with async operations.");
  });

  test("extracts method docstring", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const cls = result!.classes.find((c) => c.name === "UserService");
    const getUser = cls!.methods.find((m) => m.name === "get_user");
    expect(getUser!.jsdoc).toBe("Fetch a user by ID.");
  });

  test("extracts annotated class attributes as properties", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const cls = result!.classes.find((c) => c.name === "BaseService");
    const nameProp = cls!.properties.find((p) => p.name === "name");
    expect(nameProp).toBeDefined();
    expect(nameProp!.type).toBe("str");
    expect(nameProp!.visibility).toBe("public");

    const configProp = cls!.properties.find((p) => p.name === "_config");
    expect(configProp).toBeDefined();
    expect(configProp!.visibility).toBe("private");
  });

  test("method visibility based on underscore convention", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const cls = result!.classes.find((c) => c.name === "UserService");
    const priv = cls!.methods.find((m) => m.name === "_private_helper");
    expect(priv).toBeDefined();
    expect(priv!.visibility).toBe("protected");

    const dunder = cls!.methods.find((m) => m.name === "__init__");
    expect(dunder).toBeDefined();
    expect(dunder!.visibility).toBe("public");
  });
});

describe("python parser - decorators", () => {
  test("decorator name appears in method signature", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const cls = result!.classes.find((c) => c.name === "UserService");
    const prop = cls!.methods.find((m) => m.name === "display_name");
    expect(prop).toBeDefined();
    expect(prop!.signature).toContain("@property");
  });
});

describe("python parser - type aliases", () => {
  test("extracts PEP 695 type aliases", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/types_.py"),
      "mypackage/types_.py",
    );
    const email = result!.types.find((t) => t.name === "Email");
    expect(email).toBeDefined();
    expect(email!.kind).toBe("type");
    expect(email!.typeExpression).toBe("str");

    const maybe = result!.types.find((t) => t.name === "MaybeUser");
    expect(maybe).toBeDefined();
    expect(maybe!.typeExpression).toBe("Union[dict, None]");
  });
});

describe("python parser - exports (PEP 8 convention)", () => {
  test("public top-level names appear in exports", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    // __all__ defined → exports filtered to that list
    const names = result!.exports.map((e) => e.name);
    expect(names).toContain("UserService");
    expect(names).toContain("BaseService");
    expect(names).toContain("validate_email");
    expect(names).toContain("VERSION");
  });

  test("__all__ filters out names not listed", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const names = result!.exports.map((e) => e.name);
    // fetch_all is defined but not in __all__ → excluded
    expect(names).not.toContain("fetch_all");
  });

  test("leading-underscore names are not exported", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const names = result!.exports.map((e) => e.name);
    expect(names).not.toContain("_private_func");
    expect(names).not.toContain("_INTERNAL");
  });

  test("module-level const has signature with value", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "mypackage/service.py"),
      "mypackage/service.py",
    );
    const versionExp = result!.exports.find((e) => e.name === "VERSION");
    expect(versionExp).toBeDefined();
    expect(versionExp!.kind).toBe("const");
    expect(versionExp!.signature).toContain('"1.0.0"');
  });
});

describe("python parser - real-world snippet", () => {
  test("parses a FastAPI-style module without crashing", async () => {
    // Inline a realistic Python snippet (we can't depend on external repos in tests).
    const src = `"""FastAPI-style example."""
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, List

app = FastAPI()


class Item(BaseModel):
    name: str
    price: float
    is_offer: Optional[bool] = None


@app.get("/")
async def read_root():
    """Root endpoint."""
    return {"Hello": "World"}


@app.get("/items/{item_id}")
async def read_item(item_id: int, q: Optional[str] = None):
    """Read an item by ID."""
    if item_id < 0:
        raise HTTPException(status_code=400, detail="bad id")
    return {"item_id": item_id, "q": q}


@app.put("/items/{item_id}")
async def update_item(item_id: int, item: Item) -> Item:
    return item
`;
    // Use the system temp dir to avoid polluting tests/fixtures (which is
    // tracked in git).
    const { tmpdir } = await import("node:os");
    const tmp = resolve(tmpdir(), `codemap-fastapi-snippet-${Date.now()}.py`);
    await Bun.write(tmp, src);
    const result = await parseFile(tmp, "_fastapi_snippet.py");
    expect(result).not.toBeNull();

    const cls = result!.classes.find((c) => c.name === "Item");
    expect(cls).toBeDefined();
    expect(cls!.extends).toBe("BaseModel");

    const root = result!.functions.find((f) => f.name === "read_root");
    expect(root).toBeDefined();
    expect(root!.isAsync).toBe(true);
    expect(root!.signature).toContain('@app.get("/")');

    const updateItem = result!.functions.find((f) => f.name === "update_item");
    expect(updateItem).toBeDefined();
    expect(updateItem!.returnType).toBe("Item");
  });
});
