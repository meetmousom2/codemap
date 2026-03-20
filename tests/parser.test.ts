import { test, expect, describe, beforeAll } from "bun:test";
import { parseFile, registerPlugin, initParser } from "../src/parser";
import { registerTypescript } from "../src/languages/typescript";
import { resolve } from "node:path";

const FIXTURE_ROOT = resolve(import.meta.dir, "fixtures/sample-project");

beforeAll(async () => {
  const plugin = await registerTypescript();
  registerPlugin(plugin);
});

describe("parser - exports", () => {
  test("extracts function exports", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/index.ts"),
      "src/index.ts",
    );
    expect(result).not.toBeNull();
    const helloExport = result!.exports.find((e) => e.name === "hello");
    expect(helloExport).toBeDefined();
    expect(helloExport!.kind).toBe("function");
    expect(helloExport!.isDefault).toBe(false);
  });

  test("extracts const exports", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/utils.ts"),
      "src/utils.ts",
    );
    expect(result).not.toBeNull();
    const versionExport = result!.exports.find((e) => e.name === "VERSION");
    expect(versionExport).toBeDefined();
    expect(versionExport!.kind).toBe("const");
  });

  test("extracts class exports", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/service.ts"),
      "src/service.ts",
    );
    expect(result).not.toBeNull();
    const userServiceExport = result!.exports.find(
      (e) => e.name === "UserService",
    );
    expect(userServiceExport).toBeDefined();
    expect(userServiceExport!.kind).toBe("class");
  });

  test("extracts interface exports", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/types.ts"),
      "src/types.ts",
    );
    expect(result).not.toBeNull();
    const userExport = result!.exports.find((e) => e.name === "User");
    expect(userExport).toBeDefined();
    expect(userExport!.kind).toBe("interface");
  });

  test("extracts type alias exports", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/types.ts"),
      "src/types.ts",
    );
    expect(result).not.toBeNull();
    const configExport = result!.exports.find((e) => e.name === "Config");
    expect(configExport).toBeDefined();
    expect(configExport!.kind).toBe("type");
  });

  test("extracts enum exports", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/service.ts"),
      "src/service.ts",
    );
    expect(result).not.toBeNull();
    const logLevelExport = result!.exports.find((e) => e.name === "LogLevel");
    expect(logLevelExport).toBeDefined();
    expect(logLevelExport!.kind).toBe("enum");
  });
});

describe("parser - JSDoc", () => {
  test("extracts JSDoc from exports", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/types.ts"),
      "src/types.ts",
    );
    const userExport = result!.exports.find((e) => e.name === "User");
    expect(userExport!.jsdoc).toBe("A user in the system");
  });

  test("extracts JSDoc from class methods", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/service.ts"),
      "src/service.ts",
    );
    const userService = result!.classes.find((c) => c.name === "UserService");
    expect(userService).toBeDefined();
    const getUser = userService!.methods.find((m) => m.name === "getUser");
    expect(getUser).toBeDefined();
    expect(getUser!.jsdoc).toBe("Get a user by ID");
  });
});

describe("parser - classes", () => {
  test("extracts class extends", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/service.ts"),
      "src/service.ts",
    );
    const userService = result!.classes.find((c) => c.name === "UserService");
    expect(userService).toBeDefined();
    expect(userService!.extends).toBe("BaseService");
  });

  test("extracts abstract class", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/service.ts"),
      "src/service.ts",
    );
    const baseService = result!.classes.find((c) => c.name === "BaseService");
    expect(baseService).toBeDefined();
    expect(baseService!.isAbstract).toBe(true);
  });

  test("extracts class methods with params", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/service.ts"),
      "src/service.ts",
    );
    const userService = result!.classes.find((c) => c.name === "UserService");
    expect(userService!.methods.length).toBeGreaterThanOrEqual(3);

    const createUser = userService!.methods.find(
      (m) => m.name === "createUser",
    );
    expect(createUser).toBeDefined();
    expect(createUser!.isAsync).toBe(true);
    expect(createUser!.params.length).toBe(2);
    expect(createUser!.params[0]!.name).toBe("name");
    expect(createUser!.params[1]!.name).toBe("email");
    expect(createUser!.params[1]!.isOptional).toBe(true);
  });

  test("extracts class properties with visibility", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/service.ts"),
      "src/service.ts",
    );
    const baseService = result!.classes.find((c) => c.name === "BaseService");
    expect(baseService).toBeDefined();
    const configProp = baseService!.properties.find(
      (p) => p.name === "config",
    );
    expect(configProp).toBeDefined();
    expect(configProp!.visibility).toBe("protected");
  });
});

