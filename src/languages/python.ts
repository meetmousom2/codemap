/**
 * Python language plugin for tree-sitter.
 *
 * Extracts module-level functions, classes (with methods + properties), type aliases
 * (PEP 695 `type` statements), imports, and re-exports. Mirrors the shape of
 * `src/languages/typescript.ts` so downstream graph/ranker/renderer code stays
 * language-agnostic.
 *
 * Notes on Python semantics vs the FileNode contract:
 * - Python has no `export` keyword. Every top-level binding is "exported" unless
 *   it starts with `_` (PEP 8 convention) or is excluded from `__all__`. We use
 *   this convention to populate `exports` while still recording all definitions
 *   in `classes`/`functions` for skeleton rendering.
 * - "Default export" doesn't exist; `isDefault` is always false.
 * - Docstrings (first string expression in a body) are extracted as `jsdoc`.
 * - Decorators are preserved in `signature` and tracked for `@property`/`@staticmethod`.
 */

import { Parser, Language } from "web-tree-sitter";
import type {
  LanguagePlugin,
  FileNode,
  Export,
  Import,
  ClassInfo,
  FunctionInfo,
  TypeInfo,
  ReExport,
  MethodInfo,
  PropertyInfo,
  ParamInfo,
  ExportKind,
} from "../types";
import { initParser, loadLanguage } from "../parser";

let pyLang: Language | null = null;
let parser: Parser | null = null;

// ─── helpers ──────────────────────────────────────────────────────────────

function childText(node: any, fieldName: string): string | undefined {
  const child = node.childForFieldName(fieldName);
  return child?.text;
}

function childrenOfType(node: any, type: string): any[] {
  const results: any[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === type) results.push(child);
  }
  return results;
}

function childOfType(node: any, type: string): any | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === type) return child;
  }
  return null;
}

/** Strip surrounding quotes from a Python string literal (single, double, triple). */
function stripPyString(raw: string): string {
  let s = raw.trim();
  // Drop leading string prefixes like r, b, u, f, rb, etc.
  s = s.replace(/^[rRbBuUfF]{0,2}/, "");
  if (s.startsWith('"""') && s.endsWith('"""')) return s.slice(3, -3);
  if (s.startsWith("'''") && s.endsWith("'''")) return s.slice(3, -3);
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}

/** Dedent and trim a docstring per PEP 257. */
function cleanDocstring(raw: string): string {
  const text = stripPyString(raw);
  const lines = text.split("\n");
  if (lines.length === 1) return lines[0]!.trim();

  // Find min indent of non-empty lines (skip first line — convention: no indent)
  let minIndent = Infinity;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent < minIndent) minIndent = indent;
  }
  if (!isFinite(minIndent)) minIndent = 0;

  const out: string[] = [lines[0]!.trim()];
  for (let i = 1; i < lines.length; i++) {
    out.push(lines[i]!.slice(minIndent).trimEnd());
  }
  // Trim leading/trailing blank lines
  while (out.length && out[0]!.trim() === "") out.shift();
  while (out.length && out[out.length - 1]!.trim() === "") out.pop();
  return out.join("\n");
}

/**
 * Extract the docstring of a function/class/module body, if present.
 * A docstring is a string expression that is the first statement in the body.
 */
function getDocstring(bodyNode: any): string | undefined {
  if (!bodyNode) return undefined;
  // body type is `block`. Its first named child should be expression_statement → string.
  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const stmt = bodyNode.namedChild(i);
    if (!stmt) continue;
    if (stmt.type === "expression_statement") {
      const expr = stmt.namedChild(0);
      if (expr?.type === "string") return cleanDocstring(expr.text);
    }
    // Stop at the first non-comment, non-string statement
    if (stmt.type !== "comment") return undefined;
  }
  return undefined;
}

/**
 * Build a one-line signature for a function/class node by slicing up to (but
 * excluding) the `body` field.
 */
function signatureWithoutBody(node: any): string {
  const body = node.childForFieldName("body");
  if (!body) return node.text;
  return node.text
    .slice(0, body.startIndex - node.startIndex)
    .replace(/:\s*$/, "")
    .trim();
}

/** Convention-based "is public" check (PEP 8: leading underscore = private). */
function isPublicName(name: string): boolean {
  return !name.startsWith("_") || (name.startsWith("__") && name.endsWith("__"));
}

/** Extract decorators from a decorated_definition wrapper. */
function extractDecorators(decoratedNode: any): string[] {
  const decs: string[] = [];
  for (const dec of childrenOfType(decoratedNode, "decorator")) {
    // Decorator text starts with '@' and ends with newline — strip them.
    decs.push(dec.text.replace(/^@/, "").trim());
  }
  return decs;
}

