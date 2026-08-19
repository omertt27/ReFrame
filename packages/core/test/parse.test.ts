import * as t from "@babel/types";
import { describe, expect, it } from "vitest";

import { buildComponentGraph } from "../src/parse.js";

function nameOf(node: t.JSXElement | t.JSXFragment): string {
  if (!t.isJSXElement(node)) return "Fragment";
  const name = node.openingElement.name;
  return "name" in name ? (name as { name: string }).name : "?";
}

describe("buildComponentGraph — arrow-function and function-expression components", () => {
  // Found via a real-world comparison against Excalidraw (a second, genuinely
  // different real project — see project memory `reframe-second-project-
  // comparison`): 68/86 of its real components use this shape, and were
  // completely invisible to buildComponentGraph before this fix (0
  // components detected in a real file that has one). PrivaPDF, this
  // session's original test subject, happens to use only FunctionDeclaration
  // (68/68) — which is exactly why this gap went unnoticed for so long.

  it("detects an arrow function component with a block body", () => {
    const source = `
      const Card = ({ title }) => {
        return <div className="Card">{title}</div>;
      };
    `;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    expect(graph.definitions.has("Card")).toBe(true);
    expect(nameOf(graph.definitions.get("Card")!.rootElement)).toBe("div");
  });

  it("detects an arrow function component with an implicit-return expression body (parenthesized)", () => {
    const source = `
      const ButtonSeparator = () => (
        <div className="ButtonSeparator" />
      );
    `;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    expect(graph.definitions.has("ButtonSeparator")).toBe(true);
    expect(nameOf(graph.definitions.get("ButtonSeparator")!.rootElement)).toBe("div");
  });

  it("detects an arrow function component with an implicit-return expression body (no parens)", () => {
    const source = `const HelpButton = () => <button className="help" />;`;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    expect(graph.definitions.has("HelpButton")).toBe(true);
    expect(nameOf(graph.definitions.get("HelpButton")!.rootElement)).toBe("button");
  });

  it("detects a plain function-expression component (const X = function () {...})", () => {
    const source = `
      const Legacy = function () {
        return <span>x</span>;
      };
    `;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    expect(graph.definitions.has("Legacy")).toBe(true);
  });

  it("extracts classAttr/styleAttr for an arrow component exactly like a FunctionDeclaration one", () => {
    const source = `
      const Card = () => {
        return <div className="Card" style={{ padding: 16 }} />;
      };
    `;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    const def = graph.definitions.get("Card")!;
    expect(def.classAttr?.ir).toEqual({ kind: "string", value: "Card" });
    expect(def.styleAttr?.ir.kind).toBe("object");
  });

  it("does not treat a lowercase-named const arrow function as a component (e.g. a hook)", () => {
    const source = `const useThing = () => { return <div />; };`;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    expect(graph.definitions.has("useThing")).toBe(false);
  });

  it("does not treat a non-JSX-returning arrow function as a component", () => {
    const source = `const Add = (a, b) => a + b;`;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    expect(graph.definitions.has("Add")).toBe(false);
  });

  it("does not false-positive on a capitalized const assigned to a non-function call (e.g. React.createContext)", () => {
    const source = `const ThemeContext = React.createContext({ dark: false });`;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    expect(graph.definitions.has("ThemeContext")).toBe(false);
  });

  it("computes isDefaultExport correctly for an arrow-const component", () => {
    const source = `
      const Page = () => { return <main />; };
      export default Page;
    `;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    expect(graph.definitions.get("Page")!.isDefaultExport).toBe(true);
  });

  it("detects both FunctionDeclaration and arrow-const components in the same file", () => {
    const source = `
      export default function Page() { return <main><Header /></main>; }
      const Header = () => { return <header />; };
    `;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    expect(graph.definitions.has("Page")).toBe(true);
    expect(graph.definitions.has("Header")).toBe(true);
    expect(graph.definitions.get("Page")!.isDefaultExport).toBe(true);
    expect(graph.definitions.get("Header")!.isDefaultExport).toBe(false);
  });

  it("registers a usage site for an arrow-const component the same as a FunctionDeclaration one", () => {
    const source = `
      const Card = () => { return <div className="Card" />; };
      const Page = () => { return <div><Card /></div>; };
    `;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    expect(graph.usages.some((u) => u.component === "Card")).toBe(true);
  });
});
