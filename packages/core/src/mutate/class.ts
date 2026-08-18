import * as t from "@babel/types";

import type { ClassAttrRef } from "../graph.js";

export type ClassMutation =
  | { op: "setString"; value: string }
  | { op: "setBranch"; branch: "consequent" | "alternate"; value: string }
  | { op: "setClsxArg"; index: number; value: string };

/**
 * Applies a mutation to a className attribute in place.
 *
 * "setString" deliberately refuses to touch a ternary — collapsing a
 * prop-driven conditional into one flat string is exactly the failure mode
 * found in Onlook's editor (see project memory `reframe-onlook-validation`).
 * Use "setBranch" to target one branch and leave the conditional intact.
 */
export function applyClassMutation(target: ClassAttrRef, mutation: ClassMutation): void {
  const { attrNode, ir } = target;

  if (ir.kind === "unsupported") {
    throw new Error(`className is unsupported, refusing to guess: ${ir.reason}`);
  }

  if (mutation.op === "setBranch") {
    if (ir.kind !== "ternary") {
      throw new Error(`Cannot target a branch: className is not a ternary (kind="${ir.kind}")`);
    }
    if (!t.isJSXExpressionContainer(attrNode.value) || !t.isConditionalExpression(attrNode.value.expression)) {
      throw new Error("Expected a conditional expression on this className attribute");
    }
    const conditional = attrNode.value.expression;
    const branchNode = mutation.branch === "consequent" ? conditional.consequent : conditional.alternate;
    if (!t.isStringLiteral(branchNode)) {
      throw new Error(`The "${mutation.branch}" branch is not a plain string literal`);
    }
    branchNode.value = mutation.value;
    return;
  }

  if (mutation.op === "setString") {
    if (ir.kind === "ternary") {
      throw new Error(
        'Refusing to replace a conditional className with a flat string — this would silently ' +
          'destroy the per-instance variant. Use { op: "setBranch" } to target one branch instead.',
      );
    }
    if (ir.kind === "clsxCall") {
      throw new Error("clsx()/cn() className mutation is not supported in V0");
    }
    if (!t.isStringLiteral(attrNode.value)) {
      throw new Error("Unsupported className attribute shape for setString");
    }
    attrNode.value.value = mutation.value;
    return;
  }

  if (mutation.op === "setClsxArg") {
    if (ir.kind !== "clsxCall") {
      throw new Error(`Cannot target a clsx argument: className is not a clsx()/cn() call (kind="${ir.kind}")`);
    }
    if (ir.args === null) {
      throw new Error(
        `This ${ir.calleeName}() call has argument shapes V0 doesn't recognize (only string literals ` +
          'and `test && "class"` conditionals are supported) — refusing to edit around what it can\'t parse',
      );
    }
    const arg = ir.args[mutation.index];
    if (!arg) {
      throw new Error(`No ${ir.calleeName}() argument at index ${mutation.index}`);
    }
    arg.node.value = mutation.value;
    return;
  }
}
