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

/**
 * The arrow/function-expression counterpart to findReturnedJsx — a
 * function's body is either a block (`{ return <jsx>; }`, searched the
 * same way) or, for an arrow function specifically, the JSX directly
 * (`() => <jsx>`, React's common implicit-return shorthand — verified as
 * real and common via a second real-world project, Excalidraw, where it
 * accounts for a meaningful share of components; see project memory
 * `reframe-second-project-comparison`).
 */
function findComponentJsx(body: t.BlockStatement | t.Expression): t.JSXElement | t.JSXFragment | null {
  if (t.isBlockStatement(body)) return findReturnedJsx(body);
  if (t.isJSXElement(body) || t.isJSXFragment(body)) return body;
  return null;
}

/** `forwardRef(...)` or `React.forwardRef(...)` — both verified as real via
 * Excalidraw (`export const FilledButton = forwardRef<...>(...)`,
 * `export const Island = React.forwardRef<...>(...)`). Generic type
 * arguments (`<HTMLButtonElement, Props>`) don't affect this — they're not
 * part of the callee expression at all. */
function isForwardRefCallee(callee: t.Expression | t.V8IntrinsicIdentifier): boolean {
  if (t.isIdentifier(callee)) return callee.name === "forwardRef";
  return t.isMemberExpression(callee) && t.isIdentifier(callee.object) && callee.object.name === "React" && t.isIdentifier(callee.property) && callee.property.name === "forwardRef";
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

  // Pass 1: component definitions — a capitalized name, function body
  // returning JSX, in any of React's common declaration shapes:
  // `function X() {}` (FunctionDeclaration); `const X = (...) => {}` /
  // `const X = function (...) {}` (an arrow/function expression assigned
  // to a const); or `const X = forwardRef((props, ref) => {...})` /
  // `const X = React.forwardRef<T, P>((props, ref) => {...})` (the same
  // arrow/function expression, one call deeper). The arrow/const shapes
  // were completely unrecognized before this — found and fixed via a
  // real-world comparison against a second project (Excalidraw) that uses
  // them almost exclusively; see project memory
  // `reframe-second-project-comparison` for how stark the gap was (68/68
  // FunctionDeclaration in PrivaPDF vs 68/86 arrow-const, 8/86 forwardRef,
  // in Excalidraw).
  function registerDefinition(name: string, filePath: string, rootElement: t.JSXElement | t.JSXFragment) {
    definitions.set(name, {
      name,
      filePath,
      rootElement,
      classAttr: extractClassAttr(rootElement),
      styleAttr: extractStyleAttr(rootElement),
      isDefaultExport: defaultExportByFile.get(filePath) === name,
    });
  }

  for (const [filePath, { ast }] of parsedFiles) {
    traverse(ast, {
      FunctionDeclaration(path) {
        const name = path.node.id?.name;
        if (!name || !/^[A-Z]/.test(name)) return;
        const rootElement = findReturnedJsx(path.node.body);
        if (!rootElement) return;
        registerDefinition(name, filePath, rootElement);
      },
      VariableDeclarator(path) {
        const id = path.node.id;
        if (!t.isIdentifier(id) || !/^[A-Z]/.test(id.name)) return;
        const init = path.node.init;
        if (!init) return;

        if (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) {
          const rootElement = findComponentJsx(init.body);
          if (rootElement) registerDefinition(id.name, filePath, rootElement);
          return;
        }

        if (t.isCallExpression(init) && isForwardRefCallee(init.callee)) {
          const inner = init.arguments[0];
          if (inner && (t.isArrowFunctionExpression(inner) || t.isFunctionExpression(inner))) {
            const rootElement = findComponentJsx(inner.body);
            if (rootElement) registerDefinition(id.name, filePath, rootElement);
          }
        }
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

        const props: Record<string, string | boolean> = {};
        for (const attr of path.node.openingElement.attributes) {
          if (!t.isJSXAttribute(attr) || !t.isJSXIdentifier(attr.name)) continue;
          if (attr.value === null) {
            props[attr.name.name] = true; // shorthand boolean attribute, e.g. <Button isActive />
          } else if (t.isStringLiteral(attr.value)) {
            props[attr.name.name] = attr.value.value;
          } else if (t.isJSXExpressionContainer(attr.value) && t.isBooleanLiteral(attr.value.expression)) {
            props[attr.name.name] = attr.value.expression.value;
          }
          // Any other expression (identifier, member expression, call, ...)
          // is left uncaptured — never guess a value we can't verify statically.
        }

        usages.push({ component: name, filePath, element: path.node, props });
      },
    });
  }

  return { definitions, usages, files: parsedFiles };
}
