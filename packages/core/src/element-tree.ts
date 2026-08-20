import * as t from "@babel/types";

import type { ComponentGraph } from "./graph.js";
import { jsxChildren } from "./jsx-utils.js";
import { extractTextIR } from "./text-ir.js";

/** One row in a component's "meaningful children" tree — see buildElementTree. */
export interface ElementTreeNode {
  path: number[];
  tag: string;
  isComponent: boolean;
  isTextLeaf: boolean;
  children: ElementTreeNode[];
}

/** Host tags kept as their own row even when they're a pass-through wrapper's
 * only child — these carry distinct visual/functional identity, so
 * collapsing them into their parent would hide something meaningful. */
const NEVER_COLLAPSE_TAGS = new Set(["img", "button", "a", "input", "select", "textarea", "svg", "video", "iframe"]);

function tagName(node: t.JSXElement): string | null {
  const name = node.openingElement.name;
  return t.isJSXIdentifier(name) ? name.name : null;
}

/**
 * Walks a component's rendered children looking for the ones a non-developer
 * would actually think of as "things on the page" — collapsing plain
 * structural wrappers (a `<div>`/`<section>` that exists purely to hold one
 * other element) so `<section><div><h1/><p/><button/></div></section>` reads
 * as three sibling rows, not a four-level chain. This is a structural rule
 * (child count + a small fixed tag set below), not a guess about visual
 * intent — the `path` on every returned node is still the exact real
 * ElementPath, so collapsing display never changes what a click on it edits.
 *
 * A node whose tag matches a known component in `graph` is shown as its own
 * leaf row and never expanded — its internals belong to its own definition,
 * the same boundary pageSectionOrder/resolveComponentAtRoute already respect.
 */
export function buildElementTree(
  parent: t.JSXElement | t.JSXFragment,
  graph: ComponentGraph,
  path: number[] = [],
): ElementTreeNode[] {
  const kids = jsxChildren(parent.children);
  const result: ElementTreeNode[] = [];

  kids.forEach((child, i) => {
    const childPath = [...path, i];
    const tag = tagName(child);
    const isComponent = tag !== null && graph.definitions.has(tag);
    const textIR = extractTextIR(child);
    const isTextLeaf = textIR.kind === "text";
    const childKids = jsxChildren(child.children);

    const isPassThroughWrapper =
      !isComponent && !isTextLeaf && tag !== null && !NEVER_COLLAPSE_TAGS.has(tag) && childKids.length === 1;

    if (isPassThroughWrapper) {
      result.push(...buildElementTree(child, graph, childPath));
      return;
    }

    result.push({
      path: childPath,
      tag: tag ?? "Fragment",
      isComponent,
      isTextLeaf,
      children: isComponent ? [] : buildElementTree(child, graph, childPath),
    });
  });

  return result;
}
