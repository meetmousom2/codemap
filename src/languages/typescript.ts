/**
 * TypeScript/TSX language plugin for tree-sitter.
 * Extracts exports, imports, classes, functions, types, interfaces, enums, and re-exports.
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

let tsLang: Language | null = null;
let tsxLang: Language | null = null;
let parser: Parser | null = null;

async function ensureParser(ext: string): Promise<Parser> {
  await initParser();
  if (!parser) parser = new Parser();

  if (ext === ".tsx") {
    if (!tsxLang) {
      tsxLang = await loadLanguage(
        require.resolve("tree-sitter-typescript/tree-sitter-tsx.wasm"),
      );
    }
    parser.setLanguage(tsxLang);
  } else {
    if (!tsLang) {
      tsLang = await loadLanguage(
        require.resolve("tree-sitter-typescript/tree-sitter-typescript.wasm"),
      );
    }
    parser.setLanguage(tsLang);
  }

  return parser;
}

function getExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot) : "";
}

/** Get text of a child node by field name */
function childText(node: any, fieldName: string): string | undefined {
  const child = node.childForFieldName(fieldName);
  return child?.text;
}

/** Find all children of a specific type */
function childrenOfType(node: any, type: string): any[] {
  const results: any[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === type) results.push(child);
  }
  return results;
}

/** Find first child of a specific type */
function childOfType(node: any, type: string): any | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === type) return child;
  }
  return null;
}

/** Get the JSDoc comment preceding a node */
function getJsDoc(node: any): string | undefined {
  const prev = node.previousNamedSibling;
  if (prev?.type === "comment") {
    const text = prev.text;
    if (text.startsWith("/**")) {
      // Strip /** and */ and leading * from each line
      return text
        .replace(/^\/\*\*\s*/, "")
        .replace(/\s*\*\/$/, "")
        .replace(/^\s*\* ?/gm, "")
        .trim() || undefined;
    }
  }
  return undefined;
}

/** Extract parameter info from a formal_parameters node */
function extractParams(paramsNode: any): ParamInfo[] {
  if (!paramsNode) return [];
  const params: ParamInfo[] = [];

  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const param = paramsNode.namedChild(i);
    if (!param) continue;

    if (param.type === "required_parameter" || param.type === "optional_parameter") {
      const pattern = param.childForFieldName("pattern");
      const typeAnnotation = param.childForFieldName("type");
      const value = param.childForFieldName("value");

      params.push({
        name: pattern?.text ?? param.text,
        type: typeAnnotation ? typeAnnotation.text.replace(/^:\s*/, "") : "unknown",
        isOptional: param.type === "optional_parameter",
        isRest: false,
        defaultValue: value?.text,
      });
    } else if (param.type === "rest_parameter") {
      const pattern = param.childForFieldName("pattern");
      const typeAnnotation = param.childForFieldName("type");
      params.push({
        name: pattern?.text ?? param.text.replace("...", ""),
        type: typeAnnotation ? typeAnnotation.text.replace(/^:\s*/, "") : "unknown",
        isOptional: false,
        isRest: true,
      });
    }
  }

  return params;
}

/** Extract return type from a node with type_annotation child */
function getReturnType(node: any): string {
  const returnType = node.childForFieldName("return_type");
  if (returnType) return returnType.text.replace(/^:\s*/, "");
  return "void";
}

/** Check if a node has an export keyword */
function isExported(node: any): boolean {
  // Check if parent is export_statement
  const parent = node.parent;
  if (parent?.type === "export_statement") return true;
  // Check for `export` modifier
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === "export") return true;
  }
  return false;
}

/** Check if a node is a default export */
function isDefaultExport(node: any): boolean {
  const parent = node.parent;
  if (parent?.type === "export_statement") {
    for (let i = 0; i < parent.childCount; i++) {
      if (parent.child(i)?.type === "default") return true;
    }
  }
  return false;
}

