import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildComponentGraph, loadProjectFiles } from "@reframe/core";

import type { AppState, HistoryEntry } from "./state.js";

export function pushHistory(state: AppState, entry: Omit<HistoryEntry, "id" | "timestamp">): void {
  state.history.push({ ...entry, id: state.nextId++, timestamp: Date.now() });
  state.redoStack = []; // a fresh edit invalidates whatever redo history existed
}

/** Reverting a file's text on disk isn't enough by itself: the in-memory
 * graph's AST nodes (ComponentDef.classAttr.attrNode, UsageSite.element,
 * ...) are direct references into the parsed tree, and would go stale the
 * instant the file's content changes underneath them. Re-parsing the whole
 * project from disk is cheap at this scale and avoids an entire class of
 * stale-reference bugs that patching just one file's AST in place risks. */
function rebuildGraph(state: AppState): void {
  state.graph = buildComponentGraph(loadProjectFiles(state.targetDir));
}

export function undo(state: AppState): HistoryEntry | null {
  const entry = state.history.pop();
  if (!entry) return null;
  writeFileSync(join(state.targetDir, entry.filePath), entry.before, "utf8");
  rebuildGraph(state);
  state.redoStack.push(entry);
  return entry;
}

export function redo(state: AppState): HistoryEntry | null {
  const entry = state.redoStack.pop();
  if (!entry) return null;
  writeFileSync(join(state.targetDir, entry.filePath), entry.after, "utf8");
  rebuildGraph(state);
  state.history.push(entry);
  return entry;
}
