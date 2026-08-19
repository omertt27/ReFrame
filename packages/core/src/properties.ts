import { replaceUtilityClass } from "./mutate/tailwind.js";
import type { StyleIR } from "./style-ir.js";
import { pxToSpacingToken, spacingTokenToPx } from "./tailwind-scale.js";

/**
 * A semantic property (e.g. "height") is deliberately kept decoupled from
 * any one styling backend: `prefix`/`conflictsWith` are how it's expressed
 * in Tailwind, `cssProperty` is how it's expressed inline. The Style IR
 * vision this implements: visual property -> semantic value -> whichever
 * source representation the element already uses (see mutate/style.ts,
 * mutate/tailwind.ts) — never rewritten into a *different* representation
 * than the one the author chose (see project memory
 * `reframe-real-world-stress-test` for why this matters against real code).
 *
 * `valueKind` splits properties into genuinely different value shapes, not
 * just different CSS properties — a "color" isn't a unit-converted
 * "dimension", it's a different kind of value entirely (a string, not a
 * number), read/written through its own pair of functions below
 * (readStyleObjectColor/writeStyleColor) rather than reusing the numeric
 * px path. See project memory `reframe-color-editing` for why this split
 * exists instead of a single generic value type threaded everywhere.
 */
export type PropertyValueKind = "dimension" | "color";

export interface PropertyDef {
  key: string;
  label: string;
  valueKind: PropertyValueKind;
  /** The exact Tailwind utility prefix, e.g. "h-" for height. Matched
   * literally so "p-" never matches "px-"/"py-"/"pt-"/etc — Tailwind's own
   * naming makes this safe (the character after the property letter is
   * always either "-" for the all-sides utility or another axis/side
   * letter). For a `valueKind: "color"` property this is DETECTION ONLY
   * (see findUtilityClass's callers in apps/dev/host.ts) — there is no
   * Tailwind color-scale reader/writer yet, so it's never used to actually
   * read or write a class, only to notice one is already there. */
  prefix?: string;
  /** Other prefixes that set an overlapping CSS property with different (or
   * higher, later-in-stylesheet) specificity — if any of these are already
   * present, writing this property would silently not apply as expected, so
   * it's refused rather than guessed. Dimension properties only. */
  conflictsWith?: string[];
  /** The CSS property name this maps to for the inline-style backend
   * (`style={{ [cssProperty]: ... }}`) — camelCase, matching JS object key
   * convention (e.g. "borderRadius", not "border-radius"). */
  cssProperty: string;
}

export const EDITABLE_PROPERTIES: PropertyDef[] = [
  { key: "height", label: "Height", valueKind: "dimension", prefix: "h-", cssProperty: "height" },
  { key: "width", label: "Width", valueKind: "dimension", prefix: "w-", cssProperty: "width" },
  {
    key: "padding",
    label: "Padding",
    valueKind: "dimension",
    prefix: "p-",
    conflictsWith: ["px-", "py-", "pt-", "pr-", "pb-", "pl-"],
    cssProperty: "padding",
  },
  { key: "textColor", label: "Text color", valueKind: "color", prefix: "text-", cssProperty: "color" },
  { key: "backgroundColor", label: "Background color", valueKind: "color", prefix: "bg-", cssProperty: "backgroundColor" },
  // Typography dimensions — no `prefix`, deliberately: Tailwind's own
  // utilities for these (font-bold, leading-relaxed, tracking-tight,
  // text-lg) are separate keyword-based scales, not the numeric spacing
  // scale h-/w-/p- map onto, so there is nothing for the Tailwind
  // reader/writer to target. Style-backend only for now — the same "detect,
  // don't guess" boundary color drew around Tailwind color utilities.
  // Structurally these are no different from height/width/padding on the
  // style side (readStyleObjectProperty/writeStyleProperty never assumed a
  // px unit — only the Tailwind path did), so they need zero new IR code.
  { key: "fontSize", label: "Font size", valueKind: "dimension", cssProperty: "fontSize" },
  { key: "fontWeight", label: "Font weight", valueKind: "dimension", cssProperty: "fontWeight" },
  { key: "lineHeight", label: "Line height", valueKind: "dimension", cssProperty: "lineHeight" },
  { key: "letterSpacing", label: "Letter spacing", valueKind: "dimension", cssProperty: "letterSpacing" },
];

function tokens(classList: string): string[] {
  return classList.split(/\s+/).filter(Boolean);
}

