import * as t from "@babel/types";

import type { StyleIR } from "../style-ir.js";

export type StyleWriteResult = { ok: true } | { ok: false; reason: string };

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
    if (existing.form === "number") {
      (existing.node as t.NumericLiteral).value = px;
    } else {
      (existing.node as t.StringLiteral).value = `${px}px`;
    }
    return { ok: true };
  }

  ir.node.properties.push(t.objectProperty(t.identifier(cssProperty), t.numericLiteral(px)));
  return { ok: true };
}
