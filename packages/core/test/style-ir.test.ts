import { describe, expect, it } from "vitest";

import { EDITABLE_PROPERTIES, readStyleObjectColor, readStyleObjectProperty, type PropertyDef } from "../src/properties.js";
import { writeStyleColor, writeStyleProperty } from "../src/mutate/style.js";
import { buildComponentGraph } from "../src/parse.js";
import { resolveDefinition } from "../src/resolve.js";
import { printFile } from "../src/write.js";

const height = EDITABLE_PROPERTIES.find((p) => p.key === "height")!;
const padding = EDITABLE_PROPERTIES.find((p) => p.key === "padding")!;
const background: PropertyDef = { key: "background", label: "Background", valueKind: "color", cssProperty: "background" };

function loadStyled(source: string) {
  return buildComponentGraph([{ filePath: "X.tsx", source }]);
}

describe("style IR — recognized shapes", () => {
  it("reads a numeric literal (React's px-by-default convention)", () => {
    const graph = loadStyled(`export default function X() { return <div style={{ height: 44 }}>x</div>; }`);
    const def = resolveDefinition(graph, "X");
    const read = readStyleObjectProperty(def.styleAttr!.ir, height);
    expect(read).toEqual({ available: true, px: 44 });
  });

  it("reads a plain \"Npx\" string", () => {
    const graph = loadStyled(`export default function X() { return <div style={{ height: "44px" }}>x</div>; }`);
    const def = resolveDefinition(graph, "X");
    const read = readStyleObjectProperty(def.styleAttr!.ir, height);
    expect(read).toEqual({ available: true, px: 44 });
  });

  it("reports px: null when the property isn't set at all", () => {
    const graph = loadStyled(`export default function X() { return <div style={{ width: 44 }}>x</div>; }`);
    const def = resolveDefinition(graph, "X");
    expect(readStyleObjectProperty(def.styleAttr!.ir, height)).toEqual({ available: true, px: null });
  });
});

describe("style IR — unsupported shapes, reported not guessed", () => {
  it("a CSS variable reference reads as a color, not a dimension (PrivaPDF's exact SectionHeader pattern)", () => {
    const graph = loadStyled(
      `export default function X() { return <div style={{ background: "var(--accent-light)" }}>x</div>; }`,
    );
    const def = resolveDefinition(graph, "X");
    const dimensionRead = readStyleObjectProperty(def.styleAttr!.ir, background);
    expect(dimensionRead.available).toBe(false);
    expect(!dimensionRead.available && dimensionRead.reason).toMatch(/color/);

    const colorRead = readStyleObjectColor(def.styleAttr!.ir, background);
    expect(colorRead).toEqual({ available: true, value: "var(--accent-light)" });
  });

  it("refuses a shorthand multi-value string", () => {
    const graph = loadStyled(`export default function X() { return <div style={{ padding: "12px 24px" }}>x</div>; }`);
    const def = resolveDefinition(graph, "X");
    const read = readStyleObjectProperty(def.styleAttr!.ir, padding);
    expect(read.available).toBe(false);
  });

  it("refuses a computed/templated expression", () => {
    const graph = loadStyled(
      `export default function X({ n }) { return <div style={{ height: n * 2 }}>x</div>; }`,
    );
    const def = resolveDefinition(graph, "X");
    const read = readStyleObjectProperty(def.styleAttr!.ir, height);
    expect(read.available).toBe(false);
  });
});