/** The exact-token match for a prefix (never a responsive/state variant —
 * "md:h-20" is deliberately not found by prefix "h-"). */
export function findUtilityClass(classList: string, prefix: string): string | null {
  return tokens(classList).find((t) => t.startsWith(prefix) && !t.includes(":")) ?? null;
}

export type PropertyReadResult =
  | { available: true; px: number | null } // px null: property prefix not present in this class list at all
  | { available: false; reason: string };

/** Dimension/Tailwind-only — `prop.prefix` is required at runtime here even
 * though it's typed optional on PropertyDef (color entries carry a prefix
 * for detection only, see the PropertyDef doc comment; calling this with
 * one would be a caller bug, not a real "not set" case, so it throws rather
 * than silently misreading). */
export function readProperty(classList: string, prop: PropertyDef): PropertyReadResult {
  if (!prop.prefix) throw new Error(`"${prop.key}" has no Tailwind prefix — readProperty is dimension-only`);
  if (prop.conflictsWith?.some((p) => tokens(classList).some((t) => t.startsWith(p)))) {
    return {
      available: false,
      reason: `already set via a more specific utility (${prop.conflictsWith.join("/")}) — editing "${prop.prefix}" here wouldn't reliably apply`,
    };
  }
  const match = findUtilityClass(classList, prop.prefix);
  if (!match) return { available: true, px: null };
  const px = spacingTokenToPx(match.slice(prop.prefix.length));
  return { available: true, px };
}

export type PropertyWriteResult = { ok: true; classList: string } | { ok: false; reason: string };

export function writeProperty(classList: string, prop: PropertyDef, px: number): PropertyWriteResult {
  const read = readProperty(classList, prop);
  if (!read.available) return { ok: false, reason: read.reason };

  const newClass = prop.prefix! + pxToSpacingToken(px);
  const existing = findUtilityClass(classList, prop.prefix!);
  const newClassList = existing
    ? replaceUtilityClass(classList, existing, newClass)
    : `${classList.trim()} ${newClass}`.trim();
  return { ok: true, classList: newClassList };
}

// --- Inline-style backend (style={{...}}) — the V0.2 counterpart to the
// Tailwind functions above. Kept as separate, focused primitives operating
// on a StyleIR rather than folded into readProperty/writeProperty, since
// which backend to prefer for a given element (it may have both a
// className and a style attribute) is an orchestration decision the caller
// makes, not something these pure functions decide for themselves. ---

export function readStyleObjectProperty(ir: StyleIR, prop: PropertyDef): PropertyReadResult {
  if (ir.kind === "unsupported") {
    return { available: false, reason: `style is unsupported, refusing to guess: ${ir.reason}` };
  }
  const found = ir.properties.get(prop.cssProperty);
  if (!found) return { available: true, px: null };
  if (found.kind === "unsupported") {
    return { available: false, reason: `"${prop.cssProperty}" is unsupported, refusing to guess: ${found.reason}` };
  }
  if (found.kind === "color") {
    return { available: false, reason: `"${prop.cssProperty}" is a color value ("${found.value}"), not a dimension` };
  }
  return { available: true, px: found.value };
}

export type PropertyReadColorResult = { available: true; value: string | null } | { available: false; reason: string };

/** The color counterpart to readStyleObjectProperty — see the StyleIR doc
 * comment for why hex/rgb/named/CSS-variable forms are all just "the raw
 * string" here rather than separately parsed sub-kinds. */
export function readStyleObjectColor(ir: StyleIR, prop: PropertyDef): PropertyReadColorResult {
  if (ir.kind === "unsupported") {
    return { available: false, reason: `style is unsupported, refusing to guess: ${ir.reason}` };
  }
  const found = ir.properties.get(prop.cssProperty);
  if (!found) return { available: true, value: null };
  if (found.kind === "unsupported") {
    return { available: false, reason: `"${prop.cssProperty}" is unsupported, refusing to guess: ${found.reason}` };
  }
  if (found.kind === "px") {
    return { available: false, reason: `"${prop.cssProperty}" is a dimension value (${found.value}), not a color` };
  }
  return { available: true, value: found.value };
}

// Writing a style property is exported directly from mutate/style.js
// (writeStyleProperty) rather than wrapped here — unlike the Tailwind path,
// it mutates the relevant AST node in place and has no new classList string
// for a caller to apply separately, so a PropertyWriteResult-shaped wrapper
// would just be a confusing no-op indirection.
