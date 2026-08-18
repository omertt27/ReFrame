#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createTwoFilesPatch } from "diff";

import { applyClassMutation } from "./mutate/class.js";
import { setUsageProp } from "./mutate/prop.js";
import { buildComponentGraph } from "./parse.js";
import { resolveSharedClassTarget, resolveUsage } from "./resolve.js";
import { printFile } from "./write.js";

function loadDir(dir: string) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => ({ filePath: f, source: readFileSync(join(dir, f), "utf8") }));
}

function printDiff(filePath: string, before: string, after: string) {
  if (before === after) {
    console.log(`(no change) ${filePath}`);
    return;
  }
  console.log(createTwoFilesPatch(filePath, filePath, before, after));
}

function main() {
  const [, , dir, command, ...rest] = process.argv;
  if (!dir || !command) {
    console.error(
      "Usage:\n" +
        "  cli <dir> shared-class <Component> <consequent|alternate> <value>\n" +
        "  cli <dir> instance-prop <Component> <usageFile> <propName> <value>\n" +
        "  cli <dir> clsx-arg <Component> <argIndex> <value>",
    );
    process.exit(1);
  }

  const files = loadDir(dir);
  const graph = buildComponentGraph(files);
  const originalSources = new Map(files.map((f) => [f.filePath, f.source]));

  if (command === "shared-class") {
    const [component, branch, value] = rest;
    const target = resolveSharedClassTarget(graph, component!);
    applyClassMutation(target, { op: "setBranch", branch: branch as "consequent" | "alternate", value: value! });
  } else if (command === "instance-prop") {
    const [component, usageFile, propName, value] = rest;
    const usage = resolveUsage(graph, component!, usageFile!);
    setUsageProp(usage, propName!, value!);
  } else if (command === "clsx-arg") {
    const [component, index, value] = rest;
    const target = resolveSharedClassTarget(graph, component!);
    applyClassMutation(target, { op: "setClsxArg", index: Number(index), value: value! });
  } else {
    console.error(`Unknown command "${command}"`);
    process.exit(1);
  }

  for (const [filePath, before] of originalSources) {
    const after = printFile(graph, filePath);
    printDiff(filePath, before, after);
  }
}

main();
