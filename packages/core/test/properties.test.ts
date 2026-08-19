import { describe, expect, it } from "vitest";

import { buildComponentGraph } from "../src/parse.js";
import {
  EDITABLE_PROPERTIES,
  readProperty,
  readResponsiveProperty,
  readStyleObjectProperty,
  writeProperty,
  writeResponsiveProperty,
} from "../src/properties.js";
import { resolveDefinition } from "../src/resolve.js";
import { pxToSpacingToken, spacingTokenToPx } from "../src/tailwind-scale.js";
import { writeStyleProperty } from "../src/mutate/style.js";
import { printFile } from "../src/write.js";

const height = EDITABLE_PROPERTIES.find((p) => p.key === "height")!;
const padding = EDITABLE_PROPERTIES.find((p) => p.key === "padding")!;
const lineHeight = EDITABLE_PROPERTIES.find((p) => p.key === "lineHeight")!;
const letterSpacing = EDITABLE_PROPERTIES.find((p) => p.key === "letterSpacing")!;

describe("tailwind spacing scale", () => {
  it("maps exact scale values both ways", () => {
    expect(pxToSpacingToken(80)).toBe("20");
    expect(spacingTokenToPx("20")).toBe(80);
  });

  it("falls back to an arbitrary value for an off-scale px, never rounds silently", () => {
    expect(pxToSpacingToken(83)).toBe("[83px]");
    expect(spacingTokenToPx("[83px]")).toBe(83);
  });

  it("returns null for a token that isn't a spacing value at all", () => {
    expect(spacingTokenToPx("bg-white")).toBeNull();
  });
});

describe("readProperty / writeProperty — height", () => {
  it("reads the current height from a class list", () => {
    const result = readProperty("absolute top-0 h-16 bg-transparent", height);
    expect(result).toEqual({ available: true, px: 64 });
  });

  it("reports px: null when the property isn't present at all", () => {
    const result = readProperty("absolute top-0 bg-transparent", height);
    expect(result).toEqual({ available: true, px: null });
  });

  it("writes an exact-scale value by replacing the existing token", () => {
    const result = writeProperty("absolute top-0 h-16 bg-transparent", height, 80);
    expect(result).toEqual({ ok: true, classList: "absolute top-0 h-20 bg-transparent" });
  });

  it("writes an off-scale value as an arbitrary value", () => {
    const result = writeProperty("h-16 bg-white", height, 83);
    expect(result).toEqual({ ok: true, classList: "h-[83px] bg-white" });
  });

  it("appends the class when the property wasn't present before", () => {
    const result = writeProperty("absolute top-0 bg-transparent", height, 64);
    expect(result).toEqual({ ok: true, classList: "absolute top-0 bg-transparent h-16" });
  });

  it("never touches an unrelated token that merely contains the prefix as a substring", () => {
    // "shadow-xl" contains no "h-" boundary issue, but this guards the same
    // class of bug as the Tailwind matrix's "sm:p-4 vs p-4" case, for height.
    const result = writeProperty("h-16 shadow-xl", height, 80);
    expect(result).toEqual({ ok: true, classList: "h-20 shadow-xl" });
  });
});

describe("readProperty / writeProperty — padding conflict guard", () => {
  it("refuses to write p-* when px-/py- already set it more specifically", () => {
    const result = writeProperty("px-6 py-3 rounded-full", padding, 32);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("px-/py-") });
  });

  it("still allows reading (as unavailable, not a crash) in the conflict case", () => {
    const result = readProperty("px-6 py-3 rounded-full", padding);
    expect(result.available).toBe(false);
  });

  it("writes p-* freely when there's no existing padding at all", () => {
    const result = writeProperty("absolute top-0 bg-transparent", padding, 24);
    expect(result).toEqual({ ok: true, classList: "absolute top-0 bg-transparent p-6" });
  });
});

