import type { ComponentGraph } from "@reframe/core";

export interface HistoryEntry {
  id: number;
  timestamp: number;
  filePath: string;
  before: string;
  after: string;
  description: string;
  /** Ordered names from the edited component down to the specific nested
   * element (inclusive) — e.g. ["Hero", "button"] — the grouping key the
   * Changes panel uses to fold several property edits on the same element
   * into one card, the same way a developer would describe "what I changed
   * on the CTA button" rather than listing each edit separately. */
  breadcrumb: string[];
  propertyLabel: string;
  beforeValue: string;
  afterValue: string;
  /** Enough to re-run the exact same selection this edit was made against
   * (component + route + ElementPath) — lets the Changes panel jump the
   * canvas back to the element a card describes, the same call a Pages-tree
   * click already makes. */
  component: string;
  route: string;
  path: number[];
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
  /** Number of leading `history` entries already acknowledged via "Keep
   * changes" in the Review diff panel — everything after this index is
   * "pending" and counted in the Changes badge. Session-scoped only (not
   * persisted), matching the rest of ReFrame's no-accounts-yet posture. */
  reviewedCount: number;
}
