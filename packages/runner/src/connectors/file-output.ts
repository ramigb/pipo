// `to: file` (docs/spec.md §3.5, §3.5.1). A repeated write of the same packet_id is skipped, also
// after a crash between writing the file and committing the journal:
//  - jsonl / json (append): the file is its own index, every record carries its packet_id.
//  - csv / text (append): a sidecar `<file>.pipo-keys` logs "begin key(s) offset length" before the
//    append and "done key(s)" after it; on open an unfinished begin is resolved by file size
//    (complete: counts as written, partial: truncated and rewritten). A failed append is cut back
//    and logged as "abort".
//  - mode write: the file is replaced atomically (temp + rename), so a repeat is harmless.
// A batch (several items) is one append per file: one write call for jsonl/csv/text, one replace
// for json and mode write (where the last packet's content wins, as with one write per packet).
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { toText } from "@pipo/spec";
import type { OutputAdapter, WriteItem } from "./types";

type Format = "jsonl" | "json" | "csv" | "text";

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function csvColumns(data: unknown): string[] {
  return data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data) : ["value"];
}

function csvRow(data: unknown, columns: string[]): string {
  const obj = (data && typeof data === "object" && !Array.isArray(data) ? data : { value: data }) as Record<
    string,
    unknown
  >;
  return `${columns.map((c) => csvCell(obj[c])).join(",")}\n`;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export class FileOutput implements OutputAdapter {
  private readonly seen = new Map<string, Set<string>>();

  constructor(private readonly baseDir: string) {}

  async write(items: WriteItem[]): Promise<unknown[]> {
    const results: unknown[] = new Array(items.length);
    const groups = new Map<string, { path: string; format: Format; mode: "append" | "write"; idx: number[] }>();
    items.forEach((item, i) => {
      const w = item.with as { path?: string; format?: Format; mode?: "append" | "write" };
      if (!w.path) throw new Error("output.with.path is empty after rendering; check the template");
      const path = resolve(this.baseDir, w.path);
      const format = w.format ?? "jsonl";
      const mode = w.mode ?? "append";
      const key = `${mode}\0${format}\0${path}`;
      const g = groups.get(key) ?? { path, format, mode, idx: [] };
      g.idx.push(i);
      groups.set(key, g);
    });
    for (const g of groups.values()) {
      const group = g.idx.map((i) => items[i] as WriteItem);
      mkdirSync(dirname(g.path), { recursive: true });
      let out: unknown[];
      if (g.mode === "write") {
        this.replace(g.path, this.whole(g.format, group[group.length - 1] as WriteItem));
        out = group.map(() => ({ path: g.path, written: true }));
      } else if (g.format === "json") out = this.appendJson(g.path, group);
      else if (g.format === "jsonl") out = this.appendJsonl(g.path, group);
      else out = this.appendLogged(g.path, g.format, group);
      g.idx.forEach((i, j) => {
        results[i] = out[j];
      });
    }
    return results;
  }

  /** Items not written yet, each once; the rest are reported as skipped. */
  private fresh(path: string, group: WriteItem[], keys: Set<string>) {
    const seen = new Set<string>();
    const todo: WriteItem[] = [];
    const out = group.map((item) => {
      if (keys.has(item.packetId) || seen.has(item.packetId)) return { path, skipped: true };
      seen.add(item.packetId);
      todo.push(item);
      return { path, written: true };
    });
    return { todo, out };
  }

  private appendJsonl(path: string, group: WriteItem[]): unknown[] {
    const keys = this.jsonlKeys(path);
    const { todo, out } = this.fresh(path, group, keys);
    if (!todo.length) return out;
    const size = existsSync(path) ? statSync(path).size : 0;
    const prefix = size > 0 && lastByte(path, size) !== 0x0a ? "\n" : "";
    const chunk = todo.map((item) => `${JSON.stringify({ packet_id: item.packetId, data: item.data })}\n`).join("");
    appendOrCutBack(path, size, `${prefix}${chunk}`);
    for (const item of todo) keys.add(item.packetId);
    return out;
  }

  private whole(format: Format, item: WriteItem): string {
    switch (format) {
      case "jsonl":
        return `${JSON.stringify({ packet_id: item.packetId, data: item.data })}\n`;
      case "json":
        return `${JSON.stringify(item.data, null, 2)}\n`;
      case "csv": {
        const cols = csvColumns(item.data);
        return `${cols.map(csvCell).join(",")}\n${csvRow(item.data, cols)}`;
      }
      default:
        return `${toText(item.data)}\n`;
    }
  }

  private replace(path: string, content: string) {
    writeFileSync(`${path}.tmp`, content);
    renameSync(`${path}.tmp`, path);
  }

  private jsonlKeys(path: string): Set<string> {
    let keys = this.seen.get(path);
    if (!keys) {
      keys = new Set();
      if (existsSync(path)) {
        for (const line of readFileSync(path, "utf8").split("\n")) {
          try {
            const id = JSON.parse(line)?.packet_id;
            if (typeof id === "string") keys.add(id);
          } catch {}
        }
      }
      this.seen.set(path, keys);
    }
    return keys;
  }

  private appendJson(path: string, group: WriteItem[]): unknown[] {
    let records: { packet_id: string; data: unknown }[] = [];
    if (existsSync(path) && statSync(path).size > 0) {
      try {
        records = JSON.parse(readFileSync(path, "utf8"));
        if (!Array.isArray(records)) throw new Error("not an array");
      } catch {
        throw new Error(`${path} is not a JSON array written by Pipo; use mode: write, or another path or format`);
      }
    }
    const { todo, out } = this.fresh(path, group, new Set(records.map((r) => r.packet_id)));
    if (!todo.length) return out;
    for (const item of todo) records.push({ packet_id: item.packetId, data: item.data });
    this.replace(path, `${JSON.stringify(records, null, 2)}\n`);
    return out;
  }

  private appendLogged(path: string, format: Format, group: WriteItem[]): unknown[] {
    const keys = this.loggedKeys(path);
    const { todo, out } = this.fresh(path, group, keys);
    if (!todo.length) return out;
    const size = existsSync(path) ? statSync(path).size : 0;
    let chunk: string;
    if (format === "csv") {
      let cols: string[];
      if (size > 0) cols = splitCsvLine(readFileSync(path, "utf8").split("\n", 1)[0] ?? "");
      else cols = csvColumns(todo[0]?.data);
      chunk = (size > 0 ? "" : `${cols.map(csvCell).join(",")}\n`) + todo.map((i) => csvRow(i.data, cols)).join("");
    } else chunk = todo.map((i) => `${toText(i.data)}\n`).join("");
    const length = Buffer.byteLength(chunk);
    const ids = todo.length === 1 ? (todo[0] as WriteItem).packetId : todo.map((i) => i.packetId);
    const log = `${path}.pipo-keys`;
    appendFileSync(log, `${JSON.stringify(["begin", ids, size, length])}\n`);
    try {
      appendOrCutBack(path, size, chunk);
    } catch (e) {
      try {
        appendFileSync(log, `${JSON.stringify(["abort", ids])}\n`);
      } catch {}
      throw e;
    }
    appendFileSync(log, `${JSON.stringify(["done", ids])}\n`);
    for (const item of todo) keys.add(item.packetId);
    return out;
  }

  private loggedKeys(path: string): Set<string> {
    let keys = this.seen.get(path);
    if (keys) return keys;
    keys = new Set();
    const log = `${path}.pipo-keys`;
    if (existsSync(log)) {
      const pending = new Map<string, [number, number]>();
      for (const line of readFileSync(log, "utf8").split("\n")) {
        try {
          const [kind, key, offset, length] = JSON.parse(line);
          for (const k of Array.isArray(key) ? key : [key]) {
            if (kind === "begin") pending.set(k, [offset, length]);
            else if (kind === "abort") pending.delete(k);
            else if (kind === "done") {
              pending.delete(k);
              keys.add(k);
            }
          }
        } catch {}
      }
      for (const [key, [offset, length]] of pending) {
        const size = existsSync(path) ? statSync(path).size : 0;
        if (size >= offset + length) {
          keys.add(key);
          appendFileSync(log, `${JSON.stringify(["done", key])}\n`);
        } else if (size > offset) truncateSync(path, offset);
      }
    }
    this.seen.set(path, keys);
    return keys;
  }

  async verify(
    check: string,
    checkWith: Record<string, unknown>,
    item: WriteItem,
    _result?: unknown,
  ): Promise<boolean> {
    if (!["file_exists", "file_nonempty", "line_contains", "checksum"].includes(check)) {
      throw new Error(`file output does not support delivery check '${check}'`);
    }
    const target = (checkWith.path ?? item.with.path) as string | undefined;
    if (!target) throw new Error("delivered.with.path is empty after rendering; set it or output.with.path");
    const path = resolve(this.baseDir, target);
    if (!existsSync(path)) return false;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) throw new Error(`${path} is not a file`);
      if (check === "file_exists") return true;
      if (check === "file_nonempty") return stat.size > 0;
      if (check === "line_contains") {
        const value = checkWith.value;
        if (typeof value !== "string" || value === "")
          throw new Error("delivered.with.value is empty; give the text to look for");
        return readFileSync(path, "utf8")
          .split(/\r?\n/)
          .some((line) => line.includes(value));
      }
      const want = checkWith.sha256;
      if (typeof want !== "string" || !/^[0-9a-f]{64}$/i.test(want.trim())) {
        throw new Error("delivered.with.sha256 must be 64 hex characters");
      }
      return createHash("sha256").update(readFileSync(path)).digest("hex") === want.trim().toLowerCase();
    } catch (e) {
      throw new Error(
        `cannot read ${path} for check '${check}': ${(e as Error).message}; check the path and permissions`,
      );
    }
  }

  close(): void {
    this.seen.clear();
  }
}

function lastByte(path: string, size: number): number {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] as number;
  } finally {
    closeSync(fd);
  }
}

/** Append in one call; if it fails part-way, cut the file back so no torn record is left behind. */
function appendOrCutBack(path: string, size: number, chunk: string) {
  try {
    appendFileSync(path, chunk);
  } catch (e) {
    try {
      if (existsSync(path) && statSync(path).size > size) truncateSync(path, size);
    } catch {}
    throw e;
  }
}
