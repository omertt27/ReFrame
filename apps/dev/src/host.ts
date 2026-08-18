import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPatch } from "diff";

import {
  applyClassMutation,
  EDITABLE_PROPERTIES,
  extractClassIR,
  extractStyleIR,
  listPageRoutes,
  moveChild,
  pageSectionOrder,
  printFile,
  readProperty,
  readStyleObjectProperty,
  resolveAllUsages,
  resolveComponentAtRoute,
  resolveDefinition,
  resolveDefinitionByFile,
  routeToPageFile,
  writeProperty,
  writeStyleProperty,
  type ClassAttrRef,
  type PropertyDef,
  type StyleAttrRef,
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

type Backend = "tailwind" | "style";

interface PropertyReadInfo {
  available: boolean;
  px: number | null;
  reason?: string;
  /** Which backend this value came from (or, if px is null, which backend
   * a write would go to) — the client echoes this back on mutate, so the
   * server never has to re-derive a per-property backend decision that
   * might disagree with what was actually shown. */
  backend?: Backend;
}

/**
 * Reads every editable property's current value across BOTH style backends
 * for one root element — the Style IR dispatch the real-world stress test
 * called for. Tailwind is preferred when a property is actually set there;
 * inline style is checked next; if neither has it, "not set" defaults to
 * whichever backend exists (Tailwind if present, else style) so a
 * subsequent write has somewhere sensible to go. A property already set via
 * one backend is never silently rewritten into the other — see
 * mutate/style.ts and mutate/tailwind.ts's own guards for the enforcement.
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
    const fromTailwind = classList !== null ? readProperty(classList, prop) : null;
    if (fromTailwind?.available && fromTailwind.px !== null) {
      values[prop.key] = { available: true, px: fromTailwind.px, backend: "tailwind" };
      continue;
    }

    const fromStyle = styleIR ? readStyleObjectProperty(styleIR, prop) : null;
    if (fromStyle?.available && fromStyle.px !== null) {
      values[prop.key] = { available: true, px: fromStyle.px, backend: "style" };
      continue;
    }

    if (fromTailwind && !fromTailwind.available) {
      values[prop.key] = { available: false, px: null, reason: fromTailwind.reason };
    } else if (fromStyle && !fromStyle.available) {
      values[prop.key] = { available: false, px: null, reason: fromStyle.reason };
    } else if (classList !== null) {
      values[prop.key] = { available: true, px: null, backend: "tailwind" };
    } else if (styleIR) {
      values[prop.key] = { available: true, px: null, backend: "style" };
    } else {
      values[prop.key] = { available: false, px: null, reason: classUnsupportedReason ?? "no editable style found" };
    }
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
          const { component, route } = body as { component?: string; route?: string };
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

          const properties = readCurrentProperties(def.classAttr, def.styleAttr, props);

          sendJson(res, 200, { ok: true, kind, filePath, props, usageCount, note, properties });
        })
        .catch((err) => sendJson(res, 400, { ok: false, error: (err as Error).message }));
      return;
    }

    if (req.method === "POST" && req.url === "/__reframe/mutate") {
      readJsonBody(req)
        .then((body) => {
          const { component, route, scope, property, px, backend } = body as {
            component?: string;
            route?: string;
            scope?: "instance" | "all";
            property?: string;
            px?: number;
            backend?: Backend;
          };
          if (!component || !route || !scope || !property || typeof px !== "number" || !backend) {
            sendJson(res, 400, { ok: false, error: "expected { component, route, scope, property, px, backend }" });
            return;
          }
          try {
            const def = resolveDefinition(graph, component);
            const propDef = EDITABLE_PROPERTIES.find((p) => p.key === property);
            if (!propDef) throw new Error(`Unknown property "${property}"`);

            const before = printFile(graph, def.filePath);
            let beforePx: number | null = null;
            let scopeLabel: string;

            if (backend === "style") {
              if (!def.styleAttr) throw new Error(`"${component}" has no editable inline style`);
              beforePx = applyStylePropertyEdit(def.styleAttr, propDef, px);
              scopeLabel = "this instance"; // style={{}} is always per-usage-site, no ternary scope
            } else {
              if (!def.classAttr) throw new Error(`"${component}" has no editable root className`);
              const fresh = extractClassIR(def.classAttr.attrNode);
              let branches: ("consequent" | "alternate" | null)[];
              if (!fresh) {
                throw new Error("Nothing to edit");
              } else if (fresh.kind === "string") {
                branches = [null];
              } else if (fresh.kind === "ternary") {
                if (scope === "all") {
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
                const px0 = applyTailwindPropertyEdit(def.classAttr!, branch, propDef, px);
                if (i === 0) beforePx = px0;
              });
              scopeLabel = scope === "all" ? "all usages" : "this instance";
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