// ─── parameter extraction ─────────────────────────────────────────────────

function extractParam(param: any): ParamInfo | null {
  switch (param.type) {
    case "identifier":
      return {
        name: param.text,
        type: "unknown",
        isOptional: false,
        isRest: false,
      };
    case "typed_parameter": {
      // Child 0 is the name pattern (identifier / list_splat_pattern / dict_splat_pattern)
      const nameNode = param.child(0);
      const typeNode = param.childForFieldName("type");
      const isRest =
        nameNode?.type === "list_splat_pattern" ||
        nameNode?.type === "dictionary_splat_pattern";
      const rawName = nameNode?.text ?? param.text;
      return {
        name: rawName.replace(/^\*+/, ""),
        type: typeNode?.text ?? "unknown",
        isOptional: false,
        isRest,
      };
    }
    case "default_parameter": {
      const nameNode = param.childForFieldName("name");
      const valueNode = param.childForFieldName("value");
      return {
        name: nameNode?.text ?? "unknown",
        type: "unknown",
        isOptional: true,
        isRest: false,
        defaultValue: valueNode?.text,
      };
    }
    case "typed_default_parameter": {
      const nameNode = param.childForFieldName("name");
      const typeNode = param.childForFieldName("type");
      const valueNode = param.childForFieldName("value");
      return {
        name: nameNode?.text ?? "unknown",
        type: typeNode?.text ?? "unknown",
        isOptional: true,
        isRest: false,
        defaultValue: valueNode?.text,
      };
    }
    case "list_splat_pattern":
      return {
        name: param.text.replace(/^\*+/, ""),
        type: "unknown",
        isOptional: false,
        isRest: true,
      };
    case "dictionary_splat_pattern":
      return {
        name: param.text.replace(/^\*+/, ""),
        type: "unknown",
        isOptional: false,
        isRest: true,
      };
    case "positional_separator":
    case "keyword_separator":
      return null; // '/' and '*' markers
    default:
      return null;
  }
}

function extractParams(paramsNode: any): ParamInfo[] {
  if (!paramsNode) return [];
  const params: ParamInfo[] = [];
  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const p = paramsNode.namedChild(i);
    if (!p) continue;
    const info = extractParam(p);
    if (info) params.push(info);
  }
  return params;
}

function getReturnType(node: any): string {
  const ret = node.childForFieldName("return_type");
  return ret ? ret.text : "None";
}

// ─── function / method extraction ────────────────────────────────────────

interface PyFnExtras {
  decorators: string[];
}

function extractFunctionInfo(
  node: any,
  extras: PyFnExtras = { decorators: [] },
): FunctionInfo {
  const name = childText(node, "name") ?? "anonymous";
  const params = extractParams(node.childForFieldName("parameters"));
  const returnType = getReturnType(node);
  const body = node.childForFieldName("body");
  const isAsync = childOfType(node, "async") !== null;
  const typeParamsNode = node.childForFieldName("type_parameters");
  const typeParams = typeParamsNode ? [typeParamsNode.text] : [];

  let signature = signatureWithoutBody(node);
  if (extras.decorators.length) {
    signature =
      extras.decorators.map((d) => `@${d}`).join("\n") + "\n" + signature;
  }

  return {
    name,
    signature,
    params,
    returnType,
    isAsync,
    // Generators in Python are functions that contain `yield`. Detecting that
    // requires a full body scan — too expensive at this layer. Mark false; the
    // renderer doesn't depend on this for Python.
    isGenerator: false,
    typeParameters: typeParams,
    jsdoc: getDocstring(body),
  };
}

function extractMethodInfo(
  node: any,
  extras: PyFnExtras = { decorators: [] },
): MethodInfo {
  const name = childText(node, "name") ?? "anonymous";
  const params = extractParams(node.childForFieldName("parameters"));
  const returnType = getReturnType(node);
  const body = node.childForFieldName("body");
  const isAsync = childOfType(node, "async") !== null;

  const decorators = extras.decorators;
  const isStatic = decorators.some(
    (d) => d === "staticmethod" || d.endsWith(".staticmethod"),
  );
  const isClassMethod = decorators.some(
    (d) => d === "classmethod" || d.endsWith(".classmethod"),
  );
  const isAbstract = decorators.some((d) => d.includes("abstractmethod"));

  let signature = signatureWithoutBody(node);
  if (decorators.length) {
    signature = decorators.map((d) => `@${d}`).join("\n") + "\n" + signature;
  }

  return {
    name,
    signature,
    returnType,
    params,
    isStatic: isStatic || isClassMethod,
    isAsync,
    isAbstract,
    // Python convention: leading underscore → private, double-leading → "private"
    // (name-mangled), dunder methods are public.
    visibility: name.startsWith("__") && name.endsWith("__")
      ? "public"
      : name.startsWith("__")
        ? "private"
        : name.startsWith("_")
          ? "protected"
          : "public",
    jsdoc: getDocstring(body),
  };
}

