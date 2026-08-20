import type * as t from "@babel/types";
import type { ClassIR } from "./class-ir.js";
import type { StyleIR } from "./style-ir.js";

export interface ClassAttrRef {
  attrNode: t.JSXAttribute;
  ir: ClassIR;
}

export interface StyleAttrRef {
  attrNode: t.JSXAttribute;
  ir: StyleIR;
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
  /** The two style backends this root element might express properties
   * through — a real element can have both (Tailwind for layout, inline
   * style for one-off values) or either alone. See properties.ts for how a
   * property read/write picks between them. */
  classAttr: ClassAttrRef | null;
  styleAttr: StyleAttrRef | null;
  /** Whether this is the file's `export default` — real page/layout files
   * often also define small local helper components in the same file
   * (e.g. a `StatBar` alongside `export default function DashboardPage`).
   * Anything that treats "the component this file is about" as singular
   * (page-route detection, resolveDefinitionByFile) must key off this, not
   * just file-path + capitalized-name-returns-JSX. */
  isDefaultExport: boolean;
}

/** A `<Component prop="value" />` call site, distinct from its definition.
 * `props` only ever holds values that were statically verifiable from the
 * JSX attribute itself (a string literal, a shorthand boolean attribute, or
 * an explicit `{true}`/`{false}`) — an identifier, member expression, or any
 * other JSX expression is left uncaptured rather than guessed at. */
export interface UsageSite {
  component: string;
  filePath: string;
  element: t.JSXElement;
  props: Record<string, string | boolean>;
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