describe("responsive Tailwind prefixes (md:/lg:/...) — current, deliberately narrow behavior", () => {
  // Real-world stress test finding: PrivaPDF (this session's real test
  // subject) uses ZERO Tailwind responsive prefixes and ZERO Tailwind
  // spacing-scale utilities anywhere in its actual source — every real
  // dimension/color edit this session went through the style backend, not
  // this one. These cases use realistic Tailwind syntax rather than real
  // PrivaPDF code (there isn't any to test against) to document current
  // engine behavior precisely, ahead of building real breakpoint support:
  // ReFrame today only ever sees/writes the BASE (unprefixed) utility —
  // findUtilityClass's `!t.includes(":")` guard deliberately excludes any
  // responsive/state-variant token. This is safe (never silently rewrites
  // a breakpoint override) but also invisible — there is currently no way
  // to even show the user "tablet: 24px, mobile: 16px" exists at all.
  it("readProperty finds only the base utility, ignoring responsive variants entirely", () => {
    const result = readProperty("p-4 md:p-6 lg:p-8", padding);
    expect(result).toEqual({ available: true, px: 16 });
  });

  it("writeProperty edits only the base utility — md:/lg: overrides survive untouched", () => {
    const result = writeProperty("p-4 md:p-6 lg:p-8", padding, 20);
    expect(result).toEqual({ ok: true, classList: "p-5 md:p-6 lg:p-8" });
  });

  it("editing the base value when only responsive variants exist (no base) appends one — it does not touch or infer from md:/lg:", () => {
    // There's no bare "p-*" token here at all — Tailwind would fall back to
    // md:'s value below that breakpoint via normal cascade, but ReFrame has
    // no visibility into that; it just adds a new base utility.
    const result = writeProperty("md:p-6 lg:p-8", padding, 16);
    expect(result).toEqual({ ok: true, classList: "md:p-6 lg:p-8 p-4" });
  });
});

describe("typography properties (fontSize/fontWeight/lineHeight/letterSpacing) — style backend only, no Tailwind prefix", () => {
  it("readProperty/writeProperty (Tailwind) refuse a prefix-less property rather than guessing a mapping", () => {
    // Contract callers must respect: readDimensionValue in apps/dev/host.ts
    // guards on prop.prefix before ever calling these for exactly this
    // reason — Tailwind's typography utilities (font-bold, leading-relaxed)
    // are keyword scales, not the numeric spacing scale these functions
    // implement, so there is no mapping to guess at.
    expect(() => readProperty("text-lg font-bold", lineHeight)).toThrow(/no Tailwind prefix/);
  });

  it("reads and writes lineHeight (a unitless number, no px unit assumed) via the style backend", () => {
    const graph = buildComponentGraph([
      { filePath: "X.tsx", source: `export default function X() { return <h1 style={{ lineHeight: 1.1, letterSpacing: -1.5 }}>x</h1>; }` },
    ]);
    const def = resolveDefinition(graph, "X");
    expect(readStyleObjectProperty(def.styleAttr!.ir, lineHeight)).toEqual({ available: true, px: 1.1 });
    expect(readStyleObjectProperty(def.styleAttr!.ir, letterSpacing)).toEqual({ available: true, px: -1.5 });

    const result = writeStyleProperty(def.styleAttr!.ir, "lineHeight", 1.5);
    expect(result).toEqual({ ok: true });
    const after = printFile(graph, "X.tsx");
    expect(after).toContain("lineHeight: 1.5");
    expect(after).not.toContain("lineHeight: 1.1");
  });

  it("writes a new value onto an already-negative letter-spacing, preserving the negative form (PrivaPDF's exact AboutPage h1 shape)", () => {
    const graph = buildComponentGraph([
      { filePath: "X.tsx", source: `export default function X() { return <h1 style={{ letterSpacing: -1.5 }}>x</h1>; }` },
    ]);
    const def = resolveDefinition(graph, "X");
    const result = writeStyleProperty(def.styleAttr!.ir, "letterSpacing", -2.5);
    expect(result).toEqual({ ok: true });
    const after = printFile(graph, "X.tsx");
    expect(after).toContain("letterSpacing: -2.5");
  });

  it("refuses to flip an already-negative value positive rather than guessing what that should look like", () => {
    const graph = buildComponentGraph([
      { filePath: "X.tsx", source: `export default function X() { return <h1 style={{ letterSpacing: -1.5 }}>x</h1>; }` },
    ]);
    const def = resolveDefinition(graph, "X");
    const result = writeStyleProperty(def.styleAttr!.ir, "letterSpacing", 2);
    expect(result.ok).toBe(false);
  });

  it("readStyleObjectProperty never needed a prefix in the first place — safe regardless of the element's className", () => {
    // The actual crash this fix addresses lived one layer up, in
    // apps/dev/host.ts's readDimensionValue, which unconditionally called
    // the TAILWIND reader (readProperty, tested above) whenever an element
    // had ANY className — very common in this codebase (e.g.
    // className="nav-root" alongside inline styles). This test documents
    // why that layer needed a guard: the style-backend reader below was
    // never at fault, since it doesn't consult the className at all.
    const graph = buildComponentGraph([
      { filePath: "X.tsx", source: `export default function X() { return <h1 className="nav-root" style={{ lineHeight: 1.1 }}>x</h1>; }` },
    ]);
    const def = resolveDefinition(graph, "X");
    expect(() => readStyleObjectProperty(def.styleAttr!.ir, lineHeight)).not.toThrow();
    expect(readStyleObjectProperty(def.styleAttr!.ir, lineHeight)).toEqual({ available: true, px: 1.1 });
  });
});

