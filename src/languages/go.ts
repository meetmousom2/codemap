/**
 * Go language plugin for tree-sitter.
 *
 * Extracts: package clauses, top-level functions, methods (with receivers),
 * type declarations (structs, interfaces, type aliases), struct fields,
 * interface method-sets, imports, and the leading doc-comment block for each.
 *
 * Mirrors the shape of `src/languages/typescript.ts` so callers don't need
 * Go-specific branches in downstream code. Go has no `export` keyword —
 * "exported" is encoded by capitalization (UpperCamelCase / TitleCase
 * identifiers are package-public). The plugin uses that convention to set
 * the `Export` list.
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
  EnumInfo,
  ReExport,
  MethodInfo,
  PropertyInfo,
  ParamInfo,
  ExportKind,
} from "../types";
import { initParser, loadLanguage } from "../parser";

let goLang: Language | null = null;
let parser: Parser | null = null;

/** Go's notion of "exported": identifier starts with an uppercase letter. */
function isGoExported(name: string): boolean {
  if (!name) return false;
  const first = name[0]!;
  return first >= "A" && first <= "Z";
}

/** Find first child of a specific type. */
function childOfType(node: any, type: string): any | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === type) return child;
  }
  return null;
}

/** Find all named children of a specific type. */
function namedChildrenOfType(node: any, type: string): any[] {
  const results: any[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === type) results.push(child);
  }
  return results;
}

/**
 * Get the contiguous block of `//` line-comments immediately preceding `node`.
 * Go convention: doc-comment is the comment block directly above the
 * declaration with no blank line between them. We walk previous siblings
 * gathering comments until we hit a non-comment or detect a blank-line gap.
 */
function getDocComment(node: any): string | undefined {
  const lines: string[] = [];
  let cur = node.previousNamedSibling;
  let lastStartRow = node.startPosition?.row ?? Infinity;

  while (cur && cur.type === "comment") {
    const endRow = cur.endPosition?.row ?? -1;
    // Blank line between this comment and the next thing below — break.
    if (lastStartRow - endRow > 1) break;
    let text = cur.text as string;
    if (text.startsWith("//")) {
      text = text.replace(/^\/\/\s?/, "");
    } else if (text.startsWith("/*")) {
      text = text.replace(/^\/\*\*?\s*/, "").replace(/\s*\*\/$/, "");
    }
    lines.unshift(text);
    lastStartRow = cur.startPosition?.row ?? lastStartRow;
    cur = cur.previousNamedSibling;
  }

  const joined = lines.join("\n").trim();
  return joined.length > 0 ? joined : undefined;
}

/** Extract a parameter_list into ParamInfo[]. */
function extractParams(paramsNode: any): ParamInfo[] {
  if (!paramsNode) return [];
  const params: ParamInfo[] = [];

  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const decl = paramsNode.namedChild(i);
    if (!decl) continue;

    const isVariadic = decl.type === "variadic_parameter_declaration";
    if (decl.type !== "parameter_declaration" && !isVariadic) continue;

    const typeNode = decl.childForFieldName("type");
    const typeText = typeNode ? typeNode.text : "unknown";

    // A single declaration may bind multiple names: `a, b int`
    const nameNodes: any[] = [];
    for (let j = 0; j < decl.childCount; j++) {
      const c = decl.child(j);
      if (c?.type === "identifier") nameNodes.push(c);
    }

    if (nameNodes.length === 0) {
      // Unnamed (return-only or interface-style) parameter.
      params.push({
        name: "_",
        type: typeText,
        isOptional: false,
        isRest: isVariadic,
      });
    } else {
      for (const n of nameNodes) {
        params.push({
          name: n.text,
          type: typeText,
          isOptional: false,
          isRest: isVariadic,
        });
      }
    }
  }

  return params;
}

/** Get return-type text from a func/method declaration. */
function getReturnType(node: any): string {
  const result = node.childForFieldName("result");
  if (!result) return "";
  return result.text;
}

/** Build a Go-style signature ("func Foo(x int) error") without the body. */
function buildFuncSignature(node: any): string {
  const body = node.childForFieldName("body");
  if (body) {
    return node.text.slice(0, body.startIndex - node.startIndex).trim();
  }
  return node.text.trim();
}

