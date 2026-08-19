import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as t from "@babel/types";
import { createPatch } from "diff";

import {
  applyClassMutation,
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
  printFile,
  readProperty,
  readStyleObjectColor,
  readStyleObjectProperty,
  resolveAllUsages,
  resolveComponentAtRoute,
  resolveDefinition,
  resolveDefinitionByFile,
  resolveElementPath,
  routeToPageFile,
  writeProperty,
  writeStyleColor,
  writeStyleProperty,
  writeTextContent,
  type ClassAttrRef,
  type ComponentDef,
  type PropertyDef,
  type StyleAttrRef,
  type StyleIR,
} from "@reframe/core";

import { pushHistory, redo, undo } from "./history.js";
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

/** Which ternary branch a specific prop value resolves to — the same rule
 * used everywhere "this instance" vs "all instances" is decided. */
function branchForValue(ir: { propName: string; testValue: string }, value: string | undefined): "consequent" | "alternate" {
  return value === ir.testValue ? "consequent" : "alternate";
}

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

type Backend = "tailwind" | "style";

interface PropertyReadInfo {
  available: boolean;
  kind: "dimension" | "color";
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
  const fromTailwind = prop.prefix && classList !== null ? readProperty(classList, prop) : null;
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
  if (classList !== null && prop.prefix && hasTailwindColorUtility(classList, prop.prefix)) {
    const existing = findUtilityClass(classList, prop.prefix);
    return {
      available: false,
      kind: "color",
      reason: `already set via a Tailwind utility class ("${existing}") — editing Tailwind color utilities isn't supported yet, only inline style colors`,
    };
  }
  const fromStyle = styleIR ? readStyleObjectColor(styleIR, prop) : null;
  if (fromStyle?.available && fromStyle.value !== null) {
    return { available: true, kind: "color", value: fromStyle.value, backend: "style" };
  }
  if (fromStyle && !fromStyle.available) return { available: false, kind: "color", reason: fromStyle.reason };
  if (styleIR) return { available: true, kind: "color", value: null, backend: "style" };
  return {
    available: false,
    kind: "color",
    reason: classUnsupportedReason ?? "no inline style on this element to add a color to — Tailwind color utilities aren't editable yet",
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
function crossCheckAgainstComputed(kind: "dimension" | "color", predicted: number | string, computedRaw: string): boolean | null {
  if (kind === "color") {
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
  usageProps: Record<string, string> | null,
  computedStyle: Record<string, string> | null,
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

  const values: Record<string, PropertyReadInfo> = {};
  for (const prop of EDITABLE_PROPERTIES) {
    const info =
      prop.valueKind === "dimension"
        ? readDimensionValue(prop, classList, styleIR, classUnsupportedReason)
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
  return { editable: true as const, values };
}

/** Applies one property edit to one Tailwind branch (or the plain string),
 * re-reading the IR fresh from the live AST first so repeated edits within
 * a session see each other's changes. Returns the previous px value. */
function applyTailwindPropertyEdit(
  classAttr: ClassAttrRef,
  branch: "consequent" | "alternate" | null,
  prop: PropertyDef,
  px: number,
): number | null {
  const fresh = extractClassIR(classAttr.attrNode);
  if (branch) {
    if (!fresh || fresh.kind !== "ternary") throw new Error("Expected a ternary className");
    const current = branch === "consequent" ? fresh.consequent : fresh.alternate;
    const before = readProperty(current, prop);
    const result = writeProperty(current, prop, px);
    if (!result.ok) throw new Error(result.reason);
    applyClassMutation({ attrNode: classAttr.attrNode, ir: fresh }, { op: "setBranch", branch, value: result.classList });
    return before.available ? before.px : null;
  }
  if (!fresh || fresh.kind !== "string") throw new Error("Expected a plain string className");
  const before = readProperty(fresh.value, prop);
  const result = writeProperty(fresh.value, prop, px);
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
 */
function applyClsxPropertyEdit(classAttr: ClassAttrRef, prop: PropertyDef, px: number): number | null {
  const fresh = extractClassIR(classAttr.attrNode);
  if (!fresh || fresh.kind !== "clsxCall") throw new Error("Expected a clsx()/cn() call");
  if (fresh.args === null) {
    throw new Error(
      `${fresh.calleeName}() has argument shapes that aren't recognized (only string literals and ` +
        '`test && "class"` conditionals are supported) — refusing to edit around what it can\'t parse',
    );
  }

  let targetIndex = fresh.args.findIndex((a) => prop.prefix && findUtilityClass(a.value, prop.prefix));
  if (targetIndex === -1) targetIndex = fresh.args.findIndex((a) => a.kind === "string");
  if (targetIndex === -1) {
    throw new Error(`${fresh.calleeName}() has no plain string argument to add "${prop.prefix}" to`);
  }

  const arg = fresh.args[targetIndex]!;
  const before = readProperty(arg.value, prop);
  const result = writeProperty(arg.value, prop, px);
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

function recordAndWrite(state: AppState, filePath: string, before: string, description: string) {
  const after = printFile(state.graph, filePath);
  writeFileSync(join(state.targetDir, filePath), after, "utf8");
  pushHistory(state, { filePath, before, after, description });
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
      const pages = listPageRoutes(graph).map(({ route, pageComponent }) => ({
        route,
        label: routeDisplayName(route),
        pageComponent,
        sections: (pageSectionOrder(graph, route) ?? []).map((s) => s.name),
      }));
      sendJson(res, 200, pages);
      return;
    }

    if (req.method === "GET" && req.url === "/__reframe/history") {
      sendJson(res, 200, {
        history: state.history.map(({ id, filePath, description }) => ({ id, filePath, description })),
        canRedo: state.redoStack.length > 0,
      });
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
          const { component, route, path, elementTag, computedStyle } = body as {
            component?: string;
            route?: string;
            path?: number[];
            elementTag?: string;
            computedStyle?: Record<string, string>;
          };
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
          let props: Record<string, string> | null = null;
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

          const properties = readCurrentProperties(classAttr, styleAttr, props, computedStyle ?? null);
          const textIR = extractTextIR(target);
          const text =
            textIR.kind === "text" ? { editable: true as const, value: textIR.value } : { editable: false as const, reason: textIR.reason };

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
          });
        })
        .catch((err) => sendJson(res, 400, { ok: false, error: (err as Error).message }));
      return;
    }

    if (req.method === "POST" && req.url === "/__reframe/mutate") {
      readJsonBody(req)
        .then((body) => {
          const { component, route, scope, property, px, value, backend, path } = body as {
            component?: string;
            route?: string;
            scope?: "instance" | "all";
            property?: string;
            px?: number;
            value?: string;
            backend?: Backend;
            path?: number[];
          };
          if (!component || !route || !scope || !property || !backend || (typeof px !== "number" && typeof value !== "string")) {
            sendJson(res, 400, { ok: false, error: "expected { component, route, scope, property, backend, px } or { ..., value }" });
            return;
          }
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
            if (propDef.valueKind === "color") {
              if (typeof value !== "string") throw new Error(`"${property}" is a color property — expected { value }`);
              const styleAttr = hasPath ? extractStyleAttr(targetNode) : def.styleAttr;
              if (!styleAttr) throw new Error(`"${component}" has no editable inline style`);
              const beforeValue = applyStyleColorEdit(styleAttr, propDef, value);
              const description = `${component} ${propDef.label}: ${beforeValue ?? "not set"} → ${value} (this instance, style)`;
              const { diff } = recordAndWrite(state, def.filePath, before, description);
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
                // pair.
                beforePx = applyClsxPropertyEdit(classAttr, propDef, px);
                branches = [];
              } else {
                // Every other ClassIR kind is handled above (string/ternary/
                // clsxCall) — the only one left here is "unsupported".
                throw new Error(`className is unsupported: ${fresh.reason}`);
              }
              branches.forEach((branch, i) => {
                const px0 = applyTailwindPropertyEdit(classAttr, branch, propDef, px);
                if (i === 0) beforePx = px0;
              });
              scopeLabel = !hasPath && scope === "all" ? "all usages" : "this instance";
            }

            const description = `${component} ${propDef.label}: ${beforePx !== null ? beforePx + "px" : "not set"} → ${px}px (${scopeLabel}, ${backend})`;
            const { diff } = recordAndWrite(state, def.filePath, before, description);

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
            const { diff } = recordAndWrite(state, def.filePath, before, description);

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
          const { route, fromIndex, toIndex, fromName, toName } = body as {
            route?: string;
            fromIndex?: number;
            toIndex?: number;
            fromName?: string;
            toName?: string;
          };
          if (typeof route !== "string" || typeof fromIndex !== "number" || typeof toIndex !== "number") {
            sendJson(res, 400, { ok: false, error: "expected { route, fromIndex, toIndex }" });
            return;
          }
          try {
            const pageDef = resolveDefinitionByFile(graph, routeToPageFile(route));
            if (!pageDef) throw new Error(`No page found for route "${route}"`);

            const before = printFile(graph, pageDef.filePath);
            moveChild(pageDef.rootElement, fromIndex, toIndex);

            const description = `${fromName ?? "Section"} moved to ${toName ?? "a new"} position on ${routeDisplayName(route)}`;
            const { diff } = recordAndWrite(state, pageDef.filePath, before, description);

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
