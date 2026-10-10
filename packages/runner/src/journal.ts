// The pipeline's durable journal (docs/spec.md §2, §7.3), as TypeScript reads it: the Rust runner owns and writes it
// (crates/pipo-runner/src/journal.rs). The engine and the tests open it read-only, and the engine journals the stop a
// killed runner could not write (events.ts journalStop, D46) through `Journal.event`.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const IN_FLIGHT = ["accepted", "processing", "writing", "verifying"] as const;
export const TERMINAL = ["delivered", "filtered", "dead_lettered", "rejected"] as const;
/**
 * A packet (or copy) that fanned out (spec §3.4, D22): its own path ended in one transaction that
 * created its branch copies. It is neither in flight nor terminal; it becomes terminal, with a
 * summary state, in the same transaction as its last copy.
 */
export const BRANCHED = "branched";
/**
 * A unit handed to the agent (`then: agent`, `agent.on_stall: handle`; spec §3.9, §9, D50): it stopped moving and waits,
 * across restarts, until a `resolve` retries, dead-letters or drops it. Neither in flight (nothing recovers or runs it)
 * nor terminal (it is pending); its cursor is where a retry resumes.
 */
export const ESCALATED = "escalated";
export type PacketState = (typeof IN_FLIGHT)[number] | (typeof TERMINAL)[number] | typeof BRANCHED | typeof ESCALATED;
/** Not terminal yet: in flight, waiting on branch copies (D22), or waiting for an agent (D50). */
export const PENDING = [...IN_FLIGHT, BRANCHED, ESCALATED] as const;

/** Next step for an in-flight packet: a node id, or `$output`, `$batch` or `$verify`. */
export type Cursor = string;

export interface PacketRow {
  /** The journal unit: `packet_id` for a packet, `packet_id:<branch>` for a branch copy (D22). */
  id: string;
  /** The packet a copy belongs to (`meta.packet_id`); null for the packet itself. */
  root: string | null;
  /** The unit that fanned out into this copy; null for the packet itself. */
  parent: string | null;
  /** Fan-out path, consumer ids joined by `/` (e.g. `a/b`); empty for the packet itself. */
  branch: string;
  version: number;
  state: PacketState;
  cursor: Cursor | null;
  data: unknown;
  trigger: string;
  source: string;
  attempt: number;
  iteration: number;
  hops: number;
  error: { code: string; message: string; node?: string; attempts?: number } | null;
  result: unknown;
  received_at: number;
  updated_at: number;
  /** The input the packet came in through (D76); `input` for the `input:` shorthand and older journals. */
  input: string;
  /** For a packet from another pipeline: `{pipeline, packet_id, key, depth}` (D77); else null. */
  upstream: { pipeline: string; packet_id: string | null; key: string; depth: number } | null;
}

