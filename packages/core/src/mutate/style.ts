import * as t from "@babel/types";
import * as recast from "recast";

import { babelRecastParser } from "../parse.js";
import type { StyleIR } from "../style-ir.js";

export type StyleWriteResult = { ok: true } | { ok: false; reason: string };

/**
 * Adds a brand-new property to a style={{...}} object without forcing
 * recast to reprint the whole object multi-line.
 *
 * `node.properties.push(builderNode)` (the naive approach) mutates the
 * ObjectExpression's property list in place, but recast decides how to
 * print a node by comparing it against the `.original` it captured at
 * parse time — once the list's length differs from that original, it can
 * no longer reuse the source text verbatim and falls back to its
 * from-scratch printer, which (see recast/lib/printer.js's ObjectExpression
 * case) ALWAYS multi-lines a non-empty object. A compact `{ color: "...",
 * fontStyle: "italic" }` one-liner becomes 4+ lines to add a single
 * `padding: 12` — functionally correct, but far noisier than a hand-written
 * edit, and undercuts "would I confidently commit this diff" for what's
 * conceptually a one-line change. Verified live against the exact
 * reproduction from project memory (a `style={{ color, fontStyle }}` prop
 * on a real nested element).
 *
 * The fix: print the CURRENT object's existing text (recast reprints it
 * verbatim here — nothing's changed about it yet), splice the new
 * property's source into that text, and reparse the WHOLE result as one
 * snippet. The resulting node carries its own `.original` (from being
 * freshly parsed) that matches itself exactly, so recast's patcher reprints
 * it verbatim too — the object as a whole is treated as "this one small
 * subtree changed," not "everything about this list needs regenerating."
 * Swapping it in via `ir.container.expression` (rather than mutating
 * `ir.node` in place) is what actually matters here — recast's reprint
 * decision is keyed off the property list's structural identity, not the
 * containing node's object identity, so an in-place array replacement on
 * the same node would hit the exact same fallback.
 */
function appendObjectProperty(ir: Extract<StyleIR, { kind: "object" }>, propertySource: string): void {
  const currentText = recast.print(ir.node).code;
  // A trailing comma before the closing brace (common in multi-line object
  // literals, e.g. Prettier's default style) survived stripping the braces
  // — appending ", <newProp>" after it produced a double comma
  // ("...ink)",, padding: 8"), which is invalid syntax and made the
  // reparse below throw. Found live against a real multi-line style object
  // with a trailing comma; strip it the same way the braces themselves are.
  const inner = currentText
    .trim()
    .replace(/^\{/, "")
    .replace(/\}$/, "")
    .trim()
    .replace(/,\s*$/, "");
  const newText = inner.length > 0 ? `{ ${inner}, ${propertySource} }` : `{ ${propertySource} }`;
  // Parsed as the RHS of an assignment, not wrapped in `(...)` — a bare
  // `{...}` at statement position parses as a BlockStatement, but wrapping
  // parens instead would leave Babel's `extra.parenthesized` flag set on
  // the resulting ObjectExpression, which recast then dutifully reprints as
  // a real `({ ... })` in the final output (verified live: this was the
  // first thing that broke here — an extra pair of parens showed up around
  // the whole object, and the enclosing JSX return statement got needlessly
  // reformatted along with it).
  const parsed = recast.parse(`x = ${newText}`, { parser: babelRecastParser }) as t.File;
  const stmt = parsed.program.body[0];
  const expr = t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression) ? stmt.expression.right : null;
  if (!expr || !t.isObjectExpression(expr)) {
    throw new Error(`internal error: failed to reparse style object after appending "${propertySource}"`);
  }
  ir.container.expression = expr;
}

/**
 * Sets one CSS property's px value on a style={{...}} object, preserving
 * the author's existing number-vs-"Npx"-string convention for that property
 * if it's already set, or defaulting to a plain number (React's own idiom)
 * when adding a new property that wasn't there before.
 */
export function writeStyleProperty(ir: StyleIR, cssProperty: string, px: number): StyleWriteResult {
  if (ir.kind === "unsupported") {
    return { ok: false, reason: `style is unsupported, refusing to guess: ${ir.reason}` };
  }

  const existing = ir.properties.get(cssProperty);
  if (existing) {
    if (existing.kind === "unsupported") {
      return { ok: false, reason: `"${cssProperty}" is unsupported, refusing to guess: ${existing.reason}` };
    }
    if (existing.kind === "color") {
      return {
        ok: false,
        reason: `"${cssProperty}" is set to a non-numeric string ("${existing.value}"), not a plain px dimension`,
      };
    }
    if (existing.negated && px > 0) {
      return {
        ok: false,
        reason: `"${cssProperty}" is currently negative (a UnaryExpression, e.g. "-1.5") — flipping it positive isn't attempted here, edit the source directly`,
      };
    }
    if (existing.form === "number") {
      (existing.node as t.NumericLiteral).value = existing.negated ? Math.abs(px) : px;
    } else {
      // A negative "Npx" string ("-1.5px") is already just a StringLiteral
      // — no UnaryExpression involved, the sign is part of the string
      // content — so no equivalent guard is needed for this form.
      (existing.node as t.StringLiteral).value = `${px}px`;
    }
    return { ok: true };
  }

  appendObjectProperty(ir, `${cssProperty}: ${px}`);
  return { ok: true };
}

/**
 * The color counterpart to writeStyleProperty — sets the raw string as-is,
 * with no unit conversion or form disambiguation (see style-ir.ts's doc
 * comment). Preserves whatever form was already there simply by never
 * touching anything except the one string value: a `var(--accent)` stays a
 * plain string either way, so there's no separate "convert representation"
 * step needed the way the number-vs-"Npx"-string convention required for
 * dimensions.
 */
export function writeStyleColor(ir: StyleIR, cssProperty: string, value: string): StyleWriteResult {
  if (ir.kind === "unsupported") {
    return { ok: false, reason: `style is unsupported, refusing to guess: ${ir.reason}` };
  }

  const existing = ir.properties.get(cssProperty);
  if (existing) {
    if (existing.kind === "unsupported") {
      return { ok: false, reason: `"${cssProperty}" is unsupported, refusing to guess: ${existing.reason}` };
    }
    if (existing.kind === "px") {
      return { ok: false, reason: `"${cssProperty}" is a dimension value (${existing.value}), not a color` };
    }
    existing.node.value = value;
    return { ok: true };
  }

  appendObjectProperty(ir, `${cssProperty}: ${JSON.stringify(value)}`);
  return { ok: true };
}
