// The pipeline's durable journal (docs/spec.md §2, §7.3): every packet state change is committed here before the
// runner moves on, so a crash resumes from the last committed step. Ports journal.ts. The on-disk format is shared
// with the TypeScript engine and CLI (bun:sqlite): same schema, migrations, pragmas and JSON column text.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags, OptionalExtension, Row, params, params_from_iter};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Value, json};

pub const IN_FLIGHT: [&str; 4] = ["accepted", "processing", "writing", "verifying"];
pub const TERMINAL: [&str; 4] = ["delivered", "filtered", "dead_lettered", "rejected"];
/// A packet (or copy) that fanned out (spec §3.4, D22): neither in flight nor terminal; it becomes terminal, with a
/// summary state, in the same transaction as its last copy.
pub const BRANCHED: &str = "branched";
/// A unit handed to the agent (spec §3.9, §9, D50): it waits, across restarts, until a `resolve` retries,
/// dead-letters or drops it. Its cursor is where a retry resumes.
pub const ESCALATED: &str = "escalated";
/// Not terminal yet: in flight, waiting on branch copies (D22), or waiting for an agent (D50).
pub const PENDING: [&str; 6] = ["accepted", "processing", "writing", "verifying", BRANCHED, ESCALATED];

pub const OUTPUT_STEP: &str = "$output";
/// Passed `output.validate` and waits in an output batch (spec §3.5.1, D20); state stays `writing`.
pub const BATCH_STEP: &str = "$batch";
pub const VERIFY_STEP: &str = "$verify";

/// How long opening a journal keeps retrying while it is busy.
pub const BUSY_RETRY_MS: u64 = 5000;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS versions (
  version INTEGER PRIMARY KEY,
  hash TEXT NOT NULL,
  source TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'human',
  reason TEXT,
  created_at INTEGER NOT NULL,
  author_kind TEXT,
  proposal TEXT,
  files TEXT,
  compiled TEXT
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
";

/// Audit columns added to `versions` after it first shipped: D49, D60, and the compiled form (docs/rust-runner.md).
const VERSION_AUDIT_COLUMNS: [&str; 4] = ["author_kind", "proposal", "files", "compiled"];

const BRANCH_COLUMNS: [(&str, &str); 3] =
    [("root", "TEXT"), ("parent", "TEXT"), ("branch", "TEXT NOT NULL DEFAULT ''")];

// ── errors ──────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum Error {
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
    Io(std::io::Error),
    /// A message for the user, as journal.ts throws it.
    Message(String),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Sqlite(e) => write!(f, "{e}"),
            Error::Json(e) => write!(f, "{e}"),
            Error::Io(e) => write!(f, "{e}"),
            Error::Message(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Sqlite(e)
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Json(e)
    }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}
impl From<String> for Error {
    fn from(m: String) -> Self {
        Error::Message(m)
    }
}
impl From<&str> for Error {
    fn from(m: &str) -> Self {
        Error::Message(m.to_string())
    }
}

/// The SQLite code name (`SQLITE_BUSY`, `SQLITE_BUSY_RECOVERY`, …) of a busy error, or None for any other error.
pub fn busy_code(e: &Error) -> Option<&'static str> {
    let Error::Sqlite(rusqlite::Error::SqliteFailure(f, _)) = e else { return None };
    if f.code != rusqlite::ErrorCode::DatabaseBusy {
        return None;
    }
    Some(match f.extended_code {
        261 => "SQLITE_BUSY_RECOVERY",
        517 => "SQLITE_BUSY_SNAPSHOT",
        773 => "SQLITE_BUSY_TIMEOUT",
        _ => "SQLITE_BUSY",
    })
}

/// SQLITE_BUSY and its extended codes (SQLITE_BUSY_RECOVERY, SQLITE_BUSY_SNAPSHOT, …).
pub fn is_busy(e: &Error) -> bool {
    busy_code(e).is_some()
}

/// Run `f`, again after a short, growing pause while it fails busy, for up to `ms`; then the last error.
pub fn retry_busy<T>(f: impl FnMut() -> Result<T>, ms: u64) -> Result<T> {
    retry_busy_with(f, ms, |n| std::thread::sleep(Duration::from_millis(n)))
}

/// `retry_busy` with its sleep injected (tests).
pub fn retry_busy_with<T>(mut f: impl FnMut() -> Result<T>, ms: u64, mut sleep: impl FnMut(u64)) -> Result<T> {
    // Bounded by the pauses taken and by the clock, since a plain SQLITE_BUSY has already waited out busy_timeout.
    let deadline = Instant::now() + Duration::from_millis(ms);
    let mut waited = 0;
    let mut wait = 25;
    loop {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) => {
                if !is_busy(&e) || waited + wait > ms || Instant::now() + Duration::from_millis(wait) > deadline {
                    return Err(e);
                }
                sleep(wait);
                waited += wait;
                wait = (wait * 2).min(500);
            }
        }
    }
}

/// `ms / 1000` as JavaScript prints it.
fn js_secs(ms: u64) -> String {
    if ms.is_multiple_of(1000) { (ms / 1000).to_string() } else { (ms as f64 / 1000.0).to_string() }
}

fn locked(path: &Path, e: &Error, ms: u64, what: &str) -> Error {
    Error::Message(format!(
        "the journal {} stayed locked by another process ({}) for {}s; is another pipo process {what}? Try again; if it persists, stop the processes that use it",
        path.display(),
        busy_code(e).unwrap_or("SQLITE_BUSY"),
        js_secs(ms),
    ))
}

/// Open a journal file read-only. A read-only connection's first statement is where WAL recovery bites
/// (SQLITE_BUSY_RECOVERY after a SIGKILL), so the open and a first probe are retried like `Journal::open`'s.
pub fn open_readonly(path: impl AsRef<Path>, ms: u64) -> Result<Connection> {
    let path = path.as_ref();
    retry_busy(
        || {
            let db = Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            db.execute_batch("PRAGMA busy_timeout = 5000")?;
            db.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))?;
            Ok(db)
        },
        ms,
    )
    .map_err(|e| if is_busy(&e) { locked(path, &e, ms, "recovering it") } else { e })
}

// ── JSON as journal.ts writes it ────────────────────────────────────────────

/// JSON text as JavaScript's `JSON.stringify` writes it: no spaces, key order kept, integral numbers without `.0`.
// TODO(merge): use crate::expr::js_json
fn js_json(v: &Value) -> String {
    struct Js<'a>(&'a Value);
    impl Serialize for Js<'_> {
        fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
            match self.0 {
                Value::Number(n) if n.is_f64() => {
                    let f = n.as_f64().unwrap_or(0.0);
                    if f.fract() == 0.0 && f.abs() < 9.0e15 { s.serialize_i64(f as i64) } else { n.serialize(s) }
                }
                Value::Array(a) => s.collect_seq(a.iter().map(Js)),
                Value::Object(o) => s.collect_map(o.iter().map(|(k, v)| (k, Js(v)))),
                v => v.serialize(s),
            }
        }
    }
    serde_json::to_string(&Js(v)).expect("JSON values serialize")
}

/// SQL value of journal.ts `json(v)`: NULL for undefined (None), else the JSON text (`"null"` for null).
fn json_opt(v: Option<&Value>) -> Option<String> {
    v.map(js_json)
}

fn unjson(text: Option<String>) -> Result<Value> {
    Ok(match text {
        None => Value::Null,
        Some(t) => serde_json::from_str(&t)?,
    })
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// ── types ───────────────────────────────────────────────────────────────────

/// A packet error as stored in `packets.error` (absent fields are left out, as in TS).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PacketError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempts: Option<u32>,
}

impl PacketError {
    fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("PacketError serializes")
    }
}

