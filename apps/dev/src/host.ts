import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPatch } from "diff";

import {
  applyClassMutation,
  extractClassIR,
  printFile,
  replaceUtilityClass,
  resolveComponentAtRoute,
  resolveDefinition,
  type ComponentGraph,
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

/**
 * Applies a token-exact utility-class replace to one branch of a shared
 * component's ternary className, re-extracting the IR fresh from the live
 * AST each time (not from a parse-time snapshot) so repeated edits within
 * the same server session see each other's changes. Uses replaceUtilityClass
 * (exact token match), not a substring replace — a substring replace would
 * corrupt "sm:p-4" while targeting "p-4".
 */
function editBranch(
  attrNode: Parameters<typeof extractClassIR>[0],
  branch: "consequent" | "alternate",
  find: string,
  replace: string,
): void {
  const fresh = extractClassIR(attrNode);
  if (!fresh || fresh.kind !== "ternary") {
    throw new Error("Target className is not a ternary — can't scope-edit a branch");
  }
  const current = branch === "consequent" ? fresh.consequent : fresh.alternate;
  applyClassMutation(
    { attrNode, ir: fresh },
    { op: "setBranch", branch, value: replaceUtilityClass(current, find, replace) },
  );
}

/** Serves the host shell (iframe + sidebar) and the small JSON API it calls
 * into packages/core's resolution logic — that logic needs fs/Babel/recast,
 * so it has to run server-side, not in the browser. */
export function startHostServer(
  hostPort: number,
  proxyPort: number,
  targetDir: string,
  graph: ComponentGraph,
  originalSources: Map<string, string>,
): void {
  const componentNames = [...graph.definitions.keys()];
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
      sendJson(res, 200, componentNames);
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
          try {
            const result = resolveComponentAtRoute(graph, component, route);
            const payload =
              "props" in result
                ? { ok: true, kind: "usage", filePath: result.filePath, props: result.props }
                : { ok: true, kind: "definition", filePath: result.filePath };
            sendJson(res, 200, payload);
          } catch (routeErr) {
            // Not used directly in a page/layout file (e.g. nested two or
            // more components deep — Page -> Hero -> CTA -> Button) — V0's
            // route resolution doesn't search inside imported subcomponents.
            // Still identify the definition file so "shared" edits (which
            // don't need per-instance usage/props) keep working; "instance"
            // scope correctly stays unavailable, since we can't determine
            // this instance's prop values without that usage.
            try {
              const def = resolveDefinition(graph, component);
              sendJson(res, 200, {
                ok: true,
                kind: "definition",
                filePath: def.filePath,
                note: "not directly used in a page/layout file — instance-scoped editing isn't available for this component yet, shared edits still work",
              });
            } catch {
              sendJson(res, 200, { ok: false, error: (routeErr as Error).message });
            }
          }
        })
        .catch((err) => sendJson(res, 400, { ok: false, error: (err as Error).message }));
      return;
    }

    if (req.method === "POST" && req.url === "/__reframe/mutate") {
      readJsonBody(req)
        .then((body) => {
          const { component, route, scope, find, replace } = body as {
            component?: string;
            route?: string;
            scope?: "instance" | "shared";
            find?: string;
            replace?: string;
          };
          if (!component || !route || !scope || !find || replace === undefined) {
            sendJson(res, 400, { ok: false, error: "expected { component, route, scope, find, replace }" });
            return;
          }
          try {
            const def = resolveDefinition(graph, component);
            if (!def.classAttr) throw new Error(`"${component}" has no editable root className`);

            const fresh = extractClassIR(def.classAttr.attrNode);
            if (!fresh || fresh.kind !== "ternary") {
              throw new Error(`"${component}"'s className isn't a ternary — nothing to scope-edit`);
            }

            let branches: ("consequent" | "alternate")[];
            if (scope === "shared") {
              branches = ["consequent", "alternate"];
            } else {
              const usage = resolveComponentAtRoute(graph, component, route);
              if (!("props" in usage)) {
                throw new Error(`"${component}" at "${route}" is a page/layout itself, not an instance`);
              }
              const currentValue = usage.props[fresh.propName];
              branches = [currentValue === fresh.testValue ? "consequent" : "alternate"];
            }

            for (const branch of branches) {
              editBranch(def.classAttr.attrNode, branch, find, replace);
            }

            const newSource = printFile(graph, def.filePath);
            writeFileSync(join(targetDir, def.filePath), newSource, "utf8");

            const original = originalSources.get(def.filePath) ?? newSource;
            const diff = createPatch(def.filePath, original, newSource, "", "");

            sendJson(res, 200, { ok: true, filePath: def.filePath, branchesChanged: branches, diff });
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
