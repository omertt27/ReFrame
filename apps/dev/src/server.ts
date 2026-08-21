import { buildComponentGraph, loadProjectFiles, resolveProjectBaseDir } from "@reframe/core";

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

// Every ComponentDef.filePath is relative to resolveProjectBaseDir(targetDir),
// NOT targetDir itself — they silently diverge for a src/app-layout project
// (targetDir/src vs targetDir). state.targetDir feeds every on-disk write
// (recordAndWrite, undo, redo), so it has to be the SAME base loadProjectFiles
// used, or every write fails outright (ENOENT) regardless of which file it's
// touching — found live against the real PrivaPDF project, which uses src/app.
const baseDir = resolveProjectBaseDir(targetDir);
const state: AppState = { graph, targetDir: baseDir, history: [], redoStack: [], nextId: 1, reviewedCount: 0 };

startProxyServer(targetPort, proxyPort, state);
startHostServer(hostPort, proxyPort, state);
