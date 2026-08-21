import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { diffLines } from "diff";
import { describe, expect, it } from "vitest";

import { applyClassMutation } from "../src/mutate/class.js";
import { removeElement } from "../src/mutate/delete.js";
import { duplicateElement } from "../src/mutate/duplicate.js";
import { moveChild } from "../src/mutate/move.js";
import { setUsageProp } from "../src/mutate/prop.js";
import { buildComponentGraph } from "../src/parse.js";
import { resolveAllUsages, resolveDefinition, resolveSharedClassTarget, resolveUsage } from "../src/resolve.js";
import { printFile } from "../src/write.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "fixtures/basic-tailwind-app");

function loadFixture() {
  const filePaths = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".tsx"));
  const files = filePaths.map((filePath) => ({
    filePath,
    source: readFileSync(join(FIXTURE_DIR, filePath), "utf8"),
  }));
  const originalSources = new Map(files.map((f) => [f.filePath, f.source]));
  const graph = buildComponentGraph(files);
  return { graph, originalSources, filePaths };
}

/** Files whose printed output changed vs. their original source. */
function changedFiles(graph: ReturnType<typeof buildComponentGraph>, originalSources: Map<string, string>) {
  const changed = new Set<string>();
  for (const [filePath, before] of originalSources) {
    if (printFile(graph, filePath) !== before) changed.add(filePath);
  }
  return changed;
}

/** Number of changed lines between two texts (added + removed), ignoring unchanged context. */
function changedLineCount(before: string, after: string): number {
  return diffLines(before, after)
    .filter((part) => part.added || part.removed)
    .reduce((sum, part) => sum + part.count!, 0);
}

describe("shared structural edit", () => {
  it("changes Navbar's height in the shared definition only, with a minimal diff", () => {
    const { graph, originalSources } = loadFixture();

    const target = resolveSharedClassTarget(graph, "Navbar");
    expect(target.ir.kind).toBe("ternary");
    applyClassMutation(target, { op: "setBranch", branch: "consequent", value: "absolute top-0 left-0 right-0 h-20 bg-transparent text-white" });
    applyClassMutation(target, { op: "setBranch", branch: "alternate", value: "sticky top-0 h-20 bg-white text-slate-900 shadow-sm" });

    const changed = changedFiles(graph, originalSources);
    expect(changed).toEqual(new Set(["Navbar.tsx"]));

    const before = originalSources.get("Navbar.tsx")!;
    const after = printFile(graph, "Navbar.tsx");
    expect(after).toContain("h-20");
    expect(after).not.toContain("h-16");
    // Two branches changed, one line each (counted as remove+add per line) —
    // not a full-file reformat.
    expect(changedLineCount(before, after)).toBeLessThanOrEqual(4);
  });
});

describe("instance-scoped prop edit", () => {
  it("changes only Home's usage site, leaving Navbar.tsx and other pages untouched", () => {
    const { graph, originalSources } = loadFixture();

    const home = resolveUsage(graph, "Navbar", "Home.tsx");
    expect(home.props.variant).toBe("transparent");
    setUsageProp(home, "variant", "solid");

    const changed = changedFiles(graph, originalSources);
    expect(changed).toEqual(new Set(["Home.tsx"]));

    expect(printFile(graph, "Home.tsx")).toContain('variant="solid"');
    expect(printFile(graph, "Navbar.tsx")).toBe(originalSources.get("Navbar.tsx"));
    expect(printFile(graph, "Pricing.tsx")).toBe(originalSources.get("Pricing.tsx"));
    expect(printFile(graph, "About.tsx")).toBe(originalSources.get("About.tsx"));
  });

  it("still reports the correct variant per page for every other usage", () => {
    const { graph } = loadFixture();
    const usages = resolveAllUsages(graph, "Navbar");
    const byFile = Object.fromEntries(usages.map((u) => [u.filePath, u.props.variant]));
    expect(byFile).toEqual({
      "Home.tsx": "transparent",
      "Pricing.tsx": "solid",
      "About.tsx": "solid",
    });
  });
});

