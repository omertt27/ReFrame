import { describe, expect, it } from "vitest";

import { applyClassMutation } from "../src/mutate/class.js";
import { replaceUtilityClass } from "../src/mutate/tailwind.js";
import { buildComponentGraph } from "../src/parse.js";
import {
  resolveAllUsages,
  resolveComponentAtRoute,
  resolveDefinition,
  resolveSharedClassTarget,
  resolveUsage,
} from "../src/resolve.js";
import { printFile } from "../src/write.js";

// Stress-test matrix requested after the click-to-edit spike: prove exactly
// what the engine supports and — just as important — that everything
// outside that boundary fails loudly with a specific reason, never silently.

describe("1. direct Tailwind token replace", () => {
  it("replaces height, padding, and text-size tokens", () => {
    expect(replaceUtilityClass("h-16 bg-white", "h-16", "h-20")).toBe("h-20 bg-white");
    expect(replaceUtilityClass("px-4 py-2", "px-4", "px-6")).toBe("px-6 py-2");
    expect(replaceUtilityClass("text-sm font-medium", "text-sm", "text-lg")).toBe("text-lg font-medium");
  });

  it("never touches a token that merely contains `find` as a substring", () => {
    // A naive string.replace would corrupt "sm:p-4" while targeting "p-4".
    expect(replaceUtilityClass("sm:p-4 p-4 p-40", "p-4", "p-8")).toBe("sm:p-4 p-8 p-40");
  });
});

describe("4. responsive breakpoint targeting", () => {
  it("changes only the specified breakpoint-prefixed token", () => {
    expect(replaceUtilityClass("p-4 md:p-6 lg:p-8", "lg:p-8", "lg:p-10")).toBe("p-4 md:p-6 lg:p-10");
  });
});

describe("2. conditional classes — cn()/clsx() with multiple conditions", () => {
  const src = `
    export default function Button({ isActive, isDisabled }) {
      return <button className={cn("base flex", isActive && "bg-blue-500", isDisabled && "opacity-50")}>x</button>;
    }
  `;

  it("extracts every argument independently", () => {
    const graph = buildComponentGraph([{ filePath: "Button.tsx", source: src }]);
    const target = resolveSharedClassTarget(graph, "Button");
    if (target.ir.kind !== "clsxCall" || !target.ir.args) throw new Error("expected parsed clsx args");
    expect(target.ir.args.map((a) => a.value)).toEqual(["base flex", "bg-blue-500", "opacity-50"]);
    expect(target.ir.args.map((a) => a.kind)).toEqual(["string", "conditional", "conditional"]);
  });

  it("marks identifier and negated-identifier tests evaluable, leaves a member-expression test non-evaluable", () => {
    const graph = buildComponentGraph([
      { filePath: "Button.tsx", source: src },
      {
        filePath: "Toggle.tsx",
        source: `
          export default function Toggle({ collapsed }) {
            return <div className={cn("base", !collapsed && "expanded")}>x</div>;
          }
        `,
      },
      {
        filePath: "Card.tsx",
        source: `
          export default function Card({ state }) {
            return <div className={cn("base", state.open && "open")}>x</div>;
          }
        `,
      },
    ]);

    const button = resolveSharedClassTarget(graph, "Button");
    if (button.ir.kind !== "clsxCall" || !button.ir.args) throw new Error("expected parsed clsx args");
    expect(button.ir.args.map((a) => (a.kind === "conditional" ? a.evaluable : undefined))).toEqual([
      undefined,
      { propName: "isActive", negated: false },
      { propName: "isDisabled", negated: false },
    ]);

    const toggle = resolveSharedClassTarget(graph, "Toggle");
    if (toggle.ir.kind !== "clsxCall" || !toggle.ir.args) throw new Error("expected parsed clsx args");
    const expanded = toggle.ir.args.find((a) => a.kind === "conditional");
    expect(expanded?.kind === "conditional" ? expanded.evaluable : "missing").toEqual({
      propName: "collapsed",
      negated: true,
    });

    const card = resolveSharedClassTarget(graph, "Card");
    if (card.ir.kind !== "clsxCall" || !card.ir.args) throw new Error("expected parsed clsx args");
    const open = card.ir.args.find((a) => a.kind === "conditional");
    expect(open?.kind === "conditional" ? open.evaluable : "missing").toBeNull();
  });

  it("edits one conditional argument without touching the other or the static base", () => {
    const graph = buildComponentGraph([{ filePath: "Button.tsx", source: src }]);
    const target = resolveSharedClassTarget(graph, "Button");
    applyClassMutation(target, { op: "setClsxArg", index: 2, value: "opacity-30" });

    const after = printFile(graph, "Button.tsx");
    expect(after).toContain("opacity-30");
    expect(after).toContain("bg-blue-500"); // untouched
    expect(after).toContain("base flex"); // untouched
    expect(after).toContain("isDisabled &&"); // test expression untouched
  });
});