// ─── class extraction ────────────────────────────────────────────────────

function extractClassInfo(
  node: any,
  extras: PyFnExtras = { decorators: [] },
): ClassInfo {
  const name = childText(node, "name") ?? "Unknown";
  const body = node.childForFieldName("body");
  const superclassesNode = node.childForFieldName("superclasses");
  const typeParamsNode = node.childForFieldName("type_parameters");

  // Parse superclasses (argument_list): first positional arg is the base class,
  // additional positional args are mixins/protocols, keyword args (metaclass=,
  // total=, etc.) are ignored.
  let extendsClause: string | undefined;
  const implementsList: string[] = [];
  if (superclassesNode) {
    for (let i = 0; i < superclassesNode.namedChildCount; i++) {
      const arg = superclassesNode.namedChild(i);
      if (!arg) continue;
      // Skip keyword_argument nodes
      if (arg.type === "keyword_argument") continue;
      if (!extendsClause) {
        extendsClause = arg.text;
      } else {
        implementsList.push(arg.text);
      }
    }
  }

  const methods: MethodInfo[] = [];
  const properties: PropertyInfo[] = [];

  if (body) {
    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i);
      if (!member) continue;

      if (member.type === "function_definition") {
        methods.push(extractMethodInfo(member));
      } else if (member.type === "decorated_definition") {
        const decorators = extractDecorators(member);
        const inner = member.childForFieldName("definition");
        if (inner?.type === "function_definition") {
          methods.push(extractMethodInfo(inner, { decorators }));
        }
        // Decorated nested classes are rare — skip for now
      } else if (member.type === "expression_statement") {
        // Class-level type-annotated attribute: `name: type = default`
        // Treated by tree-sitter as either an `assignment` (with type field) or
        // bare annotation. We pull these out as properties.
        const inner = member.namedChild(0);
        if (inner?.type === "assignment") {
          const left = inner.childForFieldName("left");
          const typeNode = inner.childForFieldName("type");
          if (left?.type === "identifier") {
            properties.push({
              name: left.text,
              type: typeNode?.text ?? "unknown",
              isOptional: false,
              isReadonly: false,
              isStatic: false,
              visibility: left.text.startsWith("_") ? "private" : "public",
            });
          }
        }
      }
    }
  }

  const isAbstract = extras.decorators.some((d) =>
    d.includes("abstractmethod"),
  ) ||
    // Inherits from abc.ABC / ABCMeta
    extendsClause === "ABC" ||
    extendsClause === "abc.ABC" ||
    implementsList.some((i) => i === "ABC" || i === "abc.ABC");

  let signature = `class ${name}`;
  if (typeParamsNode) signature += typeParamsNode.text;
  if (superclassesNode) signature += superclassesNode.text;

  return {
    name,
    extends: extendsClause,
    implements: implementsList,
    methods,
    properties,
    isAbstract,
    typeParameters: typeParamsNode ? [typeParamsNode.text] : [],
    jsdoc: getDocstring(body),
  };
}

// ─── type alias extraction (PEP 695) ─────────────────────────────────────

function extractTypeAliasInfo(node: any): TypeInfo {
  const leftNode = node.childForFieldName("left");
  const rightNode = node.childForFieldName("right");

  // `left` may be a plain name or `Name[T, U]`. Extract just the name.
  let name = leftNode?.text ?? "unknown";
  const typeParams: string[] = [];
  // Subscript: e.g. `Stack[T]`
  if (leftNode?.type === "type" && leftNode.namedChildCount > 0) {
    const inner = leftNode.namedChild(0);
    if (inner?.type === "subscript") {
      const value = inner.childForFieldName("value");
      name = value?.text ?? name;
      // Collect type params
      for (let i = 0; i < inner.namedChildCount; i++) {
        const child = inner.namedChild(i);
        if (!child || child === value) continue;
        if (child.type !== "subscript") typeParams.push(child.text);
      }
    } else if (inner?.type === "identifier") {
      name = inner.text;
    }
  }

  return {
    name,
    kind: "type",
    properties: [],
    extends: [],
    typeParameters: typeParams,
    typeExpression: rightNode?.text,
  };
}

