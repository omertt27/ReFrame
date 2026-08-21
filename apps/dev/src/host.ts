import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as t from "@babel/types";
import { createPatch } from "diff";

import {
  applyClassMutation,
  buildElementTree,
  duplicateElement,
  EDITABLE_PROPERTIES,
  extractClassAttr,
  extractClassIR,
  extractStyleAttr,
  extractStyleIR,
  extractTextIR,
  findUtilityClass,
  listPageRoutes,
  moveChild,
  pageSectionOrder,
  removeElement,
  printFile,
  readResponsiveProperty,
  readStyleObjectColor,
  readStyleObjectProperty,
  resolveAllUsages,
  resolveComponentAtRoute,
  resolveDefinition,
  resolveDefinitionByFile,
  resolveElementPath,
  routeToPageFile,
  writeResponsiveProperty,
  writeStyleColor,
  writeStyleProperty,
  writeTextContent,
  type ClassAttrRef,
  type ClsxArg,
  type ComponentDef,
  type PropertyDef,
  type StyleAttrRef,
  type StyleIR,
  type ViewportTier,
} from "@reframe/core";

import { discardPending, pushHistory, redo, undo } from "./history.js";
import type { AppState } from "./state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function routeDisplayName(route: string): string {
  if (route === "/") return "Home";
  return route
    .split("/")
    .filter(Boolean)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join(" / ");
}

// Small, real-world-driven word overrides for titleCasing a route segment
// — "pdf" showing up as "Pdf" everywhere reads wrong on a project whose
// entire domain is PDFs; kept as a tiny table rather than a general
// acronym detector, extend as real projects surface more of these.
const SEGMENT_WORD_OVERRIDES: Record<string, string> = { pdf: "PDF" };

/** A Next.js route-group segment — `(marketing)`, `(seo)` — organizes files
 * on disk but never appears in the actual URL, so it should never appear
 * in a human-facing page name either. */
function isRouteGroupSegment(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
}

/** A dynamic segment — `[slug]`, `[id]`, `[[...sign-in]]` — represents a
 * template shared by however many real pages match it at runtime, not one
 * specific page; "Template" says that plainly instead of leaking the raw
 * param name or bracket syntax into the UI. */
function isDynamicSegment(segment: string): boolean {
  return segment.startsWith("[");
}

