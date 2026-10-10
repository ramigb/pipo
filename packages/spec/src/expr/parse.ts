// Expression parsing (docs/spec.md §3.2). jsep produces the syntax tree; this module is
// the only place that knows about jsep, so the parser can be swapped behind `parse()`.
import object from "@jsep-plugin/object";
import ternary from "@jsep-plugin/ternary";
import jsep from "jsep";
import { HELPERS } from "./helpers";

jsep.plugins.register(object, ternary);
jsep.addBinaryOp("??", 1);
jsep.addBinaryOp("in", 7);

export type Ast = jsep.Expression;

export class ExprError extends Error {
  constructor(
    message: string,
    /** Character offset in the expression source, when known. */
    readonly index?: number,
  ) {
    super(message);
    this.name = "ExprError";
  }
}

export const BINARY_OPS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "==",
  "!=",
  "===",
  "!==",
  "<",
  "<=",
  ">",
  ">=",
  "&&",
  "||",
  "??",
  "in",
]);
export const UNARY_OPS = new Set(["!", "-", "+"]);
export const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const LIMITS = { sourceLength: 2000, depth: 32, nodes: 256 };

export interface Compiled {
  source: string;
  ast: Ast;
  /** Root identifiers the expression reads (`data`, `meta`, …). */
  identifiers: Set<string>;
  /** Helper functions the expression calls. */
  helpers: Set<string>;
}

const cache = new Map<string, Compiled>();

/** Parse and vet an expression. Throws ExprError for syntax or anything outside the allowed subset. */
export function parse(source: string): Compiled {
  const hit = cache.get(source);
  if (hit) return hit;
  if (source.length > LIMITS.sourceLength) {
    throw new ExprError(`expression is longer than ${LIMITS.sourceLength} characters`);
  }
  let ast: Ast;
  try {
    ast = jsep(source);
  } catch (e) {
    const err = e as Error & { index?: number };
    throw new ExprError(err.message.replace(/ at character \d+$/, ""), err.index);
  }
  const compiled: Compiled = { source, ast, identifiers: new Set(), helpers: new Set() };
  let count = 0;
  const visit = (node: Ast, depth: number): void => {
    if (++count > LIMITS.nodes) throw new ExprError(`expression has more than ${LIMITS.nodes} parts`);
    if (depth > LIMITS.depth) throw new ExprError(`expression is nested deeper than ${LIMITS.depth}`);
    const n = node as Record<string, any>;
    switch (node.type) {
      case "Literal":
        if (n.value instanceof RegExp) throw new ExprError('regex literals are not allowed; use matches(s, "pattern")');
        return;
      case "Identifier":
        compiled.identifiers.add(n.name);
        return;
      case "MemberExpression":
        visit(n.object, depth + 1);
        if (n.computed) visit(n.property, depth + 1);
        else if (BLOCKED_KEYS.has(n.property.name))
          throw new ExprError(`access to '${n.property.name}' is not allowed`);
        return;
      case "CallExpression":
        if (n.callee.type !== "Identifier") {
          throw new ExprError("only helper functions can be called, e.g. len(x) rather than x.length()");
        }
        if (!Object.hasOwn(HELPERS, n.callee.name)) throw new ExprError(`unknown function '${n.callee.name}'`);
        compiled.helpers.add(n.callee.name);
        for (const a of n.arguments) visit(a, depth + 1);
        return;
      case "BinaryExpression":
        if (!BINARY_OPS.has(n.operator)) throw new ExprError(`operator '${n.operator}' is not allowed`);
        visit(n.left, depth + 1);
        visit(n.right, depth + 1);
        return;
      case "UnaryExpression":
        if (!UNARY_OPS.has(n.operator)) throw new ExprError(`operator '${n.operator}' is not allowed`);
        visit(n.argument, depth + 1);
        return;
      case "ConditionalExpression":
        visit(n.test, depth + 1);
        visit(n.consequent, depth + 1);
        visit(n.alternate, depth + 1);
        return;
      case "ArrayExpression":
        for (const el of n.elements) if (el) visit(el, depth + 1);
        return;
      case "ObjectExpression":
        for (const p of n.properties) {
          if (p.type !== "Property") throw new ExprError("object entries must be 'key: value' pairs or names");
          if (p.computed) throw new ExprError("computed object keys are not allowed");
          visit(p.value ?? p.key, depth + 1);
        }
        return;
      case "Compound":
        throw new ExprError("only a single expression is allowed (found ',' or ';')");
      default:
        throw new ExprError(`'${node.type}' is not allowed in expressions`);
    }
  };
  visit(ast, 0);
  cache.set(source, compiled);
  return compiled;
}
