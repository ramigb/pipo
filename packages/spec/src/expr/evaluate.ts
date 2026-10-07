// Allow-list evaluator for parsed expressions (docs/spec.md §3.2). Never uses eval/Function.
import { HELPERS } from "./helpers";
import { type Ast, BLOCKED_KEYS, ExprError, parse } from "./parse";

export type Context = Record<string, unknown>;

/** Parse (cached) and evaluate an expression against the given context variables. */
export function evaluate(source: string, ctx: Context): unknown {
  return evalNode(parse(source).ast, ctx);
}

/** Read a property without ever reaching the prototype chain. Missing or null-ish → undefined. */
export function getMember(target: unknown, key: unknown): unknown {
  if (target === null || target === undefined) return undefined;
  const k = typeof key === "number" ? key : String(key);
  if (typeof k === "string" && BLOCKED_KEYS.has(k)) return undefined;
  const obj = Object(target);
  return Object.hasOwn(obj, k) ? obj[k] : undefined;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as any)[k], (b as any)[k]));
}

function contains(collection: unknown, item: unknown): boolean {
  if (Array.isArray(collection)) return collection.some((x) => deepEqual(x, item));
  if (typeof collection === "string") return typeof item === "string" && collection.includes(item);
  if (collection && typeof collection === "object") return Object.hasOwn(collection, String(item));
  return false;
}

function evalNode(node: Ast, ctx: Context): unknown {
  const n = node as Record<string, any>;
  switch (node.type) {
    case "Literal":
      return n.value;
    case "Identifier":
      if (!Object.hasOwn(ctx, n.name)) throw new ExprError(`'${n.name}' is not available here`);
      return ctx[n.name];
    case "MemberExpression": {
      const target = evalNode(n.object, ctx);
      const key = n.computed ? evalNode(n.property, ctx) : n.property.name;
      return getMember(target, key);
    }
    case "CallExpression": {
      const fn = HELPERS[n.callee.name] as (...a: unknown[]) => unknown;
      const args = n.arguments.map((a: Ast) => evalNode(a, ctx));
      try {
        return fn(...args);
      } catch (e) {
        throw new ExprError((e as Error).message);
      }
    }
    case "UnaryExpression": {
      const v = evalNode(n.argument, ctx) as any;
      if (n.operator === "!") return !v;
      return n.operator === "-" ? -v : +v;
    }
    case "BinaryExpression": {
      const op: string = n.operator;
      if (op === "&&") return evalNode(n.left, ctx) && evalNode(n.right, ctx);
      if (op === "||") return evalNode(n.left, ctx) || evalNode(n.right, ctx);
      if (op === "??") return evalNode(n.left, ctx) ?? evalNode(n.right, ctx);
      const l = evalNode(n.left, ctx) as any;
      const r = evalNode(n.right, ctx) as any;
      switch (op) {
        case "==":
        case "===":
          return deepEqual(l, r);
        case "!=":
        case "!==":
          return !deepEqual(l, r);
        case "<":
          return l < r;
        case "<=":
          return l <= r;
        case ">":
          return l > r;
        case ">=":
          return l >= r;
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          return l / r;
        case "%":
          return l % r;
        case "in":
          return contains(r, l);
      }
      throw new ExprError(`operator '${op}' is not allowed`);
    }
    case "ConditionalExpression":
      return evalNode(n.test, ctx) ? evalNode(n.consequent, ctx) : evalNode(n.alternate, ctx);
    case "ArrayExpression":
      return n.elements.map((el: Ast | null) => (el ? evalNode(el, ctx) : undefined));
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const p of n.properties) {
        const key = p.key.type === "Identifier" ? p.key.name : String(p.key.value);
        if (BLOCKED_KEYS.has(key)) throw new ExprError(`key '${key}' is not allowed`);
        out[key] = evalNode(p.value ?? p.key, ctx);
      }
      return out;
    }
  }
  throw new ExprError(`'${node.type}' is not allowed in expressions`);
}
