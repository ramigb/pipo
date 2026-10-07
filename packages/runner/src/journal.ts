// The pipeline's durable journal (docs/spec.md §2, §7.3): every packet state change is
// committed here before the runner moves on, so a crash resumes from the last committed step.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { InputState } from "./connectors/types";

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

/** Next step for an in-flight packet: a node id, or the output/verification stages. */
export type Cursor = string;
export const OUTPUT_STEP = "$output";
/** Passed `output.validate` and waits in an output batch (spec §3.5.1, D20); state stays `writing`. */
export const BATCH_STEP = "$batch";
export const VERIFY_STEP = "$verify";

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

/** A version's referenced files (`fn` module, schema files) as written in its source → sha256 of their content (D60). */
export type FileHashes = Record<string, string>;

/** Who made a version and from what, beyond `author` and `reason` (D49), and the files it ran with (D60). */
export interface VersionAudit {
  /** `human` (a start from the file), `agent`, or null when the channel doesn't say (the `apply`/`rollback` ops). */
  author_kind?: "human" | "agent" | null;
  /** The proposal the version was applied from (§9.3). */
  proposal?: string | null;
  /** The content hashes of the files the version runs with (D60); null for versions from before D60. */
  files?: FileHashes | null;
}

/** File hashes as stored: JSON with sorted keys, so equal sets store equal text. */
const filesJson = (files: FileHashes | null | undefined) =>
  files
    ? JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
    : null;

const BRANCH_COLUMNS = [
  ["root", "TEXT"],
  ["parent", "TEXT"],
  ["branch", "TEXT NOT NULL DEFAULT ''"],
] as const;

