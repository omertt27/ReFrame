import { describe, expect, it } from "vitest";

import { buildComponentGraph } from "../src/parse.js";
import { resolveComponentAtRoute, routeLayoutFiles, routeToPageFile } from "../src/resolve.js";

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