// ─── imports ─────────────────────────────────────────────────────────────

interface ImportName {
  /** dotted name e.g. "os.path" or single name "helper" */
  name: string;
  /** alias if `as X` */
  alias?: string;
}

function parseImportList(parentNode: any): ImportName[] {
  // Items live as `field('name', ...)` repeated, where each is dotted_name or aliased_import.
  // Iterate all named children and filter to dotted_name / aliased_import.
  const items: ImportName[] = [];
  for (let i = 0; i < parentNode.namedChildCount; i++) {
    const child = parentNode.namedChild(i);
    if (!child) continue;
    if (child.type === "dotted_name") {
      items.push({ name: child.text });
    } else if (child.type === "aliased_import") {
      const name = child.childForFieldName("name")?.text ?? child.text;
      const alias = child.childForFieldName("alias")?.text;
      items.push({ name, alias });
    } else if (child.type === "identifier") {
      // Bare identifier inside the import list (rare, but handle it)
      items.push({ name: child.text });
    }
  }
  return items;
}

function extractImportStatement(node: any): Import[] {
  // `import a, b as c, d.e` → one Import per item (each is its own module).
  const items = parseImportList(node);
  const imports: Import[] = [];
  for (const item of items) {
    imports.push({
      source: item.name,
      resolvedPath: null,
      namedImports: [],
      namespaceImport: item.alias ?? item.name.split(".")[0],
      isExternal: true, // resolver will flip this if the module is in-tree
    });
  }
  return imports;
}

function extractImportFromStatement(node: any): {
  imp?: Import;
  reExport?: ReExport;
} {
  const moduleField = node.childForFieldName("module_name");
  if (!moduleField) return {};

  // module can be `dotted_name` (absolute) or `relative_import` (.foo / ..bar)
  let source: string;
  if (moduleField.type === "relative_import") {
    const prefix = childOfType(moduleField, "import_prefix");
    const dotted = childOfType(moduleField, "dotted_name");
    source = (prefix?.text ?? "") + (dotted?.text ?? "");
  } else {
    source = moduleField.text;
  }

  // Check for wildcard
  const wildcard = childOfType(node, "wildcard_import");
  if (wildcard) {
    return {
      imp: {
        source,
        resolvedPath: null,
        namedImports: [],
        namespaceImport: "*",
        isExternal: !source.startsWith("."),
      },
    };
  }

  // Collect named imports — tree-sitter exposes each as a `name`-field child
  // (dotted_name or aliased_import) directly on the import_from_statement node.
  const named: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child === moduleField) continue;
    if (child.type === "dotted_name") {
      named.push(child.text);
    } else if (child.type === "aliased_import") {
      const name = child.childForFieldName("name")?.text ?? child.text;
      const alias = child.childForFieldName("alias")?.text;
      named.push(alias ? `${name} as ${alias}` : name);
    }
  }

  return {
    imp: {
      source,
      resolvedPath: null,
      namedImports: named,
      isExternal: !source.startsWith("."),
    },
  };
}

// ─── exports synthesis ───────────────────────────────────────────────────

/**
 * Synthesize an Export from a top-level declaration. Python has no `export`
 * keyword; we use PEP 8 convention (leading underscore = private). The graph
 * builder uses these exports for cross-file edges and ranker scoring.
 */
function makeExport(
  name: string,
  kind: ExportKind,
  signature: string,
  jsdoc: string | undefined,
): Export | null {
  if (!isPublicName(name)) return null;
  return { name, kind, signature, jsdoc, isDefault: false };
}

// ─── main parse ──────────────────────────────────────────────────────────