describe("parser - functions", () => {
  test("extracts function params and return type", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/service.ts"),
      "src/service.ts",
    );
    const validateEmail = result!.functions.find(
      (f) => f.name === "validateEmail",
    );
    expect(validateEmail).toBeDefined();
    expect(validateEmail!.params.length).toBe(1);
    expect(validateEmail!.params[0]!.name).toBe("email");
    expect(validateEmail!.params[0]!.type).toBe("string");
    expect(validateEmail!.returnType).toBe("boolean");
  });
});

describe("parser - types and interfaces", () => {
  test("extracts interface properties", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/types.ts"),
      "src/types.ts",
    );
    const user = result!.types.find((t) => t.name === "User");
    expect(user).toBeDefined();
    expect(user!.kind).toBe("interface");
    expect(user!.properties.length).toBe(3);

    const emailProp = user!.properties.find((p) => p.name === "email");
    expect(emailProp!.isOptional).toBe(true);
  });

  test("extracts interface extends", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/types.ts"),
      "src/types.ts",
    );
    const adminUser = result!.types.find((t) => t.name === "AdminUser");
    expect(adminUser).toBeDefined();
    expect(adminUser!.extends).toContain("User");
  });

  test("extracts type aliases with properties", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/types.ts"),
      "src/types.ts",
    );
    const config = result!.types.find((t) => t.name === "Config");
    expect(config).toBeDefined();
    expect(config!.kind).toBe("type");
    expect(config!.properties.length).toBe(3);
  });
});

describe("parser - imports", () => {
  test("extracts named imports", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/service.ts"),
      "src/service.ts",
    );
    const typesImport = result!.imports.find((i) => i.source === "./types");
    expect(typesImport).toBeDefined();
    expect(typesImport!.namedImports).toContain("User");
    expect(typesImport!.namedImports).toContain("Config");
    expect(typesImport!.isExternal).toBe(false);
  });

  test("identifies external imports", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/index.ts"),
      "src/index.ts",
    );
    const externalImports = result!.imports.filter((i) => i.isExternal);
    expect(externalImports.length).toBe(0);
  });
});

describe("parser - re-exports", () => {
  test("extracts barrel re-exports (export *)", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/barrel.ts"),
      "src/barrel.ts",
    );
    const starReExport = result!.reExports.find(
      (r) => r.source === "./types" && r.names.length === 0,
    );
    expect(starReExport).toBeDefined();
    expect(starReExport!.isNamespaceReExport).toBe(true);
  });

  test("extracts named re-exports", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/barrel.ts"),
      "src/barrel.ts",
    );
    const serviceReExport = result!.reExports.find(
      (r) => r.source === "./service",
    );
    expect(serviceReExport).toBeDefined();
    expect(serviceReExport!.names).toContain("UserService");
  });
});

describe("parser - language detection", () => {
  test("sets language field to typescript", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/index.ts"),
      "src/index.ts",
    );
    expect(result!.language).toBe("typescript");
  });

  test("returns null for unsupported extensions", async () => {
    const result = await parseFile(
      resolve(FIXTURE_ROOT, "src/index.ts").replace(".ts", ".rs"),
      "src/index.rs",
    );
    expect(result).toBeNull();
  });
});