function titleCaseSegment(segment: string): string {
  return segment
    .split("-")
    .filter(Boolean)
    .map((word) => SEGMENT_WORD_OVERRIDES[word.toLowerCase()] ?? word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/** The segments of a route that are actually meaningful to show a person —
 * route groups dropped entirely (they don't affect the URL, shouldn't
 * affect the displayed hierarchy either), dynamic segments collapsed to a
 * single "Template" entry. `/(seo)/[slug]` -> ["Template"]; `/guides/how-to`
 * -> ["Guides", "How To"]. */
function displaySegments(route: string): string[] {
  const raw = route.split("/").filter(Boolean);
  const out: string[] = [];
  for (const segment of raw) {
    if (isRouteGroupSegment(segment)) continue;
    out.push(isDynamicSegment(segment) ? "Template" : titleCaseSegment(segment));
  }
  return out;
}

interface PageTreeNode {
  kind: "page";
  route: string;
  label: string;
  pageComponent: string;
  sections: string[];
}
interface GroupTreeNode {
  kind: "group";
  label: string;
  children: PageTreeNode[];
}

/** Groups a flat page list into a shallow (one level) tree, purely from
 * the real route structure — never a second, hand-maintained hierarchy.
 * Pages sharing the same first real (non-route-group) segment become a
 * collapsible group named after that segment (its own index page, if one
 * exists at exactly that path, sorts first inside the group); anything
 * alone at its first segment stays a flat top-level entry — a group of
 * one is just noise. Verified against PrivaPDF's real route list: only
 * `/guides/*` (30+ real pages) actually benefits from grouping; everything
 * else here is naturally flat, and stays flat rather than being nested for
 * the sake of it. */
function buildPageTree(pages: PageTreeNode[]): (PageTreeNode | GroupTreeNode)[] {
  const firstSegment = new Map<string, PageTreeNode[]>();
  const order: string[] = [];
  for (const page of pages) {
    const segs = displaySegments(page.route);
    const key = segs.length > 0 ? segs[0]! : "";
    if (!firstSegment.has(key)) {
      firstSegment.set(key, []);
      order.push(key);
    }
    firstSegment.get(key)!.push(page);
  }

  const result: (PageTreeNode | GroupTreeNode)[] = [];
  for (const key of order) {
    const group = firstSegment.get(key)!;
    if (key === "" || group.length === 1) {
      result.push(...group);
      continue;
    }
    // The group's own index page (route segments === [key], e.g. "/guides"
    // itself among "/guides/*") sorts first; the rest keep their natural
    // (already alphabetical-by-route) order.
    const sorted = [...group].sort((a, b) => {
      const aIsIndex = displaySegments(a.route).length === 1;
      const bIsIndex = displaySegments(b.route).length === 1;
      if (aIsIndex === bIsIndex) return 0;
      return aIsIndex ? -1 : 1;
    });
    result.push({ kind: "group", label: key, children: sorted });
  }
  return result;
}

/** Which ternary branch a specific prop value resolves to — the same rule
 * used everywhere "this instance" vs "all instances" is decided. */
function branchForValue(
  ir: { propName: string; testValue: string },
  value: string | boolean | undefined,
): "consequent" | "alternate" {
  return value === ir.testValue ? "consequent" : "alternate";
}

/** Whether a clsx()/cn() argument is active for a given usage's props —
 * `true`/`false` when it's a plain string or an evaluable (identifier /
 * `!identifier`) conditional whose prop was actually captured, `null` when
 * it can't be determined (a non-evaluable test, or a prop that wasn't
 * captured — see UsageSite.props). Never guessed either way. */
function clsxArgActive(arg: ClsxArg, props: Record<string, string | boolean> | null): boolean | null {
  if (arg.kind === "string") return true;
  if (!arg.evaluable || !props) return null;
  const raw = props[arg.evaluable.propName];
  if (raw === undefined) return null;
  const truthy = typeof raw === "boolean" ? raw : raw.length > 0;
  return arg.evaluable.negated ? !truthy : truthy;
}

/** Whether "all instances" vs "this instance" (ternary) or "which argument"
 * (clsx) is a real, non-no-op choice for the selected element's className —
 * see the /resolve handler below, the only place this is populated. `null`
 * means the choice is a no-op (plain string class, single-arg clsx, or a
 * nested element), so the client shows no scope UI at all. */
type ScopeChoice =
  | { kind: "ternary"; propName: string; currentBranch: "consequent" | "alternate" }
  | { kind: "clsx"; args: { index: number; label: string; active: boolean | null }[]; defaultIndex: number }
  | null;

/** Resolves which JSX node an operation should target — the component's own
 * root when no path is given, or the specific nested node an ElementPath
 * addresses. Shared by /resolve, /mutate, and /mutate-text so there's a
 * single place that ever calls resolveElementPath directly. */
function resolveTarget(def: ComponentDef, path: number[] | undefined): t.JSXElement | t.JSXFragment | null {
  if (!Array.isArray(path) || path.length === 0) return def.rootElement;
  return resolveElementPath(def.rootElement, path);
}

function truncate(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function elementTagName(node: t.JSXElement | t.JSXFragment): string | null {
  if (!t.isJSXElement(node)) return null;
  const name = node.openingElement.name;
  return t.isJSXIdentifier(name) ? name.name : null;
}

/** Ordered tag/component names from a component's own root down to the
 * ElementPath target (inclusive) — feeds the breadcrumb UI so a nested
 * selection reads as "main → section → h1", not just a bare tag name. */
function breadcrumbFor(root: t.JSXElement | t.JSXFragment, path: number[]): string[] {
  const names: string[] = [elementTagName(root) ?? "Fragment"];
  for (let i = 0; i < path.length; i++) {
    const node = resolveElementPath(root, path.slice(0, i + 1));
    if (!node) break;
    names.push(elementTagName(node) ?? "Fragment");
  }
  return names;
}

/** The Changes-panel grouping key for a history entry: the component's own
 * name (more meaningful than its root JSX tag) followed by any nested tag
 * names a path descends through — e.g. ["Hero", "button"]. Reuses
 * breadcrumbFor's tag walk but swaps in the component name for its root
 * entry, since "Hero" reads better than "section" as the group heading. */
function elementBreadcrumb(component: string, root: t.JSXElement | t.JSXFragment, path?: number[]): string[] {
  if (!path || path.length === 0) return [component];
  return [component, ...breadcrumbFor(root, path).slice(1)];
}

type Backend = "tailwind" | "style";

interface PropertyReadInfo {
  available: boolean;
  kind: "dimension" | "color" | "text";
  px?: number | null;
  value?: string | null;
  reason?: string;
  /** Which backend this value came from (or, if not set, which backend a
   * write would go to) — the client echoes this back on mutate, so the
   * server never has to re-derive a per-property backend decision that
   * might disagree with what was actually shown. */
  backend?: Backend;
}

const TAILWIND_COLOR_KEYWORDS = new Set(["black", "white", "transparent", "current", "inherit"]);

/**
 * Whether a className already sets a Tailwind COLOR utility for this
 * prefix — advisory only, used to produce a clear refusal message; there is
 * no Tailwind color-scale writer yet (see project memory
 * `reframe-color-editing`), so this never feeds a write, only a reason
 * string. "text-" is ambiguous in Tailwind's own naming (font-size
 * utilities share the prefix — "text-lg", "text-[10px]"), so this requires
 * either an exact palette keyword or a "-{shade-number}" suffix (matching
 * "text-red-600") to count as a color; a bare size utility is never
 * flagged.
 */
function hasTailwindColorUtility(classList: string, prefix: string): boolean {
  const match = findUtilityClass(classList, prefix);
  if (!match) return false;
  const suffix = match.slice(prefix.length);
  return TAILWIND_COLOR_KEYWORDS.has(suffix) || /-\d{2,3}$/.test(suffix);
}

function readDimensionValue(
  prop: PropertyDef,
  classList: string | null,
  styleIR: StyleIR | null,
  classUnsupportedReason: string | null,
  tier: ViewportTier,
): PropertyReadInfo {
  // Typography dimensions (fontSize/fontWeight/lineHeight/letterSpacing)
  // have no Tailwind mapping at all — Tailwind's own utilities for these
  // are keyword-based scales (font-bold, leading-relaxed, tracking-tight),
  // not the numeric spacing scale h-/w-/p- use, so there's nothing for
  // readProperty to map to. Skip Tailwind entirely when a property has no
  // prefix, rather than calling into readProperty (which throws for
  // exactly this case) just because the element happens to have SOME
  // unrelated className — very common in this codebase (e.g.
  // `className="nav-root"` alongside inline styles).
  //
  // STYLE IS CHECKED FIRST — this order matters and was previously
  // backwards. Inline `style` always wins the CSS cascade over any class
  // selector, Tailwind utilities included, regardless of specificity or
  // stylesheet order. Verified live against PrivaPDF (className="... p-4"
  // + style={{padding: 32}} on the same element): the browser renders
  // 32px, but with Tailwind checked first this function reported 16 as the
  // "current" value — a real, confirmed bug, not a hypothetical (see
  // project memory `reframe-stress-test-responsive-css`). Checking style
  // first means the reported value always matches what the browser
  // actually shows whenever both backends happen to set the same property.
  const fromStyle = styleIR ? readStyleObjectProperty(styleIR, prop) : null;
  if (fromStyle?.available && fromStyle.px !== null) {
    return { available: true, kind: "dimension", px: fromStyle.px, backend: "style" };
  }
  const fromTailwind = prop.prefix && classList !== null ? readResponsiveProperty(classList, prop, tier) : null;
  if (fromTailwind?.available && fromTailwind.px !== null) {
    return { available: true, kind: "dimension", px: fromTailwind.px, backend: "tailwind" };
  }
  if (fromStyle && !fromStyle.available) return { available: false, kind: "dimension", reason: fromStyle.reason };
  if (fromTailwind && !fromTailwind.available) return { available: false, kind: "dimension", reason: fromTailwind.reason };
  // Neither backend has a value set yet — this fallback (which backend a
  // brand-new write defaults to) is a separate, unrelated question from
  // the precedence fix above and is deliberately left as Tailwind-first
  // when a className exists; see project memory
  // `reframe-stress-test-responsive-css` Finding 1 for why even this
  // default isn't fully safe (an external stylesheet rule can still
  // silently override a newly-added Tailwind class) — that's a larger,
  // separately-scoped architecture gap, not fixed here.
  if (prop.prefix && classList !== null) return { available: true, kind: "dimension", px: null, backend: "tailwind" };
  if (styleIR) return { available: true, kind: "dimension", px: null, backend: "style" };
  return { available: false, kind: "dimension", reason: classUnsupportedReason ?? "no editable style found" };
}

/** Color is always the inline-style backend — see the plan/memory for why
 * Tailwind color utilities are explicitly out of scope (no color-scale
 * module exists the way tailwind-scale.ts does for spacing). A Tailwind
 * color class already present is detected and refused with a specific
 * reason rather than silently offering a style-backend edit that would
 * visually override it (inline style always wins CSS specificity, but
 * leaving a now-dead Tailwind class behind isn't what a developer wants). */
function readColorValue(
  prop: PropertyDef,
  classList: string | null,
  styleIR: StyleIR | null,
  classUnsupportedReason: string | null,
): PropertyReadInfo {
  // `valueKind` is "color" or "text" for anything routed here — both share
  // the exact same free-form-string read/write path (see PropertyValueKind's
  // doc comment), this just tags each result with the right one so the
  // client can tell a swatch-worthy value apart from a font-family value.
  const kind = prop.valueKind === "text" ? "text" : "color";
  if (classList !== null && prop.prefix && hasTailwindColorUtility(classList, prop.prefix)) {
    const existing = findUtilityClass(classList, prop.prefix);
    return {
      available: false,
      kind,
      reason: `already set via a Tailwind utility class ("${existing}") — editing Tailwind color utilities isn't supported yet, only inline style colors`,
    };
  }
  const fromStyle = styleIR ? readStyleObjectColor(styleIR, prop) : null;
  if (fromStyle?.available && fromStyle.value !== null) {
    return { available: true, kind, value: fromStyle.value, backend: "style" };
  }
  if (fromStyle && !fromStyle.available) return { available: false, kind, reason: fromStyle.reason };
  if (styleIR) return { available: true, kind, value: null, backend: "style" };
  return {
    available: false,
    kind,
    reason:
      classUnsupportedReason ??
      (kind === "color"
        ? "no inline style on this element to add a color to — Tailwind color utilities aren't editable yet"
        : "no inline style on this element to add a font to yet"),
  };
}

/** "#3B82F6" -> "rgb(59, 130, 246)" — matches getComputedStyle's own output
 * format exactly (browsers always normalize computed color to rgb()/
 * rgba(), regardless of source syntax). Plain arithmetic, mirrored
 * (intentionally, not shared) in preload.js's client-side copy of this
 * same function. Named colors and var() references are NOT normalized
 * here — there's no DOM/canvas available server-side to resolve those
 * reliably — callers treat that as "can't verify," not "mismatch." */
function hexToRgb(hex: string): string | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * The external-CSS safety net: cross-checks a value the source PREDICTS
 * against what the browser ACTUALLY rendered (reported by preload.js
 * alongside the click, from `getComputedStyle` on the real DOM node).
 * Verified live against PrivaPDF's real `<nav className="nav-root">`:
 * ReFrame previously reported a successful padding edit while the
 * rendered page never changed — an external CSS rule for `.nav-root`,
 * invisible to this source model, silently won the cascade (see project
 * memory `reframe-stress-test-responsive-css`, Finding 1). Rather than try
 * to guess which class names might be "custom" (rejected — a healthy
 * Tailwind-heavy element has dozens of utility classes this engine
 * doesn't specifically recognize, like `flex`/`rounded-lg`/`shadow-md`;
 * flagging those as suspicious would produce false refusals on perfectly
 * safe elements), this compares against ground truth instead: the actual
 * browser. Generalizes to every cause (external CSS, CSS Modules,
 * `!important`, specificity) without needing to know which one applies.
 * Returns null — "can't verify, don't guess" — rather than false whenever
 * the predicted value's form can't be reliably normalized (any color that
 * isn't a plain hex string).
 */
function crossCheckAgainstComputed(
  kind: "dimension" | "color" | "text",
  predicted: number | string,
  computedRaw: string,
): boolean | null {
  if (kind !== "dimension") {
    // "text" (fontFamily) is structurally the same "can't reliably verify a
    // non-hex string against computed style" case color already handles —
    // getComputedStyle normalizes font stacks (quoting, fallback order) in
    // ways that would produce false-positive mismatches on a naive string
    // compare, so this returns null ("can't verify, don't guess") for
    // anything that isn't a plain hex color, which every fontFamily value
    // naturally falls into.
    const predictedRgb = hexToRgb(String(predicted));
    if (!predictedRgb) return null;
    return predictedRgb === computedRaw;
  }
  const actual = Number.parseFloat(computedRaw);
  if (Number.isNaN(actual)) return false; // e.g. "normal" when a value was predicted
  return Math.abs(actual - Number(predicted)) < 0.5;
}

/**
 * Reads every editable property's current value across BOTH style backends
 * for one root element — the Style IR dispatch the real-world stress test
 * called for. Tailwind is preferred when a dimension is actually set there;
 * inline style is checked next; if neither has it, "not set" defaults to
 * whichever backend exists (Tailwind if present, else style) so a
 * subsequent write has somewhere sensible to go. A property already set via
 * one backend is never silently rewritten into the other — see
 * mutate/style.ts and mutate/tailwind.ts's own guards for the enforcement.
 * Color properties dispatch through readColorValue instead — a different
 * value shape (a string, not a px number), see PropertyDef.valueKind.
 *
 * When `computedStyle` is provided (the browser's actual rendered values
 * for this element, sent by preload.js), every property that reads back
 * `available: true` with a real value is cross-checked against it via
 * crossCheckAgainstComputed — a definite mismatch overrides the result to
 * unavailable with an explicit reason, rather than showing (and inviting
 * an edit built on) a value the page doesn't actually display. Only
 * applies to values already predicted from the source; the "not set
 * anywhere yet" fallback has nothing to cross-check against here — that
 * risk (a brand-new write silently losing to something invisible) is
 * caught after the fact instead, by the /mutate post-write verification.
 */
function readCurrentProperties(
  classAttr: ClassAttrRef | null,
  styleAttr: StyleAttrRef | null,
  usageProps: Record<string, string | boolean> | null,
  computedStyle: Record<string, string> | null,
  tier: ViewportTier,
) {
  if (!classAttr && !styleAttr) {
    return { editable: false as const, reason: "no className or style found on this element" };
  }

  let classList: string | null = null;
  let classUnsupportedReason: string | null = null;
  if (classAttr) {
    const fresh = extractClassIR(classAttr.attrNode);
    if (fresh?.kind === "string") classList = fresh.value;
    else if (fresh?.kind === "ternary") {
      const branch = branchForValue(fresh, usageProps?.[fresh.propName]);
      classList = branch === "consequent" ? fresh.consequent : fresh.alternate;
    } else if (fresh?.kind === "clsxCall" && fresh.args !== null) {
      // Every argument's string is a candidate — a conditional arg
      // (`test && "..."`) might not always be active, but this is a READ
      // only; findUtilityClass just needs to know a token exists somewhere
      // to report it, and the external-CSS cross-check (readCurrentProperties's
      // caller) already catches a value that doesn't match what's actually
      // rendered, whatever the reason. Which specific argument a WRITE
      // lands in is decided separately, per-write, in applyClsxPropertyEdit.
      classList = fresh.args.map((a) => a.value).join(" ");
    } else {
      classUnsupportedReason =
        fresh?.kind === "unsupported"
          ? fresh.reason
          : fresh?.kind === "clsxCall"
            ? `${fresh.calleeName}() has argument shapes that aren't recognized`
            : "className shape isn't a plain string, ternary, or clsx()/cn() call";
    }
  }
  const styleIR = styleAttr ? extractStyleIR(styleAttr.attrNode) : null;

  // CSS structurally ignores width/height on an inline element (only
  // block, inline-block, flex/grid, and similar box-generating display
  // types respect them) — no value ReFrame could ever write there would
  // visually apply. Found live: a real drag-resize on an inline `<em>`
  // wrote a new width/height on every drag, always "succeeded" as far as
  // the source edit went, and the post-write safety net caught a mismatch
  // EVERY single time — technically correct, but a bad experience (drag,
  // get a scary warning, repeat). Refusing width/height up front here
  // (before any drag is even possible — see host.html's resize-handle
  // visibility, gated on this same availability) is strictly better than
  // catching it after the fact.
  const isInlineDisplay = computedStyle?.display === "inline";

  const values: Record<string, PropertyReadInfo> = {};
  for (const prop of EDITABLE_PROPERTIES) {
    if (isInlineDisplay && (prop.key === "width" || prop.key === "height")) {
      values[prop.key] = {
        available: false,
        kind: "dimension",
        reason: "this element is inline — CSS ignores width and height on inline elements",
      };
      continue;
    }
    const info =
      prop.valueKind === "dimension"
        ? readDimensionValue(prop, classList, styleIR, classUnsupportedReason, tier)
        : readColorValue(prop, classList, styleIR, classUnsupportedReason);

    const predicted = info.available ? (info.kind === "dimension" ? info.px : info.value) : null;
    const computedRaw = computedStyle?.[prop.key];
    if (predicted !== null && predicted !== undefined && computedRaw !== undefined) {
      let matches = crossCheckAgainstComputed(info.kind, predicted, computedRaw);
      // lineHeight is the one property with a genuinely dual CSS meaning: a
      // unitless number (React's default form for a plain JS number) is a
      // MULTIPLIER of the element's own font-size, not an absolute pixel
      // value — the computed style always resolves it to px regardless.
      // Found live against PrivaPDF's real h1 (`lineHeight: 1.1`, computed
      // "40.7px" against a ~37px font-size) as a false positive from the
      // naive direct comparison: 1.1 was never going to equal 40.7px, yet
      // nothing was actually wrong. No other tracked property has this
      // ambiguity (fontSize/letterSpacing/height/width/padding are always
      // directly comparable), so this is scoped to lineHeight specifically
      // rather than generalized.
      if (matches === false && prop.key === "lineHeight" && computedStyle?.fontSize) {
        const fontSizePx = Number.parseFloat(computedStyle.fontSize);
        if (!Number.isNaN(fontSizePx)) {
          const asMultiplier = Number(predicted) * fontSizePx;
          if (crossCheckAgainstComputed("dimension", asMultiplier, computedRaw) === true) matches = true;
        }
      }
      if (matches === false) {
        const predictedLabel = info.kind === "dimension" ? `${predicted}px` : String(predicted);
        values[prop.key] = {
          available: false,
          kind: info.kind,
          reason: `the source predicts ${predictedLabel}, but the page actually renders ${computedRaw} — this property may be controlled by something ReFrame can't see (external CSS, specificity, !important) and isn't safely editable here`,
        };
        continue;
      }
    }
    values[prop.key] = info;
  }
  // No PropertyDef currently targets a custom CSS property, so this can't
  // point at a specific field — it's a general "there's more style here
  // than what's shown" note. See style-ir.ts's extractStyleIR for what
  // sets this (a computed/bracket property key, e.g. a `key as any` TS
  // cast — verified real via Excalidraw's Card.tsx theming pattern).
  const hasHiddenStyleProperties = styleIR?.kind === "object" && styleIR.hasUnsupportedComputedKeys;
  return { editable: true as const, values, hasHiddenStyleProperties };
}

/** Applies one property edit to one Tailwind branch (or the plain string),
 * re-reading the IR fresh from the live AST first so repeated edits within
 * a session see each other's changes. Returns the previous px value. */
function applyTailwindPropertyEdit(
  classAttr: ClassAttrRef,
  branch: "consequent" | "alternate" | null,
  prop: PropertyDef,
  px: number,
  tier: ViewportTier,
): number | null {
  const fresh = extractClassIR(classAttr.attrNode);
  if (branch) {
    if (!fresh || fresh.kind !== "ternary") throw new Error("Expected a ternary className");
    const current = branch === "consequent" ? fresh.consequent : fresh.alternate;
    const before = readResponsiveProperty(current, prop, tier);
    const result = writeResponsiveProperty(current, prop, px, tier);
    if (!result.ok) throw new Error(result.reason);
    applyClassMutation({ attrNode: classAttr.attrNode, ir: fresh }, { op: "setBranch", branch, value: result.classList });
    return before.available ? before.px : null;
  }
  if (!fresh || fresh.kind !== "string") throw new Error("Expected a plain string className");
  const before = readResponsiveProperty(fresh.value, prop, tier);
  const result = writeResponsiveProperty(fresh.value, prop, px, tier);
  if (!result.ok) throw new Error(result.reason);
  applyClassMutation({ attrNode: classAttr.attrNode, ir: fresh }, { op: "setString", value: result.classList });
  return before.available ? before.px : null;
}

/**
 * The clsx()/cn() counterpart to applyTailwindPropertyEdit — class-ir.ts
 * already extracts a clsxCall's arguments (string literals and
 * `test && "class"` conditionals) and mutate/class.ts already has a
 * "setClsxArg" op to edit one argument's string in place, but neither was
 * ever wired up to an actual read/write here; a clsxCall was treated
 * identically to any unrecognized className shape. Fixed per the user's
 * own worked example: `clsx("p-4", active && "bg-blue-500")` — each
 * argument's string is checked INDIVIDUALLY (not the call concatenated)
 * for the target utility, since a write can only ever touch one argument's
 * string without restructuring the call; whichever argument has it gets
 * edited, every other argument (the conditional included) stays untouched.
 * If the property isn't set in any argument yet, defaults to appending it
 * onto the first plain-string argument (the conventional "base classes"
 * position) — refuses rather than guessing if there isn't one.
 *
 * `forcedIndex`, when given, overrides the structural search entirely — the
 * client already showed the user which argument would be targeted (see
 * ScopeChoice's "clsx" variant in the /resolve handler) and let them pick a
 * different one, so this is an explicit choice, not a guess.
 */
function applyClsxPropertyEdit(
  classAttr: ClassAttrRef,
  prop: PropertyDef,
  px: number,
  tier: ViewportTier,
  forcedIndex?: number,
): number | null {
  const fresh = extractClassIR(classAttr.attrNode);
  if (!fresh || fresh.kind !== "clsxCall") throw new Error("Expected a clsx()/cn() call");
  if (fresh.args === null) {
    throw new Error(
      `${fresh.calleeName}() has argument shapes that aren't recognized (only string literals and ` +
        '`test && "class"` conditionals are supported) — refusing to edit around what it can\'t parse',
    );
  }

  let targetIndex = forcedIndex ?? fresh.args.findIndex((a) => prop.prefix && findUtilityClass(a.value, prop.prefix));
  if (targetIndex === -1) targetIndex = fresh.args.findIndex((a) => a.kind === "string");
  if (targetIndex === -1 || !fresh.args[targetIndex]) {
    throw new Error(`${fresh.calleeName}() has no plain string argument to add "${prop.prefix}" to`);
  }

  const arg = fresh.args[targetIndex]!;
  const before = readResponsiveProperty(arg.value, prop, tier);
  const result = writeResponsiveProperty(arg.value, prop, px, tier);
  if (!result.ok) throw new Error(result.reason);
  applyClassMutation({ attrNode: classAttr.attrNode, ir: fresh }, { op: "setClsxArg", index: targetIndex, value: result.classList });
  return before.available ? before.px : null;
}

/** Applies one property edit to a style={{...}} object, re-reading fresh
 * from the live AST first. No "scope" concept — a style object is per-JSX
 * usage-site, not a shared-component ternary, so there's only ever one
 * thing to edit. Returns the previous px value. */
function applyStylePropertyEdit(styleAttr: StyleAttrRef, prop: PropertyDef, px: number): number | null {
  const fresh = extractStyleIR(styleAttr.attrNode);
  if (!fresh) throw new Error("Expected a style object");
  const before = readStyleObjectProperty(fresh, prop);
  const result = writeStyleProperty(fresh, prop.cssProperty, px);
  if (!result.ok) throw new Error(result.reason);
  return before.available ? before.px : null;
}

/** The color counterpart to applyStylePropertyEdit — same re-read-fresh
 * discipline, same "always this instance, no scope" rule (see
 * readColorValue's doc comment for why Tailwind never applies here).
 * Returns the previous value. */
function applyStyleColorEdit(styleAttr: StyleAttrRef, prop: PropertyDef, value: string): string | null {
  const fresh = extractStyleIR(styleAttr.attrNode);
  if (!fresh) throw new Error("Expected a style object");
  const before = readStyleObjectColor(fresh, prop);
  const result = writeStyleColor(fresh, prop.cssProperty, value);
  if (!result.ok) throw new Error(result.reason);
  return before.available ? before.value : null;
}

interface ChangeMeta {
  description: string;
  breadcrumb: string[];
  propertyLabel: string;
  beforeValue: string;
  afterValue: string;
  component: string;
  route: string;
  path: number[];
}

function recordAndWrite(state: AppState, filePath: string, before: string, meta: ChangeMeta) {
  const after = printFile(state.graph, filePath);
  writeFileSync(join(state.targetDir, filePath), after, "utf8");
  pushHistory(state, { filePath, before, after, ...meta });
  return { after, diff: createPatch(filePath, before, after, "", "") };
}

/** Serves the host shell (layers panel + canvas + property/changes panels)
 * and the small JSON API it calls into packages/core's resolution/mutation
 * logic — that logic needs fs/Babel/recast, so it has to run server-side. */
export function startHostServer(hostPort: number, proxyPort: number, state: AppState): void {
  const hostHtml = readFileSync(join(__dirname, "static/host.html"), "utf8").replace(
    "__PROXY_URL__",
    `http://localhost:${proxyPort}/`,
  );

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const graph = state.graph;

    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(hostHtml);
      return;
    }

    if (req.method === "GET" && req.url === "/__reframe/components") {
      const list = [...graph.definitions.keys()]
        .sort()
        .map((name) => ({ name, usageCount: resolveAllUsages(graph, name).length }));
      sendJson(res, 200, list);
      return;
    }

    if (req.method === "GET" && req.url === "/__reframe/tree") {
      const flat: PageTreeNode[] = listPageRoutes(graph).map(({ route, pageComponent }) => {
        const segs = displaySegments(route);
        return {
          kind: "page",
          route,
          // Just the page's OWN name, not the full "Guides / How To"
          // breadcrumb routeDisplayName used to produce — that framing
          // belongs to the tree structure now (grouping already says
          // "this is inside Guides"), not to every individual label.
          label: segs.length > 0 ? segs[segs.length - 1]! : "Home",
          pageComponent,
          sections: (pageSectionOrder(graph, route) ?? []).map((s) => s.name),
        };
      });
      sendJson(res, 200, buildPageTree(flat));
      return;
    }

    if (req.method === "POST" && req.url === "/__reframe/element-tree") {
      readJsonBody(req)
        .then((body) => {
          const { component } = body as { component?: string };
          if (!component) {
            sendJson(res, 400, { ok: false, error: "expected { component }" });
            return;
          }
          const def = graph.definitions.get(component);
          if (!def) {
            sendJson(res, 200, { ok: false, error: `Unknown component "${component}"` });
            return;
          }
          sendJson(res, 200, { ok: true, tree: buildElementTree(def.rootElement, graph) });
        })
        .catch((err) => sendJson(res, 400, { ok: false, error: (err as Error).message }));
      return;
    }

    if (req.method === "GET" && req.url === "/__reframe/history") {
      sendJson(res, 200, {
        history: state.history.map((h) => ({
          id: h.id,
          filePath: h.filePath,
          description: h.description,
          breadcrumb: h.breadcrumb,
          propertyLabel: h.propertyLabel,
          beforeValue: h.beforeValue,
          afterValue: h.afterValue,
          component: h.component,
          route: h.route,
          path: h.path,
        })),
        canRedo: state.redoStack.length > 0,
        pendingCount: state.history.length - state.reviewedCount,
      });
      return;
    }

    // Squashes every still-pending edit into one diff per touched file
    // (oldest "before" -> current "after"), so reviewing "changed the CTA
    // color, then its height" produces one clean Hero.tsx diff, not two
    // separate hunks — the same shape a developer would actually commit.
    if (req.method === "GET" && req.url === "/__reframe/review") {
      const pending = state.history.slice(state.reviewedCount);
      const byFile = new Map<string, { before: string; after: string }>();
      for (const h of pending) {
        const existing = byFile.get(h.filePath);
        if (existing) existing.after = h.after;
        else byFile.set(h.filePath, { before: h.before, after: h.after });
      }
      const files = [...byFile.entries()].map(([filePath, { before, after }]) => ({
        filePath,
        diff: createPatch(filePath, before, after, "", ""),
      }));
      sendJson(res, 200, { files, changeCount: pending.length });
      return;
    }

    // "Keep changes": acknowledges every currently-pending entry as
    // reviewed. Doesn't touch disk or history — the edits are already
    // live in the working tree — it only resets the Changes badge and
    // narrows what the next Review diff squashes together.
    if (req.method === "POST" && req.url === "/__reframe/keep") {
      state.reviewedCount = state.history.length;
      sendJson(res, 200, { ok: true });
      return;
    }

    // Bulk "Undo" from the Review diff panel: reverts every still-pending
    // entry (most recent first), leaving already-kept history untouched.
    if (req.method === "POST" && req.url === "/__reframe/discard-pending") {
      const count = discardPending(state);
      sendJson(res, 200, { ok: true, count });
      return;
    }

    if (req.method === "POST" && (req.url === "/__reframe/undo" || req.url === "/__reframe/redo")) {
      const entry = req.url === "/__reframe/undo" ? undo(state) : redo(state);
      if (!entry) {
        sendJson(res, 200, { ok: false, error: req.url === "/__reframe/undo" ? "nothing to undo" : "nothing to redo" });
        return;
      }
      const diff = createPatch(
        entry.filePath,
        req.url === "/__reframe/undo" ? entry.after : entry.before,
        req.url === "/__reframe/undo" ? entry.before : entry.after,
        "",
        "",
      );
      sendJson(res, 200, { ok: true, entry: { id: entry.id, filePath: entry.filePath, description: entry.description }, diff });
      return;
    }

    if (req.method === "POST" && req.url === "/__reframe/resolve") {
      readJsonBody(req)
        .then((body) => {
          const { component, route, path, elementTag, computedStyle, viewport } = body as {
            component?: string;
            route?: string;
            path?: number[];
            elementTag?: string;
            computedStyle?: Record<string, string>;
            viewport?: ViewportTier;
          };
          const tier: ViewportTier = viewport ?? "desktop";
          if (!component || typeof route !== "string") {
            sendJson(res, 400, { ok: false, error: "expected { component, route }" });
            return;
          }

          const def = graph.definitions.get(component);
          if (!def) {
            sendJson(res, 200, { ok: false, error: `Unknown component "${component}"` });
            return;
          }
          const usageCount = resolveAllUsages(graph, component).length;

          let kind: "usage" | "definition";
          let filePath: string;
          let props: Record<string, string | boolean> | null = null;
          let note: string | undefined;
          try {
            const result = resolveComponentAtRoute(graph, component, route);
            if ("props" in result) {
              kind = "usage";
              filePath = result.filePath;
              props = result.props;
            } else {
              kind = "definition";
              filePath = result.filePath;
            }
          } catch (routeErr) {
            kind = "definition";
            filePath = def.filePath;
            note =
              "not directly used in a page/layout file — instance-scoped editing isn't available for this component yet, editing all instances still works";
            void routeErr;
          }

          // A nested ElementPath (anything beyond the component's own root)
          // resolves against a fresh classAttr/styleAttr pulled straight off
          // the target JSX node — the same extraction the root already used,
          // just pointed at a different node — so readCurrentProperties needs
          // no changes at all to work on either. Never guess: a bad path or a
          // tag mismatch (the DOM drifted from what the AST predicts, e.g. a
          // conditional render) refuses instead of editing the wrong element.
          const hasPath = Array.isArray(path) && path.length > 0;
          const target = resolveTarget(def, path);
          if (!target) {
            sendJson(res, 200, { ok: false, error: "This element can't currently be edited safely." });
            return;
          }

          let classAttr = def.classAttr;
          let styleAttr = def.styleAttr;
          let breadcrumb: string[] | undefined;
          if (hasPath) {
            const resolvedTag = elementTagName(target);
            if (elementTag && resolvedTag && resolvedTag.toLowerCase() !== elementTag.toLowerCase()) {
              sendJson(res, 200, { ok: false, error: "This element can't currently be edited safely." });
              return;
            }
            classAttr = extractClassAttr(target);
            styleAttr = extractStyleAttr(target);
            breadcrumb = breadcrumbFor(def.rootElement, path!);
          }

          const properties = readCurrentProperties(classAttr, styleAttr, props, computedStyle ?? null, tier);
          const textIR = extractTextIR(target);
          const text =
            textIR.kind === "text" ? { editable: true as const, value: textIR.value } : { editable: false as const, reason: textIR.reason };

          // "All instances" vs "this instance" only ever changes anything
          // when the root className is a prop-driven ternary or a clsx()/cn()
          // call with more than one argument (see the branches/forcedIndex
          // logic in the /__reframe/mutate handler below) — a plain string
          // class, a single-arg clsx call, or any nested element always
          // resolves to exactly one target regardless of scope. Only report
          // a scopeChoice (and thus only let the client show a scope UI) in
          // those two real cases, so the UI never asks a question the editor
          // can already answer.
          let scopeChoice: ScopeChoice = null;
          if (!hasPath && classAttr) {
            const fresh = extractClassIR(classAttr.attrNode);
            if (fresh && fresh.kind === "ternary" && kind === "usage" && props) {
              scopeChoice = { kind: "ternary", propName: fresh.propName, currentBranch: branchForValue(fresh, props[fresh.propName]) };
            } else if (fresh && fresh.kind === "clsxCall" && fresh.args && fresh.args.length > 1) {
              const args = fresh.args.map((arg, index) => ({
                index,
                label:
                  arg.kind === "string"
                    ? "Always"
                    : arg.evaluable
                      ? `When ${arg.evaluable.negated ? "not " : ""}${arg.evaluable.propName}`
                      : `When ${arg.testSource}`,
                active: clsxArgActive(arg, props),
              }));
              const activeIndex = args.find((a) => a.active === true)?.index;
              const firstStringIndex = fresh.args.findIndex((a) => a.kind === "string");
              scopeChoice = { kind: "clsx", args, defaultIndex: activeIndex ?? (firstStringIndex === -1 ? 0 : firstStringIndex) };
            }
          }

          sendJson(res, 200, {
            ok: true,
            kind,
            filePath,
            props,
            usageCount,
            note,
            properties,
            text,
            path: hasPath ? path : [],
            breadcrumb,
            scopeChoice,
          });
        })
        .catch((err) => sendJson(res, 400, { ok: false, error: (err as Error).message }));
      return;
    }

    if (req.method === "POST" && req.url === "/__reframe/mutate") {
      readJsonBody(req)
        .then((body) => {
          const { component, route, scope, property, px, value, backend, path, viewport, clsxArgIndex } = body as {
            component?: string;
            route?: string;
            scope?: "instance" | "all";
            property?: string;
            px?: number;
            value?: string;
            backend?: Backend;
            path?: number[];
            viewport?: ViewportTier;
            clsxArgIndex?: number;
          };
          if (!component || !route || !scope || !property || !backend || (typeof px !== "number" && typeof value !== "string")) {
            sendJson(res, 400, { ok: false, error: "expected { component, route, scope, property, backend, px } or { ..., value }" });
            return;
          }
          const tier: ViewportTier = viewport ?? "desktop";
          try {
            const def = resolveDefinition(graph, component);
            const propDef = EDITABLE_PROPERTIES.find((p) => p.key === property);
            if (!propDef) throw new Error(`Unknown property "${property}"`);

            // A nested ElementPath is resolved fresh against the live AST
            // (not cached) so it reflects any earlier edit in this same
            // request chain — same discipline applyTailwindPropertyEdit/
            // applyStylePropertyEdit already use internally.
            const hasPath = Array.isArray(path) && path.length > 0;
            const targetNode = resolveTarget(def, path);
            if (!targetNode) throw new Error("This element can't currently be edited safely.");

            const before = printFile(graph, def.filePath);

            // Color is always the inline-style backend, always "this
            // instance" — no ternary-branch scope question, same as nested
            // style edits already are. Kept as its own short path rather
            // than folded into the dimension branch below since the two
            // barely share any logic once you're past "resolve the style
            // attr" (see readColorValue's doc comment for why Tailwind
            // color classes are refused rather than written).
            if (propDef.valueKind === "color" || propDef.valueKind === "text") {
              if (typeof value !== "string") throw new Error(`"${property}" is a text-valued property — expected { value }`);
              const styleAttr = hasPath ? extractStyleAttr(targetNode) : def.styleAttr;
              if (!styleAttr) throw new Error(`"${component}" has no editable inline style`);
              const beforeValue = applyStyleColorEdit(styleAttr, propDef, value);
              const description = `${component} ${propDef.label}: ${beforeValue ?? "not set"} → ${value} (this instance, style)`;
              const { diff } = recordAndWrite(state, def.filePath, before, {
                description,
                breadcrumb: elementBreadcrumb(component, def.rootElement, hasPath ? path : undefined),
                propertyLabel: propDef.label,
                beforeValue: beforeValue ?? "not set",
                afterValue: value,
                component,
                route,
                path: hasPath ? path! : [],
              });
              sendJson(res, 200, { ok: true, filePath: def.filePath, diff });
              return;
            }
            if (typeof px !== "number") throw new Error(`"${property}" is a dimension property — expected { px }`);

            let beforePx: number | null = null;
            let scopeLabel: string;

            if (backend === "style") {
              const styleAttr = hasPath ? extractStyleAttr(targetNode) : def.styleAttr;
              if (!styleAttr) throw new Error(`"${component}" has no editable inline style`);
              beforePx = applyStylePropertyEdit(styleAttr, propDef, px);
              scopeLabel = "this instance"; // style={{}} is always per-usage-site, no ternary scope
            } else {
              const classAttr = hasPath ? extractClassAttr(targetNode) : def.classAttr;
              if (!classAttr) throw new Error(`"${component}" has no editable root className`);
              const fresh = extractClassIR(classAttr.attrNode);
              let branches: ("consequent" | "alternate" | null)[];
              if (!fresh) {
                throw new Error("Nothing to edit");
              } else if (fresh.kind === "string") {
                branches = [null];
              } else if (fresh.kind === "ternary") {
                // A nested element's own className ternary still tests a prop
                // of the *component instance* it lives inside — "all usages"
                // isn't a meaningful scope for it (there's only ever one
                // instance selected via the click that produced this path),
                // so a path always resolves to the single matching branch.
                if (!hasPath && scope === "all") {
                  branches = ["consequent", "alternate"];
                } else {
                  const usage = resolveComponentAtRoute(graph, component, route);
                  if (!("props" in usage)) {
                    throw new Error(`"${component}" at "${route}" is a page/layout itself, not an instance`);
                  }
                  branches = [branchForValue(fresh, usage.props[fresh.propName])];
                }
              } else if (fresh.kind === "clsxCall") {
                // Not a ternary-branch shape at all — applied directly,
                // below the forEach the ternary/string cases use, since
                // there's nothing to iterate: a clsx() call has exactly one
                // relevant argument per edit, not a consequent/alternate
                // pair. clsxArgIndex, when the client sent one (see
                // ScopeChoice's "clsx" variant), overrides the structural
                // fallback applyClsxPropertyEdit would otherwise use.
                beforePx = applyClsxPropertyEdit(classAttr, propDef, px, tier, clsxArgIndex);
                branches = [];
              } else {
                // Every other ClassIR kind is handled above (string/ternary/
                // clsxCall) — the only one left here is "unsupported".
                throw new Error(`className is unsupported: ${fresh.reason}`);
              }
              branches.forEach((branch, i) => {
                const px0 = applyTailwindPropertyEdit(classAttr, branch, propDef, px, tier);
                if (i === 0) beforePx = px0;
              });
              // clsx never has an "all usages" concept — a write always
              // lands on exactly one argument (see applyClsxPropertyEdit) —
              // so it's always described as "this instance" regardless of
              // what scope the client happened to send.
              scopeLabel = fresh.kind !== "clsxCall" && !hasPath && scope === "all" ? "all usages" : "this instance";
            }

            // The viewport tier only means anything for a Tailwind write —
            // an inline style has no responsive variant, so tagging a style
            // edit with "(mobile)" would falsely imply it only applies
            // there.
            const tierLabel = backend === "tailwind" && tier !== "desktop" ? `, ${tier}` : "";
            const description = `${component} ${propDef.label}: ${beforePx !== null ? beforePx + "px" : "not set"} → ${px}px (${scopeLabel}, ${backend}${tierLabel})`;
            const { diff } = recordAndWrite(state, def.filePath, before, {
              description,
              breadcrumb: elementBreadcrumb(component, def.rootElement, hasPath ? path : undefined),
              propertyLabel: propDef.label,
              beforeValue: beforePx !== null ? `${beforePx}px` : "not set",
              afterValue: `${px}px`,
              component,
              route,
              path: hasPath ? path! : [],
            });

            sendJson(res, 200, { ok: true, filePath: def.filePath, diff });
          } catch (err) {
            sendJson(res, 200, { ok: false, error: (err as Error).message });
          }
        })
        .catch((err) => sendJson(res, 400, { ok: false, error: (err as Error).message }));
      return;
    }

    if (req.method === "POST" && req.url === "/__reframe/mutate-text") {
      readJsonBody(req)
        .then((body) => {
          const { component, route, path, value } = body as {
            component?: string;
            route?: string;
            path?: number[];
            value?: string;
          };
          if (!component || typeof route !== "string" || typeof value !== "string") {
            sendJson(res, 400, { ok: false, error: "expected { component, route, value }" });
            return;
          }
          try {
            const def = resolveDefinition(graph, component);
            const target = resolveTarget(def, path);
            if (!target) throw new Error("This element can't currently be edited safely.");

            const before = printFile(graph, def.filePath);
            const ir = extractTextIR(target);
            const beforeValue = ir.kind === "text" ? ir.value : null;
            const result = writeTextContent(ir, value);
            if (!result.ok) throw new Error(result.reason);

            const description = `${component} text: "${truncate(beforeValue ?? "")}" → "${truncate(value)}"`;
            const { diff } = recordAndWrite(state, def.filePath, before, {
              description,
              breadcrumb: elementBreadcrumb(component, def.rootElement, path && path.length > 0 ? path : undefined),
              propertyLabel: "Text",
              beforeValue: `"${truncate(beforeValue ?? "")}"`,
              afterValue: `"${truncate(value)}"`,
              component,
              route,
              path: path ?? [],
            });

            sendJson(res, 200, { ok: true, filePath: def.filePath, diff });
          } catch (err) {
            sendJson(res, 200, { ok: false, error: (err as Error).message });
          }
        })
        .catch((err) => sendJson(res, 400, { ok: false, error: (err as Error).message }));
      return;
    }

    if (req.method === "POST" && req.url === "/__reframe/delete") {
      readJsonBody(req)
        .then((body) => {
          const { component, route, path } = body as {
            component?: string;
            route?: string;
            path?: number[];
          };
          if (!component || typeof route !== "string") {
            sendJson(res, 400, { ok: false, error: "expected { component, route, path }" });
            return;
          }
          // Deleting a component's own root (path: [] or absent) would mean
          // removing everything that component ever renders, from a click
          // inside it — a fundamentally different, much larger operation
          // ("delete this component everywhere it's used") than "remove
          // this one nested element," and not one a single click on the
          // canvas should be able to trigger by accident. Refused, not
          // guessed at.
          if (!Array.isArray(path) || path.length === 0) {
            sendJson(res, 200, { ok: false, error: "Can't delete a component's own root from here — only a nested element." });
            return;
          }
          try {
            const def = resolveDefinition(graph, component);
            const parent = resolveElementPath(def.rootElement, path.slice(0, -1));
            if (!parent) throw new Error("This element can't currently be edited safely.");
            const target = resolveElementPath(def.rootElement, path);
            if (!target) throw new Error("This element can't currently be edited safely.");
            const label = elementTagName(target) ?? "element";

            const before = printFile(graph, def.filePath);
            removeElement(parent, path[path.length - 1]!);
            const description = `${component}: removed <${label}>`;
            const { diff } = recordAndWrite(state, def.filePath, before, {
              description,
              breadcrumb: elementBreadcrumb(component, def.rootElement, path),
              propertyLabel: "Removed",
              beforeValue: `<${label}>`,
              afterValue: "—",
              component,
              route,
              // The deleted element no longer exists at this path — jumping
              // "back to it" means the component's own root, not the (now
              // gone) nested node.
              path: [],
            });

            sendJson(res, 200, { ok: true, filePath: def.filePath, diff });
          } catch (err) {
            sendJson(res, 200, { ok: false, error: (err as Error).message });
          }
        })
        .catch((err) => sendJson(res, 400, { ok: false, error: (err as Error).message }));
      return;
    }

    if (req.method === "POST" && req.url === "/__reframe/duplicate") {
      readJsonBody(req)
        .then((body) => {
          const { component, route, path } = body as {
            component?: string;
            route?: string;
            path?: number[];
          };
          if (!component || typeof route !== "string") {
            sendJson(res, 400, { ok: false, error: "expected { component, route, path }" });
            return;
          }
          // Same restriction as delete — duplicating a component's own root
          // isn't "add another instance of this element," it's "add another
          // usage of this whole component wherever it's rendered," a
          // different and much larger operation than a click on the canvas
          // should trigger.
          if (!Array.isArray(path) || path.length === 0) {
            sendJson(res, 200, { ok: false, error: "Can't duplicate a component's own root from here — only a nested element." });
            return;
          }
          try {
            const def = resolveDefinition(graph, component);
            const parent = resolveElementPath(def.rootElement, path.slice(0, -1));
            if (!parent) throw new Error("This element can't currently be edited safely.");
            const target = resolveElementPath(def.rootElement, path);
            if (!target) throw new Error("This element can't currently be edited safely.");
            const label = elementTagName(target) ?? "element";

            const before = printFile(graph, def.filePath);
            duplicateElement(parent, path[path.length - 1]!);
            const description = `${component}: duplicated <${label}>`;
            const { diff } = recordAndWrite(state, def.filePath, before, {
              description,
              breadcrumb: elementBreadcrumb(component, def.rootElement, path),
              propertyLabel: "Duplicated",
              beforeValue: "—",
              afterValue: `<${label}>`,
              component,
              route,
              path,
            });

            sendJson(res, 200, { ok: true, filePath: def.filePath, diff });
          } catch (err) {
            sendJson(res, 200, { ok: false, error: (err as Error).message });
          }
        })
        .catch((err) => sendJson(res, 400, { ok: false, error: (err as Error).message }));
      return;
    }

    if (req.method === "POST" && req.url === "/__reframe/reorder") {
      readJsonBody(req)
        .then((body) => {
          const { route, fromIndex, toIndex, fromName, toName, insertBefore } = body as {
            route?: string;
            fromIndex?: number;
            toIndex?: number;
            fromName?: string;
            toName?: string;
            insertBefore?: boolean;
          };
          if (typeof route !== "string" || typeof fromIndex !== "number" || typeof toIndex !== "number") {
            sendJson(res, 400, { ok: false, error: "expected { route, fromIndex, toIndex }" });
            return;
          }
          try {
            const pageDef = resolveDefinitionByFile(graph, routeToPageFile(route));
            if (!pageDef) throw new Error(`No page found for route "${route}"`);

            const before = printFile(graph, pageDef.filePath);
            moveChild(pageDef.rootElement, fromIndex, toIndex, insertBefore);

            const description = `${fromName ?? "Section"} moved to ${toName ?? "a new"} position on ${routeDisplayName(route)}`;
            const { diff } = recordAndWrite(state, pageDef.filePath, before, {
              description,
              breadcrumb: [routeDisplayName(route)],
              propertyLabel: "Position",
              beforeValue: fromName ?? "Section",
              afterValue: `moved to ${toName ?? "new position"}`,
              // No single element was "the one edited" here — a reorder is
              // page-level. Jumping to it means the page's own root, the
              // closest equivalent to what a Pages-tree click on this page
              // already resolves to.
              component: pageDef.name,
              route,
              path: [],
            });

            sendJson(res, 200, { ok: true, filePath: pageDef.filePath, diff });
          } catch (err) {
            sendJson(res, 200, { ok: false, error: (err as Error).message });
          }
        })
        .catch((err) => sendJson(res, 400, { ok: false, error: (err as Error).message }));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  server.listen(hostPort, () => {
    console.log(`[reframe] open http://localhost:${hostPort} in a browser`);
  });
}
