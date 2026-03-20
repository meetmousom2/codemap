/**
 * Core types for the codemap AST-based knowledge graph generator.
 */

/** Kind of an exported symbol */
export type ExportKind = "function" | "class" | "type" | "interface" | "const" | "enum" | "variable" | "namespace" | "re-export";

/** A single exported symbol from a file */
export interface Export {
  /** Symbol name */
  name: string;
  /** What kind of export */
  kind: ExportKind;
  /** Full TypeScript signature (e.g. "function foo(x: string): Promise<void>") */
  signature: string;
  /** JSDoc comment if present */
  jsdoc?: string;
  /** Whether this is a default export */
  isDefault: boolean;
}

/** A single import in a file */
export interface Import {
  /** Module specifier as written (e.g. "./utils", "@yuzu/platform/tupy") */
  source: string;
  /** Resolved file path relative to project root, null if external */
  resolvedPath: string | null;
  /** Named imports (e.g. ["foo", "bar"]) */
  namedImports: string[];
  /** Default import name, if any */
  defaultImport?: string;
  /** Namespace import name (import * as X), if any */
  namespaceImport?: string;
  /** Whether this is an external (npm) package import */
  isExternal: boolean;
}

/** Info about a class property */
export interface PropertyInfo {
  name: string;
  type: string;
  isOptional: boolean;
  isReadonly: boolean;
  isStatic: boolean;
  visibility: "public" | "protected" | "private";
  jsdoc?: string;
}

/** Info about a class or interface method */
export interface MethodInfo {
  name: string;
  signature: string;
  returnType: string;
  params: ParamInfo[];
  isStatic: boolean;
  isAsync: boolean;
  isAbstract: boolean;
  visibility: "public" | "protected" | "private";
  jsdoc?: string;
}

/** Info about a function parameter */
export interface ParamInfo {
  name: string;
  type: string;
  isOptional: boolean;
  isRest: boolean;
  defaultValue?: string;
}

/** Detailed class information */
export interface ClassInfo {
  name: string;
  extends?: string;
  implements: string[];
  methods: MethodInfo[];
  properties: PropertyInfo[];
  isAbstract: boolean;
  typeParameters: string[];
  jsdoc?: string;
}

/** Detailed function information */
export interface FunctionInfo {
  name: string;
  signature: string;
  params: ParamInfo[];
  returnType: string;
  isAsync: boolean;
  isGenerator: boolean;
  typeParameters: string[];
  jsdoc?: string;
}

/** Detailed type or interface information */
export interface TypeInfo {
  name: string;
  kind: "type" | "interface";
  properties: PropertyInfo[];
  extends: string[];
  typeParameters: string[];
  /** For type aliases, the full type expression */
  typeExpression?: string;
  jsdoc?: string;
}

/** Detailed enum information */
export interface EnumInfo {
  name: string;
  members: { name: string; value?: string }[];
  isConst: boolean;
  jsdoc?: string;
}

/** A barrel re-export (export * from './x' or export { a } from './x') */
export interface ReExport {
  source: string;
  resolvedPath: string | null;
  /** Specific named re-exports, empty means "export *" */
  names: string[];
  isNamespaceReExport: boolean;
}

/** Complete parsed information for a single file */
export interface FileNode {
  /** File path relative to project root */
  path: string;
  /** All exports from this file */
  exports: Export[];
  /** All imports in this file */
  imports: Import[];
  /** Detailed class information */
  classes: ClassInfo[];
  /** Detailed function information */
  functions: FunctionInfo[];
  /** Detailed type/interface information */
  types: TypeInfo[];
  /** Detailed enum information */
  enums: EnumInfo[];
  /** Barrel re-exports */
  reExports: ReExport[];
}

/** A directed edge in the dependency graph */
export interface Edge {
  /** Source file path (relative to root) */
  from: string;
  /** Target file path (relative to root) */
  to: string;
  /** Imported symbol names */
  importedNames: string[];
}

/** Module grouping (by directory) */
export interface ModuleInfo {
  /** Module name (directory name) */
  name: string;
  /** Directory path relative to root */
  path: string;
  /** Files in this module */
  files: string[];
  /** Auto-generated summary */
  summary?: string;
}

/** The complete code graph for a project */
export interface CodeGraph {
  /** Project root path */
  root: string;
  /** All parsed files */
  files: FileNode[];
  /** Dependency edges */
  edges: Edge[];
  /** Module groupings */
  modules: ModuleInfo[];
  /** Git commit hash at generation time */
  commitHash?: string;
  /** Generation timestamp */
  generatedAt: string;
}

/** CLI options parsed from command line arguments */
export interface CliOptions {
  /** Root path to analyze */
  path: string;
  /** Output file path */
  output: string;
  /** Include glob patterns */
  include: string[];
  /** Exclude glob patterns */
  exclude: string[];
  /** Check if codemap is stale */
  check: boolean;
  /** Install git post-merge hook */
  installHook: boolean;
}
