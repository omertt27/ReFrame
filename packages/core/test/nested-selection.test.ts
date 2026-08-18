import { describe, expect, it } from "vitest";

import { buildComponentGraph } from "../src/parse.js";
import { resolveDefinition, resolveElementPath } from "../src/resolve.js";
import { extractClassAttr } from "../src/parse.js";

function nameOf(node: ReturnType<typeof resolveElementPath>): string | null {
  if (!node) return null;
  if ("openingElement" in node) {
    const name = node.openingElement.name;
    return "name" in name ? (name as { name: string }).name : null;
  }
  return "Fragment";
}

describe("resolveElementPath — single-element-rooted component", () => {
  // Mirrors the real-world stress test's exact case: a monolithic component
  // with plain nested HTML, no sub-components.
  const source = `
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
  `;

  it("path: [] resolves to the root element itself (today's existing behavior, unchanged)", () => {
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    const def = resolveDefinition(graph, "AboutPage");
    expect(nameOf(resolveElementPath(def.rootElement, []))).toBe("main");
  });

  it("resolves an arbitrarily deep nested element via its index path", () => {
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    const def = resolveDefinition(graph, "AboutPage");
    // main -> section[0] -> div[0] -> button[2]
    expect(nameOf(resolveElementPath(def.rootElement, [0, 0, 2]))).toBe("button");
    expect(nameOf(resolveElementPath(def.rootElement, [0, 0, 0]))).toBe("h1");
    expect(nameOf(resolveElementPath(def.rootElement, [0, 0, 1]))).toBe("p");
  });

  it("returns null (never guesses) for an out-of-bounds index at any level", () => {
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    const def = resolveDefinition(graph, "AboutPage");
    expect(resolveElementPath(def.rootElement, [0, 0, 99])).toBeNull();
    expect(resolveElementPath(def.rootElement, [5])).toBeNull();
  });

  it("the resolved nested element's own className is independently editable via extractClassAttr", () => {
    const styled = `
      export default function X({ variant }) {
        return (
          <main>
            <div>
              <h1 className={variant === "big" ? "text-lg" : "text-sm"}>Heading</h1>
            </div>
          </main>
        );
      }
    `;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source: styled }]);
    const def = resolveDefinition(graph, "X");
    const h1 = resolveElementPath(def.rootElement, [0, 0]);
    expect(nameOf(h1)).toBe("h1");
    const classAttr = extractClassAttr(h1 as Parameters<typeof extractClassAttr>[0]);
    expect(classAttr?.ir.kind).toBe("ternary");
  });
});

describe("resolveElementPath — Fragment-rooted component", () => {
  // Mirrors PrivaPDF's actual AboutPage shape: <>{scripts}<main>...</main></>
  const source = `
    export default function AboutPage() {
      return (
        <>
          <script type="application/ld+json" />
          <script type="application/ld+json" />
          <main>
            <h1>Real heading</h1>
          </main>
        </>
      );
    }
  `;

  it("indexes fragment children the same way pageSectionOrder already does", () => {
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    const def = resolveDefinition(graph, "AboutPage");
    expect(nameOf(resolveElementPath(def.rootElement, [2]))).toBe("main"); // after the two scripts
    expect(nameOf(resolveElementPath(def.rootElement, [2, 0]))).toBe("h1");
  });
});

describe("resolveElementPath — named components interspersed with plain HTML", () => {
  // Confirms path resolution stops being relevant once a nested named
  // component boundary is crossed — that's resolveComponentAtRoute's job,
  // not resolveElementPath's; this just verifies indexing counts a named
  // component usage as one element slot, same as jsxChildren/pageSectionOrder.
  const source = `
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
  `;

  it("counts a named component usage as one indexed slot among its siblings", () => {
    const graph = buildComponentGraph([
      { filePath: "Card.tsx", source: `export default function Card({ title }) { return <div>{title}</div>; }` },
      { filePath: "X.tsx", source },
    ]);
    const def = resolveDefinition(graph, "HomePage");
    expect(nameOf(resolveElementPath(def.rootElement, [0]))).toBe("p");
    expect(nameOf(resolveElementPath(def.rootElement, [1]))).toBe("Card");
    expect(nameOf(resolveElementPath(def.rootElement, [2]))).toBe("p");
  });
});