describe("readResponsiveProperty / writeResponsiveProperty — device-tier-aware, additive alongside the base-only functions above", () => {
  // Uses height/padding (the numeric spacing-scale properties that
  // actually have a Tailwind prefix) rather than fontSize — Tailwind's
  // text-lg/text-6xl scale (the property in the user's own worked example,
  // "text-6xl md:text-5xl") is a keyword scale EDITABLE_PROPERTIES
  // deliberately doesn't map a Tailwind prefix onto (see fontSize's own
  // comment) — but the exact same mobile-first read/write principle
  // applies identically to any prefixed property; height/padding are just
  // the ones actually wired up to demonstrate it against today.

  it("mobile reads the base value, ignoring larger breakpoints entirely — nothing overrides mobile from above", () => {
    expect(readResponsiveProperty("h-24 md:h-20 lg:h-16", height, "mobile")).toEqual({ available: true, px: 96 });
  });

  it("tablet's effective value cascades: md: wins over the base if present", () => {
    expect(readResponsiveProperty("h-24 md:h-20", height, "tablet")).toEqual({ available: true, px: 80 });
  });

  it("tablet falls back to the base value when no md:/sm: override exists", () => {
    expect(readResponsiveProperty("h-24 lg:h-16", height, "tablet")).toEqual({ available: true, px: 96 });
  });

  it("desktop's effective value cascades through md: when no lg:/xl: override exists — a real browser would render md: at desktop width too", () => {
    expect(readResponsiveProperty("h-24 md:h-20", height, "desktop")).toEqual({ available: true, px: 80 });
  });

  it("desktop prefers lg: over md: when both exist", () => {
    expect(readResponsiveProperty("h-24 md:h-20 lg:h-16", height, "desktop")).toEqual({ available: true, px: 64 });
  });

  it("editing mobile modifies the BASE utility and leaves md:/lg: overrides completely untouched — the user's exact worked example", () => {
    const result = writeResponsiveProperty("h-24 md:h-20 lg:h-16", height, 32, "mobile");
    expect(result).toEqual({ ok: true, classList: "h-8 md:h-20 lg:h-16" });
  });

  it("editing tablet modifies exactly the md: override, not the base or lg:", () => {
    const result = writeResponsiveProperty("h-24 md:h-20 lg:h-16", height, 28, "tablet");
    expect(result).toEqual({ ok: true, classList: "h-24 md:h-7 lg:h-16" });
  });

  it("editing desktop modifies exactly the lg: override, even though md: is what currently cascades to desktop width", () => {
    // Desktop reads as 80px here (md: cascades up, see the read test above)
    // but editing desktop must NOT touch md: — it creates/modifies lg:
    // specifically, per the tier's own direct mapping, never "whichever
    // breakpoint currently happens to govern this width."
    const result = writeResponsiveProperty("h-24 md:h-20", height, 48, "desktop");
    expect(result).toEqual({ ok: true, classList: "h-24 md:h-20 lg:h-12" });
  });

  it("editing tablet when no md: exists yet creates one, leaving the base and any lg: untouched", () => {
    const result = writeResponsiveProperty("h-24 lg:h-16", height, 40, "tablet");
    expect(result).toEqual({ ok: true, classList: "h-24 lg:h-16 md:h-10" });
  });

  it("the padding conflictsWith guard still applies at the base level for a responsive write", () => {
    const result = writeResponsiveProperty("px-6 py-3", padding, 32, "tablet");
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("px-/py-") });
  });
});