fn error_value(e: Option<&PacketError>) -> Value {
    e.map_or(Value::Null, PacketError::to_value)
}

/// A journal unit. Fields are in the table's column order, so it serializes like journal.ts's `decode`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PacketRow {
    /// `packet_id` for a packet, `packet_id:<branch>` for a branch copy (D22).
    pub id: String,
    pub version: i64,
    pub state: String,
    /// Next step for an in-flight unit: a node id, or `$output`/`$batch`/`$verify`.
    pub cursor: Option<String>,
    pub data: Value,
    pub trigger: String,
    pub source: String,
    pub attempt: u32,
    pub iteration: u32,
    pub hops: u32,
    pub error: Option<PacketError>,
    /// Null when unset.
    pub result: Value,
    pub received_at: i64,
    pub updated_at: i64,
    /// The packet a copy belongs to; None for the packet itself.
    pub root: Option<String>,
    /// The unit that fanned out into this copy; None for the packet itself.
    pub parent: Option<String>,
    /// Fan-out path, consumer ids joined by `/`; empty for the packet itself.
    pub branch: String,
}

fn decode(r: &Row) -> Result<PacketRow> {
    let error = unjson(r.get("error")?)?;
    Ok(PacketRow {
        id: r.get("id")?,
        version: r.get("version")?,
        state: r.get("state")?,
        cursor: r.get("cursor")?,
        data: unjson(r.get("data")?)?,
        trigger: r.get("trigger")?,
        source: r.get("source")?,
        attempt: r.get("attempt")?,
        iteration: r.get("iteration")?,
        hops: r.get("hops")?,
        error: if error.is_null() { None } else { Some(serde_json::from_value(error)?) },
        result: unjson(r.get("result")?)?,
        received_at: r.get("received_at")?,
        updated_at: r.get("updated_at")?,
        root: r.get("root")?,
        parent: r.get("parent")?,
        branch: r.get("branch")?,
    })
}

/// A transition's changes. `None` leaves a field alone. `cursor` and `error` are `Some(None)` to set them to null;
/// `data` and `result` are `Some(Value::Null)` for null.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PacketPatch {
    pub state: Option<String>,
    pub cursor: Option<Option<String>>,
    pub data: Option<Value>,
    pub hops: Option<u32>,
    pub error: Option<Option<PacketError>>,
    pub attempt: Option<u32>,
    pub iteration: Option<u32>,
    pub result: Option<Value>,
}

impl PacketPatch {
    /// The patch as stored on its event. TS stores the caller's object literal, so key order is the call site's.
    /// The order here (state, cursor, data, hops, error, attempt, iteration, result) agrees with every call site in
    /// runner.ts and journal.ts (each uses a subsequence of it).
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        if let Some(s) = &self.state {
            m.insert("state".into(), Value::String(s.clone()));
        }
        if let Some(c) = &self.cursor {
            m.insert("cursor".into(), c.clone().map_or(Value::Null, Value::String));
        }
        if let Some(d) = &self.data {
            m.insert("data".into(), d.clone());
        }
        if let Some(h) = self.hops {
            m.insert("hops".into(), h.into());
        }
        if let Some(e) = &self.error {
            m.insert("error".into(), error_value(e.as_ref()));
        }
        if let Some(a) = self.attempt {
            m.insert("attempt".into(), a.into());
        }
        if let Some(i) = self.iteration {
            m.insert("iteration".into(), i.into());
        }
        if let Some(r) = &self.result {
            m.insert("result".into(), r.clone());
        }
        Value::Object(m)
    }
}

/// A new packet for `insert`.
#[derive(Debug, Clone, PartialEq)]
pub struct NewPacket {
    pub id: String,
    pub version: i64,
    pub state: String,
    pub cursor: Option<String>,
    pub data: Value,
    pub trigger: String,
    pub source: String,
    pub error: Option<PacketError>,
    pub received_at: i64,
}

/// A branch copy for `insert_copies`.
#[derive(Debug, Clone, PartialEq)]
pub struct NewCopy {
    pub id: String,
    pub branch: String,
    pub state: String,
    pub cursor: String,
    pub data: Value,
    pub hops: u32,
}

/// An input's cursor write that joins `insert`'s transaction.
pub type Commit<'a> = &'a mut dyn FnMut(&mut Journal) -> Result<()>;

/// An extra event `update` logs before the transition's own.
#[derive(Debug, Clone, PartialEq)]
pub struct ExtraEvent {
    pub kind: String,
    pub detail: Option<Value>,
}

/// A version's referenced files (`fn` module, schema files) → sha256 of their content (D60). Sorted, so equal sets
/// store equal text.
pub type FileHashes = BTreeMap<String, String>;

/// Who made a version and from what, beyond `author` and `reason` (D49), and the files it ran with (D60).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct VersionAudit {
    /// `human`, `agent`, or None when the channel doesn't say.
    pub author_kind: Option<String>,
    /// The proposal the version was applied from (§9.3).
    pub proposal: Option<String>,
    pub files: Option<FileHashes>,
}

/// A live apply (D38): `expect` is the version number the caller planned for.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Applied {
    pub expect: i64,
    pub previous: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LatestVersion {
    pub version: i64,
    pub hash: String,
}

