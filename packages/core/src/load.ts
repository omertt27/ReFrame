import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build"]);

/**
 * Recursively loads every .ts/.tsx file under <rootDir>/app (Next.js App
 * Router convention — routeToPageFile/routeLayoutFiles, the Pages tree, and
 * route-scoped instance editing all depend on that shape), returning paths
 * relative to rootDir (e.g. "app/page.tsx", "app/components/Navbar.tsx").
 *
 * If no `app/` directory exists, falls back to scanning `rootDir` directly
 * — found necessary via a real, non-Next.js second project (Excalidraw, a
 * Vite app with no "app/" convention at all): pointing this at ANY
 * directory in that project previously found zero files, not because
 * component detection failed, but because this never even looked in the
 * right place. Route-dependent features (the Pages tree, "all usages"
 * scope) simply don't apply outside `app/` — resolveComponentAtRoute
 * already has an existing, gracefully-handled failure path for exactly
 * that ("not directly used in a page/layout file"), so nested
 * selection/property editing still works without it.
 */
export function loadProjectFiles(rootDir: string): { filePath: string; source: string }[] {
  const appDir = join(rootDir, "app");
  const scanDir = existsSync(appDir) ? appDir : rootDir;
  const files: { filePath: string; source: string }[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
        files.push({
          filePath: relative(rootDir, fullPath).split(sep).join("/"),
          source: readFileSync(fullPath, "utf8"),
        });
      }
    }
  }

  walk(scanDir);
  return files;
}