describe("3. shared vs instance with different prop overrides", () => {
  it("resolves distinct usages by prop value across three call sites", () => {
    const graph = buildComponentGraph([
      {
        filePath: "Navbar.tsx",
        source: `export default function Navbar({ variant }) {
          return <header className={variant === "transparent" ? "a" : "b"}>x</header>;
        }`,
      },
      {
        filePath: "app/page.tsx",
        source: `import Navbar from "../Navbar";
          export default function Home() { return <Navbar variant="transparent" />; }`,
      },
      {
        filePath: "app/pricing/page.tsx",
        source: `import Navbar from "../../Navbar";
          export default function Pricing() { return <Navbar variant="solid" />; }`,
      },
      {
        filePath: "app/about/page.tsx",
        source: `import Navbar from "../../Navbar";
          export default function About() { return <Navbar variant="solid" />; }`,
      },
    ]);

    const home = resolveComponentAtRoute(graph, "Navbar", "/");
    const pricing = resolveComponentAtRoute(graph, "Navbar", "/pricing");
    const about = resolveComponentAtRoute(graph, "Navbar", "/about");
    expect("props" in home && home.props.variant).toBe("transparent");
    expect("props" in pricing && pricing.props.variant).toBe("solid");
    expect("props" in about && about.props.variant).toBe("solid");
  });
});

describe("5. nested components (Page -> Hero -> CTA -> Button)", () => {
  const files = [
    {
      filePath: "app/components/Button.tsx",
      source: `export default function Button() {
        return <button className="rounded-full px-4 py-2">Go</button>;
      }`,
    },
    {
      filePath: "app/components/CTA.tsx",
      source: `import Button from "./Button";
        export default function CTA() {
          return <div className="flex justify-center"><Button /></div>;
        }`,
    },
    {
      filePath: "app/components/Hero.tsx",
      source: `import CTA from "./CTA";
        export default function Hero() {
          return <section className="min-h-screen"><CTA /></section>;
        }`,
    },
    {
      filePath: "app/page.tsx",
      source: `import Hero from "./components/Hero";
        export default function HomePage() {
          return <Hero />;
        }`,
    },
  ];

  it("resolves Button to its own definition file, not Hero's or the page's", () => {
    const graph = buildComponentGraph(files);
    const buttonDef = resolveDefinition(graph, "Button");
    expect(buttonDef.filePath).toBe("app/components/Button.tsx");

    const target = resolveSharedClassTarget(graph, "Button");
    expect(target.ir).toEqual({ kind: "string", value: "rounded-full px-4 py-2" });
  });

  it("mutating Button's className only touches Button.tsx, not Hero/CTA/Page", () => {
    const graph = buildComponentGraph(files);
    const originalSources = new Map(files.map((f) => [f.filePath, f.source]));
    const target = resolveSharedClassTarget(graph, "Button");
    applyClassMutation(target, { op: "setString", value: "rounded-full px-6 py-2" });

    expect(printFile(graph, "app/components/Button.tsx")).toContain("px-6");
    for (const filePath of ["app/components/CTA.tsx", "app/components/Hero.tsx", "app/page.tsx"]) {
      expect(printFile(graph, filePath)).toBe(originalSources.get(filePath));
    }
  });
});

