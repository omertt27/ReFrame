import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build"]);

/**
 * The directory every file returned by `loadProjectFiles` is relative to —
 * rootDir itself for `<rootDir>/app`, `rootDir/src` for the `src/app`
 * layout. Exported so callers that need to turn a `ComponentDef.filePath`
 * back into a real path ON DISK (writing an edit, undo/redo) resolve it
 * against the SAME base this module used to produce it, rather than against
 * the raw project root — the two silently diverge for any src/app-layout
 * project, and a write built from the wrong base fails outright (ENOENT),
 * for every file in the project, not just ones under app/.
 */
export function resolveProjectBaseDir(rootDir: string): string {
  const appDir = join(rootDir, "app");
  const srcAppDir = join(rootDir, "src", "app");
  const usingApp = existsSync(appDir);
  const usingSrcApp = !usingApp && existsSync(srcAppDir);
  return usingSrcApp ? join(rootDir, "src") : rootDir;
}

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
 *
 * Scanning stops at `baseDir` (rootDir, or rootDir/src for the src/app
 * layout), NOT at app/ itself — found necessary via a real PrivaPDF
 * component, `HeroDropZone`, that lives in the conventional sibling
 * `src/components/` directory rather than nested inside `src/app`. Scanning
 * only `app/` silently dropped every file in `components/`/`hooks/`/`lib/`
 * from the graph entirely: not "unsupported," just never read, so clicking
 * anything inside one of those components misattributed the click to the
 * nearest ancestor that *was* in the graph (the page), and every property
 * on it read back as unavailable. `baseDir` was already the right scope —
 * app/ is a subdirectory of it — this was just scanning narrower than that.
 */
export function loadProjectFiles(rootDir: string): { filePath: string; source: string }[] {
  const appDir = join(rootDir, "app");
  const srcAppDir = join(rootDir, "src", "app");
  const usingApp = existsSync(appDir);
  // The base every returned filePath is made relative to — rootDir itself
  // for <rootDir>/app (yields "app/..." directly), rootDir/src for
  // <rootDir>/src/app (also yields "app/..." — the extra "src" segment is
  // absorbed here rather than appearing in every downstream path check).
  const baseDir = resolveProjectBaseDir(rootDir);
  const scanDir = baseDir;
  // In the (degenerate, real only in tests) case where <rootDir>/app is the
  // chosen routes root but <rootDir>/src/app also happens to exist, don't
  // additionally walk into it — it would surface a second, ambiguous
  // "page.tsx" for what's meant to be a single route tree. Everything else
  // under baseDir (components/, hooks/, lib/, ...) is still fair game.
  const excludeDir = usingApp && existsSync(srcAppDir) ? srcAppDir : null;
  const files: { filePath: string; source: string }[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (fullPath === excludeDir) continue;
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
