import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPatch } from "diff";

import {
  applyClassMutation,
  EDITABLE_PROPERTIES,
  extractClassIR,
  moveChild,
  printFile,
  readProperty,
  resolveAllUsages,
  resolveComponentAtRoute,
  resolveDefinition,
  resolveDefinitionByFile,
  routeToPageFile,
  writeProperty,
  type ClassAttrRef,
  type ComponentGraph,
  type PropertyDef,
} from "@reframe/core";

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

/** Which ternary branch a specific prop value resolves to — the same rule
 * used everywhere "this instance" vs "all instances" is decided. */
function branchForValue(ir: { propName: string; testValue: string }, value: string | undefined): "consequent" | "alternate" {
  return value === ir.testValue ? "consequent" : "alternate";
}

/** Reads every editable property's current value from a classAttr, for
 * whichever branch matches the given usage (or the plain string, if it's
 * not a ternary at all). Ternary/clsx-call callers reuse this per branch. */
function readCurrentProperties(classAttr: ClassAttrRef, usageProps: Record<string, string> | null) {
  const fresh = extractClassIR(classAttr.attrNode);
  let classList: string | null = null;
  if (fresh?.kind === "string") {
    classList = fresh.value;
  } else if (fresh?.kind === "ternary") {
    const branch = branchForValue(fresh, usageProps?.[fresh.propName]);
    classList = branch === "consequent" ? fresh.consequent : fresh.alternate;
  }

  if (classList === null) {
    return { editable: false as const, reason: fresh?.kind === "unsupported" ? fresh.reason : "className shape isn't a plain string or ternary" };
  }

  const values: Record<string, { available: boolean; px: number | null; reason?: string }> = {};
  for (const prop of EDITABLE_PROPERTIES) {
    const read = readProperty(classList, prop);
    values[prop.key] = read.available ? { available: true, px: read.px } : { available: false, px: null, reason: read.reason };
  }
  return { editable: true as const, values };
}

/** Applies one property edit to one branch (or the plain string), re-reading
 * the IR fresh from the live AST first so repeated edits within a session
 * see each other's changes. */
function applyPropertyEdit(
  classAttr: ClassAttrRef,
  branch: "consequent" | "alternate" | null,
  prop: PropertyDef,
  px: number,
): void {
  const fresh = extractClassIR(classAttr.attrNode);
  if (branch) {
    if (!fresh || fresh.kind !== "ternary") throw new Error("Expected a ternary className");
    const current = branch === "consequent" ? fresh.consequent : fresh.alternate;
    const result = writeProperty(current, prop, px);
    if (!result.ok) throw new Error(result.reason);
    applyClassMutation({ attrNode: classAttr.attrNode, ir: fresh }, { op: "setBranch", branch, value: result.classList });
  } else {
    if (!fresh || fresh.kind !== "string") throw new Error("Expected a plain string className");
    const result = writeProperty(fresh.value, prop, px);
    if (!result.ok) throw new Error(result.reason);
    applyClassMutation({ attrNode: classAttr.attrNode, ir: fresh }, { op: "setString", value: result.classList });
  }
}

/** Serves the host shell (component list + canvas + property panel) and the
 * small JSON API it calls into packages/core's resolution/mutation logic —
 * that logic needs fs/Babel/recast, so it has to run server-side. */
export function startHostServer(
  hostPort: number,
  proxyPort: number,
  targetDir: string,
  graph: ComponentGraph,
  originalSources: Map<string, string>,
): void {
  const hostHtml = readFileSync(join(__dirname, "static/host.html"), "utf8").replace(
    "__PROXY_URL__",
    `http://localhost:${proxyPort}/`,
  );

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
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

          const properties = def.classAttr ? readCurrentProperties(def.classAttr, props) : { editable: false as const, reason: "no root className" };

          sendJson(res, 200, { ok: true, kind, filePath, props, usageCount, note, properties });
        })
        .catch((err) => sendJson(res, 400, { ok: false, error: (err as Error).message }));
      return;
    }

    if (req.method === "POST" && req.url === "/__reframe/mutate") {
      readJsonBody(req)
        .then((body) => {
          const { component, route, scope, property, px } = body as {
            component?: string;
            route?: string;
            scope?: "instance" | "all";
            property?: string;
            px?: number;
          };
          if (!component || !route || !scope || !property || typeof px !== "number") {
            sendJson(res, 400, { ok: false, error: "expected { component, route, scope, property, px }" });
            return;
          }
          try {
            const def = resolveDefinition(graph, component);
            if (!def.classAttr) throw new Error(`"${component}" has no editable root className`);
            const propDef = EDITABLE_PROPERTIES.find((p) => p.key === property);
            if (!propDef) throw new Error(`Unknown property "${property}"`);

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

            for (const branch of branches) {
              applyPropertyEdit(def.classAttr, branch, propDef, px);
            }

            const newSource = printFile(graph, def.filePath);
            writeFileSync(join(targetDir, def.filePath), newSource, "utf8");

            const original = originalSources.get(def.filePath) ?? newSource;
            const diff = createPatch(def.filePath, original, newSource, "", "");

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
          const { route, fromIndex, toIndex } = body as { route?: string; fromIndex?: number; toIndex?: number };
          if (typeof route !== "string" || typeof fromIndex !== "number" || typeof toIndex !== "number") {
            sendJson(res, 400, { ok: false, error: "expected { route, fromIndex, toIndex }" });
            return;
          }
          try {
            const pageDef = resolveDefinitionByFile(graph, routeToPageFile(route));
            if (!pageDef) throw new Error(`No page found for route "${route}"`);

            moveChild(pageDef.rootElement, fromIndex, toIndex);

            const newSource = printFile(graph, pageDef.filePath);
            writeFileSync(join(targetDir, pageDef.filePath), newSource, "utf8");

            const original = originalSources.get(pageDef.filePath) ?? newSource;
            const diff = createPatch(pageDef.filePath, original, newSource, "", "");

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
