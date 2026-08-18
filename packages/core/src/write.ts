import * as recast from "recast";

import type { ComponentGraph } from "./graph.js";

/**
 * Reprints one file's mutated AST back to source. Because the AST was
 * parsed by recast (see parse.ts), only the mutated subtree is re-emitted —
 * everything else stays byte-identical to the original, which is what keeps
 * the resulting git diff minimal.
 */
export function printFile(graph: ComponentGraph, filePath: string): string {
  const file = graph.files.get(filePath);
  if (!file) throw new Error(`Unknown file "${filePath}"`);
  return recast.print(file.ast).code;
}
