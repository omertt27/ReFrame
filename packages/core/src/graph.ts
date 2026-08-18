import type * as t from "@babel/types";
import type { ClassIR } from "./class-ir.js";

export interface ClassAttrRef {
  attrNode: t.JSXAttribute;
  ir: ClassIR;
}

/**
 * A component definition, tracked by its root JSX element only (V0 scope —
 * enough for the shared-component/prop-override test cases; nested elements
 * aren't modeled yet).
 */
export interface ComponentDef {
  name: string;
  filePath: string;
  rootElement: t.JSXElement | t.JSXFragment;
  classAttr: ClassAttrRef | null;
}

/** A `<Component prop="value" />` call site, distinct from its definition. */
export interface UsageSite {
  component: string;
  filePath: string;
  element: t.JSXElement;
  props: Record<string, string>;
}

export interface ParsedFile {
  ast: t.File;
  source: string;
}

export interface ComponentGraph {
  definitions: Map<string, ComponentDef>;
  usages: UsageSite[];
  files: Map<string, ParsedFile>;
}
