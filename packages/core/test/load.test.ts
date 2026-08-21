import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadProjectFiles } from "../src/load.js";

describe("loadProjectFiles", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reframe-load-test-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("normalizes <rootDir>/app/page.tsx to app/page.tsx", () => {
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(join(root, "app", "page.tsx"), "export default function Home() { return null; }");

    const files = loadProjectFiles(root);
    expect(files.map((f) => f.filePath)).toEqual(["app/page.tsx"]);
  });

  it("normalizes <rootDir>/src/app/page.tsx to app/page.tsx (Next.js src/ layout)", () => {
    mkdirSync(join(root, "src", "app", "pricing"), { recursive: true });
    writeFileSync(join(root, "src", "app", "page.tsx"), "export default function Home() { return null; }");
    writeFileSync(join(root, "src", "app", "pricing", "page.tsx"), "export default function Pricing() { return null; }");

    const files = loadProjectFiles(root).map((f) => f.filePath).sort();
    expect(files).toEqual(["app/page.tsx", "app/pricing/page.tsx"]);
  });

  it("prefers <rootDir>/app over <rootDir>/src/app if both somehow exist", () => {
    mkdirSync(join(root, "app"), { recursive: true });
    mkdirSync(join(root, "src", "app"), { recursive: true });
    writeFileSync(join(root, "app", "page.tsx"), "export default function Home() { return null; }");
    writeFileSync(join(root, "src", "app", "page.tsx"), "export default function Other() { return null; }");

    const files = loadProjectFiles(root);
    expect(files.map((f) => f.filePath)).toEqual(["app/page.tsx"]);
  });

  it("falls back to scanning rootDir directly when neither app dir exists", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "Main.tsx"), "export default function Main() { return null; }");

    const files = loadProjectFiles(root);
    expect(files.map((f) => f.filePath)).toEqual(["src/Main.tsx"]);
  });
});
