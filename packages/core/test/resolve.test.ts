import { describe, expect, it } from "vitest";

import { moveChild } from "../src/mutate/move.js";
import { buildComponentGraph } from "../src/parse.js";
import { listPageRoutes, pageSectionOrder, resolveDefinitionByFile, resolveComponentAtRoute, routeLayoutFiles, routeToPageFile } from "../src/resolve.js";
import { printFile } from "../src/write.js";

// Mirrors fixtures/onlook-validation-app's real (nested) shape: a shared
// Navbar defined under app/components/, used directly in two page files,
// plus a root layout that doesn't use it at all.
function loadNestedFixture() {
  const files = [
    {
      filePath: "app/components/Navbar.tsx",
      source: `
        export default function Navbar({ variant }) {
          return <header className={variant === "transparent" ? "bg-transparent" : "bg-white"}>x</header>;
        }
      `,
    },
    {
      filePath: "app/layout.tsx",
      source: `
        export default function RootLayout({ children }) {
          return <html><body>{children}</body></html>;
        }
      `,
    },
    {
      filePath: "app/page.tsx",
      source: `
        import Navbar from "./components/Navbar";
        export default function HomePage() {
          return <><Navbar variant="transparent" /></>;
        }
      `,
    },
    {
      filePath: "app/pricing/page.tsx",
      source: `
        import Navbar from "../components/Navbar";
        export default function PricingPage() {
          return <><Navbar variant="solid" /></>;
        }
      `,
    },
  ];
  return buildComponentGraph(files);
}

describe("routeToPageFile / routeLayoutFiles", () => {
  it("maps the root route", () => {
    expect(routeToPageFile("/")).toBe("app/page.tsx");
    expect(routeLayoutFiles("/")).toEqual(["app/layout.tsx"]);
  });

  it("maps a nested route and its ancestor layout chain", () => {
    expect(routeToPageFile("/pricing")).toBe("app/pricing/page.tsx");
    expect(routeLayoutFiles("/pricing")).toEqual(["app/layout.tsx", "app/pricing/layout.tsx"]);
  });
});

describe("listPageRoutes", () => {
  it("finds every page.tsx and derives its route, inverse of routeToPageFile", () => {
    const graph = buildComponentGraph([
      { filePath: "app/page.tsx", source: `export default function HomePage() { return <div />; }` },
      { filePath: "app/pricing/page.tsx", source: `export default function PricingPage() { return <div />; }` },
      { filePath: "app/about/page.tsx", source: `export default function AboutPage() { return <div />; }` },
      { filePath: "app/layout.tsx", source: `export default function RootLayout({ children }) { return <html>{children}</html>; }` },
      { filePath: "app/components/Navbar.tsx", source: `export default function Navbar() { return <header />; }` },
    ]);

    expect(listPageRoutes(graph)).toEqual([
      { route: "/", pageComponent: "HomePage" },
      { route: "/about", pageComponent: "AboutPage" },
      { route: "/pricing", pageComponent: "PricingPage" },
    ]);
  });

  it("ignores local helper components co-located in the same page file — regression for a real bug found against PrivaPDF's /tools page", () => {
    // Real code often defines small subcomponents directly in a page file
    // instead of splitting them out (e.g. src/app/tools/page.tsx defining
    // MergePanel, SplitPanel, CompressPanel, ... alongside the actual page).
    // Without tracking the default export specifically, every one of those
    // helpers looked like its own separate "page" at the same route.
    const graph = buildComponentGraph([
      {
        filePath: "app/tools/page.tsx",
        source: `
          function MergePanel() { return <div>merge</div>; }
          function SplitPanel() { return <div>split</div>; }
          export default function ToolsPage() {
            return <div><MergePanel /><SplitPanel /></div>;
          }
        `,
      },
    ]);

    expect(listPageRoutes(graph)).toEqual([{ route: "/tools", pageComponent: "ToolsPage" }]);
  });
});

describe("resolveDefinitionByFile with co-located helpers", () => {
  it("resolves to the default export, not whichever helper happens to be defined first", () => {
    const graph = buildComponentGraph([
      {
        filePath: "app/dashboard/page.tsx",
        source: `
          function StatBar() { return <div>stats</div>; }
          function LicenseCard() { return <div>license</div>; }
          export default function DashboardPage() {
            return <div><StatBar /><LicenseCard /></div>;
          }
        `,
      },
    ]);

    const def = resolveDefinitionByFile(graph, "app/dashboard/page.tsx");
    expect(def?.name).toBe("DashboardPage");
    expect(def?.isDefaultExport).toBe(true);
  });
});

