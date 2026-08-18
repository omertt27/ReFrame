import * as babelParser from "@babel/parser";
import babelTraverseModule from "@babel/traverse";
import * as t from "@babel/types";
import * as recast from "recast";

// @babel/traverse is CJS; how its default export shows up differs between
// esbuild-transformed test runs and a plain Node ESM loader (used by the CLI).
const traverse = ((babelTraverseModule as unknown as { default?: typeof babelTraverseModule }).default ??
  babelTraverseModule) as typeof babelTraverseModule;

import { extractClassIR } from "./class-ir.js";
import type { ComponentDef, ComponentGraph, ParsedFile, UsageSite } from "./graph.js";
import { extractStyleIR } from "./style-ir.js";

/**
 * A parser adapter recast uses internally so it can track original
 * formatting per-node and later reprint only what changed (see write.ts).
 * `tokens: true` is required for recast's patch-based reprinting.
 */
const babelRecastParser = {
  parse(source: string) {
    return babelParser.parse(source, {
      sourceType: "module",
      tokens: true,
      plugins: ["jsx", "typescript"],
    });
  },
};

export function parseFile(source: string): t.File {
  return recast.parse(source, { parser: babelRecastParser }) as t.File;
}

function findReturnedJsx(body: t.BlockStatement): t.JSXElement | t.JSXFragment | null {
  for (const stmt of body.body) {
    if (t.isReturnStatement(stmt) && stmt.argument) {
      if (t.isJSXElement(stmt.argument) || t.isJSXFragment(stmt.argument)) {
        return stmt.argument;
      }
    }
  }
  return null;
}

function findAttr(root: t.JSXElement | t.JSXFragment, attrName: string): t.JSXAttribute | null {
  if (!t.isJSXElement(root)) return null; // fragments can't carry attributes
  return (
    root.openingElement.attributes.find(
      (a): a is t.JSXAttribute => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === attrName,
    ) ?? null
  );
}

/** Exported (not just used internally for ComponentDef.classAttr) so
 * resolveElementPath results — arbitrary nested elements, not just
 * component roots — can reuse the exact same extraction, keeping every
 * downstream mutation function generic over "root or nested" for free. */
export function extractClassAttr(root: t.JSXElement | t.JSXFragment) {
  const attr = findAttr(root, "className");
  if (!attr) return null;
  const ir = extractClassIR(attr);
  if (!ir) return null;
  return { attrNode: attr, ir };
}

export function extractStyleAttr(root: t.JSXElement | t.JSXFragment) {
  const attr = findAttr(root, "style");
  if (!attr) return null;
  const ir = extractStyleIR(attr);
  if (!ir) return null;
  return { attrNode: attr, ir };
}

export function buildComponentGraph(files: { filePath: string; source: string }[]): ComponentGraph {
  const definitions = new Map<string, ComponentDef>();
  const usages: UsageSite[] = [];
  const parsedFiles = new Map<string, ParsedFile>();

  for (const { filePath, source } of files) {
    parsedFiles.set(filePath, { ast: parseFile(source), source });
  }

  // Pass 0: which function each file's `export default` points to — real
  // page/layout files often also define local helper components in the
  // same file, and those aren't "the page" even though they're also a
  // capitalized top-level function returning JSX.
  const defaultExportByFile = new Map<string, string>();
  for (const [filePath, { ast }] of parsedFiles) {
    traverse(ast, {
      ExportDefaultDeclaration(path) {
        const decl = path.node.declaration;
        if (t.isFunctionDeclaration(decl) && decl.id) {
          defaultExportByFile.set(filePath, decl.id.name);
        } else if (t.isIdentifier(decl)) {
          defaultExportByFile.set(filePath, decl.name);
        }
      },
    });
  }

  // Pass 1: component definitions — top-level function declarations whose
  // name is capitalized and whose body returns JSX.
  for (const [filePath, { ast }] of parsedFiles) {
    traverse(ast, {
      FunctionDeclaration(path) {
        const name = path.node.id?.name;
        if (!name || !/^[A-Z]/.test(name)) return;
        const rootElement = findReturnedJsx(path.node.body);
        if (!rootElement) return;
        definitions.set(name, {
          name,
          filePath,
          rootElement,
          classAttr: extractClassAttr(rootElement),
          styleAttr: extractStyleAttr(rootElement),
          isDefaultExport: defaultExportByFile.get(filePath) === name,
        });
      },
    });
  }

  // Pass 2: usage sites — any JSX element whose tag matches a known
  // component name, anywhere in any file.
  for (const [filePath, { ast }] of parsedFiles) {
    traverse(ast, {
      JSXElement(path) {
        const openingName = path.node.openingElement.name;
        if (!t.isJSXIdentifier(openingName)) return;
        const name = openingName.name;
        if (!definitions.has(name)) return;

        const props: Record<string, string> = {};
        for (const attr of path.node.openingElement.attributes) {
          if (
            t.isJSXAttribute(attr) &&
            t.isJSXIdentifier(attr.name) &&
            t.isStringLiteral(attr.value)
          ) {
            props[attr.name.name] = attr.value.value;
          }
        }

        usages.push({ component: name, filePath, element: path.node, props });
      },
    });
  }

  return { definitions, usages, files: parsedFiles };
}
