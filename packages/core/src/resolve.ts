import type { ClassAttrRef, ComponentDef, ComponentGraph, UsageSite } from "./graph.js";

export function resolveDefinition(graph: ComponentGraph, component: string): ComponentDef {
  const def = graph.definitions.get(component);
  if (!def) throw new Error(`Unknown component "${component}"`);
  return def;
}

export function resolveSharedClassTarget(graph: ComponentGraph, component: string): ClassAttrRef {
  const def = resolveDefinition(graph, component);
  if (!def.classAttr) {
    throw new Error(`Component "${component}" has no editable root className`);
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
