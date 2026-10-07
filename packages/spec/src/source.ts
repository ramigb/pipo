// `.pipo` source from a pipeline value (docs/spec.md §8, D62): what the dashboard builder saves. Without a base, the
// value is written in the canonical layout of `pipo fmt` (key order, a blank line between blocks, short scalar lists
// in flow style). With a base, the value is applied onto the base's YAML document, so what didn't change keeps its
// comments, formatting and key order; a value equal to the base's returns the base unchanged.
import {
  Document,
  isCollection,
  isMap,
  isScalar,
  isSeq,
  type Node,
  type Pair,
  parseDocument,
  Scalar,
  visit,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";
import { deepEqual } from "./expr/evaluate";

const TOP = [
  "pipo",
  "name",
  "description",
  "fn",
  "secrets",
  "lifetime",
  "concurrency",
  "buffer",
  "errors",
  "input",
  "nodes",
  "output",
  "delivered",
  "agent",
  "agent_budget",
  "retention",
];
const NODE = ["label", "from", "tap", "transform", "filter", "route", "agent", "with", "on_error", "loop"];
const INPUT = ["via", "with", "format", "schema", "validate", "on_invalid"];
const OUTPUT = ["from", "to", "batch", "with", "validate", "on_invalid", "on_error"];
/** Scalar lists up to this many items (and this many characters) are written in flow style: `[a, b]`. */
const FLOW_ITEMS = 6;
const FLOW_CHARS = 60;
const OPTIONS = { indent: 2, lineWidth: 0, flowCollectionPadding: false } as const;

type Order = { order: string[]; children?: (key: string) => Order | undefined };
const NODE_ORDER: Order = { order: NODE };
const NODES_ORDER: Order = { order: [], children: () => NODE_ORDER };
const ROOT_ORDER: Order = {
  order: TOP,
  children: (k) =>
    k === "input" ? { order: INPUT } : k === "output" ? { order: OUTPUT } : k === "nodes" ? NODES_ORDER : undefined,
};

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keyOf = (p: Pair) => (isScalar(p.key) ? String(p.key.value) : String(p.key));

/** The value without undefined members, so it compares and writes like its JSON. */
function defined(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : defined(x)));
  if (isPlain(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = defined(x);
    return out;
  }
  return v;
}

