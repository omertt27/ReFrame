import * as t from "@babel/types";

import type { UsageSite } from "../graph.js";

/** Sets a string-literal prop value at one usage site — an "instance-scoped" edit. */
export function setUsageProp(usage: UsageSite, propName: string, value: string): void {
  const attrs = usage.element.openingElement.attributes;
  const existing = attrs.find(
    (a): a is t.JSXAttribute => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === propName,
  );

  if (existing) {
    if (!t.isStringLiteral(existing.value)) {
      throw new Error(
        `Prop "${propName}" is not a plain string literal — V0 doesn't support mutating dynamic prop expressions`,
      );
    }
    existing.value.value = value;
  } else {
    attrs.push(t.jsxAttribute(t.jsxIdentifier(propName), t.stringLiteral(value)));
  }

  usage.props[propName] = value;
}