describe("style IR — writes preserve the author's number-vs-string convention", () => {
  it("writes a numeric literal back as a number", () => {
    const graph = loadStyled(`export default function X() { return <div style={{ height: 44 }}>x</div>; }`);
    const def = resolveDefinition(graph, "X");
    const result = writeStyleProperty(def.styleAttr!.ir, "height", 80);
    expect(result).toEqual({ ok: true });
    expect(printFile(graph, "X.tsx")).toContain("height: 80");
    expect(printFile(graph, "X.tsx")).not.toContain("80px");
  });

  it("writes a string literal back as a \"Npx\" string, not a bare number", () => {
    const graph = loadStyled(`export default function X() { return <div style={{ height: "44px" }}>x</div>; }`);
    const def = resolveDefinition(graph, "X");
    const result = writeStyleProperty(def.styleAttr!.ir, "height", 80);
    expect(result).toEqual({ ok: true });
    expect(printFile(graph, "X.tsx")).toContain('"80px"');
  });

  it("appends a new property (as a number, React's idiom) when not present before", () => {
    const graph = loadStyled(`export default function X() { return <div style={{ width: 44 }}>x</div>; }`);
    const def = resolveDefinition(graph, "X");
    const result = writeStyleProperty(def.styleAttr!.ir, "height", 60);
    expect(result).toEqual({ ok: true });
    const after = printFile(graph, "X.tsx");
    expect(after).toContain("width: 44");
    expect(after).toContain("height: 60");
  });

  it("refuses to write over an unsupported existing value rather than clobbering it", () => {
    const graph = loadStyled(
      `export default function X() { return <div style={{ background: "var(--accent)" }}>x</div>; }`,
    );
    const def = resolveDefinition(graph, "X");
    const result = writeStyleProperty(def.styleAttr!.ir, "background", 1);
    expect(result.ok).toBe(false);
  });
});

describe("style IR — color values (hex/rgb/named/CSS-variable, all just a raw string)", () => {
  it.each([
    ["#3B82F6", "hex"],
    ["rgb(59, 130, 246)", "rgb()"],
    ["rebeccapurple", "named"],
    ["var(--accent)", "CSS variable"],
  ])("recognizes a %s color value (%s)", (value) => {
    const graph = loadStyled(`export default function X() { return <div style={{ color: "${value}" }}>x</div>; }`);
    const def = resolveDefinition(graph, "X");
    const textColor: PropertyDef = { key: "textColor", label: "Text color", valueKind: "color", cssProperty: "color" };
    expect(readStyleObjectColor(def.styleAttr!.ir, textColor)).toEqual({ available: true, value });
  });

  it("reports value: null when the color property isn't set at all", () => {
    const graph = loadStyled(`export default function X() { return <div style={{ height: 44 }}>x</div>; }`);
    const def = resolveDefinition(graph, "X");
    expect(readStyleObjectColor(def.styleAttr!.ir, background)).toEqual({ available: true, value: null });
  });

  it("writes a new color value, replacing whatever was there — preserving the form (a var() edit stays a plain string, never resolved)", () => {
    const graph = loadStyled(`export default function X() { return <div style={{ background: "var(--accent-light)" }}>x</div>; }`);
    const def = resolveDefinition(graph, "X");
    const result = writeStyleColor(def.styleAttr!.ir, "background", "#3B82F6");
    expect(result).toEqual({ ok: true });
    const after = printFile(graph, "X.tsx");
    expect(after).toContain('background: "#3B82F6"');
    expect(after).not.toContain("var(--accent-light)");
  });

  it("appends a new color property when not present before", () => {
    const graph = loadStyled(`export default function X() { return <div style={{ height: 44 }}>x</div>; }`);
    const def = resolveDefinition(graph, "X");
    const result = writeStyleColor(def.styleAttr!.ir, "color", "var(--accent)");
    expect(result).toEqual({ ok: true });
    const after = printFile(graph, "X.tsx");
    expect(after).toContain("height: 44");
    expect(after).toContain('color: "var(--accent)"');
  });

  it("refuses to write a color over an existing dimension value", () => {
    const graph = loadStyled(`export default function X() { return <div style={{ height: 44 }}>x</div>; }`);
    const def = resolveDefinition(graph, "X");
    const result = writeStyleColor(def.styleAttr!.ir, "height", "red");
    expect(result.ok).toBe(false);
  });

  it("a shorthand multi-value string still stays unsupported, not misread as a color", () => {
    const graph = loadStyled(`export default function X() { return <div style={{ padding: "12px 24px" }}>x</div>; }`);
    const def = resolveDefinition(graph, "X");
    const paddingColor: PropertyDef = { key: "padding", label: "Padding", valueKind: "color", cssProperty: "padding" };
    expect(readStyleObjectColor(def.styleAttr!.ir, paddingColor).available).toBe(false);
  });
});

