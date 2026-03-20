/**
 * Parser — language-agnostic AST extraction using tree-sitter.
 * Auto-detects language from file extension and delegates to language plugins.
 */

import { resolve } from "node:path";
import { Parser, Language } from "web-tree-sitter";
import type { FileNode, LanguagePlugin, Language as Lang } from "./types";

/** Registry of language plugins */
const plugins = new Map<string, LanguagePlugin>();

/** Cached tree-sitter Language instances */
const languageCache = new Map<string, Language>();

/** Whether Parser.init() has been called */
let initialized = false;

/** Map file extension to language */
const extensionToLanguage = new Map<string, Lang>();

/**
 * Register a language plugin.
 */
export function registerPlugin(plugin: LanguagePlugin): void {
  for (const ext of plugin.extensions) {
    plugins.set(ext, plugin);
    extensionToLanguage.set(ext, plugin.language);
  }
}

/**
 * Get the language for a file extension, or null if unsupported.
 */
export function detectLanguage(filePath: string): Lang | null {
  const ext = getExtension(filePath);
  return extensionToLanguage.get(ext) ?? null;
}

function getExtension(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot >= 0 ? filePath.slice(dot) : "";
}

/**
 * Initialize tree-sitter. Must be called once before parsing.
 */
export async function initParser(): Promise<void> {
  if (initialized) return;
  await Parser.init();
  initialized = true;
}

/**
 * Load a tree-sitter language WASM file.
 */
export async function loadLanguage(wasmPath: string): Promise<Language> {
  const cached = languageCache.get(wasmPath);
  if (cached) return cached;
  const lang = await Language.load(wasmPath);
  languageCache.set(wasmPath, lang);
  return lang;
}

/**
 * Parse a single source file and extract AST information.
 *
 * @param filePath - Absolute path to the file
 * @param relativePath - Path relative to project root
 * @returns FileNode with all extracted information, or null if language unsupported
 */
export async function parseFile(filePath: string, relativePath: string): Promise<FileNode | null> {
  await initParser();

  const ext = getExtension(filePath);
  const plugin = plugins.get(ext);
  if (!plugin) return null;

  const source = await Bun.file(filePath).text();
  const result = plugin.parseFile(source, filePath);

  return {
    path: relativePath,
    language: plugin.language,
    ...result,
  };
}

/**
 * Parse multiple files in batch. Skips unsupported languages.
 */
export async function parseFiles(
  rootPath: string,
  relativePaths: string[],
): Promise<FileNode[]> {
  await initParser();
  const absRoot = resolve(rootPath);
  const results: FileNode[] = [];

  for (const relPath of relativePaths) {
    const absPath = resolve(absRoot, relPath);
    const node = await parseFile(absPath, relPath);
    if (node) results.push(node);
  }

  return results;
}