/** Extract a single field_declaration into one or more PropertyInfo entries. */
function extractFields(structNode: any): PropertyInfo[] {
  const props: PropertyInfo[] = [];
  if (!structNode) return props;

  // struct_type → field_declaration_list → field_declaration
  const list = childOfType(structNode, "field_declaration_list");
  if (!list) return props;

  for (let i = 0; i < list.namedChildCount; i++) {
    const field = list.namedChild(i);
    if (!field || field.type !== "field_declaration") continue;

    const typeNode = field.childForFieldName("type");
    const typeText = typeNode ? typeNode.text : "unknown";

    // Collect field names (may be 0 for embedded fields).
    const nameNodes: any[] = [];
    for (let j = 0; j < field.childCount; j++) {
      const c = field.child(j);
      if (c?.type === "field_identifier") nameNodes.push(c);
    }

    const jsdoc = getDocComment(field);

    if (nameNodes.length === 0) {
      // Embedded field — use the type's text as the "name".
      props.push({
        name: typeText,
        type: typeText,
        isOptional: false,
        isReadonly: false,
        isStatic: false,
        visibility: isGoExported(typeText.replace(/^\*/, "").split(".").pop() ?? typeText) ? "public" : "private",
        jsdoc,
      });
    } else {
      for (const n of nameNodes) {
        const fieldName = n.text;
        props.push({
          name: fieldName,
          type: typeText,
          isOptional: false,
          isReadonly: false,
          isStatic: false,
          visibility: isGoExported(fieldName) ? "public" : "private",
          jsdoc,
        });
      }
    }
  }

  return props;
}

/** Convert a method_elem (inside interface_type) to MethodInfo. */
function extractInterfaceMethod(node: any): MethodInfo {
  const name = node.childForFieldName("name")?.text ?? "unknown";
  const params = extractParams(node.childForFieldName("parameters"));
  const result = node.childForFieldName("result");
  const returnType = result ? result.text : "";
  return {
    name,
    signature: node.text.trim(),
    returnType,
    params,
    isStatic: false,
    isAsync: false,
    isAbstract: true,
    visibility: isGoExported(name) ? "public" : "private",
    jsdoc: getDocComment(node),
  };
}

/** Resolve a method_declaration → MethodInfo, capturing receiver type. */
function extractMethodDecl(node: any): { receiverType: string; method: MethodInfo } {
  const name = node.childForFieldName("name")?.text ?? "unknown";
  const params = extractParams(node.childForFieldName("parameters"));
  const returnType = getReturnType(node);
  const signature = buildFuncSignature(node);

  // Receiver: parameter_list with one parameter_declaration whose type is the receiver type.
  let receiverType = "";
  const receiverList = node.childForFieldName("receiver");
  if (receiverList) {
    const decl = namedChildrenOfType(receiverList, "parameter_declaration")[0];
    if (decl) {
      const typeNode = decl.childForFieldName("type");
      if (typeNode) {
        // Strip leading `*` for pointer receivers.
        receiverType = typeNode.text.replace(/^\*/, "").trim();
      }
    }
  }

  return {
    receiverType,
    method: {
      name,
      signature,
      returnType,
      params,
      isStatic: false,
      isAsync: false,
      isAbstract: false,
      visibility: isGoExported(name) ? "public" : "private",
      jsdoc: getDocComment(node),
    },
  };
}

/** Extract a top-level function_declaration → FunctionInfo. */
function extractFunction(node: any): FunctionInfo {
  const name = node.childForFieldName("name")?.text ?? "unknown";
  const params = extractParams(node.childForFieldName("parameters"));
  const returnType = getReturnType(node);
  const typeParams = node.childForFieldName("type_parameters");

  return {
    name,
    signature: buildFuncSignature(node),
    params,
    returnType,
    isAsync: false,
    isGenerator: false,
    typeParameters: typeParams ? [typeParams.text] : [],
    jsdoc: getDocComment(node),
  };
}

/**
 * Convert a type_spec or type_alias → TypeInfo / ClassInfo-ish payload.
 *
 * Go has no classes. We model:
 *   - struct types → ClassInfo (so downstream rendering shows fields & methods)
 *   - interface types → TypeInfo with kind="interface"
 *   - other named types (aliases, slices, maps, function types) → TypeInfo with kind="type"
 */