describe("style IR — computed/bracket property keys are explicitly flagged, not silently dropped", () => {
  // Found via a real-world comparison against Excalidraw's Card.tsx —
  // `style={{ ["--card-color" as any]: COLOR_MAP[color].base }}`, used to
  // set CSS custom properties dynamically. A computed key has no static
  // name to record it under, so it can never appear in `properties` by
  // name — but silently vanishing is worse than an explicit "there's
  // something here ReFrame can't see" (this project's own standing
  // principle), hence the flag rather than just skipping quietly.
  it("flags hasUnsupportedComputedKeys and does not crash", () => {
    // The exact real shape (Excalidraw's Card.tsx): a `key as any` TS cast
    // wraps the key in a TSAsExpression, not a bare StringLiteral — bracket
    // notation with a PLAIN string key (`["foo"]: x`, no cast) is actually
    // already fine today, since the key node is still a StringLiteral
    // either way; it's specifically the cast that defeats the check.
    const graph = loadStyled(`
      export default function X({ color }) {
        return <div style={{ ["--card-color" as any]: color, ["--card-color-darker" as any]: color }}>x</div>;
      }
    `);
    const def = resolveDefinition(graph, "X");
    const ir = def.styleAttr!.ir;
    expect(ir.kind).toBe("object");
    expect(ir.kind === "object" && ir.hasUnsupportedComputedKeys).toBe(true);
  });

  it("still parses the OTHER, plain-keyed properties in the same object normally", () => {
    const graph = loadStyled(`
      export default function X({ color }) {
        return <div style={{ ["--card-color" as any]: color, height: 44 }}>x</div>;
      }
    `);
    const def = resolveDefinition(graph, "X");
    expect(readStyleObjectProperty(def.styleAttr!.ir, height)).toEqual({ available: true, px: 44 });
  });

  it("bracket notation with a plain string key (no cast) is NOT flagged — the key node is still a StringLiteral", () => {
    const graph = loadStyled(`export default function X() { return <div style={{ ["height"]: 44 }}>x</div>; }`);
    const def = resolveDefinition(graph, "X");
    const ir = def.styleAttr!.ir;
    expect(ir.kind === "object" && ir.hasUnsupportedComputedKeys).toBe(false);
    expect(readStyleObjectProperty(ir, height)).toEqual({ available: true, px: 44 });
  });

  it("leaves the flag false when every key is a plain identifier/string", () => {
    const graph = loadStyled(`export default function X() { return <div style={{ height: 44 }}>x</div>; }`);
    const def = resolveDefinition(graph, "X");
    const ir = def.styleAttr!.ir;
    expect(ir.kind === "object" && ir.hasUnsupportedComputedKeys).toBe(false);
  });
});

describe("real-world regression: PrivaPDF's exact SectionHeader icon wrapper", () => {
  // packages/core/... this mirrors src/app/tools/page.tsx's SectionHeader,
  // found during the real-world stress test — width/height are plain
  // numbers (editable), background is a CSS variable (correctly refused).
  const source = `
    export default function SectionHeader({ icon, title, desc }) {
      return (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 4 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: "var(--accent-light)", flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--accent)",
          }}>
            {icon}
          </div>
          <div>
            <h2>{title}</h2>
            <p>{desc}</p>
          </div>
        </div>
      );
    }
  `;

  it("resolves the outer div's style (gap/marginBottom are unsupported, correctly)", () => {
    const graph = loadStyled(source);
    const def = resolveDefinition(graph, "SectionHeader");
    expect(def.classAttr).toBeNull(); // confirmed: no className at all, per the stress test
    expect(def.styleAttr).not.toBeNull();
    // The root div's own style has no height/width — those are on the nested icon div,
    // which V0's root-element-only model doesn't reach (documented scope limit).
    expect(readStyleObjectProperty(def.styleAttr!.ir, height)).toEqual({ available: true, px: null });
  });
});
