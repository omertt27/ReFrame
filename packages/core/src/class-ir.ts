import * as t from "@babel/types";

/** One argument of a clsx()/cn() call, structurally recognized. */
export type ClsxArg =
  | { kind: "string"; value: string; node: t.StringLiteral }
  | { kind: "conditional"; testSource: string; value: string; node: t.StringLiteral };

export type ClassIR =
  | { kind: "string"; value: string }
  | {
      kind: "ternary";
      propName: string;
      testValue: string;
      consequent: string;
      alternate: string;
    }
  | {
      kind: "clsxCall";
      calleeName: string;
      /** null means one or more arguments had a shape V0 doesn't recognize
       * (e.g. an object-map arg, a template literal) — treat as opaque
       * rather than guessing, so we never silently misinterpret intent. */
      args: ClsxArg[] | null;
    };

/** Best-effort, display-only rendering of a conditional test expression. */
function stringifyTestExpr(node: t.Expression): string {
  if (t.isIdentifier(node)) return node.name;
  if (t.isUnaryExpression(node) && node.operator === "!") {
    return `!${stringifyTestExpr(node.argument)}`;
  }
  if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property)) {
    return `${stringifyTestExpr(node.object as t.Expression)}.${node.property.name}`;
  }
  return "<expr>";
}

function extractClsxArgs(call: t.CallExpression): ClsxArg[] | null {
  const args: ClsxArg[] = [];
  for (const arg of call.arguments) {
    if (t.isStringLiteral(arg)) {
      args.push({ kind: "string", value: arg.value, node: arg });
      continue;
    }
    if (t.isLogicalExpression(arg) && arg.operator === "&&" && t.isStringLiteral(arg.right)) {
      args.push({
        kind: "conditional",
        testSource: stringifyTestExpr(arg.left as t.Expression),
        value: arg.right.value,
        node: arg.right,
      });
      continue;
    }
    // Unrecognized argument shape (object map, template literal, spread, ...) —
    // bail on the whole call rather than editing around what we don't understand.
    return null;
  }
  return args;
}

export function extractClassIR(attr: t.JSXAttribute): ClassIR | null {
  const value = attr.value;

  if (t.isStringLiteral(value)) {
    return { kind: "string", value: value.value };
  }

  if (t.isJSXExpressionContainer(value)) {
    const expr = value.expression;

    if (t.isConditionalExpression(expr)) {
      const { test, consequent, alternate } = expr;
      if (
        t.isBinaryExpression(test) &&
        test.operator === "===" &&
        t.isIdentifier(test.left) &&
        t.isStringLiteral(test.right) &&
        t.isStringLiteral(consequent) &&
        t.isStringLiteral(alternate)
      ) {
        return {
          kind: "ternary",
          propName: test.left.name,
          testValue: test.right.value,
          consequent: consequent.value,
          alternate: alternate.value,
        };
      }
    }

    if (
      t.isCallExpression(expr) &&
      t.isIdentifier(expr.callee) &&
      (expr.callee.name === "clsx" || expr.callee.name === "cn")
    ) {
      return {
        kind: "clsxCall",
        calleeName: expr.callee.name,
        args: extractClsxArgs(expr),
      };
    }
  }

  return null;
}