describe("ternary-aware class edit", () => {
  it("changes only the solid branch, preserving the conditional and the transparent branch", () => {
    const { graph, originalSources } = loadFixture();

    const target = resolveSharedClassTarget(graph, "Navbar");
    applyClassMutation(target, { op: "setBranch", branch: "alternate", value: "sticky top-0 h-16 bg-slate-50 text-slate-900 shadow-sm" });

    const before = originalSources.get("Navbar.tsx")!;
    const after = printFile(graph, "Navbar.tsx");

    expect(after).toContain("bg-slate-50");
    expect(after).not.toContain("bg-white");
    expect(after).toContain("bg-transparent"); // consequent branch untouched
    expect(after).toContain('variant === "transparent"'); // conditional itself untouched
    // One branch, one line changed (counted as remove+add).
    expect(changedLineCount(before, after)).toBeLessThanOrEqual(2);
  });

  it("refuses to collapse the conditional into a flat string", () => {
    const { graph } = loadFixture();
    const target = resolveSharedClassTarget(graph, "Navbar");
    expect(() => applyClassMutation(target, { op: "setString", value: "h-16 bg-white" })).toThrow(
      /Refusing to replace a conditional className/,
    );
  });
});

describe("clsx()/cn() class edit", () => {
  it("changes one static arg without touching the conditional arg", () => {
    const { graph, originalSources } = loadFixture();

    const target = resolveSharedClassTarget(graph, "Button");
    expect(target.ir.kind).toBe("clsxCall");
    if (target.ir.kind !== "clsxCall" || !target.ir.args) throw new Error("expected parsed clsx args");
    expect(target.ir.args).toEqual([
      { kind: "string", value: "rounded-full px-4 py-2 text-sm font-medium", node: expect.anything() },
      {
        kind: "conditional",
        testSource: "active",
        evaluable: { propName: "active", negated: false },
        value: "bg-slate-900 text-white",
        node: expect.anything(),
      },
    ]);

    applyClassMutation(target, { op: "setClsxArg", index: 0, value: "rounded-md px-4 py-2 text-sm font-medium" });

    const before = originalSources.get("Button.tsx")!;
    const after = printFile(graph, "Button.tsx");
    expect(after).toContain("rounded-md");
    expect(after).toContain("active &&"); // conditional arg untouched
    expect(after).toContain("bg-slate-900 text-white");
    expect(changedFiles(graph, originalSources)).toEqual(new Set(["Button.tsx"]));
    // NOTE: recast reprints the whole JSXElement (including its plain-text
    // children) when a CallExpression-wrapped className attribute changes,
    // even though only a StringLiteral inside the call was mutated — unlike
    // the ternary case, which stays a true single-line diff. This is a
    // recast JSX-printer granularity limit, not a mutation-logic bug: the
    // correct string value lands in the right (only) file either way. Worth
    // revisiting before this becomes a user-facing "clean diff" guarantee.
    expect(changedLineCount(before, after)).toBeLessThanOrEqual(8);
  });

  it("changes the conditional arg's value without touching the static arg or the test", () => {
    const { graph, originalSources } = loadFixture();

    const target = resolveSharedClassTarget(graph, "Button");
    applyClassMutation(target, { op: "setClsxArg", index: 1, value: "bg-indigo-600 text-white" });

    const after = printFile(graph, "Button.tsx");
    expect(after).toContain("bg-indigo-600 text-white");
    expect(after).toContain("active &&"); // test expression untouched
    expect(after).toContain("rounded-full px-4 py-2 text-sm font-medium"); // static arg untouched
  });

  it("refuses to edit a clsx call with argument shapes it doesn't recognize", () => {
    const graph = buildComponentGraph([
      {
        filePath: "Opaque.tsx",
        source: `
          export default function Opaque({ isActive }) {
            return <div className={clsx("base", { active: isActive })}>x</div>;
          }
        `,
      },
    ]);
    const target = resolveSharedClassTarget(graph, "Opaque");
    expect(target.ir.kind).toBe("clsxCall");
    if (target.ir.kind === "clsxCall") expect(target.ir.args).toBeNull();
    expect(() => applyClassMutation(target, { op: "setClsxArg", index: 0, value: "x" })).toThrow(
      /doesn't recognize/,
    );
  });
});

