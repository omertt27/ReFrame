import { replaceUtilityClass } from "./mutate/tailwind.js";
import { pxToSpacingToken, spacingTokenToPx } from "./tailwind-scale.js";

export interface PropertyDef {
  key: string;
  label: string;
  /** The exact utility prefix, e.g. "h-" for height. Matched literally so
   * "p-" never matches "px-"/"py-"/"pt-"/etc — Tailwind's own naming makes
   * this safe (the character after the property letter is always either
   * "-" for the all-sides utility or another axis/side letter). */
  prefix: string;
  /** Other prefixes that set an overlapping CSS property with different (or
   * higher, later-in-stylesheet) specificity — if any of these are already
   * present, writing this property would silently not apply as expected, so
   * it's refused rather than guessed. */
  conflictsWith?: string[];
}

export const EDITABLE_PROPERTIES: PropertyDef[] = [
  { key: "height", label: "Height", prefix: "h-" },
  { key: "padding", label: "Padding", prefix: "p-", conflictsWith: ["px-", "py-", "pt-", "pr-", "pb-", "pl-"] },
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

export function readProperty(classList: string, prop: PropertyDef): PropertyReadResult {
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

  const newClass = prop.prefix + pxToSpacingToken(px);
  const existing = findUtilityClass(classList, prop.prefix);
  const newClassList = existing
    ? replaceUtilityClass(classList, existing, newClass)
    : `${classList.trim()} ${newClass}`.trim();
  return { ok: true, classList: newClassList };
}