describe("6. multiple usages of one component in the same file", () => {
  it("resolveAllUsages finds every instance with its distinct props", () => {
    const cards = Array.from({ length: 10 }, (_, i) => `<Card title="Card ${i}" />`).join("\n");
    const graph = buildComponentGraph([
      {
        filePath: "Card.tsx",
        source: `export default function Card({ title }) { return <div className="p-4">{title}</div>; }`,
      },
      {
        filePath: "app/page.tsx",
        source: `import Card from "../Card";
          export default function Home() { return <div>${cards}</div>; }`,
      },
    ]);

    const usages = resolveAllUsages(graph, "Card");
    expect(usages).toHaveLength(10);
    expect(usages.map((u) => u.props.title)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Card ${i}`),
    );
  });

  it("fails loudly instead of silently picking one when scoped to that file", () => {
    const cards = Array.from({ length: 10 }, (_, i) => `<Card title="Card ${i}" />`).join("\n");
    const graph = buildComponentGraph([
      {
        filePath: "Card.tsx",
        source: `export default function Card({ title }) { return <div className="p-4">{title}</div>; }`,
      },
      {
        filePath: "app/page.tsx",
        source: `import Card from "../Card";
          export default function Home() { return <div>${cards}</div>; }`,
      },
    ]);

    expect(() => resolveUsage(graph, "Card", "app/page.tsx")).toThrow(/can't disambiguate/);
    expect(() => resolveComponentAtRoute(graph, "Card", "/")).toThrow(/can't disambiguate/);
  });
});

describe("7. unsupported expressions are reported, never guessed", () => {
  function irFor(source: string) {
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    return resolveDefinition(graph, "X").classAttr?.ir;
  }

  it("a direct function call is reported with the callee named", () => {
    const ir = irFor(`export default function X({ theme, variant, user }) {
      return <div className={getNavbarClasses(theme, variant, user)}>x</div>;
    }`);
    expect(ir?.kind).toBe("unsupported");
    expect(ir?.kind === "unsupported" && ir.reason).toMatch(/getNavbarClasses/);
  });

  it("a variable computed from a function call earlier is reported too, generically", () => {
    const ir = irFor(`export default function X({ theme, variant, user }) {
      const classes = getNavbarClasses(theme, variant, user);
      return <div className={classes}>x</div>;
    }`);
    expect(ir?.kind).toBe("unsupported");
  });

  it("a template literal is reported specifically", () => {
    const ir = irFor(`export default function X({ extra }) {
      return <div className={\`h-16 \${extra}\`}>x</div>;
    }`);
    expect(ir?.kind).toBe("unsupported");
    expect(ir?.kind === "unsupported" && ir.reason).toMatch(/template literal/);
  });

  it("a ternary driven by a derived variable is reported with its own specific reason", () => {
    const ir = irFor(`export default function X({ variant }) {
      const isTransparent = variant === "transparent";
      return <div className={isTransparent ? "a" : "b"}>x</div>;
    }`);
    expect(ir?.kind).toBe("unsupported");
    expect(ir?.kind === "unsupported" && ir.reason).toMatch(/variable derived from/);
  });

  it("a chained/nested ternary is reported specifically, not partially applied", () => {
    const ir = irFor(`export default function X({ variant }) {
      return <div className={variant === "a" ? "x" : variant === "b" ? "y" : "z"}>x</div>;
    }`);
    expect(ir?.kind).toBe("unsupported");
    expect(ir?.kind === "unsupported" && ir.reason).toMatch(/nested|chained/);
  });

  it("resolveSharedClassTarget surfaces the specific reason, not a generic error", () => {
    const graph = buildComponentGraph([
      {
        filePath: "X.tsx",
        source: `export default function X({ theme, variant, user }) {
          return <div className={getNavbarClasses(theme, variant, user)}>x</div>;
        }`,
      },
    ]);
    expect(() => resolveSharedClassTarget(graph, "X")).toThrow(/getNavbarClasses/);
  });
});
