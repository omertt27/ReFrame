import * as t from "@babel/types";

import { jsxChildren } from "../jsx-utils.js";

function isWhitespaceText(node: t.JSXElement["children"][number] | undefined): node is t.JSXText {
  return !!node && t.isJSXText(node) && node.value.trim() === "";
}

/** The start of an element's "chunk" — its raw index, or the whitespace-only
 * text node immediately before it, if any (the indentation that visually
 * belongs to it). Moving the whitespace along with the element is what keeps
 * a reorder's diff to the lines that actually moved. */
function chunkStart(children: t.JSXElement["children"], elementRawIndex: number): number {
  const prev = children[elementRawIndex - 1];
  return isWhitespaceText(prev) ? elementRawIndex - 1 : elementRawIndex;
}

/**
 * Moves a JSX element to a new index among its parent's element children
 * (indexed by element position, ignoring whitespace/text nodes when
 * counting), carrying its leading indentation along with it.
 *
 * `insertBefore` picks which side of `elements[toIndex]` the moved element
 * lands on. Omitted, it falls back to direction-of-travel (moving forward
 * lands after the target, backward lands before it) — the original
 * behavior, kept as the default so every existing caller is unaffected.
 * Passed explicitly, it lets a caller with real cursor position (e.g. which
 * half of the target the pointer is over during a drag) express "before" or
 * "after" directly instead of it being an accident of fromIndex/toIndex.
 */
export function moveChild(parent: t.JSXElement | t.JSXFragment, fromIndex: number, toIndex: number, insertBefore?: boolean): void {
  const elements = jsxChildren(parent.children);
  const moved = elements[fromIndex];
  if (!moved) {
    throw new Error(`No element child at index ${fromIndex}`);
  }
  if (toIndex < 0 || toIndex >= elements.length) {
    throw new Error(`Target index ${toIndex} is out of range (0-${elements.length - 1})`);
  }
  if (fromIndex === toIndex) return;

  const target = elements[toIndex]!;
  const movedRawIndex = parent.children.indexOf(moved);
  const movedChunkStart = chunkStart(parent.children, movedRawIndex);
  const chunk = parent.children.splice(movedChunkStart, movedRawIndex - movedChunkStart + 1);

  const targetRawIndex = parent.children.indexOf(target);
  const before = insertBefore !== undefined ? insertBefore : toIndex < fromIndex;
  const insertionIndex = before ? chunkStart(parent.children, targetRawIndex) : targetRawIndex + 1;

  parent.children.splice(insertionIndex, 0, ...chunk);
}
