import * as t from "@babel/types";

/** One argument of a clsx()/cn() call, structurally recognized. */
export type ClsxArg =
  | { kind: "string"; value: string; node: t.StringLiteral }
  | {
      kind: "conditional";
      testSource: string;
      /** Set only when the test is a simple identifier or `!identifier` —
       * a shape a captured usage-site prop (see UsageSite.props in graph.ts)
       * can actually be checked against. A member expression or anything
       * else stays null: still shown via testSource, just not evaluable
       * against a specific usage's props, same "display-only vs. real"
       * boundary stringifyTestExpr already draws. */
      evaluable: { propName: string; negated: boolean } | null;
      value: string;
      node: t.StringLiteral;
    };

/**
 * The explicit capability boundary: a className expression either matches
 * one of the recognized shapes below, or comes back as "unsupported" with a
 * specific, user-facing reason. There is deliberately no fallback path that
 * guesses at an unrecognized shape — see project memory `reframe-onlook-validation`
 * for why (this is the exact failure mode found in Onlook's editor).
 *
 * Recognized today:
 *   - a plain string literal
 *   - `prop === "value" ? "..." : "..."` (a DIRECT prop comparison — not a
 *     variable derived from one, see "unsupported" reasons below)
 *   - `clsx(...)` / `cn(...)` whose arguments are each either a string
 *     literal or `test && "..."`
 *
 * Explicitly NOT traced (reported as "unsupported", not guessed):
 *   - `const isX = prop === "value"; ... isX ? "..." : "..."` — tracing an
 *     intermediate variable back to a prop comparison is real, common React
 *     code, and worth building — just not yet. Flagged with its own reason
 *     string so it's distinguishable from other unsupported shapes.
 *   - a nested/chained ternary in a branch position
 *   - an arbitrary function call (`getNavbarClasses(...)`) — only clsx/cn
 *     are recognized call shapes
 *   - a template literal
 */
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
    }
  | { kind: "unsupported"; reason: string };

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

/** The subset of test shapes that can actually be checked against a captured
 * usage-site prop (an identifier or its negation) — a member expression or
 * anything else has no single prop name to look up, so it stays null. */
function evaluableTest(node: t.Expression): { propName: string; negated: boolean } | null {
  if (t.isIdentifier(node)) return { propName: node.name, negated: false };
  if (t.isUnaryExpression(node) && node.operator === "!" && t.isIdentifier(node.argument)) {
    return { propName: node.argument.name, negated: true };
  }
  return null;
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
        evaluable: evaluableTest(arg.left as t.Expression),
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

function unsupported(reason: string): ClassIR {
  return { kind: "unsupported", reason };
}

function describeConditionalMismatch(expr: t.ConditionalExpression): ClassIR {
  const { test, consequent, alternate } = expr;

  if (!t.isBinaryExpression(test) || test.operator !== "===") {
    return unsupported(
      `ternary test is "${stringifyTestExpr(test as t.Expression)}", not a direct "prop === \\"value\\"" ` +
        `comparison — likely a variable derived from one (e.g. "const isX = prop === ...; isX ? ... : ..."), ` +
        "which isn't traced back to its prop in V0",
    );
  }
  if (!t.isIdentifier(test.left) || !t.isStringLiteral(test.right)) {
    return unsupported('ternary test must be exactly "identifier === \\"string literal\\""');
  }
  if (t.isConditionalExpression(consequent) || t.isConditionalExpression(alternate)) {
    return unsupported("nested/chained conditional expressions in a ternary branch aren't supported");
  }
  return unsupported("ternary branches must both be plain string literals");
}

export function extractClassIR(attr: t.JSXAttribute): ClassIR | null {
  const value = attr.value;

  if (value === null) return null; // shorthand boolean attribute — not applicable to className
  if (t.isStringLiteral(value)) {
    return { kind: "string", value: value.value };
  }
  if (!t.isJSXExpressionContainer(value)) return null;

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
    return describeConditionalMismatch(expr);
  }

  if (t.isCallExpression(expr) && t.isIdentifier(expr.callee)) {
    if (expr.callee.name === "clsx" || expr.callee.name === "cn") {
      return {
        kind: "clsxCall",
        calleeName: expr.callee.name,
        args: extractClsxArgs(expr),
      };
    }
    return unsupported(
      `className is a call to "${expr.callee.name}(...)" — only clsx()/cn() are recognized function calls`,
    );
  }

  if (t.isTemplateLiteral(expr)) {
    return unsupported("className is a template literal, not supported");
  }

  return unsupported("unrecognized className expression shape");
}