function componentOrder(source: string, names: string[]): string[] {
  return names
    .map((name) => ({ name, index: source.indexOf(`<${name}`) }))
    .sort((a, b) => a.index - b.index)
    .map((p) => p.name);
}

describe("move / reorder children", () => {
  const HOME_ORDER = ["Navbar", "Hero", "Card", "Button", "Footer"];

  it("moves an element backward to a target index", () => {
    const { graph, originalSources } = loadFixture();
    const home = resolveDefinition(graph, "Home");

    moveChild(home.rootElement, 2, 1); // Card (2) -> before Hero (1)

    const before = originalSources.get("Home.tsx")!;
    const after = printFile(graph, "Home.tsx");
    expect(componentOrder(after, HOME_ORDER)).toEqual(["Navbar", "Card", "Hero", "Button", "Footer"]);
    expect(changedFiles(graph, originalSources)).toEqual(new Set(["Home.tsx"]));
    // Exactly the two swapped lines change — indentation travels with the
    // moved element rather than leaving a reformatting mess behind.
    expect(changedLineCount(before, after)).toBeLessThanOrEqual(4);
  });

  it("moves an element forward to a target index", () => {
    const { graph } = loadFixture();
    const home = resolveDefinition(graph, "Home");

    moveChild(home.rootElement, 0, 2); // Navbar (0) -> index 2

    const after = printFile(graph, "Home.tsx");
    expect(componentOrder(after, HOME_ORDER)).toEqual(["Hero", "Card", "Navbar", "Button", "Footer"]);
  });

  it("is a no-op when the target index equals the source index", () => {
    const { graph, originalSources } = loadFixture();
    const home = resolveDefinition(graph, "Home");

    moveChild(home.rootElement, 1, 1);

    expect(printFile(graph, "Home.tsx")).toBe(originalSources.get("Home.tsx"));
  });

  it("rejects an out-of-range target index", () => {
    const { graph } = loadFixture();
    const home = resolveDefinition(graph, "Home");
    expect(() => moveChild(home.rootElement, 0, 99)).toThrow(/out of range/);
  });

  it("honors an explicit insertBefore=true even when moving forward (default would insert after)", () => {
    const { graph } = loadFixture();
    const home = resolveDefinition(graph, "Home");

    moveChild(home.rootElement, 1, 3, true); // Hero (1) -> explicitly BEFORE Button (3)

    const after = printFile(graph, "Home.tsx");
    expect(componentOrder(after, HOME_ORDER)).toEqual(["Navbar", "Card", "Hero", "Button", "Footer"]);
  });

  it("honors an explicit insertBefore=false even when moving backward (default would insert before)", () => {
    const { graph } = loadFixture();
    const home = resolveDefinition(graph, "Home");

    moveChild(home.rootElement, 3, 1, false); // Button (3) -> explicitly AFTER Hero (1)

    const after = printFile(graph, "Home.tsx");
    expect(componentOrder(after, HOME_ORDER)).toEqual(["Navbar", "Hero", "Button", "Card", "Footer"]);
  });
});

describe("delete element", () => {
  // componentOrder (the move-tests' helper) sorts by source.indexOf, where
  // "not found" is -1 — which sorts FIRST, not "absent." It only works for
  // reordering (every name always present); deletion needs to check
  // absence directly and check the remaining order separately.
  function remainingOrder(source: string, names: string[]): string[] {
    return names.filter((name) => source.includes(`<${name}`));
  }

  it("removes an element from the middle, closing the gap", () => {
    const { graph, originalSources } = loadFixture();
    const home = resolveDefinition(graph, "Home");

    removeElement(home.rootElement, 2); // Card

    const before = originalSources.get("Home.tsx")!;
    const after = printFile(graph, "Home.tsx");
    expect(after).not.toContain("<Card");
    expect(remainingOrder(after, ["Navbar", "Hero", "Card", "Button", "Footer"])).toEqual([
      "Navbar",
      "Hero",
      "Button",
      "Footer",
    ]);
    expect(changedFiles(graph, originalSources)).toEqual(new Set(["Home.tsx"]));
    // Only the removed element's own line(s) + its leading indentation
    // disappear — no reformatting of anything around it.
    expect(changedLineCount(before, after)).toBeLessThanOrEqual(2);
  });

  it("removes the first element", () => {
    const { graph } = loadFixture();
    const home = resolveDefinition(graph, "Home");
    removeElement(home.rootElement, 0); // Navbar
    const after = printFile(graph, "Home.tsx");
    expect(after).not.toContain("<Navbar");
    expect(remainingOrder(after, ["Navbar", "Hero", "Card", "Button", "Footer"])).toEqual(["Hero", "Card", "Button", "Footer"]);
  });

  it("removes the last element", () => {
    const { graph } = loadFixture();
    const home = resolveDefinition(graph, "Home");
    removeElement(home.rootElement, 4); // Footer
    const after = printFile(graph, "Home.tsx");
    expect(after).not.toContain("<Footer");
    expect(remainingOrder(after, ["Navbar", "Hero", "Card", "Button", "Footer"])).toEqual(["Navbar", "Hero", "Card", "Button"]);
  });

  it("rejects an out-of-range index rather than guessing", () => {
    const { graph } = loadFixture();
    const home = resolveDefinition(graph, "Home");
    expect(() => removeElement(home.rootElement, 99)).toThrow(/No element child/);
  });
});

