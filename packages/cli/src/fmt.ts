// `pipo fmt` (docs/spec.md §6, D29): rewrite a .pipo file in one canonical layout. Uses the YAML Document API so
// comments survive; only key order within the spec's known maps, indentation and section spacing are normalised.
import { isCollection, isMap, isScalar, type Pair, parseDocument, Scalar, visit, type YAMLMap } from "yaml";
import { CliError } from "./errors";

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
const OUTPUT = ["from", "to", "with", "validate", "on_invalid", "on_error"];

const keyOf = (p: Pair) => (isScalar(p.key) ? String(p.key.value) : String(p.key));

function reorder(map: YAMLMap, order: string[]) {
  const rank = (p: Pair) => {
    const i = order.indexOf(keyOf(p));
    return i < 0 ? order.length : i;
  };
  // Array.sort is stable, so unknown keys keep their relative order after the known ones.
  map.items.sort((a, b) => rank(a) - rank(b));
}

function spaced(map: YAMLMap) {
  map.items.forEach((p, i) => {
    const block = (x: Pair | undefined) => isCollection(x?.value);
    if (isScalar(p.key))
      p.key.spaceBefore = i > 0 && (block(p) || block(map.items[i - 1]) || p.key.spaceBefore === true);
  });
}

/** Canonical text of a .pipo source. Throws CliError when the YAML does not parse. */
export function formatPipo(source: string, file = "<input>"): string {
  const doc = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length) {
    const e = doc.errors[0];
    throw new CliError(
      `${file}: ${e?.message.split("\n")[0]}`,
      "fix the YAML syntax first (`pipo check` shows the line); fmt will not rewrite a file it cannot parse",
    );
  }
  const root = doc.contents;
  if (isMap(root)) {
    reorder(root, TOP);
    spaced(root);
    for (const p of root.items) {
      const k = keyOf(p);
      if (k === "input" && isMap(p.value)) reorder(p.value, INPUT);
      if (k === "output" && isMap(p.value)) reorder(p.value, OUTPUT);
      if (k === "nodes" && isMap(p.value)) {
        for (const n of p.value.items) if (isMap(n.value)) reorder(n.value, NODE);
        spaced(p.value);
      }
    }
  }
  // yaml re-folds block scalars; keep them exactly as written (re-indented) by swapping in placeholders.
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
  const out = doc.toString({ indent: 2, lineWidth: 0, flowCollectionPadding: false });
  return out.replace(/^(.*?)PIPOBLOCK(\d+)X/gm, (_, before: string, i: string) => {
    const [header, ...body] = (blocks[Number(i)] as string).split("\n");
    const pad = " ".repeat(/^[\s-]*/.exec(before)?.[0].length ?? 0);
    const min = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    return [`${before}${header}`, ...body.map((l) => (l.trim() ? `${pad}  ${l.slice(min)}` : ""))].join("\n");
  });
}
