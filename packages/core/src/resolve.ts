import * as t from "@babel/types";

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

export function resolveDefinitionByFile(graph: ComponentGraph, filePath: string): ComponentDef | null {
  for (const def of graph.definitions.values()) {
    if (def.filePath === filePath) return def;
  }
  return null;
}

const PAGE_FILE_RE = /^app\/(.*\/)?page\.tsx$/;

export interface PageRoute {
  route: string;
  pageComponent: string;
}

/** Every route with a page.tsx among the parsed files, derived from the
 * component graph rather than the filesystem — inverse of routeToPageFile. */
export function listPageRoutes(graph: ComponentGraph): PageRoute[] {
  const routes: PageRoute[] = [];
  for (const def of graph.definitions.values()) {
    const match = PAGE_FILE_RE.exec(def.filePath);
    if (!match) continue;
    const segment = match[1] ? match[1].slice(0, -1) : "";
    routes.push({ route: segment ? `/${segment}` : "/", pageComponent: def.name });
  }
  routes.sort((a, b) => a.route.localeCompare(b.route));
  return routes;
}

export interface PageSection {
  name: string;
  /** Position among ALL JSX element children of the page's root — the same
   * index space moveChild operates on. NOT the position among sections
   * alone: a page can have other, non-component elements (a raw <section>
   * wrapper, say) interspersed, and those still occupy an index. Using a
   * filtered/compacted index here would silently move the wrong element the
   * moment such a wrapper exists — this is exactly the bug this shape
   * exists to prevent, not a hypothetical. */
  index: number;
}

/**
 * The ordered list of known-component sections directly rendered as
 * top-level children of a route's page (e.g. Navbar/Hero/Card/Footer) —
 * the draggable "sections" of that page. Each entry's `index` is real
 * moveChild-compatible index, already accounting for any non-component
 * siblings, so a drag's reported fromIndex/toIndex (looked up by name, not
 * by position in this array) can be passed straight through. Returns null
 * if the route's page can't be found.
 *
 * V0 scope: only the page's own direct children — a component nested inside
 * another custom component (not the page itself) isn't a reorderable
 * top-level section here, same boundary as resolveComponentAtRoute.
 */
export function pageSectionOrder(graph: ComponentGraph, route: string): PageSection[] | null {
  const pageDef = resolveDefinitionByFile(graph, routeToPageFile(route));
  if (!pageDef) return null;

  const root = pageDef.rootElement;
  if (!t.isJSXElement(root) && !t.isJSXFragment(root)) return null;

  const sections: PageSection[] = [];
  let index = 0;
  for (const child of root.children) {
    if (!t.isJSXElement(child)) continue;
    if (t.isJSXIdentifier(child.openingElement.name)) {
      const name = child.openingElement.name.name;
      if (graph.definitions.has(name)) sections.push({ name, index });
    }
    index++;
  }
  return sections;
}
