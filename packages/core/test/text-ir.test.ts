import { describe, expect, it } from "vitest";

import { buildComponentGraph } from "../src/parse.js";
import { resolveDefinition, resolveElementPath } from "../src/resolve.js";
import { extractTextIR } from "../src/text-ir.js";
import { writeTextContent } from "../src/mutate/text.js";
import { printFile } from "../src/write.js";

describe("extractTextIR", () => {
  it("recognizes a plain single text-leaf element", () => {
    const source = `
      export default function X() {
        return <p className="about-summary">Hello world, this is a test.</p>;
      }
    `;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    const def = resolveDefinition(graph, "X");
    const ir = extractTextIR(def.rootElement);
    expect(ir.kind).toBe("text");
    expect(ir.kind === "text" && ir.value).toBe("Hello world, this is a test.");
  });

  it("trims surrounding source whitespace/indentation from the extracted value", () => {
    const source = `
      export default function X() {
        return (
          <p>
            Hello world, this is a test.
          </p>
        );
      }
    `;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    const def = resolveDefinition(graph, "X");
    const ir = extractTextIR(def.rootElement);
    expect(ir.kind === "text" && ir.value).toBe("Hello world, this is a test.");
  });

  it("refuses mixed text + nested element content", () => {
    const source = `
      export default function X() {
        return <h1>Hello <em>world</em></h1>;
      }
    `;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    const def = resolveDefinition(graph, "X");
    const ir = extractTextIR(def.rootElement);
    expect(ir.kind).toBe("unsupported");
  });

  it("refuses text + expression interpolation content", () => {
    const source = `
      export default function X({ name }) {
        return <p>Hello {name}</p>;
      }
    `;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    const def = resolveDefinition(graph, "X");
    const ir = extractTextIR(def.rootElement);
    expect(ir.kind).toBe("unsupported");
  });

  it("refuses pure expression content with no literal text at all", () => {
    const source = `
      export default function X({ count }) {
        return <span>{count}</span>;
      }
    `;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    const def = resolveDefinition(graph, "X");
    const ir = extractTextIR(def.rootElement);
    expect(ir.kind).toBe("unsupported");
  });

  it("refuses a whitespace-only / empty element", () => {
    const source = `
      export default function X() {
        return <div>   </div>;
      }
    `;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    const def = resolveDefinition(graph, "X");
    const ir = extractTextIR(def.rootElement);
    expect(ir.kind).toBe("unsupported");
  });

  it("recognizes plain text inside a Fragment root", () => {
    const source = `
      export default function X() {
        return <>Hello world</>;
      }
    `;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    const def = resolveDefinition(graph, "X");
    const ir = extractTextIR(def.rootElement);
    expect(ir.kind === "text" && ir.value).toBe("Hello world");
  });

  it("works the same on a nested element resolved via resolveElementPath", () => {
    const source = `
      export default function X() {
        return (
          <div>
            <section>
              <p>Nested text here.</p>
            </section>
          </div>
        );
      }
    `;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    const def = resolveDefinition(graph, "X");
    const p = resolveElementPath(def.rootElement, [0, 0]);
    expect(p).not.toBeNull();
    const ir = extractTextIR(p!);
    expect(ir.kind === "text" && ir.value).toBe("Nested text here.");
  });
});

describe("writeTextContent", () => {
  it("writes a new value and it round-trips through printFile", () => {
    const source = `
      export default function X() {
        return <p className="about-summary">Hello world, this is a test.</p>;
      }
    `;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    const def = resolveDefinition(graph, "X");
    const ir = extractTextIR(def.rootElement);
    expect(ir.kind).toBe("text");

    const result = writeTextContent(ir, "Goodbye world, this changed.");
    expect(result.ok).toBe(true);

    const printed = printFile(graph, "X.tsx");
    expect(printed).toContain("Goodbye world, this changed.");
    expect(printed).not.toContain("Hello world, this is a test.");
  });

  it("refuses a value containing a reserved JSX character", () => {
    const source = `
      export default function X() {
        return <p>Hello world</p>;
      }
    `;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    const def = resolveDefinition(graph, "X");
    const ir = extractTextIR(def.rootElement);

    expect(writeTextContent(ir, "unsafe < value").ok).toBe(false);
    expect(writeTextContent(ir, "unsafe { value").ok).toBe(false);
  });

  it("refuses to write when the IR itself is unsupported", () => {
    const source = `
      export default function X() {
        return <h1>Hello <em>world</em></h1>;
      }
    `;
    const graph = buildComponentGraph([{ filePath: "X.tsx", source }]);
    const def = resolveDefinition(graph, "X");
    const ir = extractTextIR(def.rootElement);
    expect(writeTextContent(ir, "anything").ok).toBe(false);
  });
});