/** Get visibility of a class member */
function getVisibility(node: any): "public" | "protected" | "private" {
  const accessModifier = childOfType(node, "accessibility_modifier");
  if (accessModifier) {
    const text = accessModifier.text;
    if (text === "private") return "private";
    if (text === "protected") return "protected";
  }
  return "public";
}

/** Extract class method info */
function extractMethod(node: any): MethodInfo {
  const name = childText(node, "name") ?? "unknown";
  const params = extractParams(node.childForFieldName("parameters"));
  const returnType = getReturnType(node);
  const isStatic = childOfType(node, "static") !== null;
  const isAsync = childOfType(node, "async") !== null;
  const isAbstract = node.type === "abstract_method_definition";

  // Build signature: strip body
  let signature = node.text;
  const bodyNode = node.childForFieldName("body");
  if (bodyNode) {
    signature = node.text.slice(0, bodyNode.startIndex - node.startIndex).trim();
  }

  return {
    name,
    signature,
    returnType,
    params,
    isStatic,
    isAsync,
    isAbstract,
    visibility: getVisibility(node),
    jsdoc: getJsDoc(node),
  };
}

/** Extract class property info */
function extractProperty(node: any): PropertyInfo {
  const name = childText(node, "name") ?? "unknown";
  const typeAnnotation = node.childForFieldName("type");
  const type = typeAnnotation ? typeAnnotation.text.replace(/^:\s*/, "") : "unknown";
  const isOptional = node.text.includes("?:");
  const isReadonly = childOfType(node, "readonly") !== null;
  const isStatic = childOfType(node, "static") !== null;

  return {
    name,
    type,
    isOptional,
    isReadonly,
    isStatic,
    visibility: getVisibility(node),
    jsdoc: getJsDoc(node),
  };
}

/** Extract class info */
function extractClassInfo(node: any): ClassInfo {
  const name = childText(node, "name") ?? "default";
  const body = node.childForFieldName("body");
  const heritage = childOfType(node, "class_heritage");

  let extendsClause: string | undefined;
  const implementsList: string[] = [];

  if (heritage) {
    const extendsChild = childOfType(heritage, "extends_clause");
    if (extendsChild) {
      // Get the value after "extends"
      const val = extendsChild.namedChild(0);
      extendsClause = val?.text;
    }
    const implementsChild = childOfType(heritage, "implements_clause");
    if (implementsChild) {
      for (let i = 0; i < implementsChild.namedChildCount; i++) {
        const impl = implementsChild.namedChild(i);
        if (impl) implementsList.push(impl.text);
      }
    }
  }

  const methods: MethodInfo[] = [];
  const properties: PropertyInfo[] = [];
  const isAbstract = node.type === "abstract_class_declaration";

  if (body) {
    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i);
      if (!member) continue;
      if (member.type === "method_definition" || member.type === "abstract_method_definition") {
        methods.push(extractMethod(member));
      } else if (member.type === "public_field_definition") {
        properties.push(extractProperty(member));
      }
    }
  }

  const typeParams = childOfType(node, "type_parameters");

  return {
    name,
    extends: extendsClause,
    implements: implementsList,
    methods,
    properties,
    isAbstract,
    typeParameters: typeParams ? [typeParams.text] : [],
    jsdoc: getJsDoc(node),
  };
}

/** Extract function info */
function extractFunctionInfo(node: any): FunctionInfo {
  const name = childText(node, "name") ?? "default";
  const params = extractParams(node.childForFieldName("parameters"));
  const returnType = getReturnType(node);
  const isAsync = childOfType(node, "async") !== null || node.text.startsWith("async ");
  const isGenerator = node.type === "generator_function_declaration";
  const typeParams = childOfType(node, "type_parameters");

  // Build signature without body
  let signature = node.text;
  const bodyNode = node.childForFieldName("body");
  if (bodyNode) {
    signature = node.text.slice(0, bodyNode.startIndex - node.startIndex).trim();
  }

  return {
    name,
    signature,
    params,
    returnType,
    isAsync,
    isGenerator,
    typeParameters: typeParams ? [typeParams.text] : [],
    jsdoc: getJsDoc(node),
  };
}

