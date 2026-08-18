import * as t from "@babel/types";

/** A parent's JSX element children, indexed by position among elements only
 * (text/whitespace, expression containers, fragments-as-children ignored).
 * This is the canonical element-position index space shared by
 * pageSectionOrder, moveChild, and resolveElementPath — all three must
 * agree on what counts as "child index N" or their indices silently drift
 * apart. */
export function jsxChildren(children: t.JSXElement["children"]): t.JSXElement[] {
  return children.filter((c): c is t.JSXElement => t.isJSXElement(c));
}
