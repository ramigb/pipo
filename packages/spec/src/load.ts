// Load a .pipo file with source positions, so every diagnostic can point at file:line:col.
import { isMap, isScalar, isSeq, LineCounter, type Node, parseDocument } from "yaml";
import type { Pipeline } from "./types";

export type Path = (string | number)[];

export interface Diagnostic {
  file?: string;
  line: number;
  col: number;
  severity: "error" | "warning";
  code: string;
  message: string;
  hint?: string;
  path?: Path;
}

export interface Loaded {
  file?: string;
  source: string;
  /** Plain JS value of the document; undefined when the YAML has syntax errors. */
  value: Pipeline | undefined;
  /** YAML syntax diagnostics (P001). */
  diagnostics: Diagnostic[];
  /** Line/column (1-based) of the node at `path`, or of its nearest existing ancestor. */
  locate(path: Path, key?: boolean): { line: number; col: number };
}

export function load(source: string, file?: string): Loaded {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, prettyErrors: false, uniqueKeys: true });
  const at = (offset: number) => {
    const p = lineCounter.linePos(offset);
    return { line: p.line, col: p.col };
  };

  const diagnostics: Diagnostic[] = doc.errors.map((e) => ({
    file,
    ...at(e.pos[0]),
    severity: "error" as const,
    code: "P001",
    message: e.message.split("\n")[0] ?? "YAML syntax error",
  }));

  const locate = (path: Path, key = false) => {
    let node: Node | null | undefined = doc.contents as Node | null;
    let best = node?.range?.[0] ?? 0;
    for (const seg of path) {
      if (isMap(node)) {
        const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === String(seg));
        if (!pair) break;
        const k = pair.key as Node;
        const v = pair.value as Node | null;
        best = (v?.range && !key ? v.range[0] : k.range?.[0]) ?? best;
        if (key && seg === path[path.length - 1]) best = k.range?.[0] ?? best;
        node = v;
      } else if (isSeq(node) && typeof seg === "number") {
        const item = node.items[seg] as Node | undefined;
        if (!item) break;
        best = item.range?.[0] ?? best;
        node = item;
      } else break;
    }
    return at(best);
  };

  const value = diagnostics.length ? undefined : (doc.toJS() as Pipeline | undefined);
  return { file, source, value, diagnostics, locate };
}
