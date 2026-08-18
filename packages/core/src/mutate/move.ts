import * as t from "@babel/types";

/** A parent's JSX element children, indexed by position among elements only (text/whitespace ignored). */
function jsxChildren(children: t.JSXElement["children"]): t.JSXElement[] {
  return children.filter((c): c is t.JSXElement => t.isJSXElement(c));
}

/**
 * Moves a JSX element to a new index among its parent's element children,
 * indexed by element position (whitespace/text nodes are skipped when
 * counting, but preserved in place otherwise — this is a reorder, not a
 * reformat).
 */
export function moveChild(parent: t.JSXElement | t.JSXFragment, fromIndex: number, toIndex: number): void {
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
  const rawFromIndex = parent.children.indexOf(moved);
  const movingForward = toIndex > fromIndex;

  parent.children.splice(rawFromIndex, 1);
  const targetIndexAfterRemoval = parent.children.indexOf(target);
  const insertionIndex = movingForward ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval;
  parent.children.splice(insertionIndex, 0, moved);
}
