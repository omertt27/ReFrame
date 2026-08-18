import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import httpProxy from "http-proxy";

import { pageSectionOrder } from "@reframe/core";

import type { AppState } from "./state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRELOAD_PATH = "/__reframe/preload.js";
const preloadScript = readFileSync(join(__dirname, "static/preload.js"), "utf8");

/**
 * Fronts an already-running dev server. Passes everything through
 * unmodified except:
 *  - injects one <script> tag into HTML responses (never RSC flight
 *    payloads — gated strictly on content-type) before </body>, and serves
 *    that script itself
 *  - rewrites outbound Host/Origin/Referer toward the target so Next's
 *    allowedDevOrigins dev-origin protection doesn't need touching the
 *    user's next.config.js
 *  - strips Accept-Encoding outbound so a byte-level string-replace on the
 *    body never has to deal with a compressed response
 *  - passes the WS upgrade through untouched, so Fast Refresh keeps working
 *
 * Known tradeoff: buffers the whole HTML body before rewriting, which
 * de-streams App Router's streaming SSR (delays first byte until the
 * target's response closes). Acceptable for this read-only spike; a
 * streaming scan for </body> across chunk boundaries would fix it properly.
 */
export function startProxyServer(targetPort: number, proxyPort: number, state: AppState): void {
  const target = `http://localhost:${targetPort}`;
  const proxy = httpProxy.createProxyServer({ target, selfHandleResponse: true });

  proxy.on("proxyReq", (proxyReq) => {
    proxyReq.setHeader("host", `localhost:${targetPort}`);
    proxyReq.setHeader("origin", target);
    proxyReq.setHeader("referer", `${target}/`);
    proxyReq.setHeader("accept-encoding", "identity");
  });

  proxy.on("proxyRes", (proxyRes, _req, res: ServerResponse) => {
    const contentType = String(proxyRes.headers["content-type"] ?? "");
    if (!contentType.includes("text/html")) {
      res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
      proxyRes.pipe(res);
      return;
    }

    const chunks: Buffer[] = [];
    proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
    proxyRes.on("end", () => {
      let body = Buffer.concat(chunks).toString("utf8");
      const injectTag = `<script src="${PRELOAD_PATH}"></script>`;
      body = body.includes("</body>") ? body.replace("</body>", `${injectTag}</body>`) : body + injectTag;

      const headers = { ...proxyRes.headers };
      delete headers["content-length"];
      delete headers["content-encoding"];
      headers["content-length"] = String(Buffer.byteLength(body));

      res.writeHead(proxyRes.statusCode ?? 200, headers);
      res.end(body);
    });
  });

  proxy.on("error", (err, _req, res) => {
    if (isServerResponse(res)) {
      res.writeHead(502);
      res.end(`proxy error: ${err.message}`);
    }
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === PRELOAD_PATH) {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(preloadScript);
      return;
    }
    // Served here too, not just on the host server: the preload script runs
    // at the proxy's origin (inside the iframe), so its own relative fetch
    // for this resolves against this server, not the host's.
    if (req.url === "/__reframe/components") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([...state.graph.definitions.keys()]));
      return;
    }
    if (req.url?.startsWith("/__reframe/sections")) {
      const route = new URL(req.url, "http://x").searchParams.get("route") ?? "/";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(pageSectionOrder(state.graph, route) ?? []));
      return;
    }
    proxy.web(req, res, { target });
  });

  server.on("upgrade", (req, socket, head) => {
    proxy.ws(req, socket, head, { target });
  });

  server.listen(proxyPort, () => {
    console.log(`[reframe] proxy listening on http://localhost:${proxyPort} -> ${target}`);
  });
}

// http-proxy's error handler types `res` as ServerResponse | Socket — narrow
// without importing net.Socket just for a typeof check.
function isServerResponse(res: unknown): res is ServerResponse {
  return typeof (res as ServerResponse)?.writeHead === "function";
}
