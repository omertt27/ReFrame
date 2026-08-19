import * as t from "@babel/types";

import { jsxChildren } from "../jsx-utils.js";

function isWhitespaceText(node: t.JSXElement["children"][number] | undefined): node is t.JSXText {
  return !!node && t.isJSXText(node) && node.value.trim() === "";
}

/** Same "chunk" convention move.ts/delete.ts use — the whitespace-only text
 * node immediately before an element (its indentation) travels with it. */
function chunkStart(children: t.JSXElement["children"], elementRawIndex: number): number {
  const prev = children[elementRawIndex - 1];
  return isWhitespaceText(prev) ? elementRawIndex - 1 : elementRawIndex;
}

/**
 * Duplicates one JSX element within its parent's children (indexed by
 * element position, ignoring whitespace/text nodes — the same index space
 * as removeElement/moveChild/resolveElementPath), inserting the clone
 * immediately after the original along with a copy of its leading
 * indentation.
 *
 * Clones with `withoutLoc: true` — recast tracks each node's original
 * source range by identity/loc to decide what it can reprint verbatim vs.
 * what it must regenerate; a clone that kept the original's loc would
 * point recast at the same source range for two different positions in
 * the tree. Stripping loc tells recast this is new code, so it prints the
 * clone fresh from its own printer instead of misapplying the original's
 * cached text to the wrong spot.
 */
export function duplicateElement(parent: t.JSXElement | t.JSXFragment, index: number): void {
  const elements = jsxChildren(parent.children);
  const target = elements[index];
  if (!target) {
    throw new Error(`No element child at index ${index}`);
  }
  const rawIndex = parent.children.indexOf(target);
  const start = chunkStart(parent.children, rawIndex);
  const chunk = parent.children.slice(start, rawIndex + 1);
  const clone = chunk.map((node) => t.cloneNode(node, true, true));
  parent.children.splice(rawIndex + 1, 0, ...clone);
}
