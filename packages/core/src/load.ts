import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);

/**
 * Recursively loads every .ts/.tsx file under <rootDir>/app, returning paths
 * relative to rootDir (e.g. "app/page.tsx", "app/components/Navbar.tsx") —
 * the shape routeToPageFile/routeLayoutFiles expect.
 *
 * V0 scope: only walks app/ (App Router convention). Real projects that keep
 * shared components outside app/ (top-level components/, src/components/)
 * aren't covered yet — deliberately, to avoid pulling in unrelated files
 * (scripts, tests, config) without more careful filtering.
 */
export function loadProjectFiles(rootDir: string): { filePath: string; source: string }[] {
  const appDir = join(rootDir, "app");
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

  walk(appDir);
  return files;
}