function ordered(v: unknown, o: Order | undefined): unknown {
  if (!isPlain(v)) return v;
  const keys = Object.keys(v);
  const rank = (k: string) => {
    const i = o?.order.indexOf(k) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const sorted = o ? [...keys].sort((a, b) => rank(a) - rank(b)) : keys;
  const out: Record<string, unknown> = {};
  for (const k of sorted) out[k] = ordered(v[k], o?.children?.(k));
  return out;
}

/** Short lists of scalars in flow style, everywhere under `node`. */
function flowLists(node: unknown) {
  visit(node as Node, {
    Seq(_, seq) {
      if (seq.flow || seq.range) return;
      const scalars = seq.items.every((i) => isScalar(i) && !String(i.value).includes("\n"));
      const chars = seq.items.reduce<number>((n, i) => n + String((i as Scalar).value).length + 2, 0);
      if (scalars && seq.items.length <= FLOW_ITEMS && chars <= FLOW_CHARS) seq.flow = true;
    },
  });
}

/** A blank line before each block (a map or list) and after it, in a block map; as `pipo fmt` lays them out. */
function spaced(map: YAMLMap) {
  map.items.forEach((p, i) => {
    const block = (x: Pair | undefined) => {
      const v = x?.value;
      return isCollection(v) && !v.flow;
    };
    if (isScalar(p.key))
      p.key.spaceBefore = i > 0 && (block(p) || block(map.items[i - 1] as Pair) || p.key.spaceBefore === true);
  });
}

function fresh(value: unknown): string {
  const doc = new Document(ordered(value, ROOT_ORDER));
  flowLists(doc.contents);
  if (isMap(doc.contents)) {
    spaced(doc.contents);
    for (const p of doc.contents.items) if (keyOf(p) === "nodes" && isMap(p.value)) spaced(p.value);
  }
  return doc.toString(OPTIONS);
}

/** `value` applied onto `node`: the same node where nothing changed, so its comments and layout survive. */
function apply(doc: Document, node: unknown, value: unknown, o: Order | undefined): unknown {
  if (node && isMap(node) && isPlain(value)) {
    const map = node as YAMLMap;
    map.items = map.items.filter((p) => Object.hasOwn(value, keyOf(p)));
    for (const p of map.items) p.value = apply(doc, p.value, value[keyOf(p)], o?.children?.(keyOf(p)));
    const have = new Set(map.items.map(keyOf));
    for (const [k, v] of Object.entries(value)) {
      if (have.has(k)) continue;
      const pair = doc.createPair(k, ordered(v, o?.children?.(k))) as Pair;
      flowLists(pair.value);
      // At its canonical place among the known keys, else at the end.
      const rank = o?.order.indexOf(k) ?? -1;
      const at =
        rank < 0
          ? -1
          : map.items.findIndex((p) => {
              const r = o?.order.indexOf(keyOf(p)) ?? -1;
              return r < 0 || r > rank;
            });
      if (at < 0) map.items.push(pair);
      else map.items.splice(at, 0, pair);
    }
    return map;
  }
  if (node && isSeq(node) && Array.isArray(value)) {
    const seq = node as YAMLSeq;
    if (deepEqual(seq.toJSON(), value)) return seq;
    seq.items = seq.items.slice(0, value.length);
    value.forEach((v, i) => {
      if (i < seq.items.length) seq.items[i] = apply(doc, seq.items[i], v, undefined);
      else seq.items.push(doc.createNode(v));
    });
    return seq;
  }
  if (node && isScalar(node) && !isPlain(value) && !Array.isArray(value)) {
    const scalar = node as Scalar;
    if (scalar.value === value) return scalar;
    // A new scalar (no source range), keeping the old one's comments; a block scalar is written afresh.
    const next = new Scalar(value);
    next.comment = scalar.comment;
    next.commentBefore = scalar.commentBefore;
    next.spaceBefore = scalar.spaceBefore;
    if (typeof value === "string" && (scalar.type === Scalar.QUOTE_DOUBLE || scalar.type === Scalar.QUOTE_SINGLE)) {
      next.type = scalar.type;
    }
    return next;
  }
  const next = doc.createNode(ordered(value, o)) as Node;
  flowLists(next);
  const old = node as { comment?: string | null; commentBefore?: string | null } | null;
  if (old && isCollection(next)) {
    next.comment = old.comment ?? undefined;
    next.commentBefore = old.commentBefore ?? undefined;
  }
  return next;
}

/** The document as text, with block scalars it kept from `source` written exactly as they were (re-indented). */
function stringify(doc: Document, source: string): string {
  const blocks: string[] = [];
  visit(doc, {
    Scalar(_, node) {
      if (node.type !== Scalar.BLOCK_FOLDED && node.type !== Scalar.BLOCK_LITERAL) return;
      const range = node.range;
      if (!range) return;
      const raw = source.slice(range[0], range[1]).replace(/\s+$/, "");
      if (!/^[>|][+-]?\n/.test(raw)) return;
      node.type = Scalar.PLAIN;
      node.value = `PIPOBLOCK${blocks.length}X`;
      blocks.push(raw);
    },
  });
  // Flow collections are padded (`{ a: 1 }`) when the base mostly pads them.
  const padded = (source.match(/[:-] +[[{] /g) ?? []).length;
  const tight = (source.match(/[:-] +[[{][^\s\]}]/g) ?? []).length;
  const out = doc.toString({ ...OPTIONS, flowCollectionPadding: padded > tight });
  return out.replace(/^(.*?)PIPOBLOCK(\d+)X/gm, (_, before: string, i: string) => {
    const [header, ...body] = (blocks[Number(i)] as string).split("\n");
    const pad = " ".repeat(/^[\s-]*/.exec(before)?.[0].length ?? 0);
    const min = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    return [`${before}${header}`, ...body.map((l) => (l.trim() ? `${pad}  ${l.slice(min)}` : ""))].join("\n");
  });
}

/**
 * The `.pipo` text of `pipeline` (a parsed pipeline, or a draft of one). With `base` (the source it was loaded from),
 * only what changed is rewritten: comments, layout and key order elsewhere survive. A base that doesn't parse is
 * ignored, and the value written fresh.
 */
export function toSource(pipeline: object, base?: string): string {
  const value = defined(pipeline);
  if (base === undefined) return fresh(value);
  const doc = parseDocument(base, { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length || !isMap(doc.contents)) return fresh(value);
  if (deepEqual(doc.toJSON(), value)) return base;
  doc.contents = apply(doc, doc.contents, value, ROOT_ORDER) as typeof doc.contents;
  return stringify(doc, base);
}
