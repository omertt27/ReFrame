import type { ComponentGraph } from "@reframe/core";

export interface HistoryEntry {
  id: number;
  timestamp: number;
  filePath: string;
  before: string;
  after: string;
  description: string;
}

/** Mutable, shared across the proxy and host servers — both must always
 * read state.graph fresh per-request, never capture it once at startup,
 * since undo/redo swap in a freshly rebuilt graph after reverting a file. */
export interface AppState {
  graph: ComponentGraph;
  targetDir: string;
  history: HistoryEntry[];
  redoStack: HistoryEntry[];
  nextId: number;
}