/// What a start decided from its read of the journal (D38).
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedStart {
    pub latest: Option<i64>,
    pub append: Option<PlannedAppend>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlannedAppend {
    pub hash: String,
    pub source: String,
    pub reason: String,
    /// The version's compiled form (JSON), stored in `versions.compiled`.
    pub compiled: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Settled {
    pub id: String,
    pub state: String,
    pub error: Option<PacketError>,
}

/// A dead-lettered unit put back in flight by a DLQ replay (D33): where it resumes.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ReplayLeaf {
    pub id: String,
    pub cursor: String,
    pub state: String,
    /// Set to reset a loop's iteration count (a `loop.max` failure gets a fresh budget).
    #[serde(default)]
    pub iteration: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ReplayItem {
    pub packet_id: String,
    pub leaves: Vec<ReplayLeaf>,
}

/// One agent call's usage (spec §3.11, D36, D37).
#[derive(Debug, Clone, PartialEq)]
pub struct AgentUsage {
    pub at: i64,
    pub unit: String,
    pub root: String,
    pub node: String,
    pub provider: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub attempt: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TimedDetail {
    pub at: i64,
    pub detail: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PacketEvent {
    #[serde(rename = "type")]
    pub kind: String,
    pub node: Option<String>,
    pub at: i64,
    pub detail: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct JournalEvent {
    pub seq: i64,
    pub at: i64,
    pub packet_id: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    pub node: Option<String>,
    pub detail: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LatestEvent {
    #[serde(rename = "type")]
    pub kind: String,
    pub at: i64,
    pub detail: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OldestPending {
    pub row: PacketRow,
    pub last_error: Option<String>,
}

fn marks(n: usize) -> String {
    vec!["?"; n].join(", ")
}

/// `\bUNIQUE\b`, case-insensitive.
fn has_unique(sql: &str) -> bool {
    let lower = sql.to_ascii_lowercase();
    let word = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
    lower
        .match_indices("unique")
        .any(|(i, m)| !word(lower[..i].chars().next_back()) && !word(lower[i + m.len()..].chars().next()))
}

// ── the journal ─────────────────────────────────────────────────────────────

/// The journal of one pipeline. Every method runs in its own transaction, or joins the caller's inside `atomically`
/// (a nested transaction becomes a savepoint, as bun:sqlite's `db.transaction()` does).
pub struct Journal {
    db: Connection,
    path: PathBuf,
}

impl Journal {
    /// Open (creating it if needed) and migrate a journal. A busy journal is retried for `BUSY_RETRY_MS`.
    pub fn open(path: impl AsRef<Path>) -> Result<Journal> {
        let path = path.as_ref().to_path_buf();
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)?;
        }
        let db = Connection::open(&path)?;
        let j = Journal { db, path };
        // busy_timeout first, on its own (it takes no lock): switching to WAL and the schema do, and a concurrent open
        // must wait for them, not fail. Opening after a SIGKILL can also meet SQLITE_BUSY_RECOVERY, which doesn't
        // always go through the busy handler, so the rest (all idempotent) is retried with a short backoff.
        j.db.execute_batch("PRAGMA busy_timeout = 5000")?;
        let opened = retry_busy(
            || {
                j.db.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;")?;
                j.db.execute_batch(SCHEMA)?;
                j.migrate()
            },
            BUSY_RETRY_MS,
        );
        match opened {
            Ok(()) => Ok(j),
            Err(e) => {
                let path = j.path.clone();
                let _ = j.db.close();
                Err(if is_busy(&e) { locked(&path, &e, BUSY_RETRY_MS, "using it") } else { e })
            }
        }
    }

    /// The connection, for modules that run their own SQL (stats, retention, control reads).
    pub fn db(&self) -> &Connection {
        &self.db
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn close(self) -> Result<()> {
        self.db.close().map_err(|(_, e)| e.into())
    }

    // ── transactions ────────────────────────────────────────────────────────

    /// `begin` at the top level, a savepoint when a transaction is already open; rolled back on error (bun:sqlite's
    /// `db.transaction()`).
    fn tx<T>(&mut self, begin: &str, f: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        let nested = !self.db.is_autocommit();
        self.db.execute_batch(if nested { "SAVEPOINT pipo_tx" } else { begin })?;
        let out = f(self).and_then(|v| {
            self.db.execute_batch(if nested { "RELEASE pipo_tx" } else { "COMMIT" })?;
            Ok(v)
        });
        if out.is_err() && !self.db.is_autocommit() {
            let _ = self.db.execute_batch(if nested { "ROLLBACK TO pipo_tx; RELEASE pipo_tx" } else { "ROLLBACK" });
        }
        out
    }

    /// Run several calls as one transaction (e.g. every packet of an output batch flush). Nests: inside another
    /// `atomically`, it is a savepoint of the outer transaction. An error rolls back everything `f` did.
    pub fn atomically<T>(&mut self, f: impl FnOnce(&mut Journal) -> Result<T>) -> Result<T> {
        // `BEGIN` (deferred), as bun:sqlite's default `transaction()`.
        self.tx("BEGIN", f)
    }

    fn columns(&self, table: &str) -> Result<HashSet<String>> {
        let mut stmt = self.db.prepare(&format!("PRAGMA table_info({table})"))?;
        let names = stmt.query_map([], |r| r.get::<_, String>("name"))?.collect::<Result<_, _>>()?;
        Ok(names)
    }

    // ── migrations ──────────────────────────────────────────────────────────

    /// Journals created before fan-out (D22) lack the branch columns; adding them is additive.
    fn migrate(&self) -> Result<()> {
        let missing = |j: &Self| -> Result<Vec<(&str, &str)>> {
            let cols = j.columns("packets")?;
            Ok(BRANCH_COLUMNS.into_iter().filter(|(n, _)| !cols.contains(*n)).collect())
        };
        if !missing(self)?.is_empty() {
            self.immediate(|j| {
                for (name, def) in missing(j)? {
                    j.db.execute_batch(&format!("ALTER TABLE packets ADD COLUMN {name} {def}"))?;
                }
                Ok(())
            })?;
        }
        // Each transition's patch on its event (the packet trace, D33); older events simply have none.
        let event_cols = self.columns("events")?;
        if !event_cols.contains("patch") {
            self.db.execute_batch("ALTER TABLE events ADD COLUMN patch TEXT")?;
        }
        // A step's duration on its transition's event (§7.6 latency, D54). Checked again inside the write transaction
        // so two processes opening an old journal at once can't both add it.
        if !event_cols.contains("ms") {
            self.immediate(|j| {
                if !j.columns("events")?.contains("ms") {
                    j.db.execute_batch("ALTER TABLE events ADD COLUMN ms INTEGER")?;
                }
                Ok(())
            })?;
        }
        self.migrate_versions()?;
        self.migrate_version_audit()?;
        self.db.execute_batch(
            "CREATE INDEX IF NOT EXISTS packets_parent ON packets(parent); CREATE INDEX IF NOT EXISTS packets_root ON packets(root);
             CREATE INDEX IF NOT EXISTS packets_received ON packets(received_at); CREATE INDEX IF NOT EXISTS packets_state_updated ON packets(state, updated_at);
             CREATE INDEX IF NOT EXISTS events_node_ms ON events(node, seq) WHERE ms IS NOT NULL;",
        )?;
        Ok(())
    }

    /// A top-level `BEGIN IMMEDIATE` transaction (the migrations', which run before anything else could nest them).
    fn immediate(&self, f: impl FnOnce(&Self) -> Result<()>) -> Result<()> {
        self.db.execute_batch("BEGIN IMMEDIATE")?;
        let out = f(self).and_then(|()| Ok(self.db.execute_batch("COMMIT")?));
        if out.is_err() && !self.db.is_autocommit() {
            let _ = self.db.execute_batch("ROLLBACK");
        }
        out
    }

    /// Journals from before rollback (D38) keep one row per distinct source (`hash` UNIQUE) and have no `reason`. The
    /// table is rebuilt without the constraint in one transaction; foreign keys are off only while it runs, and the
    /// check before commit proves no packet lost its version.
    fn migrate_versions(&self) -> Result<()> {
        let table: Option<String> = self
            .db
            .query_row("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'versions'", [], |r| r.get(0))
            .optional()?;
        let cols = self.columns("versions")?;
        if let Some(sql) = table
            && (has_unique(&sql) || !cols.contains("reason"))
        {
            self.db.execute_batch("PRAGMA foreign_keys = OFF")?;
            let out = self.immediate(|j| {
                j.db.execute_batch(
                    "CREATE TABLE versions_new (
              version INTEGER PRIMARY KEY, hash TEXT NOT NULL, source TEXT NOT NULL,
              author TEXT NOT NULL DEFAULT 'human', reason TEXT, created_at INTEGER NOT NULL)",
                )?;
                j.db.execute_batch(
                    "INSERT INTO versions_new (version, hash, source, author, created_at) SELECT version, hash, source, author, created_at FROM versions",
                )?;
                j.db.execute_batch("DROP TABLE versions")?;
                j.db.execute_batch("ALTER TABLE versions_new RENAME TO versions")?;
                let mut stmt = j.db.prepare("PRAGMA foreign_key_check")?;
                let broken = stmt.query_map([], |_| Ok(()))?.count();
                if broken > 0 {
                    return Err(format!("journal migration left {broken} broken reference(s)").into());
                }
                Ok(())
            });
            self.db.execute_batch("PRAGMA foreign_keys = ON")?;
            out?;
        }
        self.db.execute_batch("CREATE INDEX IF NOT EXISTS versions_hash ON versions(hash)")?;
        Ok(())
    }

    /// A version's audit beyond author and reason (§9.3, D49, D60) and its compiled form. Older journals gain the
    /// missing columns, null for their old versions, in one transaction that checks again inside it.
    fn migrate_version_audit(&self) -> Result<()> {
        let missing = |j: &Self| -> Result<Vec<&str>> {
            let cols = j.columns("versions")?;
            Ok(VERSION_AUDIT_COLUMNS.into_iter().filter(|c| !cols.contains(*c)).collect())
        };
        if missing(self)?.is_empty() {
            return Ok(());
        }
        self.immediate(|j| {
            for c in missing(j)? {
                j.db.execute_batch(&format!("ALTER TABLE versions ADD COLUMN {c} TEXT"))?;
            }
            Ok(())
        })
    }

    // ── versions ────────────────────────────────────────────────────────────

    /// Record a pipeline definition and return its version number: the latest version when it has the same content,
    /// else a new one. Versions are a timeline (D38): an earlier source used again becomes a new version.
    pub fn version(
        &mut self,
        hash: &str,
        source: &str,
        author: &str,
        reason: Option<&str>,
        compiled: Option<&str>,
    ) -> Result<i64> {
        if let Some(latest) = self.latest_version()?
            && latest.hash == hash
        {
            return Ok(latest.version);
        }
        self.add_version(hash, source, author, reason, None, &VersionAudit::default(), compiled)
    }

    /// The newest version: the one a start with an unchanged file runs (D38).
    pub fn latest_version(&self) -> Result<Option<LatestVersion>> {
        Ok(self
            .db
            .query_row("SELECT version, hash FROM versions ORDER BY version DESC LIMIT 1", [], |r| {
                Ok(LatestVersion { version: r.get(0)?, hash: r.get(1)? })
            })
            .optional()?)
    }

    /// Append a version in one transaction. `applied` (a live apply, D38) adds a pipeline-level `version.applied`
    /// event in the same transaction, and its `expect` makes a concurrent writer an error instead of a renumbering.
    /// `compiled` is the version's compiled form (JSON), stored in `versions.compiled`.
    #[allow(clippy::too_many_arguments)]
    pub fn add_version(
        &mut self,
        hash: &str,
        source: &str,
        author: &str,
        reason: Option<&str>,
        applied: Option<Applied>,
        audit: &VersionAudit,
        compiled: Option<&str>,
    ) -> Result<i64> {
        self.tx("BEGIN", |j| {
            let next: i64 = j.db.query_row("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM versions", [], |r| r.get(0))?;
            if let Some(a) = applied
                && next != a.expect
            {
                return Err(format!(
                    "the journal's next version is v{next}, not v{}; another writer added one",
                    a.expect
                )
                .into());
            }
            let files = audit.files.as_ref().map(serde_json::to_string).transpose()?;
            j.db.prepare_cached(
                "INSERT INTO versions (version, hash, source, author, reason, created_at, author_kind, proposal, files, compiled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )?
            .execute(params![
                next,
                hash,
                source,
                author,
                reason,
                now_ms(),
                audit.author_kind,
                audit.proposal,
                files,
                compiled
            ])?;
            if let Some(a) = applied {
                let mut d = Map::new();
                d.insert("version".into(), next.into());
                d.insert("previous".into(), a.previous.into());
                d.insert("author".into(), author.into());
                if let Some(k) = audit.author_kind.as_deref().filter(|k| !k.is_empty()) {
                    d.insert("author_kind".into(), k.into());
                }
                d.insert("reason".into(), reason.map_or(Value::Null, Value::from));
                d.insert("hash".into(), hash.into());
                if let Some(p) = audit.proposal.as_deref().filter(|p| !p.is_empty()) {
                    d.insert("proposal".into(), p.into());
                }
                j.event_raw(None, "version.applied", None, Some(&Value::Object(d)), None, None)?;
            }
            Ok(next)
        })
    }

    /// Commit the version a start runs (D38), with the file's content hash, in one transaction. `planned` is what the
    /// start decided from its read of the journal; if the journal moved since (another runner), nothing is written.
    pub fn commit_start(&mut self, planned: &PlannedStart, file_hash: &str, files: Option<&FileHashes>) -> Result<i64> {
        self.tx("BEGIN", |j| {
            let latest = j.latest_version()?.map(|l| l.version);
            if latest != planned.latest {
                let show = |v: Option<i64>| v.map_or("none".to_string(), |v| format!("v{v}"));
                return Err(format!(
                    "the journal's latest version is {}, not {}, as it was a moment ago",
                    show(latest),
                    show(planned.latest)
                )
                .into());
            }
            let version = match &planned.append {
                Some(a) => {
                    let audit =
                        VersionAudit { author_kind: Some("human".into()), proposal: None, files: files.cloned() };
                    j.add_version(&a.hash, &a.source, "human", Some(&a.reason), None, &audit, a.compiled.as_deref())?
                }
                None => latest.ok_or("the journal has no version to start")?,
            };
            j.set_meta("file_hash", file_hash)?;
            Ok(version)
        })
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self.db.query_row("SELECT value FROM meta WHERE key = ?", [key], |r| r.get(0)).optional()?)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.db
            .prepare_cached(
                "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            )?
            .execute([key, value])?;
        Ok(())
    }

    /// The file hashes a version recorded (D60); None when it has none (a version from before D60) or doesn't exist.
    pub fn version_files(&self, version: i64) -> Result<Option<FileHashes>> {
        let files: Option<Option<String>> =
            self.db.query_row("SELECT files FROM versions WHERE version = ?", [version], |r| r.get(0)).optional()?;
        match files.flatten().filter(|f| !f.is_empty()) {
            Some(f) => Ok(Some(serde_json::from_str(&f)?)),
            None => Ok(None),
        }
    }

    pub fn version_source(&self, version: i64) -> Result<String> {
        self.db
            .query_row("SELECT source FROM versions WHERE version = ?", [version], |r| r.get(0))
            .optional()?
            .ok_or_else(|| format!("journal has no version {version}").into())
    }

    /// A version's compiled form (JSON); None for versions stored without one (by the TS runner) or unknown versions.
    pub fn version_compiled(&self, version: i64) -> Result<Option<String>> {
        let c: Option<Option<String>> =
            self.db.query_row("SELECT compiled FROM versions WHERE version = ?", [version], |r| r.get(0)).optional()?;
        Ok(c.flatten())
    }

    // ── packets ─────────────────────────────────────────────────────────────

    /// Insert a packet and its first event; `commit` (an input's cursor write) joins the same transaction.
    pub fn insert(
        &mut self,
        p: &NewPacket,
        event: &str,
        detail: Option<&Value>,
        commit: Option<Commit<'_>>,
    ) -> Result<()> {
        self.tx("BEGIN", |j| {
            j.db.prepare_cached(
                "INSERT INTO packets (id, version, state, cursor, data, trigger, source, error, received_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )?
            .execute(params![
                p.id,
                p.version,
                p.state,
                p.cursor,
                js_json(&p.data),
                p.trigger,
                p.source,
                js_json(&error_value(p.error.as_ref())),
                p.received_at,
                p.received_at
            ])?;
            let patch = PacketPatch {
                state: Some(p.state.clone()),
                cursor: Some(p.cursor.clone()),
                data: Some(p.data.clone()),
                ..Default::default()
            };
            j.event_raw(Some(&p.id), event, None, detail, Some(&patch), None)?;
            if let Some(commit) = commit {
                commit(j)?;
            }
            Ok(())
        })
    }

    /// Insert the branch copies of `parent` (spec §3.4, D22), each with its first event. Call it inside the
    /// transaction that commits the parent's step, so a fan-out is never partial.
    pub fn insert_copies(&mut self, parent: &PacketRow, copies: &[NewCopy], node: Option<&str>) -> Result<()> {
        let now = now_ms();
        for c in copies {
            self.db
                .prepare_cached(
                    "INSERT INTO packets (id, version, state, cursor, data, trigger, source, attempt, iteration, hops, error, received_at,
         updated_at, root, parent, branch)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, ?, ?, ?)",
                )?
                .execute(params![
                    c.id,
                    parent.version,
                    c.state,
                    c.cursor,
                    js_json(&c.data),
                    parent.trigger,
                    parent.source,
                    parent.iteration,
                    c.hops,
                    parent.received_at,
                    now,
                    parent.root.as_deref().unwrap_or(&parent.id),
                    parent.id,
                    c.branch
                ])?;
            let patch = PacketPatch {
                state: Some(c.state.clone()),
                cursor: Some(Some(c.cursor.clone())),
                data: Some(c.data.clone()),
                ..Default::default()
            };
            let detail = json!({ "parent": parent.id, "branch": c.branch });
            self.event_raw(Some(&c.id), "packet.branched", node, Some(&detail), Some(&patch), None)?;
        }
        Ok(())
    }

    fn parent_of(&self, id: &str) -> Result<Option<String>> {
        let p: Option<Option<String>> =
            self.db.query_row("SELECT parent FROM packets WHERE id = ?", [id], |r| r.get(0)).optional()?;
        Ok(p.flatten())
    }

    /// After `id` reached a terminal state: settle each ancestor whose copies are now all terminal, in the caller's
    /// transaction (D22). An ancestor is dead-lettered if any copy is, else delivered if any copy is, else filtered.
    /// Returns the settled ancestors, nearest first.
    pub fn settle_ancestors(&mut self, id: &str) -> Result<Vec<Settled>> {
        let mut settled = Vec::new();
        let mut parent = self.parent_of(id)?;
        while let Some(p) = parent {
            let copies: Vec<(String, String, Option<String>)> = self
                .db
                .prepare_cached("SELECT branch, state, error FROM packets WHERE parent = ? ORDER BY branch")?
                .query_map([&p], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<Result<_, _>>()?;
            if copies.iter().any(|(_, s, _)| !TERMINAL.contains(&s.as_str())) {
                break;
            }
            let count = |s: &str| copies.iter().filter(|c| c.1 == s).count();
            let branches = json!({
                "delivered": count("delivered"),
                "filtered": count("filtered"),
                "dead_lettered": count("dead_lettered"),
            });
            let dead: Vec<_> = copies.iter().filter(|c| c.1 == "dead_lettered").collect();
            let state = if !dead.is_empty() {
                "dead_lettered"
            } else if count("delivered") > 0 {
                "delivered"
            } else {
                "filtered"
            };
            let error = match dead.first() {
                None => None,
                Some((branch, _, err)) => {
                    let e = unjson(err.clone())?;
                    let e: Option<PacketError> = if e.is_null() { None } else { Some(serde_json::from_value(e)?) };
                    let more = if dead.len() > 1 {
                        format!(" (and {} more branch(es))", dead.len() - 1)
                    } else {
                        String::new()
                    };
                    let why = e.as_ref().map_or(String::new(), |e| format!(": {}", e.message));
                    Some(PacketError {
                        code: "branch.dead_lettered".into(),
                        message: format!("branch '{branch}' dead-lettered{why}{more}"),
                        node: e.and_then(|e| e.node).filter(|n| !n.is_empty()),
                        attempts: None,
                    })
                }
            };
            let patch = PacketPatch {
                state: Some(state.into()),
                cursor: Some(None),
                error: Some(error.clone()),
                ..Default::default()
            };
            self.update(
                &p,
                &patch,
                &format!("packet.{state}"),
                None,
                Some(&json!({ "branches": branches })),
                &[],
                None,
            )?;
            settled.push(Settled { id: p.clone(), state: state.into(), error });
            parent = self.parent_of(&p)?;
        }
        Ok(settled)
    }

    fn rows(&self, sql: &str, args: impl rusqlite::Params) -> Result<Vec<PacketRow>> {
        let mut stmt = self.db.prepare_cached(sql)?;
        let mut rows = stmt.query(args)?;
        let mut out = Vec::new();
        while let Some(r) = rows.next()? {
            out.push(decode(r)?);
        }
        Ok(out)
    }

    /// The branch copies of a packet (any depth), by branch path.
    pub fn copies(&self, packet_id: &str) -> Result<Vec<PacketRow>> {
        self.rows("SELECT * FROM packets WHERE root = ? ORDER BY branch", [packet_id])
    }

    /// Durable state for the pipeline's input (spec §14.3), usable inside an intake's `commit`.
    pub fn input_state(&mut self, scope: &str) -> InputState<'_> {
        InputState { journal: self, scope: scope.to_string() }
    }

    /// Every saved entry for `scope`, or None when nothing was saved for it yet (first start).
    pub fn input_load(&self, scope: &str) -> Result<Option<Map<String, Value>>> {
        let started =
            self.db.query_row("SELECT 1 FROM input_scopes WHERE scope = ?", [scope], |_| Ok(())).optional()?;
        if started.is_none() {
            return Ok(None);
        }
        let mut stmt = self.db.prepare_cached("SELECT key, value FROM input_state WHERE scope = ?")?;
        let mut rows = stmt.query([scope])?;
        let mut out = Map::new();
        while let Some(r) = rows.next()? {
            let value: String = r.get(1)?;
            out.insert(r.get(0)?, serde_json::from_str(&value)?);
        }
        Ok(Some(out))
    }

    /// Replace `scope`'s entries in one transaction and mark the scope as started (other scopes are dropped).
    pub fn input_baseline(&mut self, scope: &str, entries: &Map<String, Value>) -> Result<()> {
        self.tx("BEGIN", |j| {
            j.db.execute("DELETE FROM input_scopes", [])?;
            j.db.execute("INSERT INTO input_scopes (scope, created_at) VALUES (?, ?)", params![scope, now_ms()])?;
            let mut put = j.db.prepare_cached("INSERT INTO input_state (scope, key, value) VALUES (?, ?, ?)")?;
            for (k, v) in entries {
                put.execute(params![scope, k, js_json(v)])?;
            }
            Ok(())
        })
    }

    /// Upsert one entry, or delete it with None. Inside an intake `commit` it joins the packet's transaction.
    pub fn input_put(&self, scope: &str, key: &str, value: Option<&Value>) -> Result<()> {
        match value {
            None => {
                self.db.prepare_cached("DELETE FROM input_state WHERE scope = ? AND key = ?")?.execute([scope, key])?;
            }
            Some(v) => {
                self.db
                    .prepare_cached(
                        "INSERT INTO input_state (scope, key, value) VALUES (?, ?, ?) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value",
                    )?
                    .execute(params![scope, key, js_json(v)])?;
            }
        }
        Ok(())
    }

    /// Apply a patch and log an event in one transaction. `ms`, a step's duration, goes on that event when the
    /// transition completes the step (§7.6 latency, D54), so the sample commits with the transition, exactly once.
    #[allow(clippy::too_many_arguments)]
    pub fn update(
        &mut self,
        id: &str,
        patch: &PacketPatch,
        event: &str,
        node: Option<&str>,
        detail: Option<&Value>,
        extra: &[ExtraEvent],
        ms: Option<f64>,
    ) -> Result<()> {
        use rusqlite::types::Value as Sql;
        let mut sets = vec!["updated_at = ?"];
        let mut values: Vec<Sql> = vec![Sql::Integer(now_ms())];
        let text = |s: Option<String>| s.map_or(Sql::Null, Sql::Text);
        if let Some(s) = &patch.state {
            sets.push("state = ?");
            values.push(Sql::Text(s.clone()));
        }
        if let Some(c) = &patch.cursor {
            sets.push("cursor = ?");
            values.push(text(c.clone()));
        }
        if let Some(d) = &patch.data {
            sets.push("data = ?");
            values.push(Sql::Text(js_json(d)));
        }
        if let Some(h) = patch.hops {
            sets.push("hops = ?");
            values.push(Sql::Integer(h.into()));
        }
        if let Some(e) = &patch.error {
            sets.push("error = ?");
            values.push(Sql::Text(js_json(&error_value(e.as_ref()))));
        }
        if let Some(a) = patch.attempt {
            sets.push("attempt = ?");
            values.push(Sql::Integer(a.into()));
        }
        if let Some(i) = patch.iteration {
            sets.push("iteration = ?");
            values.push(Sql::Integer(i.into()));
        }
        if let Some(r) = &patch.result {
            sets.push("result = ?");
            values.push(Sql::Text(js_json(r)));
        }
        values.push(Sql::Text(id.to_string()));
        let sql = format!("UPDATE packets SET {} WHERE id = ?", sets.join(", "));
        self.tx("BEGIN", |j| {
            j.db.prepare_cached(&sql)?.execute(params_from_iter(values))?;
            for e in extra {
                j.event_raw(Some(id), &e.kind, node, e.detail.as_ref(), None, None)?;
            }
            j.event_raw(Some(id), event, node, detail, Some(patch), ms)
        })
    }

    pub fn event(&self, kind: &str, detail: Option<&Value>, packet_id: Option<&str>, node: Option<&str>) -> Result<()> {
        self.event_raw(packet_id, kind, node, detail, None, None)
    }

    fn event_raw(
        &self,
        packet_id: Option<&str>,
        kind: &str,
        node: Option<&str>,
        detail: Option<&Value>,
        patch: Option<&PacketPatch>,
        ms: Option<f64>,
    ) -> Result<()> {
        self.db
            .prepare_cached(
                "INSERT INTO events (at, packet_id, type, node, detail, patch, ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )?
            .execute(params![
                now_ms(),
                packet_id,
                kind,
                node,
                json_opt(detail),
                patch.map(|p| js_json(&p.to_value())),
                ms.map(|m| m.round().max(0.0) as i64)
            ])?;
        Ok(())
    }

    // ── agent spend (spec §3.11, D36, D37) ──────────────────────────────────

    /// Record one agent call's usage in its own transaction: an `agent.usage` event on the unit and an `agent_spend`
    /// row keyed by that event's seq. Budgets read only `agent_spend`, which a DLQ purge leaves alone. `at` is the
    /// runner's clock (budget windows use it). Returns the seq.
    pub fn record_agent_usage(&mut self, u: &AgentUsage) -> Result<i64> {
        self.tx("BEGIN", |j| {
            let detail = json!({
                "node": u.node,
                "provider": u.provider,
                "model": u.model,
                "input_tokens": u.input_tokens,
                "output_tokens": u.output_tokens,
                "cost_usd": u.cost_usd,
                "attempt": u.attempt,
            });
            j.event_raw(Some(&u.unit), "agent.usage", Some(&u.node), Some(&detail), None, None)?;
            let seq = j.last_seq()?;
            j.db.prepare_cached(
                "INSERT INTO agent_spend (seq, at, unit, root, node, provider, model, input_tokens, output_tokens, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )?
            .execute(params![
                seq,
                u.at,
                u.unit,
                u.root,
                u.node,
                u.provider,
                u.model,
                u.input_tokens as i64,
                u.output_tokens as i64,
                u.cost_usd
            ])?;
            Ok(seq)
        })
    }

    /// Tokens (input + output) a packet used across its agent nodes, loop passes and branch copies, since its latest
    /// DLQ replay (a replayed packet gets a fresh per-packet budget, D33).
    pub fn packet_agent_tokens(&self, root: &str) -> Result<i64> {
        let replayed: i64 = self.db.query_row(
            "SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE type = 'dlq.replayed' AND (packet_id = ? OR (packet_id >= ? AND packet_id < ?))",
            [root, &format!("{root}:"), &format!("{root};")],
            |r| r.get(0),
        )?;
        Ok(self.db.query_row(
            "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM agent_spend WHERE root = ? AND seq > ?",
            params![root, replayed],
            |r| r.get(0),
        )?)
    }

    /// USD spent on agent calls at or after `since` (ms, the runner's clock).
    pub fn agent_spend_since(&self, since: i64) -> Result<f64> {
        Ok(self.db.query_row(
            "SELECT COALESCE(SUM(cost_usd), 0) AS c FROM agent_spend WHERE at >= ?",
            [since],
            |r| r.get(0),
        )?)
    }

    fn timed_detail(&self, sql: &str, args: impl rusqlite::Params) -> Result<Option<TimedDetail>> {
        let e: Option<(i64, Option<String>)> =
            self.db.query_row(sql, args, |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        e.map(|(at, d)| Ok(TimedDetail { at, detail: unjson(d)? })).transpose()
    }

    /// The latest pipeline-level event of `kind` whose detail has `key` (not null), or None.
    pub fn last_pipeline_event_with(&self, kind: &str, key: &str) -> Result<Option<TimedDetail>> {
        self.timed_detail(
            "SELECT at, detail FROM events WHERE packet_id IS NULL AND type = ? AND json_extract(detail, ?) IS NOT NULL ORDER BY seq DESC LIMIT 1",
            [kind, &format!("$.{key}")],
        )
    }

    /// Detail of the latest pipeline-level event of `kind` (no packet), or None.
    pub fn last_pipeline_event(&self, kind: &str) -> Result<Option<TimedDetail>> {
        self.timed_detail(
            "SELECT at, detail FROM events WHERE packet_id IS NULL AND type = ? ORDER BY seq DESC LIMIT 1",
            [kind],
        )
    }

    // ── dead-letter queue (spec §3.9, D33) ──────────────────────────────────

    /// The units a replay of `id` puts back in flight: `id` itself when it never fanned out, else every dead-lettered
    /// copy under it that has no copies of its own (the ones that actually failed).
    pub fn dead_leaves(&self, id: &str) -> Result<Vec<PacketRow>> {
        let Some(row) = self.get(id)?.filter(|r| r.state == "dead_lettered") else { return Ok(Vec::new()) };
        let root = row.root.clone().unwrap_or_else(|| row.id.clone());
        let prefix = if row.root.is_some() { format!("{id}/") } else { format!("{id}:") };
        let units = self
            .rows("SELECT * FROM packets WHERE (root = ? OR id = ?) AND state = 'dead_lettered'", [&root, &row.id])?;
        let parents: BTreeSet<Option<String>> = self
            .db
            .prepare_cached("SELECT DISTINCT parent FROM packets WHERE root = ?")?
            .query_map([&root], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        // TS sorts with localeCompare; ids are ULIDs and branch paths, where byte order agrees except for
        // punctuation and case differences between sibling node ids.
        let mut leaves: Vec<PacketRow> = units
            .into_iter()
            .filter(|u| (u.id == id || u.id.starts_with(&prefix)) && !parents.contains(&Some(u.id.clone())))
            .collect();
        leaves.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(leaves)
    }

    /// DLQ replay (D33), in one transaction: each leaf goes back in flight at its cursor (error cleared, attempt 0,
    /// same version and data), and each dead-lettered ancestor goes back to `branched`. Every change commits its patch
    /// and a `dlq.replayed` event. Fails (rolling everything back) if any leaf is no longer dead-lettered.
    pub fn replay(&mut self, items: &[ReplayItem], by: &str) -> Result<()> {
        self.tx("BEGIN", |j| {
            for item in items {
                let mut reopened = HashSet::new();
                for leaf in &item.leaves {
                    let row = j.get(&leaf.id)?;
                    let Some(row) = row.filter(|r| r.state == "dead_lettered") else {
                        let state = j.get(&leaf.id)?.map_or("gone".to_string(), |r| r.state);
                        return Err(
                            format!("packet {} is {state}, not dead-lettered; nothing was replayed", leaf.id).into()
                        );
                    };
                    let patch = PacketPatch {
                        state: Some(leaf.state.clone()),
                        cursor: Some(Some(leaf.cursor.clone())),
                        error: Some(None),
                        attempt: Some(0),
                        iteration: leaf.iteration,
                        ..Default::default()
                    };
                    let detail = json!({ "by": by, "packet_id": item.packet_id, "error": error_value(row.error.as_ref()) });
                    j.update(&leaf.id, &patch, "dlq.replayed", Some(&leaf.cursor), Some(&detail), &[], None)?;
                    let mut parent = row.parent.clone();
                    while let Some(pid) = parent {
                        let Some(p) = j.get(&pid)? else { break };
                        if p.state == "dead_lettered" && reopened.insert(p.id.clone()) {
                            let patch = PacketPatch {
                                state: Some(BRANCHED.into()),
                                cursor: Some(None),
                                error: Some(None),
                                ..Default::default()
                            };
                            let detail =
                                json!({ "by": by, "packet_id": item.packet_id, "error": error_value(p.error.as_ref()) });
                            j.update(&p.id, &patch, "dlq.replayed", None, Some(&detail), &[], None)?;
                        }
                        parent = p.parent;
                    }
                }
            }
            Ok(())
        })
    }

    /// DLQ purge (D33), in one transaction: removes each dead-lettered packet, its branch copies and their events, and
    /// records one `dlq.purged` event per packet with what it was (version, error, when). Nothing else is touched.
    pub fn purge(&mut self, ids: &[String], by: &str) -> Result<()> {
        self.tx("BEGIN", |j| {
            for id in ids {
                let row = j.get(id)?;
                let Some(row) = row.filter(|r| r.state == "dead_lettered" && r.branch.is_empty()) else {
                    let state = j.get(id)?.map_or("gone".to_string(), |r| r.state);
                    return Err(format!("packet {id} is {state}, not dead-lettered; nothing was purged").into());
                };
                let mut units = vec![id.clone()];
                units.extend(j.copies(id)?.into_iter().map(|c| c.id));
                let mut events = 0;
                for u in &units {
                    events += j.db.prepare_cached("DELETE FROM events WHERE packet_id = ?")?.execute([u])?;
                    j.db.prepare_cached("DELETE FROM packets WHERE id = ?")?.execute([u])?;
                }
                let detail = json!({
                    "by": by,
                    "version": row.version,
                    "received_at": row.received_at,
                    "error": error_value(row.error.as_ref()),
                    "copies": units.len() - 1,
                    "events": events,
                });
                let node = row.error.as_ref().and_then(|e| e.node.as_deref());
                j.event_raw(Some(id), "dlq.purged", node, Some(&detail), None, None)?;
            }
            Ok(())
        })
    }

    // ── reads ───────────────────────────────────────────────────────────────

    pub fn get(&self, id: &str) -> Result<Option<PacketRow>> {
        Ok(self.rows("SELECT * FROM packets WHERE id = ?", [id])?.into_iter().next())
    }

    pub fn in_flight(&self) -> Result<Vec<PacketRow>> {
        self.rows(&format!("SELECT * FROM packets WHERE state IN ({}) ORDER BY id", marks(IN_FLIGHT.len())), IN_FLIGHT)
    }

    fn count(&self, sql: &str, args: impl rusqlite::Params) -> Result<i64> {
        Ok(self.db.prepare_cached(sql)?.query_row(args, |r| r.get(0))?)
    }

    /// Packets (not copies) that are not terminal yet: in flight, waiting on their copies (D22) or an agent (D50).
    pub fn count_in_flight(&self) -> Result<i64> {
        self.count(
            &format!("SELECT COUNT(*) AS n FROM packets WHERE branch = '' AND state IN ({})", marks(PENDING.len())),
            PENDING,
        )
    }

    /// Units (packets and copies) the runner itself is moving: in flight, not waiting for an agent (D50).
    pub fn count_moving(&self) -> Result<i64> {
        self.count(&format!("SELECT COUNT(*) AS n FROM packets WHERE state IN ({})", marks(IN_FLIGHT.len())), IN_FLIGHT)
    }

    /// Packets with at least one unit (the packet or a copy) waiting for an agent (D50).
    pub fn count_escalated(&self) -> Result<i64> {
        self.count("SELECT COUNT(DISTINCT COALESCE(root, id)) AS n FROM packets WHERE state = ?", [ESCALATED])
    }

    /// Packets by state. Branch copies are not packets of their own (D22), so they are not counted.
    pub fn counts(&self) -> Result<BTreeMap<String, i64>> {
        let mut stmt =
            self.db.prepare_cached("SELECT state, COUNT(*) AS n FROM packets WHERE branch = '' GROUP BY state")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// Packets accepted (not rejected) since `since` (ms); an indexed range read on received_at (D21).
    pub fn accepted_since(&self, since: i64) -> Result<i64> {
        self.count(
            "SELECT COUNT(*) AS n FROM packets WHERE received_at >= ? AND branch = '' AND state != 'rejected'",
            [since],
        )
    }

    /// When the latest packet was delivered (ms), or None.
    pub fn last_delivered_at(&self) -> Result<Option<i64>> {
        Ok(self.db.query_row(
            "SELECT MAX(updated_at) AS at FROM packets WHERE state = 'delivered' AND branch = ''",
            [],
            |r| r.get(0),
        )?)
    }

    /// When the oldest packet not yet terminal was received (ms), or None. Copies share their packet's
    /// `received_at`, so packets suffice.
    pub fn oldest_pending_received_at(&self) -> Result<Option<i64>> {
        let sql = format!(
            "SELECT MIN(received_at) AS at FROM packets WHERE branch = '' AND state IN ({})",
            marks(PENDING.len())
        );
        Ok(self.db.prepare_cached(&sql)?.query_row(PENDING, |r| r.get(0))?)
    }

    /// The durations (ms) of the latest `limit` completed steps at `node`, newest first (§7.6 latency, D54).
    pub fn step_durations(&self, node: &str, limit: i64) -> Result<Vec<i64>> {
        let mut stmt = self
            .db
            .prepare_cached("SELECT ms FROM events WHERE node = ? AND ms IS NOT NULL ORDER BY seq DESC LIMIT ?")?;
        let out = stmt.query_map(params![node, limit], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok(out)
    }

    /// The oldest unit still in flight (stall context, §3.10) and its latest error, from the row or its last retry
    /// event.
    pub fn oldest_pending(&self) -> Result<Option<OldestPending>> {
        let sql = format!(
            "SELECT * FROM packets WHERE state IN ({}) ORDER BY received_at, id LIMIT 1",
            marks(IN_FLIGHT.len())
        );
        let Some(row) = self.rows(&sql, IN_FLIGHT)?.into_iter().next() else { return Ok(None) };
        let mut last_error = row.error.as_ref().map(|e| e.message.clone()).filter(|m| !m.is_empty());
        if last_error.is_none() {
            let d: Option<Option<String>> = self
                .db
                .query_row(
                    "SELECT detail FROM events WHERE packet_id = ? AND type = 'step.retry' ORDER BY seq DESC LIMIT 1",
                    [&row.id],
                    |r| r.get(0),
                )
                .optional()?;
            let d = unjson(d.flatten())?;
            last_error = d.get("error").and_then(Value::as_str).map(str::to_string);
        }
        Ok(Some(OldestPending { row, last_error }))
    }

    pub fn events(&self, packet_id: &str) -> Result<Vec<PacketEvent>> {
        let mut stmt =
            self.db.prepare_cached("SELECT type, node, at, detail FROM events WHERE packet_id = ? ORDER BY seq")?;
        let raw: Vec<(String, Option<String>, i64, Option<String>)> = stmt
            .query_map([packet_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<Result<_, _>>()?;
        raw.into_iter().map(|(kind, node, at, d)| Ok(PacketEvent { kind, node, at, detail: unjson(d)? })).collect()
    }

    /// Events with `seq` greater than `after`, oldest first: what a reattaching engine missed (spec §7.2).
    pub fn events_after(&self, after: i64, limit: i64) -> Result<Vec<JournalEvent>> {
        let mut stmt = self.db.prepare_cached(
            "SELECT seq, at, packet_id, type, node, detail FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
        )?;
        #[allow(clippy::type_complexity)]
        let raw: Vec<(i64, i64, Option<String>, String, Option<String>, Option<String>)> = stmt
            .query_map([after, limit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
            .collect::<Result<_, _>>()?;
        raw.into_iter()
            .map(|(seq, at, packet_id, kind, node, d)| {
                Ok(JournalEvent { seq, at, packet_id, kind, node, detail: unjson(d)? })
            })
            .collect()
    }

    pub fn last_seq(&self) -> Result<i64> {
        self.count("SELECT COALESCE(MAX(seq), 0) AS n FROM events", [])
    }

    /// The packet's most recent event among `kinds`, if any.
    pub fn latest_event(&self, packet_id: &str, kinds: &[&str]) -> Result<Option<LatestEvent>> {
        let sql = format!(
            "SELECT type, at, detail FROM events WHERE packet_id = ? AND type IN ({}) ORDER BY seq DESC LIMIT 1",
            marks(kinds.len())
        );
        let args = std::iter::once(packet_id).chain(kinds.iter().copied());
        let e: Option<(String, i64, Option<String>)> = self
            .db
            .prepare_cached(&sql)?
            .query_row(params_from_iter(args), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()?;
        e.map(|(kind, at, d)| Ok(LatestEvent { kind, at, detail: unjson(d)? })).transpose()
    }
}

/// Journal-backed state for one input scope (e.g. a watch input's resolved glob), borrowed from the journal so it
/// can be used inside an intake's `commit`.
pub struct InputState<'a> {
    journal: &'a mut Journal,
    scope: String,
}

impl InputState<'_> {
    /// Every saved entry, or None when nothing was saved for this scope yet (first start).
    pub fn load(&self) -> Result<Option<Map<String, Value>>> {
        self.journal.input_load(&self.scope)
    }

    /// Replace the scope's entries in one transaction and mark the scope as started.
    pub fn baseline(&mut self, entries: &Map<String, Value>) -> Result<()> {
        self.journal.input_baseline(&self.scope, entries)
    }

    /// Upsert one entry, or delete it with None. Inside an intake `commit` it joins the packet's transaction.
    pub fn put(&self, key: &str, value: Option<&Value>) -> Result<()> {
        self.journal.input_put(&self.scope, key, value)
    }
}

impl From<Error> for String {
    fn from(e: Error) -> String {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_json_matches_json_stringify() {
        let v: Value = serde_json::from_str(r#"{"b":1.0,"a":[2.5,-0.0,3],"c":{"z":null,"y":"é\n"}}"#).unwrap();
        assert_eq!(js_json(&v), r#"{"b":1,"a":[2.5,0,3],"c":{"z":null,"y":"é\n"}}"#);
    }

    #[test]
    fn unique_word() {
        assert!(has_unique("CREATE TABLE v (hash TEXT NOT NULL UNIQUE, x)"));
        assert!(has_unique("hash text unique)"));
        assert!(!has_unique("CREATE TABLE v (uniques TEXT, not_unique TEXT)"));
    }

    #[test]
    fn retry_busy_backs_off_then_gives_up() {
        let busy = || Error::Sqlite(rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(261), None));
        let mut calls = 0;
        let mut slept = vec![];
        let out = retry_busy_with(
            || {
                calls += 1;
                if calls < 3 { Err(busy()) } else { Ok(calls) }
            },
            5000,
            |n| slept.push(n),
        );
        assert_eq!(out.unwrap(), 3);
        assert_eq!(slept, vec![25, 50]);

        let mut slept = vec![];
        let err = retry_busy_with(|| -> Result<()> { Err(busy()) }, 100, |n| slept.push(n)).unwrap_err();
        assert_eq!(busy_code(&err), Some("SQLITE_BUSY_RECOVERY"));
        assert_eq!(slept, vec![25, 50]);
        assert_eq!(
            locked(Path::new("/x/journal.db"), &err, 5000, "using it").to_string(),
            "the journal /x/journal.db stayed locked by another process (SQLITE_BUSY_RECOVERY) for 5s; is another pipo process using it? Try again; if it persists, stop the processes that use it"
        );

        let mut calls = 0;
        let err = retry_busy_with(
            || -> Result<()> {
                calls += 1;
                Err("not busy".into())
            },
            5000,
            |_| {},
        )
        .unwrap_err();
        assert!(!is_busy(&err));
        assert_eq!(calls, 1);
    }

    fn temp_journal_path(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("pipo-journal-{name}-{}", crate::ids::ulid().to_lowercase()));
        std::fs::create_dir_all(&dir).unwrap();
        (dir.join("journal.db"), dir)
    }

    #[test]
    fn a_journal_from_before_fan_out_gains_the_branch_columns_and_keeps_its_packets() {
        let (path, dir) = temp_journal_path("fanout");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            r#"CREATE TABLE versions (version INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
              author TEXT NOT NULL DEFAULT 'human', created_at INTEGER NOT NULL);
            CREATE TABLE packets (id TEXT PRIMARY KEY, version INTEGER NOT NULL REFERENCES versions(version), state TEXT NOT NULL,
              cursor TEXT, data TEXT, trigger TEXT NOT NULL, source TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
              iteration INTEGER NOT NULL DEFAULT 0, hops INTEGER NOT NULL DEFAULT 0, error TEXT, result TEXT,
              received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
            INSERT INTO versions VALUES (1, 'h', 'src', 'human', 0);
            INSERT INTO packets (id, version, state, cursor, data, trigger, source, received_at, updated_at)
              VALUES ('P1', 1, 'processing', 'n', '{"n":1}', 'http', 'x', 0, 0), ('P2', 1, 'delivered', NULL, '{}', 'http', 'x', 0, 0);"#,
        )
        .unwrap();
        drop(db);
        let j = Journal::open(&path).unwrap();
        let p1 = j.get("P1").unwrap().unwrap();
        assert_eq!((p1.state.as_str(), p1.cursor.as_deref(), p1.branch.as_str()), ("processing", Some("n"), ""));
        assert_eq!((p1.root.as_deref(), p1.parent.as_deref()), (None, None));
        assert_eq!(j.in_flight().unwrap().iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["P1"]);
        let counts = j.counts().unwrap();
        assert_eq!((counts.get("processing"), counts.get("delivered")), (Some(&1), Some(&1)));
        assert_eq!(j.count_in_flight().unwrap(), 1);
        j.close().unwrap();
        // Opening again is a no-op.
        Journal::open(&path).unwrap().close().unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_journal_from_before_latency_gets_the_ms_column_and_index_keeping_its_events() {
        let (path, dir) = temp_journal_path("ms");
        Journal::open(&path).unwrap().close().unwrap();
        let raw = Connection::open(&path).unwrap();
        raw.execute_batch(
            "DROP INDEX events_node_ms; ALTER TABLE events DROP COLUMN ms;
             INSERT INTO events (at, packet_id, type, node, detail, patch) VALUES (1, NULL, 'old.event', 'a', NULL, NULL);",
        )
        .unwrap();
        drop(raw);
        let j = Journal::open(&path).unwrap();
        assert!(j.columns("events").unwrap().contains("ms"));
        let index: Option<String> = j
            .db()
            .query_row("SELECT name FROM sqlite_master WHERE name = 'events_node_ms'", [], |r| r.get(0))
            .optional()
            .unwrap();
        assert!(index.is_some());
        let (kind, ms): (String, Option<i64>) =
            j.db().query_row("SELECT type, ms FROM events", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((kind.as_str(), ms), ("old.event", None));
        assert!(j.step_durations("a", 10).unwrap().is_empty());
        j.close().unwrap();
        Journal::open(&path).unwrap().close().unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn journal_is_send() {
        fn send<T: Send>() {}
        send::<Journal>();
    }
}
