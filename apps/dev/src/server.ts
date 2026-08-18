import { buildComponentGraph, loadProjectFiles } from "@reframe/core";

import { startHostServer } from "./host.js";
import { startProxyServer } from "./proxy.js";

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
const files = loadProjectFiles(targetDir);
const graph = buildComponentGraph(files);
const originalSources = new Map(files.map((f) => [f.filePath, f.source]));
console.log(`[reframe] parsed ${files.length} files, ${graph.definitions.size} components`);

startProxyServer(targetPort, proxyPort, graph);
startHostServer(hostPort, proxyPort, targetDir, graph, originalSources);
