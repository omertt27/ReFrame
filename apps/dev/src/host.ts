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
  const fromTailwind = classList !== null ? readProperty(classList, prop) : null;
  if (fromTailwind?.available && fromTailwind.px !== null) {
    return { available: true, kind: "dimension", px: fromTailwind.px, backend: "tailwind" };
  }
  const fromStyle = styleIR ? readStyleObjectProperty(styleIR, prop) : null;
  if (fromStyle?.available && fromStyle.px !== null) {
    return { available: true, kind: "dimension", px: fromStyle.px, backend: "style" };
  }
  if (fromTailwind && !fromTailwind.available) return { available: false, kind: "dimension", reason: fromTailwind.reason };
  if (fromStyle && !fromStyle.available) return { available: false, kind: "dimension", reason: fromStyle.reason };
  if (classList !== null) return { available: true, kind: "dimension", px: null, backend: "tailwind" };
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
 */
function readCurrentProperties(
  classAttr: ClassAttrRef | null,
  styleAttr: StyleAttrRef | null,
  usageProps: Record<string, string> | null,
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
    } else {
      classUnsupportedReason = fresh?.kind === "unsupported" ? fresh.reason : "className shape isn't a plain string or ternary";
    }
  }
  const styleIR = styleAttr ? extractStyleIR(styleAttr.attrNode) : null;

  const values: Record<string, PropertyReadInfo> = {};
  for (const prop of EDITABLE_PROPERTIES) {
    values[prop.key] =
      prop.valueKind === "dimension"
        ? readDimensionValue(prop, classList, styleIR, classUnsupportedReason)
        : readColorValue(prop, classList, styleIR, classUnsupportedReason);
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
          const { component, route, path, elementTag } = body as {
            component?: string;
            route?: string;
            path?: number[];
            elementTag?: string;
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

          const properties = readCurrentProperties(classAttr, styleAttr, props);
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
              } else {
                throw new Error(`className is unsupported: ${fresh.kind === "unsupported" ? fresh.reason : fresh.kind}`);
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