/** Extract interface info */
function extractInterfaceInfo(node: any): TypeInfo {
  const name = childText(node, "name") ?? "unknown";
  const body = node.childForFieldName("body");
  const typeParams = childOfType(node, "type_parameters");

  const properties: PropertyInfo[] = [];
  const extendsList: string[] = [];

  // Extract extends
  const extendsClause = childOfType(node, "extends_type_clause");
  if (extendsClause) {
    for (let i = 0; i < extendsClause.namedChildCount; i++) {
      const ext = extendsClause.namedChild(i);
      if (ext) extendsList.push(ext.text);
    }
  }

  // Extract properties
  if (body) {
    for (let i = 0; i < body.namedChildCount; i++) {
      const prop = body.namedChild(i);
      if (!prop) continue;
      if (prop.type === "property_signature") {
        const propName = childText(prop, "name") ?? "unknown";
        const typeAnnotation = prop.childForFieldName("type");
        properties.push({
          name: propName,
          type: typeAnnotation ? typeAnnotation.text.replace(/^:\s*/, "") : "unknown",
          isOptional: prop.text.includes("?:") || prop.text.includes("? :"),
          isReadonly: prop.text.includes("readonly "),
          isStatic: false,
          visibility: "public",
          jsdoc: getJsDoc(prop),
        });
      }
    }
  }

  return {
    name,
    kind: "interface",
    properties,
    extends: extendsList,
    typeParameters: typeParams ? [typeParams.text] : [],
    jsdoc: getJsDoc(node),
  };
}

/** Extract type alias info */
function extractTypeAliasInfo(node: any): TypeInfo {
  const name = childText(node, "name") ?? "unknown";
  const typeNode = node.childForFieldName("value");
  const typeParams = childOfType(node, "type_parameters");

  const properties: PropertyInfo[] = [];

  // If it's an object type, extract properties
  if (typeNode?.type === "object_type") {
    for (let i = 0; i < typeNode.namedChildCount; i++) {
      const prop = typeNode.namedChild(i);
      if (!prop) continue;
      if (prop.type === "property_signature") {
        const propName = childText(prop, "name") ?? "unknown";
        const typeAnnotation = prop.childForFieldName("type");
        properties.push({
          name: propName,
          type: typeAnnotation ? typeAnnotation.text.replace(/^:\s*/, "") : "unknown",
          isOptional: prop.text.includes("?:") || prop.text.includes("? :"),
          isReadonly: prop.text.includes("readonly "),
          isStatic: false,
          visibility: "public",
        });
      }
    }
  }

  return {
    name,
    kind: "type",
    properties,
    extends: [],
    typeParameters: typeParams ? [typeParams.text] : [],
    typeExpression: typeNode?.text,
    jsdoc: getJsDoc(node),
  };
}

/** Extract enum info */
function extractEnumInfo(node: any): EnumInfo {
  const name = childText(node, "name") ?? "unknown";
  const body = node.childForFieldName("body");
  const isConst = node.text.startsWith("const enum") || node.text.startsWith("export const enum");

  const members: { name: string; value?: string }[] = [];
  if (body) {
    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i);
      if (member?.type === "enum_member" || member?.type === "property_identifier") {
        const memberName = childText(member, "name") ?? member.text;
        const value = childText(member, "value");
        members.push({ name: memberName, value });
      }
    }
  }

  return {
    name,
    members,
    isConst,
    jsdoc: getJsDoc(node),
  };
}

