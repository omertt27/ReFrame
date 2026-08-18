import { describe, expect, it } from "vitest";

import { EDITABLE_PROPERTIES, readStyleObjectProperty } from "../src/properties.js";
import { writeStyleProperty } from "../src/mutate/style.js";
import { buildComponentGraph } from "../src/parse.js";
import { resolveDefinition } from "../src/resolve.js";
import { printFile } from "../src/write.js";

const height = EDITABLE_PROPERTIES.find((p) => p.key === "height")!;
const padding = EDITABLE_PROPERTIES.find((p) => p.key === "padding")!;

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
  it("refuses a CSS variable reference (PrivaPDF's exact SectionHeader pattern)", () => {
    const graph = loadStyled(
      `export default function X() { return <div style={{ background: "var(--accent-light)" }}>x</div>; }`,
    );
    const def = resolveDefinition(graph, "X");
    const bg = { key: "background", label: "Background", prefix: "bg-", cssProperty: "background" };
    const read = readStyleObjectProperty(def.styleAttr!.ir, bg);
    expect(read.available).toBe(false);
    expect(!read.available && read.reason).toMatch(/CSS variable|shorthand/);
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
