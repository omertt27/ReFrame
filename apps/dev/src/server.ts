import { buildComponentGraph, loadProjectFiles } from "@reframe/core";

import { startHostServer } from "./host.js";
import { startProxyServer } from "./proxy.js";
import type { AppState } from "./state.js";

function flag(name: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? Number(arg.split("=")[1]) : fallback;
}

function parseArgs() {
  const [, , targetDir, targetPortArg] = process.argv;
  if (!targetDir || !targetPortArg) {
    console.error(
      "Usage: server.ts <targetProjectDir> <targetDevServerPort> [--proxy-port=N] [--host-port=N]\n" +
        "Assumes `next dev` is already running on <targetDevServerPort> — this slice doesn't spawn it.",
    );
    process.exit(1);
  }
  return {
    targetDir,
    targetPort: Number(targetPortArg),
    proxyPort: flag("proxy-port", 4300),
    hostPort: flag("host-port", 4200),
  };
}

const { targetDir, targetPort, proxyPort, hostPort } = parseArgs();

console.log(`[reframe] parsing ${targetDir} ...`);
const graph = buildComponentGraph(loadProjectFiles(targetDir));
console.log(`[reframe] parsed ${graph.files.size} files, ${graph.definitions.size} components`);

const state: AppState = { graph, targetDir, history: [], redoStack: [], nextId: 1 };

startProxyServer(targetPort, proxyPort, state);
startHostServer(hostPort, proxyPort, state);
