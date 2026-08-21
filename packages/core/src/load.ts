import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build"]);

/**
 * Recursively loads every .ts/.tsx file under the project's App Router root
 * — either <rootDir>/app or, Next.js's other officially-supported layout,
 * <rootDir>/src/app (routeToPageFile/routeLayoutFiles, the Pages tree, and
 * route-scoped instance editing all depend on the "app/..." shape), returning
 * paths relative to whichever one contains it, normalized so both cases
 * produce the same "app/page.tsx", "app/components/Navbar.tsx" form — found
 * necessary live against a real PrivaPDF restructure to `src/app`: without
 * this, `<rootDir>/app` doesn't exist, `src/app/page.tsx`'s relative path
 * comes out as "src/app/page.tsx", and PAGE_FILE_RE (which requires the
 * "app/" prefix literally) never matches a single route — the Pages tree
 * silently renders empty, not an error, so it's easy to miss.
 *
 * If NEITHER exists, falls back to scanning `rootDir` directly — found
 * necessary via a real, non-Next.js second project (Excalidraw, a Vite app
 * with no "app/" convention at all): pointing this at ANY directory in that
 * project previously found zero files, not because component detection
 * failed, but because this never even looked in the right place.
 * Route-dependent features (the Pages tree, "all usages" scope) simply don't
 * apply outside `app/` — resolveComponentAtRoute already has an existing,
 * gracefully-handled failure path for exactly that ("not directly used in a
 * page/layout file"), so nested selection/property editing still works
 * without it.
 */
export function loadProjectFiles(rootDir: string): { filePath: string; source: string }[] {
  const appDir = join(rootDir, "app");
  const srcAppDir = join(rootDir, "src", "app");
  const usingApp = existsSync(appDir);
  const usingSrcApp = !usingApp && existsSync(srcAppDir);
  const scanDir = usingApp ? appDir : usingSrcApp ? srcAppDir : rootDir;
  // The base every returned filePath is made relative to — rootDir itself
  // for <rootDir>/app (yields "app/..." directly), rootDir/src for
  // <rootDir>/src/app (also yields "app/..." — the extra "src" segment is
  // absorbed here rather than appearing in every downstream path check).
  const baseDir = usingSrcApp ? join(rootDir, "src") : rootDir;
  const files: { filePath: string; source: string }[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
        files.push({
          filePath: relative(baseDir, fullPath).split(sep).join("/"),
          source: readFileSync(fullPath, "utf8"),
        });
      }
    }
  }

  walk(scanDir);
  return files;
}
