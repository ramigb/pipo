// `to: sqlite` (docs/spec.md §3.5). Writes are idempotent on the key column, so a packet
// re-written after a crash never creates a duplicate row.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { OutputAdapter, WriteItem } from "./types";

interface SqliteWith {
  path: string;
  table: string;
  create?: boolean;
  mode?: "insert" | "upsert";
  key?: string;
  columns?: Record<string, unknown>;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

function sqlValue(v: unknown): string | number | bigint | Uint8Array | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint" || v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

export class SqliteOutput implements OutputAdapter {
  private readonly dbs = new Map<string, Database>();
  private readonly readers = new Map<string, Database>();

  constructor(private readonly baseDir: string) {}

  private db(path: string): Database {
    const abs = resolve(this.baseDir, path);
    let db = this.dbs.get(abs);
    if (!db) {
      mkdirSync(dirname(abs), { recursive: true });
      db = new Database(abs, { create: true });
      db.exec("PRAGMA busy_timeout = 5000");
      this.dbs.set(abs, db);
    }
    return db;
  }

  /** The row a packet becomes: rendered `columns`, or the top-level fields of data plus the key. */
  static row(item: WriteItem): { table: string; key: string; values: Record<string, unknown> } {
    const w = item.with as unknown as SqliteWith;
    const key = w.key ?? "packet_id";
    let values: Record<string, unknown>;
    if (w.columns) values = w.columns;
    else {
      const data = item.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("data must be an object to map onto columns; set output.with.columns");
      }
      values = { ...(data as Record<string, unknown>), [key]: item.packetId };
    }
    for (const name of Object.keys(values))
      if (!NAME.test(name)) throw new Error(`'${name}' is not a valid column name`);
    return { table: w.table, key, values };
  }

  /** One transaction per database (spec §3.5.1): a batch is written whole or not at all. */
  async write(items: WriteItem[]): Promise<unknown[]> {
    const results: unknown[] = new Array(items.length);
    const byPath = new Map<string, number[]>();
    items.forEach((item, i) => {
      const path = resolve(this.baseDir, (item.with as unknown as SqliteWith).path);
      byPath.set(path, [...(byPath.get(path) ?? []), i]);
    });
    for (const [path, idx] of byPath) {
      const db = this.db(path);
      const written = db.transaction(() => idx.map((i) => this.writeRow(db, items[i] as WriteItem)))();
      idx.forEach((i, j) => {
        results[i] = written[j];
      });
    }
    return results;
  }

  private writeRow(db: Database, item: WriteItem): unknown {
    const w = item.with as unknown as SqliteWith;
    const { table, key, values } = SqliteOutput.row(item);
    const cols = Object.keys(values);
    if (w.create) {
      const defs = cols.map((c) => (c === key ? `${q(c)} PRIMARY KEY` : q(c)));
      db.exec(`CREATE TABLE IF NOT EXISTS ${q(table)} (${defs.join(", ")})`);
    }
    const others = cols.filter((c) => c !== key);
    const onConflict =
      w.mode === "upsert" && others.length
        ? `DO UPDATE SET ${others.map((c) => `${q(c)} = excluded.${q(c)}`).join(", ")}`
        : "DO NOTHING";
    const sql = `INSERT INTO ${q(table)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT(${q(key)}) ${onConflict}`;
    try {
      const r = db.query(sql).run(...cols.map((c) => sqlValue(values[c])));
      return { rowid: Number(r.lastInsertRowid), changes: r.changes };
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("no such table")) throw new Error(`${msg} (set output.with.create: true to create it)`);
      if (msg.includes("ON CONFLICT clause does not match")) {
        throw new Error(`table '${table}' needs a PRIMARY KEY or UNIQUE constraint on '${key}' for idempotent writes`);
      }
      throw e;
    }
  }

  async verify(
    check: string,
    checkWith: Record<string, unknown>,
    item: WriteItem,
    _result?: unknown,
  ): Promise<boolean> {
    const w = item.with as unknown as SqliteWith;
    if (check === "record_exists") {
      const where = checkWith.where as Record<string, unknown>;
      const cols = Object.keys(where);
      for (const c of cols) if (!NAME.test(c)) throw new Error(`'${c}' is not a valid column name`);
      const sql = `SELECT 1 FROM ${q(w.table)} WHERE ${cols.map((c) => `${q(c)} = ?`).join(" AND ")} LIMIT 1`;
      return (
        this.db(w.path)
          .query(sql)
          .get(...cols.map((c) => sqlValue(where[c]))) !== null
      );
    }
    if (check === "row_count" || check === "query") {
      const sql = (check === "row_count" ? checkWith.query : (checkWith.sql ?? checkWith.query)) as string | undefined;
      if (typeof sql !== "string" || !sql.trim()) {
        throw new Error(`delivered.with.${check === "row_count" ? "query" : "sql"} is empty; give a SELECT statement`);
      }
      const params = Array.isArray(checkWith.params) ? checkWith.params.map(sqlValue) : [];
      const rows = this.readOnly(w.path)
        .query(sql)
        .values(...params);
      if (check === "query") return rows.length > 0 && Boolean(rows[0]?.[0]);
      const min = typeof checkWith.min === "number" ? checkWith.min : 1;
      return rows.length >= min;
    }
    throw new Error(`sqlite does not support delivery check '${check}'`);
  }

  /** Read-only handle, so a check query can never change data. Pass values via `with.params`, not in the SQL text. */
  private readOnly(path: string): Database {
    const abs = resolve(this.baseDir, path);
    let db = this.readers.get(abs);
    if (!db) {
      if (!existsSync(abs)) throw new Error(`database ${abs} does not exist yet; check output.with.path`);
      db = new Database(abs, { readonly: true });
      db.exec("PRAGMA busy_timeout = 5000");
      this.readers.set(abs, db);
    }
    return db;
  }

  close(): void {
    for (const db of [...this.dbs.values(), ...this.readers.values()]) db.close();
    this.dbs.clear();
    this.readers.clear();
  }
}
