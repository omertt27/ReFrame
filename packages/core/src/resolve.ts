import type { ClassAttrRef, ComponentDef, ComponentGraph, UsageSite } from "./graph.js";

export function resolveDefinition(graph: ComponentGraph, component: string): ComponentDef {
  const def = graph.definitions.get(component);
  if (!def) throw new Error(`Unknown component "${component}"`);
  return def;
}

export function resolveSharedClassTarget(graph: ComponentGraph, component: string): ClassAttrRef {
  const def = resolveDefinition(graph, component);
  if (!def.classAttr) {
    throw new Error(`Component "${component}" has no root className to edit`);
  }
  if (def.classAttr.ir.kind === "unsupported") {
    throw new Error(`Component "${component}"'s className is unsupported: ${def.classAttr.ir.reason}`);
  }
  return def.classAttr;
}

/** V0 only disambiguates by file: a component used more than once in the
 * same file can't be targeted individually yet. */
export function resolveUsage(graph: ComponentGraph, component: string, usageFile: string): UsageSite {
  const matches = graph.usages.filter((u) => u.component === component && u.filePath === usageFile);
  if (matches.length === 0) {
    throw new Error(`No usage of "${component}" found in ${usageFile}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple usages of "${component}" in ${usageFile} — V0 can't disambiguate between them`,
    );
  }
  return matches[0]!;
}

export function resolveAllUsages(graph: ComponentGraph, component: string): UsageSite[] {
  return graph.usages.filter((u) => u.component === component);
}

/** Next.js App Router convention: "/" -> "app/page.tsx", "/pricing" -> "app/pricing/page.tsx". */
export function routeToPageFile(route: string): string {
  const segments = route.split("/").filter(Boolean);
  return segments.length === 0 ? "app/page.tsx" : `app/${segments.join("/")}/page.tsx`;
}

/** The root layout plus every nested layout along the route's segment path,
 * root first — persistent chrome (nav/footer) usually lives in one of these,
 * not repeated per page. */
export function routeLayoutFiles(route: string): string[] {
  const segments = route.split("/").filter(Boolean);
  const files = ["app/layout.tsx"];
  let acc = "app";
  for (const segment of segments) {
    acc += `/${segment}`;
    files.push(`${acc}/layout.tsx`);
  }
  return files;
}

/**
 * Resolves a component clicked while viewing a given route to either its
 * ComponentDef (when the clicked component IS the route's own page/layout —
 * e.g. clicking bare page content resolves to the page component itself,
 * which isn't a "usage" of anything) or its UsageSite within the page or one
 * of its ancestor layouts.
 *
 * V0 scope: only looks for the usage directly in the page/layout files
 * themselves, not inside further custom components those files import.
 */
export function resolveComponentAtRoute(
  graph: ComponentGraph,
  component: string,
  route: string,
): ComponentDef | UsageSite {
  const pageFile = routeToPageFile(route);
  const candidateFiles = [...routeLayoutFiles(route), pageFile];

  const def = graph.definitions.get(component);
  if (def && candidateFiles.includes(def.filePath)) {
    return def;
  }

  for (const filePath of candidateFiles) {
    const matches = graph.usages.filter((u) => u.component === component && u.filePath === filePath);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(`Multiple usages of "${component}" in ${filePath} — V0 can't disambiguate`);
    }
  }

  throw new Error(`No usage or definition of "${component}" found for route "${route}"`);
}
