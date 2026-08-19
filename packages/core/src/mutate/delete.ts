import * as t from "@babel/types";

import { jsxChildren } from "../jsx-utils.js";

function isWhitespaceText(node: t.JSXElement["children"][number] | undefined): node is t.JSXText {
  return !!node && t.isJSXText(node) && node.value.trim() === "";
}

/** Same "chunk" convention move.ts's moveChild uses — the whitespace-only
 * text node immediately before an element (its indentation) is treated as
 * belonging to it, so removing the element doesn't leave a dangling blank
 * line the diff has to show as noise. */
function chunkStart(children: t.JSXElement["children"], elementRawIndex: number): number {
  const prev = children[elementRawIndex - 1];
  return isWhitespaceText(prev) ? elementRawIndex - 1 : elementRawIndex;
}

/**
 * Removes one JSX element from its parent's children, indexed by element
 * position (ignoring whitespace/text nodes when counting — the same index
 * space as pageSectionOrder/moveChild/resolveElementPath), along with its
 * leading indentation.
 */
export function removeElement(parent: t.JSXElement | t.JSXFragment, index: number): void {
  const elements = jsxChildren(parent.children);
  const target = elements[index];
  if (!target) {
    throw new Error(`No element child at index ${index}`);
  }
  const rawIndex = parent.children.indexOf(target);
  const start = chunkStart(parent.children, rawIndex);
  parent.children.splice(start, rawIndex - start + 1);
}