export interface PacketPatch {
  state?: PacketState;
  cursor?: Cursor | null;
  data?: unknown;
  attempt?: number;
  iteration?: number;
  hops?: number;
  error?: PacketRow["error"];
  result?: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS versions (
  version INTEGER PRIMARY KEY,
  hash TEXT NOT NULL,
  source TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'human',
  reason TEXT,
  created_at INTEGER NOT NULL,
  author_kind TEXT,
  proposal TEXT,
  files TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS packets (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL REFERENCES versions(version),
  state TEXT NOT NULL,
  cursor TEXT,
  data TEXT,
  trigger TEXT NOT NULL,
  source TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  iteration INTEGER NOT NULL DEFAULT 0,
  hops INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  result TEXT,
  received_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  root TEXT,
  parent TEXT,
  branch TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS packets_state ON packets(state);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  packet_id TEXT,
  type TEXT NOT NULL,
  node TEXT,
  detail TEXT,
  patch TEXT,
  ms INTEGER
);
CREATE INDEX IF NOT EXISTS events_packet ON events(packet_id);
CREATE TABLE IF NOT EXISTS agent_spend (
  seq INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  unit TEXT NOT NULL,
  root TEXT NOT NULL,
  node TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_spend_root ON agent_spend(root, seq);
CREATE INDEX IF NOT EXISTS agent_spend_at ON agent_spend(at);
CREATE TABLE IF NOT EXISTS input_scopes (
  scope TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  pipeline TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  source TEXT NOT NULL,
  diff TEXT NOT NULL,
  added INTEGER NOT NULL,
  removed INTEGER NOT NULL,
  changed_paths TEXT NOT NULL,
  author TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL,
  problems TEXT NOT NULL,
  diagnostics TEXT NOT NULL,
  verify TEXT,
  verification TEXT,
  applied_version INTEGER,
  decided_by TEXT,
  decision TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS proposals_state ON proposals(state, created_at);
CREATE TABLE IF NOT EXISTS input_state (
  scope TEXT NOT NULL REFERENCES input_scopes(scope) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
`;

const VERSION_AUDIT_COLUMNS = ["author_kind", "proposal", "files"] as const;

const BRANCH_COLUMNS = [
  ["root", "TEXT"],
  ["parent", "TEXT"],
  ["branch", "TEXT NOT NULL DEFAULT ''"],
] as const;

/** How long opening a journal keeps retrying while it is busy. */
export const BUSY_RETRY_MS = 5000;

/** SQLITE_BUSY and its extended codes (SQLITE_BUSY_RECOVERY, SQLITE_BUSY_SNAPSHOT, …). */
export function isBusy(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/** Run `fn`, again after a short, growing pause while it fails busy, for up to `ms`; then the last error. */
export function retryBusy<T>(fn: () => T, ms = BUSY_RETRY_MS, sleep = (n: number) => Bun.sleepSync(n)): T {
  // Bounded by the pauses taken and by the clock, since a plain SQLITE_BUSY has already waited out busy_timeout.
  const deadline = Date.now() + ms;
  let waited = 0;
  for (let wait = 25; ; wait = Math.min(wait * 2, 500)) {
    try {
      return fn();
    } catch (e) {
      if (!isBusy(e) || waited + wait > ms || Date.now() + wait > deadline) throw e;
      sleep(wait);
      waited += wait;
    }
  }
}

/**
 * Open a journal file read-only. A read-only connection's first statement is where WAL recovery bites (SQLITE_BUSY_RECOVERY
 * after a SIGKILL, while another connection replays the WAL), so the open and a first probe are retried like Journal's.
 */
export function openReadonly(path: string, ms = BUSY_RETRY_MS, sleep?: (n: number) => void): Database {
  try {
    return retryBusy(
      () => {
        const db = new Database(path, { readonly: true });
        try {
          db.exec("PRAGMA busy_timeout = 5000");
          db.query("SELECT count(*) FROM sqlite_master").get();
          return db;
        } catch (e) {
          db.close();
          throw e;
        }
      },
      ms,
      sleep,
    );
  } catch (e) {
    if (!isBusy(e)) throw e;
    throw new Error(
      `the journal ${path} stayed locked by another process (${(e as { code?: string }).code}) for ${ms / 1000}s; is another pipo process recovering it? Try again; if it persists, stop the processes that use it`,
    );
  }
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const unjson = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(String(v)));

export class Journal {
  readonly db: Database;

  /** `openReadonly`, for packages that import only the runner's index. */
  static openReadonly = openReadonly;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    // busy_timeout first, on its own (it takes no lock): switching to WAL and the schema do, and a concurrent open
    // must wait for them, not fail. Opening after a SIGKILL can also meet SQLITE_BUSY_RECOVERY while another
    // connection replays the WAL, which doesn't always go through the busy handler, so the rest (all idempotent) is
    // retried with a short backoff.
    this.db.exec("PRAGMA busy_timeout = 5000");
    try {
      retryBusy(() => {
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
        this.db.exec(SCHEMA);
        this.migrate();
      });
    } catch (e) {
      this.db.close();
      if (!isBusy(e)) throw e;
      throw new Error(
        `the journal ${path} stayed locked by another process (${(e as { code?: string }).code}) for ${BUSY_RETRY_MS / 1000}s; is another pipo process using it? Try again; if it persists, stop the processes that use it`,
      );
    }
  }

  /** Journals created before fan-out (D22) lack the branch columns; adding them is additive. */
  private migrate() {
    const missing = () => {
      const cols = new Set(
        (this.db.query("PRAGMA table_info(packets)").all() as { name: string }[]).map((c) => c.name),
      );
      return BRANCH_COLUMNS.filter(([name]) => !cols.has(name));
    };
    if (missing().length) {
      this.db
        .transaction(() => {
          for (const [name, def] of missing()) this.db.exec(`ALTER TABLE packets ADD COLUMN ${name} ${def}`);
        })
        .immediate();
    }
    // Each transition's patch on its event (the packet trace, D33); older events simply have none.
    const eventCols = (this.db.query("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name);
    if (!eventCols.includes("patch")) this.db.exec("ALTER TABLE events ADD COLUMN patch TEXT");
    // A step's duration on the event of its transition (§7.6 latency, D54). Additive, checked again inside the write
    // transaction so two processes opening an old journal at once can't both add it; older events have none.
    if (!eventCols.includes("ms")) {
      this.db
        .transaction(() => {
          const cols = (this.db.query("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name);
          if (!cols.includes("ms")) this.db.exec("ALTER TABLE events ADD COLUMN ms INTEGER");
        })
        .immediate();
    }
    this.migrateVersions();
    this.migrateVersionAudit();
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS packets_parent ON packets(parent); CREATE INDEX IF NOT EXISTS packets_root ON packets(root);" +
        " CREATE INDEX IF NOT EXISTS packets_received ON packets(received_at); CREATE INDEX IF NOT EXISTS packets_state_updated ON packets(state, updated_at);" +
        // Only timed transitions are indexed, so the latency window is a short indexed read per node (D54).
        " CREATE INDEX IF NOT EXISTS events_node_ms ON events(node, seq) WHERE ms IS NOT NULL;",
    );
  }

  /**
   * Journals from before rollback (D38) keep one row per distinct source (`hash` UNIQUE) and have no `reason`. A
   * rollback stores an earlier source again as a new version, so the table is rebuilt without the constraint, in one
   * transaction (SQLite can't drop a column constraint in place). Foreign keys are off only while it runs, since
   * `packets.version` references the table being replaced; the check before commit proves no packet lost its version.
   */
  private migrateVersions() {
    const table = this.db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'versions'").get() as {
      sql: string;
    } | null;
    const cols = (this.db.query("PRAGMA table_info(versions)").all() as { name: string }[]).map((c) => c.name);
    if (table && (/\bUNIQUE\b/i.test(table.sql) || !cols.includes("reason"))) {
      this.db.exec("PRAGMA foreign_keys = OFF");
      try {
        this.db
          .transaction(() => {
            this.db.exec(`CREATE TABLE versions_new (
              version INTEGER PRIMARY KEY, hash TEXT NOT NULL, source TEXT NOT NULL,
              author TEXT NOT NULL DEFAULT 'human', reason TEXT, created_at INTEGER NOT NULL)`);
            this.db.exec(
              "INSERT INTO versions_new (version, hash, source, author, created_at) SELECT version, hash, source, author, created_at FROM versions",
            );
            this.db.exec("DROP TABLE versions");
            this.db.exec("ALTER TABLE versions_new RENAME TO versions");
            const broken = this.db.query("PRAGMA foreign_key_check").all();
            if (broken.length) throw new Error(`journal migration left ${broken.length} broken reference(s)`);
          })
          .immediate();
      } finally {
        this.db.exec("PRAGMA foreign_keys = ON");
      }
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS versions_hash ON versions(hash)");
  }

  /**
   * A version's audit beyond author and reason (§9.3 step 5, D49): `author_kind` (`human` or `agent`), the `proposal`
   * it was applied from, and the `files` it ran with (D60). Journals from before D49 or D60 gain the missing columns,
   * null for their old versions, in one transaction that checks again inside it, so two processes opening the journal
   * at once add them once.
   */
  private migrateVersionAudit() {
    const missing = () => {
      const cols = new Set(
        (this.db.query("PRAGMA table_info(versions)").all() as { name: string }[]).map((c) => c.name),
      );
      return VERSION_AUDIT_COLUMNS.filter((c) => !cols.has(c));
    };
    if (!missing().length) return;
    this.db
      .transaction(() => {
        for (const c of missing()) this.db.exec(`ALTER TABLE versions ADD COLUMN ${c} TEXT`);
      })
      .immediate();
  }

  /** Run several updates as one transaction (e.g. every packet of an output batch flush). */
  atomically<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  event(type: string, detail?: unknown, packetId: string | null = null, node: string | null = null) {
    this.eventRaw(packetId, type, node, detail);
  }

  private eventRaw(
    packetId: string | null,
    type: string,
    node: string | null,
    detail: unknown,
    patch?: PacketPatch,
    ms?: number,
  ) {
    this.db
      .query("INSERT INTO events (at, packet_id, type, node, detail, patch, ms) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        Date.now(),
        packetId,
        type,
        node,
        json(detail),
        patch === undefined ? null : json(patch),
        ms === undefined ? null : Math.max(0, Math.round(ms)),
      );
  }

  // ── agent spend (spec §3.11, D36, D37) ──────────────────────────────────────

  // ── dead-letter queue (spec §3.9, D33) ──────────────────────────────────────

  get(id: string): PacketRow | null {
    const row = this.db.query("SELECT * FROM packets WHERE id = ?").get(id);
    return row ? decode(row) : null;
  }

  events(packetId: string): { type: string; node: string | null; at: number; detail: unknown }[] {
    return (
      this.db.query("SELECT type, node, at, detail FROM events WHERE packet_id = ? ORDER BY seq").all(packetId) as any[]
    ).map((e) => ({ ...e, detail: unjson(e.detail) }));
  }

  close() {
    this.db.close();
  }
}

function decode(row: unknown): PacketRow {
  const r = row as Record<string, unknown>;
  return {
    ...(r as unknown as PacketRow),
    data: unjson(r.data),
    error: unjson(r.error) as PacketRow["error"],
    result: unjson(r.result),
    input: typeof r.input === "string" ? r.input : "input",
    upstream: (unjson(r.upstream) as PacketRow["upstream"]) ?? null,
  };
}
