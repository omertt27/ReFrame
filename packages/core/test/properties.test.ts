import { describe, expect, it } from "vitest";

import { EDITABLE_PROPERTIES, readProperty, writeProperty } from "../src/properties.js";
import { pxToSpacingToken, spacingTokenToPx } from "../src/tailwind-scale.js";

const height = EDITABLE_PROPERTIES.find((p) => p.key === "height")!;
const padding = EDITABLE_PROPERTIES.find((p) => p.key === "padding")!;

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