/** A dead-lettered unit put back in flight by a DLQ replay (D33): where it resumes. */
export interface ReplayLeaf {
  id: string;
  cursor: Cursor;
  state: PacketState;
  /** Set to reset a loop's iteration count (a `loop.max` failure gets a fresh budget). */
  iteration?: number;
}

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

  /**
   * Record a pipeline definition and return its version number: the latest version when it has the same content,
   * else a new one. Versions are a timeline (D38): an earlier source used again becomes a new version.
   */
  version(hash: string, source: string, author = "human", reason: string | null = null): number {
    const latest = this.latestVersion();
    if (latest?.hash === hash) return latest.version;
    return this.addVersion(hash, source, author, reason);
  }

  /** The newest version: the one a start with an unchanged file runs (D38). */
  latestVersion(): { version: number; hash: string } | null {
    return this.db.query("SELECT version, hash FROM versions ORDER BY version DESC LIMIT 1").get() as {
      version: number;
      hash: string;
    } | null;
  }

  /**
   * Append a version in one transaction. `applied` (a live apply, D38) adds a pipeline-level `version.applied` event
   * in the same transaction (a start says its version in `pipeline.started`), and its `expect`, the version number
   * the caller planned for, makes a concurrent writer an error instead of a silent renumbering.
   */
  addVersion(
    hash: string,
    source: string,
    author: string,
    reason: string | null,
    applied?: { expect: number; previous: number },
    audit: VersionAudit = {},
  ): number {
    return this.db.transaction(() => {
      const next = (this.db.query("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM versions").get() as { v: number }).v;
      if (applied && next !== applied.expect) {
        throw new Error(`the journal's next version is v${next}, not v${applied.expect}; another writer added one`);
      }
      this.db
        .query(
          "INSERT INTO versions (version, hash, source, author, reason, created_at, author_kind, proposal, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          next,
          hash,
          source,
          author,
          reason,
          Date.now(),
          audit.author_kind ?? null,
          audit.proposal ?? null,
          filesJson(audit.files),
        );
      if (applied) {
        this.eventRaw(null, "version.applied", null, {
          version: next,
          previous: applied.previous,
          author,
          ...(audit.author_kind && { author_kind: audit.author_kind }),
          reason,
          hash,
          ...(audit.proposal && { proposal: audit.proposal }),
        });
      }
      return next;
    })();
  }

  /**
   * Commit the version a start runs (D38), with the file's content hash, in one transaction. `planned` is what the
   * start decided from its read of the journal; if the journal moved since (another runner), nothing is written.
   */
  commitStart(
    planned: { latest: number | null; append: { hash: string; source: string; reason: string } | null },
    fileHash: string,
    files: FileHashes | null = null,
  ): number {
    return this.db.transaction(() => {
      const latest = this.latestVersion();
      if ((latest?.version ?? null) !== planned.latest) {
        throw new Error(
          `the journal's latest version is ${latest ? `v${latest.version}` : "none"}, not ${planned.latest === null ? "none" : `v${planned.latest}`}, as it was a moment ago`,
        );
      }
      const version = planned.append
        ? this.addVersion(planned.append.hash, planned.append.source, "human", planned.append.reason, undefined, {
            author_kind: "human",
            files,
          })
        : (latest as { version: number }).version;
      this.setMeta("file_hash", fileHash);
      return version;
    })();
  }

  meta(key: string): string | null {
    return (this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
  }

  setMeta(key: string, value: string) {
    this.db
      .query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /** The file hashes a version recorded (D60); null when it has none (a version from before D60) or doesn't exist. */
  versionFiles(version: number): FileHashes | null {
    const row = this.db.query("SELECT files FROM versions WHERE version = ?").get(version) as {
      files: string | null;
    } | null;
    return row?.files ? (JSON.parse(row.files) as FileHashes) : null;
  }

  versionSource(version: number): string {
    const row = this.db.query("SELECT source FROM versions WHERE version = ?").get(version) as {
      source: string;
    } | null;
    if (!row) throw new Error(`journal has no version ${version}`);
    return row.source;
  }

  /** Insert a packet and its first event; `commit` (an input's cursor write) joins the same transaction. */
  insert(
    p: Omit<PacketRow, "updated_at" | "attempt" | "iteration" | "hops" | "result" | "root" | "parent" | "branch">,
    event: string,
    detail?: unknown,
    commit?: () => void,
  ) {
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO packets (id, version, state, cursor, data, trigger, source, error, received_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          p.id,
          p.version,
          p.state,
          p.cursor,
          json(p.data),
          p.trigger,
          p.source,
          json(p.error),
          p.received_at,
          p.received_at,
        );
      this.eventRaw(p.id, event, null, detail, { state: p.state, cursor: p.cursor, data: p.data });
      commit?.();
    })();
  }

  /**
   * Insert the branch copies of `parent` (spec §3.4, D22), each with its first event. Call it inside the
   * transaction that commits the parent's step, so a fan-out is never partial.
   */
  insertCopies(
    parent: PacketRow,
    copies: { id: string; branch: string; state: PacketState; cursor: Cursor; data: unknown; hops: number }[],
    node: string | null,
  ) {
    const now = Date.now();
    const put = this.db.query(
      `INSERT INTO packets (id, version, state, cursor, data, trigger, source, attempt, iteration, hops, error, received_at,
         updated_at, root, parent, branch)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    );
    for (const c of copies) {
      put.run(
        c.id,
        parent.version,
        c.state,
        c.cursor,
        json(c.data),
        parent.trigger,
        parent.source,
        parent.iteration,
        c.hops,
        parent.received_at,
        now,
        parent.root ?? parent.id,
        parent.id,
        c.branch,
      );
      this.eventRaw(
        c.id,
        "packet.branched",
        node,
        { parent: parent.id, branch: c.branch },
        { state: c.state, cursor: c.cursor, data: c.data },
      );
    }
  }

  /**
   * After `id` reached a terminal state: settle each ancestor whose copies are now all terminal, in the
   * caller's transaction (D22). An ancestor is dead-lettered if any copy is, else delivered if any copy
   * is, else filtered. Returns the settled ancestors, nearest first.
   */
  settleAncestors(id: string): { id: string; state: PacketState; error: PacketRow["error"] }[] {
    const settled: { id: string; state: PacketState; error: PacketRow["error"] }[] = [];
    let parent = (this.db.query("SELECT parent FROM packets WHERE id = ?").get(id) as { parent: string | null } | null)
      ?.parent;
    while (parent) {
      const copies = this.db
        .query("SELECT branch, state, error FROM packets WHERE parent = ? ORDER BY branch")
        .all(parent) as { branch: string; state: PacketState; error: string | null }[];
      if (copies.some((c) => !(TERMINAL as readonly string[]).includes(c.state))) break;
      const count = (s: string) => copies.filter((c) => c.state === s).length;
      const branches = {
        delivered: count("delivered"),
        filtered: count("filtered"),
        dead_lettered: count("dead_lettered"),
      };
      const dead = copies.filter((c) => c.state === "dead_lettered");
      const state: PacketState = dead.length ? "dead_lettered" : branches.delivered ? "delivered" : "filtered";
      let error: PacketRow["error"] = null;
      if (dead.length) {
        const first = dead[0] as (typeof dead)[number];
        const e = unjson(first.error) as PacketRow["error"];
        const more = dead.length > 1 ? ` (and ${dead.length - 1} more branch(es))` : "";
        error = {
          code: "branch.dead_lettered",
          message: `branch '${first.branch}' dead-lettered${e ? `: ${e.message}` : ""}${more}`,
          ...(e?.node && { node: e.node }),
        };
      }
      this.update(parent, { state, cursor: null, error }, `packet.${state}`, null, { branches });
      settled.push({ id: parent, state, error });
      parent = (this.db.query("SELECT parent FROM packets WHERE id = ?").get(parent) as { parent: string | null })
        .parent;
    }
    return settled;
  }

  /** The branch copies of a packet (any depth), by branch path. */
  copies(packetId: string): PacketRow[] {
    return this.db.query("SELECT * FROM packets WHERE root = ? ORDER BY branch").all(packetId).map(decode);
  }

  /** Durable state for the pipeline's input (spec §14.3); tables were added later, so old journals simply start empty. */
  inputState(scope: string): InputState {
    const db = this.db;
    return {
      load() {
        if (!db.query("SELECT 1 FROM input_scopes WHERE scope = ?").get(scope)) return null;
        const all = db.query("SELECT key, value FROM input_state WHERE scope = ?").all(scope) as {
          key: string;
          value: string;
        }[];
        return new Map(all.map((r) => [r.key, JSON.parse(r.value)]));
      },
      baseline(entries) {
        db.transaction(() => {
          db.query("DELETE FROM input_scopes").run();
          db.query("INSERT INTO input_scopes (scope, created_at) VALUES (?, ?)").run(scope, Date.now());
          const put = db.query("INSERT INTO input_state (scope, key, value) VALUES (?, ?, ?)");
          for (const [k, v] of entries) put.run(scope, k, JSON.stringify(v));
        })();
      },
      put(key, value) {
        if (value === undefined) db.query("DELETE FROM input_state WHERE scope = ? AND key = ?").run(scope, key);
        else
          db.query(
            "INSERT INTO input_state (scope, key, value) VALUES (?, ?, ?) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value",
          ).run(scope, key, JSON.stringify(value));
      },
    };
  }

  /**
   * Apply a patch and log an event in one transaction. `ms`, a step's duration, goes on that event when the transition
   * completes the step (§7.6 latency, D54), so the sample commits with the transition, exactly once.
   */
  update(
    id: string,
    patch: PacketPatch,
    event: string,
    node: string | null = null,
    detail?: unknown,
    extra: { type: string; detail?: unknown }[] = [],
    ms?: number,
  ) {
    const sets: string[] = ["updated_at = ?"];
    const values: unknown[] = [Date.now()];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      values.push(k === "data" || k === "error" || k === "result" ? json(v) : (v ?? null));
    }
    this.db.transaction(() => {
      this.db.query(`UPDATE packets SET ${sets.join(", ")} WHERE id = ?`).run(...(values as any[]), id);
      for (const e of extra) this.eventRaw(id, e.type, node, e.detail);
      this.eventRaw(id, event, node, detail, patch, ms);
    })();
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

  /**
   * Record one agent call's usage the moment the provider reports it, in its own transaction: an `agent.usage` event
   * on the unit (its trace) and an `agent_spend` row keyed by that event's seq. Budgets read only `agent_spend`, which
   * a DLQ purge leaves alone, so money spent is never forgotten. `at` is the runner's clock (budget windows use it).
   */
  recordAgentUsage(u: {
    at: number;
    unit: string;
    root: string;
    node: string;
    provider: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    attempt: number;
  }): number {
    return this.db.transaction(() => {
      const { at, unit, root, ...detail } = u;
      this.eventRaw(unit, "agent.usage", u.node, detail);
      const seq = this.lastSeq();
      this.db
        .query(
          `INSERT INTO agent_spend (seq, at, unit, root, node, provider, model, input_tokens, output_tokens, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(seq, at, unit, root, u.node, u.provider, u.model, u.input_tokens, u.output_tokens, u.cost_usd);
      return seq;
    })();
  }

  /**
   * Tokens (input + output) a packet used across all its agent nodes, loop passes and branch copies, since its latest
   * DLQ replay (a replayed packet gets a fresh per-packet budget, as a replayed loop gets a fresh `iteration`, D33).
   */
  packetAgentTokens(root: string): number {
    const replayed = this.db
      .query(
        "SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE type = 'dlq.replayed' AND (packet_id = ? OR (packet_id >= ? AND packet_id < ?))",
      )
      .get(root, `${root}:`, `${root};`) as { s: number };
    return (
      this.db
        .query("SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM agent_spend WHERE root = ? AND seq > ?")
        .get(root, replayed.s) as { n: number }
    ).n;
  }

  /** USD spent on agent calls at or after `since` (ms, the runner's clock). */
  agentSpendSince(since: number): number {
    return (
      this.db.query("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM agent_spend WHERE at >= ?").get(since) as {
        c: number;
      }
    ).c;
  }

  /** The latest pipeline-level event of `type` whose detail has `key` (not null), or null. */
  lastPipelineEventWith(type: string, key: string): { at: number; detail: unknown } | null {
    const e = this.db
      .query(
        "SELECT at, detail FROM events WHERE packet_id IS NULL AND type = ? AND json_extract(detail, ?) IS NOT NULL ORDER BY seq DESC LIMIT 1",
      )
      .get(type, `$.${key}`) as { at: number; detail: string | null } | null;
    return e ? { at: e.at, detail: unjson(e.detail) } : null;
  }

  /** Detail of the latest pipeline-level event of `type` (no packet), or null. */
  lastPipelineEvent(type: string): { at: number; detail: unknown } | null {
    const e = this.db
      .query("SELECT at, detail FROM events WHERE packet_id IS NULL AND type = ? ORDER BY seq DESC LIMIT 1")
      .get(type) as { at: number; detail: string | null } | null;
    return e ? { at: e.at, detail: unjson(e.detail) } : null;
  }

  // ── dead-letter queue (spec §3.9, D33) ──────────────────────────────────────

  /**
   * The units a replay of `id` puts back in flight: `id` itself when it never fanned out, else every dead-lettered
   * copy under it that has no copies of its own (the ones that actually failed; their ancestors only summarise them).
   */
  deadLeaves(id: string): PacketRow[] {
    const row = this.get(id);
    if (row?.state !== "dead_lettered") return [];
    const units = this.db
      .query("SELECT * FROM packets WHERE (root = ? OR id = ?) AND state = 'dead_lettered'")
      .all(row.root ?? row.id, row.id)
      .map(decode)
      .filter((u) => u.id === id || u.id.startsWith(row.root ? `${id}/` : `${id}:`));
    const parents = new Set(
      (
        this.db.query("SELECT DISTINCT parent FROM packets WHERE root = ?").all(row.root ?? row.id) as {
          parent: string | null;
        }[]
      ).map((p) => p.parent),
    );
    return units.filter((u) => !parents.has(u.id)).sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * DLQ replay (D33), in one transaction: each leaf goes back in flight at its cursor (error cleared, attempt 0, same
   * version and data), and each dead-lettered ancestor goes back to `branched` so it settles again once its copies
   * end. Every change commits its patch and a `dlq.replayed` event. Throws (rolling everything back) if any leaf is
   * no longer dead-lettered, so a replay can never run a packet twice.
   */
  replay(items: { packet_id: string; leaves: ReplayLeaf[] }[], by: string): void {
    this.db.transaction(() => {
      for (const item of items) {
        const reopened = new Set<string>();
        for (const leaf of item.leaves) {
          const row = this.get(leaf.id);
          if (row?.state !== "dead_lettered") {
            throw new Error(`packet ${leaf.id} is ${row?.state ?? "gone"}, not dead-lettered; nothing was replayed`);
          }
          this.update(
            leaf.id,
            {
              state: leaf.state,
              cursor: leaf.cursor,
              error: null,
              attempt: 0,
              ...(leaf.iteration !== undefined && { iteration: leaf.iteration }),
            },
            "dlq.replayed",
            leaf.cursor,
            { by, packet_id: item.packet_id, error: row.error },
          );
          for (let parent = row.parent; parent; ) {
            const p = this.get(parent);
            if (!p) break;
            if (p.state === "dead_lettered" && !reopened.has(p.id)) {
              reopened.add(p.id);
              this.update(p.id, { state: BRANCHED, cursor: null, error: null }, "dlq.replayed", null, {
                by,
                packet_id: item.packet_id,
                error: p.error,
              });
            }
            parent = p.parent;
          }
        }
      }
    })();
  }

  /**
   * DLQ purge (D33), in one transaction: removes each dead-lettered packet, its branch copies and their events, and
   * records one `dlq.purged` event per packet with what it was (version, error, when). Nothing else is touched.
   */
  purge(ids: string[], by: string): void {
    this.db.transaction(() => {
      for (const id of ids) {
        const row = this.get(id);
        if (row?.state !== "dead_lettered" || row.branch !== "") {
          throw new Error(`packet ${id} is ${row?.state ?? "gone"}, not dead-lettered; nothing was purged`);
        }
        const units = [id, ...this.copies(id).map((c) => c.id)];
        let events = 0;
        for (const u of units) {
          events += this.db.query("DELETE FROM events WHERE packet_id = ?").run(u).changes;
          this.db.query("DELETE FROM packets WHERE id = ?").run(u);
        }
        this.eventRaw(id, "dlq.purged", row.error?.node ?? null, {
          by,
          version: row.version,
          received_at: row.received_at,
          error: row.error,
          copies: units.length - 1,
          events,
        });
      }
    })();
  }

  get(id: string): PacketRow | null {
    const row = this.db.query("SELECT * FROM packets WHERE id = ?").get(id);
    return row ? decode(row) : null;
  }

  inFlight(): PacketRow[] {
    const marks = IN_FLIGHT.map(() => "?").join(", ");
    return this.db
      .query(`SELECT * FROM packets WHERE state IN (${marks}) ORDER BY id`)
      .all(...IN_FLIGHT)
      .map(decode);
  }

  /** Packets (not copies) that are not terminal yet: in flight, waiting on their branch copies (D22) or an agent (D50). */
  countInFlight(): number {
    const pending = PENDING;
    const marks = pending.map(() => "?").join(", ");
    return (
      this.db.query(`SELECT COUNT(*) AS n FROM packets WHERE branch = '' AND state IN (${marks})`).get(...pending) as {
        n: number;
      }
    ).n;
  }

  /** Units (packets and copies) the runner itself is moving: in flight, not waiting for an agent (stall check, D50). */
  countMoving(): number {
    const marks = IN_FLIGHT.map(() => "?").join(", ");
    return (
      this.db.query(`SELECT COUNT(*) AS n FROM packets WHERE state IN (${marks})`).get(...IN_FLIGHT) as { n: number }
    ).n;
  }

  /** Packets with at least one unit (the packet or a copy) waiting for an agent (D50). */
  countEscalated(): number {
    return (
      this.db.query("SELECT COUNT(DISTINCT COALESCE(root, id)) AS n FROM packets WHERE state = ?").get(ESCALATED) as {
        n: number;
      }
    ).n;
  }

  /** Packets by state. Branch copies are not packets of their own (D22), so they are not counted. */
  counts(): Record<string, number> {
    const rows = this.db.query("SELECT state, COUNT(*) AS n FROM packets WHERE branch = '' GROUP BY state").all() as {
      state: string;
      n: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  /** Packets accepted (not rejected) since `since` (ms); an indexed range read on received_at (D21). */
  acceptedSince(since: number): number {
    const r = this.db
      .query("SELECT COUNT(*) AS n FROM packets WHERE received_at >= ? AND branch = '' AND state != 'rejected'")
      .get(since) as { n: number };
    return r.n;
  }

  /** When the latest packet was delivered (ms), or null; an indexed lookup on (state, updated_at). */
  lastDeliveredAt(): number | null {
    const r = this.db
      .query("SELECT MAX(updated_at) AS at FROM packets WHERE state = 'delivered' AND branch = ''")
      .get() as { at: number | null };
    return r.at;
  }

  /**
   * When the oldest packet not yet terminal was received (ms), or null: in flight, waiting on its copies (D22) or on an
   * agent (D50), held by a pause or in a batch (§7.6). Copies share their packet's `received_at`, so packets suffice.
   */
  oldestPendingReceivedAt(): number | null {
    const marks = PENDING.map(() => "?").join(", ");
    const r = this.db
      .query(`SELECT MIN(received_at) AS at FROM packets WHERE branch = '' AND state IN (${marks})`)
      .get(...PENDING) as { at: number | null };
    return r.at;
  }

  /** The durations (ms) of the latest `limit` completed steps at `node`, newest first (§7.6 latency, D54). */
  stepDurations(node: string, limit: number): number[] {
    return (
      this.db
        .query("SELECT ms FROM events WHERE node = ? AND ms IS NOT NULL ORDER BY seq DESC LIMIT ?")
        .all(node, limit) as { ms: number }[]
    ).map((r) => r.ms);
  }

  /** The oldest unit still in flight (stall context, §3.10) and its latest error, from the row or its last retry event. */
  oldestPending(): { row: PacketRow; lastError: string | null } | null {
    const marks = IN_FLIGHT.map(() => "?").join(", ");
    const r = this.db
      .query(`SELECT * FROM packets WHERE state IN (${marks}) ORDER BY received_at, id LIMIT 1`)
      .get(...IN_FLIGHT);
    if (!r) return null;
    const row = decode(r);
    let lastError = row.error?.message ?? null;
    if (!lastError) {
      const e = this.db
        .query("SELECT detail FROM events WHERE packet_id = ? AND type = 'step.retry' ORDER BY seq DESC LIMIT 1")
        .get(row.id) as { detail: string | null } | null;
      const d = e ? (unjson(e.detail) as { error?: string } | null) : null;
      lastError = d?.error ?? null;
    }
    return { row, lastError };
  }

  events(packetId: string): { type: string; node: string | null; at: number; detail: unknown }[] {
    return (
      this.db.query("SELECT type, node, at, detail FROM events WHERE packet_id = ? ORDER BY seq").all(packetId) as any[]
    ).map((e) => ({ ...e, detail: unjson(e.detail) }));
  }

  /** Events with `seq` greater than `after`, oldest first: what a reattaching engine missed (spec §7.2). */
  eventsAfter(
    after: number,
    limit: number,
  ): { seq: number; at: number; packet_id: string | null; type: string; node: string | null; detail: unknown }[] {
    return (
      this.db
        .query("SELECT seq, at, packet_id, type, node, detail FROM events WHERE seq > ? ORDER BY seq LIMIT ?")
        .all(after, limit) as any[]
    ).map((e) => ({ ...e, detail: unjson(e.detail) }));
  }

  lastSeq(): number {
    return (this.db.query("SELECT COALESCE(MAX(seq), 0) AS n FROM events").get() as { n: number }).n;
  }

  /** The packet's most recent event among `types`, if any. */
  latestEvent(packetId: string, types: string[]): { type: string; at: number; detail: unknown } | null {
    const marks = types.map(() => "?").join(", ");
    const e = this.db
      .query(`SELECT type, at, detail FROM events WHERE packet_id = ? AND type IN (${marks}) ORDER BY seq DESC LIMIT 1`)
      .get(packetId, ...types) as { type: string; at: number; detail: string | null } | null;
    return e ? { ...e, detail: unjson(e.detail) } : null;
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
  };
}