/** Get the kind and name of a declaration node */
function getExportInfo(node: any): { name: string; kind: ExportKind; signature: string } | null {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration": {
      const name = childText(node, "name") ?? "default";
      const body = node.childForFieldName("body");
      let sig = node.text;
      if (body) sig = node.text.slice(0, body.startIndex - node.startIndex).trim();
      return { name, kind: "function", signature: sig };
    }
    case "class_declaration":
    case "abstract_class_declaration": {
      const name = childText(node, "name") ?? "default";
      let sig = `class ${name}`;
      const heritage = childOfType(node, "class_heritage");
      if (heritage) sig += ` ${heritage.text}`;
      return { name, kind: "class", signature: sig };
    }
    case "interface_declaration": {
      const name = childText(node, "name") ?? "unknown";
      return { name, kind: "interface", signature: `interface ${name}` };
    }
    case "type_alias_declaration": {
      const name = childText(node, "name") ?? "unknown";
      return { name, kind: "type", signature: node.text };
    }
    case "enum_declaration": {
      const name = childText(node, "name") ?? "unknown";
      return { name, kind: "enum", signature: `enum ${name}` };
    }
    case "lexical_declaration": {
      // const/let declarations
      const declarator = node.namedChild(0);
      if (declarator?.type === "variable_declarator") {
        const name = childText(declarator, "name") ?? "unknown";
        const typeAnnotation = declarator.childForFieldName("type");
        const value = declarator.childForFieldName("value");
        let sig = `const ${name}`;
        if (typeAnnotation) sig += typeAnnotation.text;
        else if (value) {
          const valText = value.text;
          sig += ` = ${valText.length > 80 ? valText.slice(0, 77) + "..." : valText}`;
        }
        return { name, kind: "const", signature: sig };
      }
      return null;
    }
    default:
      return null;
  }
}