describe("duplicate element", () => {
  it("inserts a clone immediately after the original in the middle", () => {
    const { graph, originalSources } = loadFixture();
    const home = resolveDefinition(graph, "Home");

    duplicateElement(home.rootElement, 2); // Card

    const before = originalSources.get("Home.tsx")!;
    const after = printFile(graph, "Home.tsx");
    const occurrences = after.split("<Card").length - 1;
    expect(occurrences).toBe(2);
    expect(changedFiles(graph, originalSources)).toEqual(new Set(["Home.tsx"]));
    // Only the duplicated element's own line(s) + indentation are new —
    // nothing else in the file gets reformatted.
    expect(after.length - before.length).toBeLessThan(200);
  });

  it("duplicates the first element, keeping the rest in place", () => {
    const { graph } = loadFixture();
    const home = resolveDefinition(graph, "Home");
    duplicateElement(home.rootElement, 0); // Navbar
    const after = printFile(graph, "Home.tsx");
    expect(after.split("<Navbar").length - 1).toBe(2);
    expect(after.split("<Hero").length - 1).toBe(1);
  });

  it("duplicates the last element", () => {
    const { graph } = loadFixture();
    const home = resolveDefinition(graph, "Home");
    duplicateElement(home.rootElement, 4); // Footer
    const after = printFile(graph, "Home.tsx");
    expect(after.split("<Footer").length - 1).toBe(2);
  });

  it("rejects an out-of-range index rather than guessing", () => {
    const { graph } = loadFixture();
    const home = resolveDefinition(graph, "Home");
    expect(() => duplicateElement(home.rootElement, 99)).toThrow(/No element child/);
  });

  it("the clone is independently editable from the original", () => {
    const { graph } = loadFixture();
    const home = resolveDefinition(graph, "Home");
    duplicateElement(home.rootElement, 2); // Card
    // Removing the clone (now at index 3) should leave exactly one Card.
    removeElement(home.rootElement, 3);
    const after = printFile(graph, "Home.tsx");
    expect(after.split("<Card").length - 1).toBe(1);
  });
});

describe("diff cleanliness", () => {
  it("touches no other files when editing one shared component", () => {
    const { graph, originalSources } = loadFixture();
    const target = resolveSharedClassTarget(graph, "Navbar");
    applyClassMutation(target, { op: "setBranch", branch: "consequent", value: "absolute top-0 left-0 right-0 h-20 bg-transparent text-white" });

    for (const filePath of ["Hero.tsx", "Card.tsx", "Footer.tsx", "Home.tsx", "Pricing.tsx", "About.tsx", "Button.tsx"]) {
      expect(printFile(graph, filePath)).toBe(originalSources.get(filePath));
    }
  });

  it("preserves formatting for every unrelated file byte-for-byte", () => {
    const { graph, originalSources, filePaths } = loadFixture();
    // No mutation at all — printing straight after parsing should round-trip exactly.
    for (const filePath of filePaths) {
      expect(printFile(graph, filePath)).toBe(originalSources.get(filePath));
    }
  });
});
