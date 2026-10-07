// `${expr}` templates (docs/spec.md §3.2). A value that is exactly one `${expr}` keeps the
// expression's type; anything else renders to a string. `$${` escapes a literal `${`.
import { type Context, evaluate } from "./evaluate";
import { ExprError } from "./parse";

export type Segment = { text: string } | { expr: string; offset: number };

/** Split a string into literal text and `${…}` expressions, honouring nested braces and quotes. */
export function segments(input: string): Segment[] {
  const out: Segment[] = [];
  let text = "";
  let i = 0;
  while (i < input.length) {
    if (input.startsWith("$${", i)) {
      text += "${";
      i += 3;
      continue;
    }
    if (!input.startsWith("${", i)) {
      text += input[i++];
      continue;
    }
    const start = i + 2;
    let depth = 1;
    let quote: string | null = null;
    let j = start;
    for (; j < input.length && depth > 0; j++) {
      const c = input[j];
      if (quote) {
        if (c === "\\") j++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    if (depth > 0) throw new ExprError("unclosed '${' in template", i);
    if (text) out.push({ text });
    text = "";
    out.push({ expr: input.slice(start, j - 1), offset: start });
    i = j;
  }
  if (text) out.push({ text });
  return out;
}

/** Every expression inside a template string. */
export function templateExpressions(input: string): string[] {
  return segments(input).flatMap((s) => ("expr" in s ? [s.expr] : []));
}

export function toText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function renderString(input: string, ctx: Context): unknown {
  const parts = segments(input);
  const only = parts[0];
  if (parts.length === 1 && only && "expr" in only) return evaluate(only.expr, ctx);
  return parts.map((s) => ("expr" in s ? toText(evaluate(s.expr, ctx)) : s.text)).join("");
}

/** Render templates in every string of a value, recursively (used for `with:` blocks). */
export function render<T>(value: T, ctx: Context): T {
  if (typeof value === "string") return renderString(value, ctx) as T;
  if (Array.isArray(value)) return value.map((v) => render(v, ctx)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = render(v, ctx);
    return out as T;
  }
  return value;
}
