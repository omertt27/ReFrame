import * as t from "@babel/types";

/**
 * The inline-style counterpart to class-ir.ts's ClassIR — same capability
 * boundary philosophy: a style value either matches a recognized shape, or
 * comes back "unsupported" with a specific reason, never guessed at.
 *
 * Recognized today:
 *   - a numeric literal (`height: 44`, React's px-by-default convention) or
 *     a plain "<number>px" string (`padding: "12px"`). The number-vs-string
 *     form is remembered per property so a write preserves whichever
 *     convention the author already used — see mutate/style.ts.
 *   - a NEGATED numeric literal (`letterSpacing: -1.5`) — verified against
 *     PrivaPDF's real AboutPage h1, which uses exactly this. JS has no
 *     negative-literal token: `-1.5` parses as a UnaryExpression("-")
 *     wrapping NumericLiteral(1.5), not a NumericLiteral with a negative
 *     `.value` — missing this meant every negative style number (a common
 *     shape for letter-spacing/margins) silently fell through to
 *     "unsupported" until this was tested against real negative values.
 *     `negated: true` marks this on the IR so a write can preserve the sign
 *     rather than guess whether flipping it was intended — see
 *     mutate/style.ts's guard.
 *   - any other plain string literal, generically treated as a "color"
 *     candidate — `color: "#3B82F6"`, `color: "var(--accent)"`,
 *     `color: "rebeccapurple"` are all structurally identical at the AST
 *     level (a StringLiteral), so there's nothing to disambiguate between
 *     hex/rgb/named/CSS-variable forms here; a write just replaces the
 *     string as-is, preserving whichever form was already there (never
 *     attempting to resolve what a CSS variable currently evaluates to —
 *     see project memory `reframe-style-ir` for why this was left
 *     unsupported originally, and `reframe` color-editing follow-up for why
 *     that's now safe to lift: nothing surfaces this as an editable color
 *     unless a PropertyDef explicitly asks for it by cssProperty name, so a
 *     stray non-color string value like `fontFamily: "var(--serif)"`
 *     extracted this way just sits unused in the map, same as before).
 *
 * Explicitly NOT supported (reported, not guessed):
 *   - a shorthand multi-value string (`padding: "12px 24px"`) — which of
 *     the two values does a single "Padding" control mean? Ambiguous
 *     without a real multi-value UI, not guessed at here (still refused:
 *     the px-string regex requires the ENTIRE string to be one length)
 *   - any computed/templated/non-literal expression
 */
export type StylePropertyIR =
  | { kind: "px"; value: number; form: "number" | "pxString"; node: t.NumericLiteral | t.StringLiteral; negated?: boolean }
  | { kind: "color"; value: string; node: t.StringLiteral }
  | { kind: "unsupported"; reason: string; node: t.Node };

export type StyleIR =
  | {
      kind: "object";
      properties: Map<string, StylePropertyIR>;
      node: t.ObjectExpression;
      /** The JSXExpressionContainer wrapping `node` (`style={<here>}`) — kept
       * alongside `node` so a write that ADDS a new property (as opposed to
       * changing an existing one in place) can swap in a freshly-reparsed
       * replacement object instead of pushing onto `node.properties`
       * in-place. See mutate/style.ts's `appendObjectProperty` for why: a
       * plain array push forces recast to fall back to its from-scratch
       * printer for the whole object (which always multi-lines it, even a
       * two-property one-liner), while a node swap built from a reparsed
       * snippet reprints as the clean one-line diff a hand-written edit
       * would produce. */
      container: t.JSXExpressionContainer;
      hasUnsupportedComputedKeys: boolean;
    }
  | { kind: "unsupported"; reason: string };

/** e.g. "12px 24px" or "10px 20px 10px 20px" — two or more independent
 * length-like tokens separated by whitespace. A color value never matches
 * this: a function call like "rgb(59, 130, 246)" has no whitespace-
 * separated segment that is itself a bare length, and named colors /
 * CSS-variable references have no internal whitespace at all. */
function looksLikeMultiValueShorthand(value: string): boolean {
  const segments = value.trim().split(/\s+/);
  const lengthLike = /^-?\d+(?:\.\d+)?(px|rem|em|%)$/;
  return segments.filter((s) => lengthLike.test(s)).length >= 2;
}

function extractStyleProperty(value: t.Expression, node: t.Node): StylePropertyIR {
  if (t.isNumericLiteral(value)) {
    return { kind: "px", value: value.value, form: "number", node: value };
  }
  if (t.isUnaryExpression(value) && value.operator === "-" && t.isNumericLiteral(value.argument)) {
    return { kind: "px", value: -value.argument.value, form: "number", node: value.argument, negated: true };
  }
  if (t.isStringLiteral(value)) {
    const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value.value);
    if (match) {
      return { kind: "px", value: Number(match[1]), form: "pxString", node: value };
    }
    if (looksLikeMultiValueShorthand(value.value)) {
      return {
        kind: "unsupported",
        reason: `value "${value.value}" looks like a multi-value shorthand (e.g. "12px 24px") — which value would a single control mean? not disambiguated in V0`,
        node,
      };
    }
    // Any other plain string — a color, most commonly ("#3B82F6",
    // "var(--accent)", "rebeccapurple") — nothing left to disambiguate
    // structurally; see the doc comment above for why this is safe.
    return { kind: "color", value: value.value, node: value };
  }
  return { kind: "unsupported", reason: "value isn't a numeric or plain string literal", node };
}

export function extractStyleIR(attr: t.JSXAttribute): StyleIR | null {
  const value = attr.value;
  if (!t.isJSXExpressionContainer(value)) return null;
  const expr = value.expression;
  if (!t.isObjectExpression(expr)) {
    return { kind: "unsupported", reason: "style value isn't a plain object literal" };
  }

  const properties = new Map<string, StylePropertyIR>();
  // Verified against a real, popular second project (Excalidraw's Card.tsx,
  // `style={{ ["--card-color" as any]: COLOR_MAP[color].base }}` — a
  // computed/bracket key, common for setting CSS custom properties
  // dynamically): a property whose key isn't a plain Identifier or
  // StringLiteral has no static name to record it under, so it was
  // previously just dropped from the map entirely — silently, not
  // "unsupported." No PropertyDef targets a custom CSS property today, so
  // this had no practical effect yet, but "silently missing" is worse than
  // "explicitly unsupported" per this project's own standing principle —
  // this flag lets a caller say "this style object has at least one
  // property ReFrame can't see" without needing a name to blame it on.
  let hasUnsupportedComputedKeys = false;
  for (const prop of expr.properties) {
    if (!t.isObjectProperty(prop)) continue; // skip spreads, methods — not addressable by name
    const keyName = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : null;
    if (!keyName) {
      hasUnsupportedComputedKeys = true;
      continue;
    }
    if (!t.isExpression(prop.value)) continue;
    properties.set(keyName, extractStyleProperty(prop.value, prop));
  }
  return { kind: "object", properties, node: expr, container: value, hasUnsupportedComputedKeys };
}