function extractTypeSpec(
  spec: any,
  isAlias: boolean,
  parentDoc: string | undefined,
): { struct?: ClassInfo; type?: TypeInfo } {
  const name = spec.childForFieldName("name")?.text ?? "unknown";
  const typeNode = spec.childForFieldName("type");
  const typeParams = spec.childForFieldName("type_parameters");
  const jsdoc = parentDoc ?? getDocComment(spec);

  if (typeNode?.type === "struct_type") {
    return {
      struct: {
        name,
        extends: undefined,
        implements: [],
        methods: [],
        properties: extractFields(typeNode),
        isAbstract: false,
        typeParameters: typeParams ? [typeParams.text] : [],
        jsdoc,
      },
    };
  }

  if (typeNode?.type === "interface_type") {
    const methods: MethodInfo[] = [];
    const embedded: string[] = [];
    for (let i = 0; i < typeNode.namedChildCount; i++) {
      const member = typeNode.namedChild(i);
      if (!member) continue;
      if (member.type === "method_elem") {
        methods.push(extractInterfaceMethod(member));
      } else if (member.type === "type_elem") {
        embedded.push(member.text.trim());
      }
    }
    // Stash interface methods on TypeInfo.properties[].name pattern is awkward —
    // instead, we emit method names into `extends` style fallback so they
    // surface in renderers; but most renderers read TypeInfo.properties.
    // To keep parity with the existing TS renderer (which doesn't render
    // interface method-sets specially), expose methods through a synthetic
    // properties list — each method becomes a property whose `type` is the
    // signature. Callers needing detailed method info should use the
    // class-style path for struct receivers.
    const properties: PropertyInfo[] = methods.map((m) => ({
      name: m.name,
      type: m.signature.replace(/^[a-zA-Z_]\w*/, "").trim() || m.returnType || "func()",
      isOptional: false,
      isReadonly: false,
      isStatic: false,
      visibility: m.visibility,
      jsdoc: m.jsdoc,
    }));
    return {
      type: {
        name,
        kind: "interface",
        properties,
        extends: embedded,
        typeParameters: typeParams ? [typeParams.text] : [],
        jsdoc,
      },
    };
  }

  // Type alias or other named type — treat as a TypeInfo.
  return {
    type: {
      name,
      kind: "type",
      properties: [],
      extends: [],
      typeParameters: typeParams ? [typeParams.text] : [],
      typeExpression: typeNode?.text,
      jsdoc: isAlias ? jsdoc : jsdoc,
    },
  };
}

