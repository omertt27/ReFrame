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
 * "text" (e.g. fontFamily) shares that exact same string read/write path —
 * a free-form string is a free-form string — it's kept as a separate kind
 * from "color" purely so the CALLER (apps/dev/host.ts's UI dispatch) can
 * tell a swatch-worthy value apart from one that needs a font picker.
 */
export type PropertyValueKind = "dimension" | "color" | "text";

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
  // Same style-only boundary as color — no Tailwind font-family utility
  // writer exists (Tailwind's font-* utilities reference a theme config
  // ReFrame doesn't parse), so this is style-backend only, same shape as
  // color (a free-form string), just a different UI treatment.
  { key: "fontFamily", label: "Font family", valueKind: "text", cssProperty: "fontFamily" },
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

// --- Responsive (breakpoint-aware) Tailwind reading/writing — additive,
// never replacing readProperty/writeProperty above (those stay exactly
// "the base/unprefixed utility only," unchanged, still what every existing
// caller and test gets). These are for a device-tier-aware caller (see
// apps/dev/host.ts's viewport wiring) that needs EITHER "what's actually
// governing this element at a given device width" (read) OR "create/modify
// exactly this device tier's own override, nothing else" (write) — two
// different, deliberately non-symmetric operations, see each function's
// own comment for why. ---

export type ViewportTier = "mobile" | "tablet" | "desktop";

/** Tailwind's real breakpoints (min-width, px) — used only to compute which
 * ALREADY-PRESENT prefixed utility governs a given reference width under
 * Tailwind's mobile-first cascade (a breakpoint's utility applies at its
 * own width AND every larger width, until a still-larger breakpoint
 * overrides it again). Never used to invent a breakpoint that isn't there. */
const BREAKPOINTS: { prefix: string; minWidth: number }[] = [
  { prefix: "sm", minWidth: 640 },
  { prefix: "md", minWidth: 768 },
  { prefix: "lg", minWidth: 1024 },
  { prefix: "xl", minWidth: 1280 },
  { prefix: "2xl", minWidth: 1536 },
];

/** The reference width used to compute a tier's CASCADED read value —
 * matches the device-preview widths the canvas actually renders at (see
 * host.html's VIEWPORT_WIDTHS), so "what ReFrame shows as current" always
 * matches "what's actually on screen" at that tier. */
export const TIER_VIEWPORT_WIDTH: Record<ViewportTier, number> = { mobile: 390, tablet: 768, desktop: 1440 };

/** The ONE breakpoint prefix a WRITE at a given tier always targets — a
 * direct mapping, never a cascade search. Per the exact rule this
 * implements: editing "mobile" always means the base/unprefixed utility
 * (Tailwind is mobile-first — there's no "mobile:" prefix, the base value
 * IS the mobile value); editing "tablet" or "desktop" always means
 * creating or modifying exactly that tier's own prefix, regardless of
 * which OTHER breakpoint happens to currently govern that width — asking
 * "which of several already-present breakpoints did the user really mean"
 * would be guessing, and the explicit tier selection already answers it. */
const TIER_WRITE_PREFIX: Record<ViewportTier, string | null> = { mobile: null, tablet: "md", desktop: "lg" };

function findUtilityClassAt(classList: string, prefix: string, breakpointPrefix: string | null): string | null {
  if (breakpointPrefix === null) return findUtilityClass(classList, prefix);
  const want = `${breakpointPrefix}:${prefix}`;
  return tokens(classList).find((t) => t.startsWith(want) && !t.slice(want.length).includes(":")) ?? null;
}

/** Breakpoint prefixes applicable at a tier's reference width, largest
 * (most specific) first, as the search order for "what's actually
 * governing this element right now" — e.g. at the desktop reference width
 * (1440px, inside the xl range), a bare `lg:` override still applies if no
 * `xl:` one exists, exactly like the real browser cascade. */
function cascadeOrderForTier(tier: ViewportTier): string[] {
  const width = TIER_VIEWPORT_WIDTH[tier];
  return BREAKPOINTS.filter((b) => b.minWidth <= width)
    .map((b) => b.prefix)
    .reverse();
}

/** The effective value at a device tier — walks the real cascade (largest
 * applicable breakpoint override first, falling back to the base value) —
 * this is deliberately NOT the same lookup writeResponsiveProperty uses;
 * see that function's own comment for why reading and writing ask
 * genuinely different questions. */
export function readResponsiveProperty(classList: string, prop: PropertyDef, tier: ViewportTier): PropertyReadResult {
  if (!prop.prefix) throw new Error(`"${prop.key}" has no Tailwind prefix — readResponsiveProperty is dimension-only`);
  if (prop.conflictsWith?.some((p) => tokens(classList).some((t) => t.startsWith(p) && !t.includes(":")))) {
    return {
      available: false,
      reason: `already set via a more specific utility (${prop.conflictsWith.join("/")}) — editing "${prop.prefix}" here wouldn't reliably apply`,
    };
  }
  for (const bp of cascadeOrderForTier(tier)) {
    const match = findUtilityClassAt(classList, prop.prefix, bp);
    if (match) return { available: true, px: spacingTokenToPx(match.slice(`${bp}:${prop.prefix}`.length)) };
  }
  const base = findUtilityClass(classList, prop.prefix);
  if (!base) return { available: true, px: null };
  return { available: true, px: spacingTokenToPx(base.slice(prop.prefix.length)) };
}

/** Writes exactly the given tier's own breakpoint override — creating it if
 * absent, modifying it in place if present — and never touches any other
 * breakpoint already on the element. Editing "mobile" when
 * `text-6xl md:text-5xl` already exists modifies `text-6xl` (the base) and
 * leaves `md:text-5xl` completely untouched, exactly matching what a real
 * Tailwind mobile-first page needs: the base value already IS the mobile
 * value, there's nothing to create. Editing "tablet" there modifies
 * `md:text-5xl` directly, not "figure out which breakpoint currently wins
 * at 768px" — that ambiguity is exactly what an explicit tier selection is
 * for resolving. `conflictsWith` is checked at the base level only (a
 * known, documented V0 limitation — a responsive-prefixed conflicting
 * utility, e.g. `md:px-4` fighting a `md:p-6` write, isn't caught). */
export function writeResponsiveProperty(
  classList: string,
  prop: PropertyDef,
  px: number,
  tier: ViewportTier,
): PropertyWriteResult {
  if (prop.conflictsWith?.some((p) => tokens(classList).some((t) => t.startsWith(p) && !t.includes(":")))) {
    return {
      ok: false,
      reason: `already set via a more specific utility (${prop.conflictsWith.join("/")}) — editing "${prop.prefix}" here wouldn't reliably apply`,
    };
  }
  const bp = TIER_WRITE_PREFIX[tier];
  const newClass = (bp ? `${bp}:` : "") + prop.prefix! + pxToSpacingToken(px);
  const existing = findUtilityClassAt(classList, prop.prefix!, bp);
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
    return {
      available: false,
      reason: `"${prop.cssProperty}" is set to a non-numeric string ("${found.value}"), not a plain px dimension`,
    };
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
