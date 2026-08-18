import * as t from "@babel/types";

/**
 * The inline-style counterpart to class-ir.ts's ClassIR — same capability
 * boundary philosophy: a style value either matches a recognized shape, or
 * comes back "unsupported" with a specific reason, never guessed at.
 *
 * Recognized today: a numeric literal (`height: 44`, React's px-by-default
 * convention) or a plain "<number>px" string (`padding: "12px"`). The
 * number-vs-string form is remembered per property so a write preserves
 * whichever convention the author already used — see mutate/style.ts.
 *
 * Explicitly NOT supported (reported, not guessed):
 *   - a CSS custom property reference (`color: "var(--accent)"`) — this is
 *     exactly PrivaPDF's SectionHeader pattern found in the real-world
 *     stress test; editing it would mean resolving what the variable
 *     currently evaluates to, which V0 doesn't attempt
 *   - a shorthand multi-value string (`padding: "12px 24px"`) — which of
 *     the two values does a single "Padding" control mean? Ambiguous
 *     without a real multi-value UI, not guessed at here
 *   - any computed/templated/non-literal expression
 */
export type StylePropertyIR =
  | { kind: "px"; value: number; form: "number" | "pxString"; node: t.NumericLiteral | t.StringLiteral }
  | { kind: "unsupported"; reason: string; node: t.Node };

export type StyleIR =
  | { kind: "object"; properties: Map<string, StylePropertyIR>; node: t.ObjectExpression }
  | { kind: "unsupported"; reason: string };

function extractStyleProperty(value: t.Expression, node: t.Node): StylePropertyIR {
  if (t.isNumericLiteral(value)) {
    return { kind: "px", value: value.value, form: "number", node: value };
  }
  if (t.isStringLiteral(value)) {
    const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value.value);
    if (match) {
      return { kind: "px", value: Number(match[1]), form: "pxString", node: value };
    }
    return {
      kind: "unsupported",
      reason: `value "${value.value}" isn't a plain px length — likely a CSS variable reference or shorthand (multiple values), not traced/disambiguated in V0`,
      node,
    };
  }
  return { kind: "unsupported", reason: "value isn't a numeric or plain px-string literal", node };
}

export function extractStyleIR(attr: t.JSXAttribute): StyleIR | null {
  const value = attr.value;
  if (!t.isJSXExpressionContainer(value)) return null;
  const expr = value.expression;
  if (!t.isObjectExpression(expr)) {
    return { kind: "unsupported", reason: "style value isn't a plain object literal" };
  }

  const properties = new Map<string, StylePropertyIR>();
  for (const prop of expr.properties) {
    if (!t.isObjectProperty(prop)) continue; // skip spreads, methods — not addressable by name
    const keyName = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : null;
    if (!keyName) continue;
    if (!t.isExpression(prop.value)) continue;
    properties.set(keyName, extractStyleProperty(prop.value, prop));
  }
  return { kind: "object", properties, node: expr };
}