function parsePython(
  source: string,
  _filePath: string,
): Omit<FileNode, "path" | "language"> {
  if (!parser) {
    throw new Error("Python parser not initialized. Call registerPython() first.");
  }
  if (pyLang) parser.setLanguage(pyLang);

  const tree = parser.parse(source);
  const empty: Omit<FileNode, "path" | "language"> = {
    exports: [],
    imports: [],
    classes: [],
    functions: [],
    types: [],
    enums: [],
    reExports: [],
  };
  if (!tree) return empty;

  const root = tree.rootNode;
  const exports: Export[] = [];
  const imports: Import[] = [];
  const classes: ClassInfo[] = [];
  const functions: FunctionInfo[] = [];
  const types: TypeInfo[] = [];
  const reExports: ReExport[] = [];

  // Track __all__ if defined — overrides the leading-underscore convention.
  let allList: string[] | null = null;

  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i);
    if (!node) continue;

    switch (node.type) {
      case "import_statement": {
        const items = extractImportStatement(node);
        imports.push(...items);
        break;
      }

      case "import_from_statement": {
        const { imp } = extractImportFromStatement(node);
        if (imp) imports.push(imp);
        break;
      }

      case "function_definition": {
        const fn = extractFunctionInfo(node);
        functions.push(fn);
        const exp = makeExport(fn.name, "function", fn.signature, fn.jsdoc);
        if (exp) exports.push(exp);
        break;
      }

      case "class_definition": {
        const cls = extractClassInfo(node);
        classes.push(cls);
        const sig = `class ${cls.name}${cls.extends ? `(${[cls.extends, ...cls.implements].join(", ")})` : ""}`;
        const exp = makeExport(cls.name, "class", sig, cls.jsdoc);
        if (exp) exports.push(exp);
        break;
      }

      case "decorated_definition": {
        const decorators = extractDecorators(node);
        const inner = node.childForFieldName("definition");
        if (!inner) break;
        if (inner.type === "function_definition") {
          const fn = extractFunctionInfo(inner, { decorators });
          functions.push(fn);
          const exp = makeExport(fn.name, "function", fn.signature, fn.jsdoc);
          if (exp) exports.push(exp);
        } else if (inner.type === "class_definition") {
          const cls = extractClassInfo(inner, { decorators });
          classes.push(cls);
          const sig = `class ${cls.name}${cls.extends ? `(${[cls.extends, ...cls.implements].join(", ")})` : ""}`;
          const exp = makeExport(cls.name, "class", sig, cls.jsdoc);
          if (exp) exports.push(exp);
        }
        break;
      }

      case "type_alias_statement": {
        const t = extractTypeAliasInfo(node);
        types.push(t);
        const exp = makeExport(t.name, "type", `type ${t.name} = ${t.typeExpression ?? ""}`, t.jsdoc);
        if (exp) exports.push(exp);
        break;
      }

      case "expression_statement": {
        // Module-level assignment — covers `__all__ = [...]` and module-level
        // constants (`VERSION = "1.0"`).
        const inner = node.namedChild(0);
        if (inner?.type === "assignment") {
          const left = inner.childForFieldName("left");
          const right = inner.childForFieldName("right");

          // Detect __all__ for filtering exports later
          if (left?.type === "identifier" && left.text === "__all__") {
            allList = parseAllList(right);
          }

          // Top-level const/var: `NAME = value` (skip `self.x = ...` etc.)
          if (left?.type === "identifier") {
            const name = left.text;
            const typeNode = inner.childForFieldName("type");
            const valueText = right?.text ?? "";
            const trimmedValue =
              valueText.length > 80 ? valueText.slice(0, 77) + "..." : valueText;
            const sig = typeNode
              ? `${name}: ${typeNode.text} = ${trimmedValue}`
              : `${name} = ${trimmedValue}`;
            const exp = makeExport(name, "const", sig, undefined);
            if (exp && name !== "__all__") exports.push(exp);
          }
        }
        break;
      }
    }
  }

  // Apply __all__ filter if present
  let filteredExports = exports;
  if (allList) {
    const allSet = new Set(allList);
    filteredExports = exports.filter((e) => allSet.has(e.name));
    // Also surface anything explicitly listed in __all__ but starting with _
    // (rare but valid) — would require a second scan; skip for now.
  }

  return {
    exports: filteredExports,
    imports,
    classes,
    functions,
    types,
    enums: [],
    reExports,
  };
}

/** Parse `__all__ = ["a", "b"]` into a list of strings. */
function parseAllList(rightNode: any): string[] | null {
  if (!rightNode) return null;
  if (rightNode.type !== "list" && rightNode.type !== "tuple") return null;
  const names: string[] = [];
  for (let i = 0; i < rightNode.namedChildCount; i++) {
    const item = rightNode.namedChild(i);
    if (item?.type === "string") names.push(stripPyString(item.text));
  }
  return names;
}

/**
 * Register the Python language plugin.
 * Must be called after initParser().
 */
export async function registerPython(): Promise<LanguagePlugin> {
  await initParser();
  if (!parser) parser = new Parser();

  pyLang = await loadLanguage(
    require.resolve("tree-sitter-python/tree-sitter-python.wasm"),
  );
  parser.setLanguage(pyLang);

  return {
    language: "python",
    extensions: [".py"],
    parseFile: parsePython,
  };
}