describe("resolveComponentAtRoute", () => {
  it("resolves a shared component to the correct route-specific usage", () => {
    const graph = loadNestedFixture();

    const home = resolveComponentAtRoute(graph, "Navbar", "/");
    expect("props" in home && home.props.variant).toBe("transparent");

    const pricing = resolveComponentAtRoute(graph, "Navbar", "/pricing");
    expect("props" in pricing && pricing.props.variant).toBe("solid");
  });

  it("resolves the route's own page component via its definition, not a usage", () => {
    const graph = loadNestedFixture();
    const result = resolveComponentAtRoute(graph, "HomePage", "/");
    expect("rootElement" in result).toBe(true);
    expect("props" in result).toBe(false);
  });

  it("throws when nothing matches the route", () => {
    const graph = loadNestedFixture();
    expect(() => resolveComponentAtRoute(graph, "Navbar", "/about")).toThrow(/No usage or definition/);
  });
});

function loadMultiSectionFixture() {
  const section = (name: string) =>
    `export default function ${name}() { return <div className="${name.toLowerCase()}">${name}</div>; }`;
  return buildComponentGraph([
    { filePath: "app/components/Navbar.tsx", source: section("Navbar") },
    { filePath: "app/components/Hero.tsx", source: section("Hero") },
    { filePath: "app/components/Card.tsx", source: section("Card") },
    { filePath: "app/components/Footer.tsx", source: section("Footer") },
    {
      filePath: "app/page.tsx",
      source: `
        import Navbar from "./components/Navbar";
        import Hero from "./components/Hero";
        import Card from "./components/Card";
        import Footer from "./components/Footer";
        export default function HomePage() {
          return (
            <>
              <Navbar />
              <Hero />
              <Card />
              <Footer />
            </>
          );
        }
      `,
    },
  ]);
}

function sectionIndexByName(sections: { name: string; index: number }[], name: string): number {
  return sections.find((s) => s.name === name)!.index;
}

describe("pageSectionOrder", () => {
  it("lists the page's direct known-component children in order, with moveChild-compatible indices", () => {
    const graph = loadMultiSectionFixture();
    expect(pageSectionOrder(graph, "/")).toEqual([
      { name: "Navbar", index: 0 },
      { name: "Hero", index: 1 },
      { name: "Card", index: 2 },
      { name: "Footer", index: 3 },
    ]);
  });

  it("returns null for a route whose page can't be found", () => {
    const graph = loadMultiSectionFixture();
    expect(pageSectionOrder(graph, "/nowhere")).toBeNull();
  });

  it("feeds directly into moveChild for a drag-drop reorder, indices matching exactly", () => {
    const graph = loadMultiSectionFixture();
    const order = pageSectionOrder(graph, "/")!;
    const pageDef = resolveDefinitionByFile(graph, "app/page.tsx")!;

    // Drag Card to before Hero — same as a user dropping it there in the canvas.
    moveChild(pageDef.rootElement, sectionIndexByName(order, "Card"), sectionIndexByName(order, "Hero"));

    const after = printFile(graph, "app/page.tsx");
    const positions = ["Navbar", "Card", "Hero", "Footer"].map((name) => after.indexOf(`<${name}`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    // pageSectionOrder reads the live (mutated) AST, so it reflects the new order too.
    expect(pageSectionOrder(graph, "/")!.map((s) => s.name)).toEqual(["Navbar", "Card", "Hero", "Footer"]);
  });

  it("computes real indices correctly when a non-component element sits between sections — regression for the exact live bug found via the drag e2e test", () => {
    const graph = buildComponentGraph([
      { filePath: "app/components/Navbar.tsx", source: `export default function Navbar() { return <header>x</header>; }` },
      { filePath: "app/components/Hero.tsx", source: `export default function Hero() { return <section>x</section>; }` },
      { filePath: "app/components/Footer.tsx", source: `export default function Footer() { return <footer>x</footer>; }` },
      {
        filePath: "app/page.tsx",
        source: `
          import Navbar from "./components/Navbar";
          import Hero from "./components/Hero";
          import Footer from "./components/Footer";
          export default function HomePage() {
            return (
              <>
                <Navbar />
                <Hero />
                <section className="cards">not a known component — a raw wrapper</section>
                <Footer />
              </>
            );
          }
        `,
      },
    ]);

    const order = pageSectionOrder(graph, "/")!;
    // Footer's REAL index must be 3 (Navbar=0, Hero=1, the raw <section>=2,
    // Footer=3) — NOT 2, which is what a naively-filtered "sections only"
    // index would wrongly compute, and would move the raw <section> instead
    // of Footer when passed to moveChild.
    expect(order).toEqual([
      { name: "Navbar", index: 0 },
      { name: "Hero", index: 1 },
      { name: "Footer", index: 3 },
    ]);

    const pageDef = resolveDefinitionByFile(graph, "app/page.tsx")!;
    moveChild(pageDef.rootElement, sectionIndexByName(order, "Footer"), sectionIndexByName(order, "Navbar"));

    const after = printFile(graph, "app/page.tsx");
    // Footer must have actually moved — not the raw <section> wrapper.
    expect(after.indexOf("<Footer")).toBeLessThan(after.indexOf("<Navbar"));
    expect(after.indexOf("<Navbar")).toBeLessThan(after.indexOf("<Hero"));
    expect(after).toContain('className="cards"'); // the raw wrapper is untouched, still present
  });
});