/** Extract import_spec → Import. Handles aliased and dot-imports. */
function extractImport(spec: any): Import | null {
  const pathNode = spec.childForFieldName("path");
  if (!pathNode) return null;
  const raw = pathNode.text;
  const source = raw.replace(/^["`]/, "").replace(/["`]$/, "");

  const nameNode = spec.childForFieldName("name");
  let alias: string | undefined;
  let isDot = false;
  let isBlank = false;
  if (nameNode) {
    if (nameNode.type === "dot") isDot = true;
    else if (nameNode.type === "blank_identifier") isBlank = true;
    else alias = nameNode.text;
  }

  // Go stdlib paths have no dot in the first segment (e.g. "fmt", "net/http").
  // Third-party paths look like domains: "github.com/...", "golang.org/x/...".
  // Local paths within the current module also look like domain paths but
  // share the module-path prefix — that's resolved later by the resolver.
  const firstSeg = source.split("/")[0] ?? "";
  const isStdlib = !firstSeg.includes(".");

  return {
    source,
    resolvedPath: null,
    namedImports: [],
    defaultImport: alias,
    // For dot-imports the package's exported names enter the file scope. We
    // don't enumerate them here — leave a marker in namespaceImport so
    // downstream code can spot it.
    namespaceImport: isDot ? "." : isBlank ? "_" : undefined,
    isExternal: isStdlib,
  };
}

/** Main parse entry point. */
function parseGo(source: string, _filePath: string): Omit<FileNode, "path" | "language"> {
  if (!parser) throw new Error("Go parser not initialized. Call registerGo() first.");
  if (goLang) parser.setLanguage(goLang);

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
  // No enums in Go (idiomatic enums are const blocks of iota) — leave empty.
  const enums: EnumInfo[] = [];
  const reExports: ReExport[] = [];

  // Pending methods, attached to their struct after the full sweep.
  const methodsByReceiver = new Map<string, MethodInfo[]>();
  let packageName: string | undefined;

  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i);
    if (!node) continue;

    switch (node.type) {
      case "package_clause": {
        const idNode = childOfType(node, "package_identifier") ?? node.namedChild(0);
        if (idNode) packageName = idNode.text;
        // Surface the package as an export so renderers / rankers can pick it up.
        if (packageName) {
          exports.push({
            name: packageName,
            kind: "namespace",
            signature: `package ${packageName}`,
            isDefault: false,
            jsdoc: getDocComment(node),
          });
        }
        break;
      }

      case "import_declaration": {
        // Body is either a single import_spec or an import_spec_list.
        const list = childOfType(node, "import_spec_list");
        if (list) {
          for (let j = 0; j < list.namedChildCount; j++) {
            const spec = list.namedChild(j);
            if (spec?.type === "import_spec") {
              const imp = extractImport(spec);
              if (imp) imports.push(imp);
            }
          }
        } else {
          const spec = childOfType(node, "import_spec");
          if (spec) {
            const imp = extractImport(spec);
            if (imp) imports.push(imp);
          }
        }
        break;
      }

      case "function_declaration": {
        const fn = extractFunction(node);
        functions.push(fn);
        if (isGoExported(fn.name)) {
          exports.push({
            name: fn.name,
            kind: "function",
            signature: fn.signature,
            isDefault: false,
            jsdoc: fn.jsdoc,
          });
        }
        break;
      }

      case "method_declaration": {
        const { receiverType, method } = extractMethodDecl(node);
        if (receiverType) {
          const bucket = methodsByReceiver.get(receiverType) ?? [];
          bucket.push(method);
          methodsByReceiver.set(receiverType, bucket);
        }
        if (isGoExported(method.name)) {
          exports.push({
            name: receiverType ? `${receiverType}.${method.name}` : method.name,
            kind: "function",
            signature: method.signature,
            isDefault: false,
            jsdoc: method.jsdoc,
          });
        }
        break;
      }

      case "type_declaration": {
        const declDoc = getDocComment(node);
        // type_declaration → one or more type_spec / type_alias
        for (let j = 0; j < node.namedChildCount; j++) {
          const spec = node.namedChild(j);
          if (!spec) continue;
          const isAlias = spec.type === "type_alias";
          if (spec.type !== "type_spec" && !isAlias) continue;

          const { struct, type } = extractTypeSpec(spec, isAlias, declDoc);
          const specName = spec.childForFieldName("name")?.text ?? "unknown";
          let kind: ExportKind = "type";
          let signature = `type ${specName}`;
          if (struct) {
            classes.push(struct);
            kind = "class";
            signature = `type ${struct.name} struct`;
          } else if (type) {
            types.push(type);
            kind = type.kind === "interface" ? "interface" : "type";
            signature = type.kind === "interface" ? `type ${type.name} interface` : `type ${type.name} ${type.typeExpression ?? ""}`.trim();
          }

          if (isGoExported(specName)) {
            exports.push({
              name: specName,
              kind,
              signature,
              isDefault: false,
              jsdoc: declDoc,
            });
          }
        }
        break;
      }

      case "var_declaration":
      case "const_declaration": {
        // Surface any exported top-level identifiers as `const` / `variable`.
        // var_spec / const_spec children carry the name(s) in identifier nodes.
        const kind: ExportKind = node.type === "const_declaration" ? "const" : "variable";
        for (let j = 0; j < node.namedChildCount; j++) {
          const spec = node.namedChild(j);
          if (!spec) continue;
          if (spec.type !== "var_spec" && spec.type !== "const_spec") continue;
          for (let k = 0; k < spec.childCount; k++) {
            const c = spec.child(k);
            if (c?.type !== "identifier") continue;
            const ident = c.text;
            if (!isGoExported(ident)) continue;
            exports.push({
              name: ident,
              kind,
              signature: spec.text.split("\n")[0]!.trim(),
              isDefault: false,
              jsdoc: getDocComment(node),
            });
          }
        }
        break;
      }
    }
  }

  // Attach methods to their struct (ClassInfo) so renderers show them.
  for (const cls of classes) {
    const ms = methodsByReceiver.get(cls.name);
    if (ms) cls.methods = ms;
  }

  return { exports, imports, classes, functions, types, enums, reExports };
}

/**
 * Register the Go language plugin. Must be called after initParser().
 */
export async function registerGo(): Promise<LanguagePlugin> {
  await initParser();
  if (!parser) parser = new Parser();

  goLang = await loadLanguage(
    require.resolve("tree-sitter-go/tree-sitter-go.wasm"),
  );
  parser.setLanguage(goLang);

  return {
    language: "go",
    extensions: [".go"],
    parseFile: parseGo,
  };
}