/** Main parse function for TypeScript */
function parseTypeScript(source: string, filePath: string): Omit<FileNode, "path" | "language"> {
  // Parser must be set up synchronously — we lazy-init in register
  if (!parser) throw new Error("TypeScript parser not initialized. Call registerTypescript() first.");

  const ext = getExtension(filePath);
  if (ext === ".tsx" && tsxLang) parser.setLanguage(tsxLang);
  else if (tsLang) parser.setLanguage(tsLang);

  const tree = parser.parse(source);
  if (!tree) return { exports: [], imports: [], classes: [], functions: [], types: [], enums: [], reExports: [] };
  const root = tree.rootNode;

  const exports: Export[] = [];
  const imports: Import[] = [];
  const classes: ClassInfo[] = [];
  const functions: FunctionInfo[] = [];
  const types: TypeInfo[] = [];
  const enums: EnumInfo[] = [];
  const reExports: ReExport[] = [];

  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i);
    if (!node) continue;

    switch (node.type) {
      case "export_statement": {
        const declaration = node.childForFieldName("declaration");
        if (declaration) {
          const info = getExportInfo(declaration);
          if (info) {
            const isDefault = node.text.includes("export default ");
            exports.push({
              name: isDefault ? "default" : info.name,
              kind: info.kind,
              signature: info.signature,
              jsdoc: getJsDoc(node),
              isDefault,
            });

            // Also extract detailed info
            if (declaration.type === "class_declaration" || declaration.type === "abstract_class_declaration") classes.push(extractClassInfo(declaration));
            if (declaration.type === "function_declaration" || declaration.type === "generator_function_declaration") functions.push(extractFunctionInfo(declaration));
            if (declaration.type === "interface_declaration") types.push(extractInterfaceInfo(declaration));
            if (declaration.type === "type_alias_declaration") types.push(extractTypeAliasInfo(declaration));
            if (declaration.type === "enum_declaration") enums.push(extractEnumInfo(declaration));
          }
        }

        // Handle export { x, y } from './module'
        const exportClause = childOfType(node, "export_clause");
        const sourceNode = node.childForFieldName("source");

        if (exportClause && sourceNode) {
          // Named re-export: export { X } from './module'
          const names: string[] = [];
          for (let j = 0; j < exportClause.namedChildCount; j++) {
            const spec = exportClause.namedChild(j);
            if (spec?.type === "export_specifier") {
              const name = childText(spec, "name") ?? spec.text;
              names.push(name);
            }
          }
          reExports.push({
            source: sourceNode.text.replace(/['"]/g, ""),
            resolvedPath: null,
            names,
            isNamespaceReExport: false,
          });
        } else if (exportClause && !sourceNode) {
          // export { x, y } — re-export from local scope
          for (let j = 0; j < exportClause.namedChildCount; j++) {
            const spec = exportClause.namedChild(j);
            if (spec?.type === "export_specifier") {
              const name = childText(spec, "name") ?? spec.text;
              exports.push({
                name,
                kind: "variable",
                signature: name,
                isDefault: false,
              });
            }
          }
        }

        // Handle export * from './module'
        if (!declaration && !exportClause && sourceNode) {
          // Namespace re-export
          const namespaceExport = childOfType(node, "namespace_export");
          reExports.push({
            source: sourceNode.text.replace(/['"]/g, ""),
            resolvedPath: null,
            names: [],
            isNamespaceReExport: true,
          });
        }
        break;
      }

      case "import_statement": {
        const sourceNode = node.childForFieldName("source");
        if (!sourceNode) break;

        const moduleSpecifier = sourceNode.text.replace(/['"]/g, "");
        const isExternal = !moduleSpecifier.startsWith(".") && !moduleSpecifier.startsWith("/");

        const namedImports: string[] = [];
        let defaultImport: string | undefined;
        let namespaceImport: string | undefined;

        // import x from './y'
        const importClause = childOfType(node, "import_clause");
        if (importClause) {
          for (let j = 0; j < importClause.childCount; j++) {
            const child = importClause.child(j);
            if (!child) continue;
            if (child.type === "identifier") {
              defaultImport = child.text;
            } else if (child.type === "named_imports") {
              for (let k = 0; k < child.namedChildCount; k++) {
                const spec = child.namedChild(k);
                if (spec?.type === "import_specifier") {
                  const name = childText(spec, "name") ?? spec.text;
                  namedImports.push(name);
                }
              }
            } else if (child.type === "namespace_import") {
              namespaceImport = child.namedChild(0)?.text;
            }
          }
        }

        imports.push({
          source: moduleSpecifier,
          resolvedPath: null,
          namedImports,
          defaultImport,
          namespaceImport,
          isExternal,
        });
        break;
      }

      // Non-exported declarations — still extract for class/function detail
      case "class_declaration":
    case "abstract_class_declaration":
        classes.push(extractClassInfo(node));
        break;
      case "function_declaration":
      case "generator_function_declaration":
        functions.push(extractFunctionInfo(node));
        break;
      case "interface_declaration":
        types.push(extractInterfaceInfo(node));
        break;
      case "type_alias_declaration":
        types.push(extractTypeAliasInfo(node));
        break;
      case "enum_declaration":
        enums.push(extractEnumInfo(node));
        break;
    }
  }

  return { exports, imports, classes, functions, types, enums, reExports };
}

/**
 * Register the TypeScript/TSX language plugin.
 * Must be called after initParser().
 */
export async function registerTypescript(): Promise<LanguagePlugin> {
  await initParser();
  if (!parser) parser = new Parser();

  tsLang = await loadLanguage(
    require.resolve("tree-sitter-typescript/tree-sitter-typescript.wasm"),
  );
  tsxLang = await loadLanguage(
    require.resolve("tree-sitter-typescript/tree-sitter-tsx.wasm"),
  );
  parser.setLanguage(tsLang);

  const plugin: LanguagePlugin = {
    language: "typescript",
    extensions: [".ts", ".tsx"],
    parseFile: parseTypeScript,
  };

  return plugin;
}
