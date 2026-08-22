import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import * as t from "@babel/types";
import { describe, expect, it } from "vitest";

import { jsxChildren } from "../src/jsx-utils.js";
import { applyClassMutation } from "../src/mutate/class.js";
import { buildComponentGraph, extractClassAttr } from "../src/parse.js";
import { printFile } from "../src/write.js";

/**
 * Runs the headless engine (parse -> resolve -> mutate -> write) against
 * real, public repos, instead of the hand-written `basic-tailwind-app`
 * fixture every other test file uses. Past real-world bug classes
 * (arrow-function component detection, recast diff-noise) were only ever
 * caught by a human manually clicking through a real app in a live session
 * -- this turns that into an assertion that runs on every `pnpm
 * test:corpus`, so a regression fails here instead of waiting for the next
 * manual session to notice.
 *
 * The corpus itself is never committed (test/fixtures/corpus is
 * gitignored) -- it's third-party source, not this repo's code. Run
 * `pnpm --filter core corpus:fetch` first, which pulls each repo listed in
 * corpus.manifest.json from its pinned upstream commit. A repo that hasn't
 * been fetched yet is reported via console.warn below and simply has no
 * tests defined for it this run, rather than a fetch failure silently
 * passing as green.
 */

const CORPUS_ROOT = join(__dirname, "fixtures/corpus");
const MANIFEST_PATH = join(__dirname, "corpus.manifest.json");

interface CorpusManifestEntry {
  name: string;
  repo: string;
  commit: string;
  componentCountFloor: number;
}

const manifest: CorpusManifestEntry[] = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const availableEntries = manifest.filter((entry) => existsSync(join(CORPUS_ROOT, entry.name)));
const missingEntries = manifest.filter((entry) => !existsSync(join(CORPUS_ROOT, entry.name)));

if (missingEntries.length > 0) {
  console.warn(
    `[corpus] not fetched, no tests run for: ${missingEntries.map((e) => e.name).join(", ")} -- ` +
      `run "pnpm --filter core corpus:fetch" to populate test/fixtures/corpus/`,
  );
}

function loadCorpusRepo(dir: string): { filePath: string; source: string }[] {
  const files: { filePath: string; source: string }[] = [];
  function walk(current: string, rel: string) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, relPath);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        files.push({ filePath: relPath, source: readFileSync(full, "utf8") });
      }
    }
  }
  walk(dir, "");
  return files;
}

describe.each(availableEntries)("corpus: $name", ({ name, componentCountFloor }) => {
  const files = loadCorpusRepo(join(CORPUS_ROOT, name));

  it("has files to test against", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("parses every file without throwing", () => {
    expect(() => buildComponentGraph(files)).not.toThrow();
  });

  it(`detects at least ${componentCountFloor} components`, () => {
    const graph = buildComponentGraph(files);
    expect(graph.definitions.size).toBeGreaterThanOrEqual(componentCountFloor);
  });

  it("round-trips every file byte-identical with zero mutations applied", () => {
    const graph = buildComponentGraph(files);
    for (const [filePath, { source }] of graph.files) {
      expect(printFile(graph, filePath)).toBe(source);
    }
  });

  it("mutate-then-revert round-trips a sample of real string classNames exactly", () => {
    const graph = buildComponentGraph(files);
    const originalSources = new Map(files.map((f) => [f.filePath, f.source]));

    // Every JSXElement, anywhere in any component's tree (not just roots),
    // whose className is a plain string literal -- the common, supported
    // case "setString" targets.
    const candidates: { filePath: string; el: t.JSXElement }[] = [];
    function collect(el: t.JSXElement, filePath: string) {
      const attr = extractClassAttr(el);
      if (attr && attr.ir.kind === "string") candidates.push({ filePath, el });
      for (const child of jsxChildren(el.children)) collect(child, filePath);
    }
    for (const def of graph.definitions.values()) {
      if (t.isJSXElement(def.rootElement)) collect(def.rootElement, def.filePath);
    }

    expect(candidates.length).toBeGreaterThan(0);

    // Sample across the corpus rather than mutating every candidate --
    // keeps runtime reasonable while still exercising real elements spread
    // across many files, not just a hand-picked few.
    const step = Math.max(1, Math.floor(candidates.length / 40));
    const sample = candidates.filter((_, i) => i % step === 0);

    for (const { filePath, el } of sample) {
      const before = printFile(graph, filePath);
      const attr = extractClassAttr(el)!;
      if (attr.ir.kind !== "string") continue; // narrow for TS after the runtime check above
      const originalValue = attr.ir.value;

      applyClassMutation(attr, { op: "setString", value: `${originalValue} reframe-corpus-probe` });
      expect(printFile(graph, filePath)).not.toBe(before);

      applyClassMutation(attr, { op: "setString", value: originalValue });
      expect(printFile(graph, filePath)).toBe(originalSources.get(filePath));
    }
  });
});
