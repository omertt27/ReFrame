import * as t from "@babel/types";

export type TextIR = { kind: "text"; node: t.JSXText; value: string } | { kind: "unsupported"; reason: string };

/**
 * Whether an element's children reduce to exactly one plain, editable text
 * node — deliberately narrow, mirroring class-ir.ts/style-ir.ts's own
 * "recognized shape or explicit unsupported reason" discipline: a single
 * JSXText child, ignoring whitespace-only siblings, with no nested
 * JSXElement/JSXFragment and no `{expression}` interpolation alongside it.
 * Real, common shapes explicitly excluded on purpose: `Hello <em>world</em>`
 * (mixed text+markup), `{name}` (interpolation), `PDF &amp; Privacy{" "}<em>`
 * (both at once) — verified as real cases on PrivaPDF's glossary page during
 * this session's stress test. Never guessing which portion is "the text"
 * here avoids silently corrupting page structure.
 */
export function extractTextIR(element: t.JSXElement | t.JSXFragment): TextIR {
  const meaningful = element.children.filter((child) => {
    if (t.isJSXText(child)) return child.value.trim().length > 0;
    return true; // any non-text child (element/fragment/expression/spread) counts
  });

  if (meaningful.length === 0) {
    return { kind: "unsupported", reason: "no text content here" };
  }
  if (meaningful.length > 1) {
    return { kind: "unsupported", reason: "mixed content (multiple text/markup pieces) isn't supported yet" };
  }

  const only = meaningful[0]!;
  if (!t.isJSXText(only)) {
    return {
      kind: "unsupported",
      reason: t.isJSXExpressionContainer(only)
        ? "content is a dynamic expression ({...}), not plain text"
        : "content is markup, not plain text",
    };
  }

  return { kind: "text", node: only, value: only.value.trim() };
}
