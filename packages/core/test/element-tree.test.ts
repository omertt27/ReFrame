import { describe, expect, it } from "vitest";

import { buildElementTree } from "../src/element-tree.js";
import { buildComponentGraph } from "../src/parse.js";
import { resolveDefinition } from "../src/resolve.js";

describe("buildElementTree", () => {
  it("collapses a single-child wrapper chain down to the meaningful leaf tag (a nav > ul > li > a chain)", () => {
    const graph = buildComponentGraph([
      {
        filePath: "X.tsx",
        source: `
          export default function Nav() {
            return (
              <nav>
                <ul>
                  <li>
                    <a href="/">Home</a>
                  </li>
                </ul>
              </nav>
            );
          }
        `,
      },
    ]);
    const def = resolveDefinition(graph, "Nav");
    const tree = buildElementTree(def.rootElement, graph);

    // nav/ul/li each have exactly one indexable child and no text/identity
    // of their own, so all three collapse — only the leaf `a` (in the
    // never-collapse tag set, and a text leaf itself) gets a row, still
    // addressed by its real, uncollapsed path.
    expect(tree).toEqual([{ path: [0, 0, 0], tag: "a", isComponent: false, isTextLeaf: true, children: [] }]);
  });

  it("does NOT collapse a wrapper with more than one meaningful child — reuses nested-selection.test.ts's AboutPage shape", () => {
    // Mirrors packages/core/test/nested-selection.test.ts's exact fixture:
    // main > section > div > h1, p, button. `section` has exactly one child
    // (div) and collapses; `div` has three children and is kept as its own
    // row — deliberately: a multi-child wrapper (e.g. a repeated "card" div
    // grouping an icon + heading + paragraph) needs to stay visible as a
    // group, or a page with several such groups would flatten into one
    // undifferentiated list and lose the grouping that made it legible.
    const graph = buildComponentGraph([
      {
        filePath: "X.tsx",
        source: `
          export default function AboutPage() {
            return (
              <main>
                <section>
                  <div>
                    <h1>About us</h1>
                    <p>Some text</p>
                    <button>Click</button>
                  </div>
                </section>
              </main>
            );
          }
        `,
      },
    ]);
    const def = resolveDefinition(graph, "AboutPage");
    const tree = buildElementTree(def.rootElement, graph);

    expect(tree).toEqual([
      {
        path: [0, 0],
        tag: "div",
        isComponent: false,
        isTextLeaf: false,
        children: [
          { path: [0, 0, 0], tag: "h1", isComponent: false, isTextLeaf: true, children: [] },
          { path: [0, 0, 1], tag: "p", isComponent: false, isTextLeaf: true, children: [] },
          { path: [0, 0, 2], tag: "button", isComponent: false, isTextLeaf: true, children: [] },
        ],
      },
    ]);
  });

  it("shows a known component usage as its own leaf row, never expanded into its internals", () => {
    // Reuses nested-selection.test.ts's "named components interspersed with
    // plain HTML" fixture.
    const graph = buildComponentGraph([
      { filePath: "Card.tsx", source: `export default function Card({ title }) { return <div>{title}</div>; }` },
      {
        filePath: "X.tsx",
        source: `
          import Card from "./Card";
          export default function HomePage() {
            return (
              <div>
                <p>intro</p>
                <Card title="one" />
                <p>outro</p>
              </div>
            );
          }
        `,
      },
    ]);
    const def = resolveDefinition(graph, "HomePage");
    const tree = buildElementTree(def.rootElement, graph);

    expect(tree).toEqual([
      { path: [0], tag: "p", isComponent: false, isTextLeaf: true, children: [] },
      { path: [1], tag: "Card", isComponent: true, isTextLeaf: false, children: [] },
      { path: [2], tag: "p", isComponent: false, isTextLeaf: true, children: [] },
    ]);
  });
});
