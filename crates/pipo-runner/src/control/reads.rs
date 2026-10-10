// Packet reads for `pipo packets`, `pipo inspect` and `pipo dlq` (docs/spec.md §6, §8, D33), plus the version and
// proposal reads, behind one dispatch. Port of control/reads.ts: a page of packets, one packet's trace through every
// node (data, timings, attempts, errors) and the dead-letter queue. The runner answers them over its control socket;
// with no runner, `pipo-runner read` answers them from the journal read-only through `offline_read`, which redacts
// with the secrets it can resolve and withholds payloads when it can't (D34).

use super::ControlError;
use super::versions::{diff_versions, get_version, list_versions, version_arg};
use crate::journal::{BRANCHED, ESCALATED, IN_FLIGHT, TERMINAL};
use crate::proposals::{PROPOSAL_STATES, read_get, read_list};
use crate::secrets::Secrets;
use rusqlite::{Connection, OptionalExtension, params_from_iter};
use serde_json::{Map, Value, json};
use std::path::Path;

pub const READ_OPS: &[&str] = &["packets", "packet", "dlq", "versions", "version", "diff", "proposals", "proposal"];
pub const DEFAULT_LIMIT: i64 = 50;
pub const MAX_LIMIT: i64 = 1000;

/// Every state a packet can be in: in flight, terminal, branched, escalated.
pub fn packet_states() -> Vec<&'static str> {
    IN_FLIGHT.iter().chain(TERMINAL.iter()).copied().chain([BRANCHED, ESCALATED]).collect()
}

/// Transition events in journals written before patches were recorded (D33).
const LEGACY_TRANSITIONS: &[&str] = &[
    "packet.accepted",
    "packet.rejected",
    "packet.branched",
    "node.done",
    "node.looped",
    "node.failed_continued",
    "packet.filtered",
    "packet.dropped",
    "packet.dead_lettered",
    "packet.delivered",
    "output.batched",
    "output.written",
    "packet.fanned_out",
];

fn internal(e: impl ToString) -> ControlError {
    ControlError::new("internal", e.to_string(), "see the runner log")
}

fn unjson(text: Option<String>) -> rusqlite::Result<Value> {
    match text {
        None => Ok(Value::Null),
        Some(t) => serde_json::from_str(&t)
            .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))),
    }
}

/// JavaScript truthiness of a parsed JSON value.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `Number(v)` in JavaScript, for the values a JSON argument can hold.
fn js_to_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => string_to_number(s),
        Value::Array(a) if a.is_empty() => 0.0,
        Value::Array(a) if a.len() == 1 && !a[0].is_array() && !a[0].is_object() => match &a[0] {
            Value::Null => 0.0,
            Value::Bool(_) => f64::NAN,
            x => js_to_number(x),
        },
        _ => f64::NAN,
    }
}

fn string_to_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).map_or(f64::NAN, |n| n as f64);
        }
    }
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    if body == "Infinity" {
        return if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    if !body.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-')) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

fn is_whole(f: f64) -> bool {
    f.is_finite() && f.fract() == 0.0
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

// ── argument parsing (shared by the runner ops and the offline reads) ────────

fn limit_arg(raw: Option<&Value>) -> Result<i64, ControlError> {
    let n = match raw {
        None | Some(Value::Null) => return Ok(DEFAULT_LIMIT),
        Some(Value::String(s)) if !s.trim().is_empty() => Some(string_to_number(s)),
        Some(Value::Number(n)) => n.as_f64(),
        Some(_) => None,
    };
    match n {
        Some(n) if is_whole(n) && (1.0..=MAX_LIMIT as f64).contains(&n) => Ok(n as i64),
        _ => Err(ControlError::new(
            "bad_request",
            format!("`limit` must be a whole number from 1 to {MAX_LIMIT}"),
            "page with `after`",
        )),
    }
}

fn after_arg(raw: Option<&Value>) -> Result<Option<String>, ControlError> {
    match raw {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(Value::String(s)) if js_len(s) <= 200 => Ok(Some(s.clone())),
        _ => Err(ControlError::new(
            "bad_request",
            "`after` must be a packet id",
            "use the `next` value of the previous page",
        )),
    }
}

pub fn state_arg(raw: Option<&Value>) -> Result<Option<String>, ControlError> {
    let states = packet_states();
    match raw {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(Value::String(s)) if states.contains(&s.as_str()) => Ok(Some(s.clone())),
        Some(other) => Err(ControlError::new(
            "bad_request",
            format!("unknown packet state {}", crate::expr::js_json(other)),
            format!("use one of {}", states.join(", ")),
        )),
    }
}

pub fn packet_id_arg(raw: Option<&Value>, op: &str) -> Result<String, ControlError> {
    match raw {
        Some(Value::String(s)) if !s.is_empty() && js_len(s) <= 400 => Ok(s.clone()),
        _ => Err(ControlError::new(
            "bad_request",
            format!("{op} needs `packet_id`"),
            format!(r#"{{"op":"{op}","args":{{"packet_id":"01J…"}}}}"#),
        )),
    }
}

// ── queries ──────────────────────────────────────────────────────────────────

/// The `packets` columns a summary and a trace read.
struct PacketCols {
    id: String,
    version: i64,
    state: String,
    cursor: Option<String>,
    trigger: String,
    source: String,
    attempt: i64,
    error: Value,
    received_at: i64,
    updated_at: i64,
}

impl PacketCols {
    fn read(r: &rusqlite::Row) -> rusqlite::Result<PacketCols> {
        Ok(PacketCols {
            id: r.get("id")?,
            version: r.get("version")?,
            state: r.get("state")?,
            cursor: r.get("cursor")?,
            trigger: r.get("trigger")?,
            source: r.get("source")?,
            attempt: r.get("attempt")?,
            error: unjson(r.get("error")?)?,
            received_at: r.get("received_at")?,
            updated_at: r.get("updated_at")?,
        })
    }

    fn in_flight(&self) -> bool {
        IN_FLIGHT.contains(&self.state.as_str())
    }

    /// A packet's summary in TS key order: where it is (in flight) or where it failed; `copies` its branch copies.
    fn summary(&self, copies: i64) -> Map<String, Value> {
        let node = if self.in_flight() {
            json!(self.cursor)
        } else {
            self.error.get("node").filter(|n| !n.is_null()).cloned().unwrap_or(Value::Null)
        };
        let mut m = Map::new();
        m.insert("packet_id".into(), json!(self.id));
        m.insert("state".into(), json!(self.state));
        m.insert("node".into(), node);
        m.insert("version".into(), json!(self.version));
        m.insert("trigger".into(), json!(self.trigger));
        m.insert("source".into(), json!(self.source));
        m.insert("attempt".into(), json!(self.attempt));
        m.insert("error".into(), self.error.clone());
        m.insert("copies".into(), json!(copies));
        m.insert("received_at".into(), json!(self.received_at));
        m.insert("updated_at".into(), json!(self.updated_at));
        m
    }
}

/// One page of packets (not branch copies, D22), newest first, optionally in one state. `escalated` lists units,
/// copies included: each waits for an agent on its own and is resolved by its own id (D50).
pub fn list_packets(db: &Connection, args: &Map<String, Value>) -> Result<Value, ControlError> {
    let state = state_arg(args.get("state"))?;
    let limit = limit_arg(args.get("limit"))?;
    let after = after_arg(args.get("after"))?;
    let mut clauses: Vec<&str> = if state.as_deref() == Some(ESCALATED) { vec![] } else { vec!["p.branch = ''"] };
    let mut params: Vec<rusqlite::types::Value> = vec![];
    if let Some(s) = &state {
        clauses.push("p.state = ?");
        params.push(s.clone().into());
    }
    // Never empty in practice: `escalated` drops the branch condition but adds the state one.
    let cond = |c: &[&str]| if c.is_empty() { "1".to_string() } else { c.join(" AND ") };
    let total: i64 = db
        .query_row(
            &format!("SELECT COUNT(*) FROM packets p WHERE {}", cond(&clauses)),
            params_from_iter(params.iter()),
            |r| r.get(0),
        )
        .map_err(internal)?;
    if let Some(a) = &after {
        clauses.push("p.id < ?");
        params.push(a.clone().into());
    }
    params.push((limit + 1).into());
    let sql = format!(
        "SELECT p.*, (SELECT COUNT(*) FROM packets c WHERE c.root = p.id) AS n_copies FROM packets p
         WHERE {} ORDER BY p.id DESC LIMIT ?",
        cond(&clauses)
    );
    let mut stmt = db.prepare(&sql).map_err(internal)?;
    let rows: Vec<(PacketCols, i64)> = stmt
        .query_map(params_from_iter(params.iter()), |r| Ok((PacketCols::read(r)?, r.get("n_copies")?)))
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;
    let more = rows.len() as i64 > limit;
    let page: Vec<Value> = rows.iter().take(limit as usize).map(|(p, n)| Value::Object(p.summary(*n))).collect();
    let next = if more { page.last().map(|p| p["packet_id"].clone()).unwrap_or(Value::Null) } else { Value::Null };
    Ok(json!({ "packets": page, "total": total, "next": next }))
}

/// The dead-letter queue: dead-lettered packets, newest first.
pub fn list_dlq(db: &Connection, args: &Map<String, Value>) -> Result<Value, ControlError> {
    let mut args = args.clone();
    args.insert("state".into(), json!("dead_lettered"));
    list_packets(db, &args)
}

struct RawEvent {
    seq: i64,
    at: i64,
    kind: String,
    node: Option<String>,
    detail: Value,
    patch: Value,
}

impl RawEvent {
    fn view(&self) -> Value {
        json!({ "seq": self.seq, "at": self.at, "type": self.kind, "node": self.node, "detail": self.detail })
    }
}

fn has_patch_column(db: &Connection) -> Result<bool, ControlError> {
    let mut stmt = db.prepare("PRAGMA table_info(events)").map_err(internal)?;
    let names: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>("name"))
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;
    Ok(names.iter().any(|n| n == "patch"))
}

fn events_of(db: &Connection, id: &str, patches: bool) -> Result<Vec<RawEvent>, ControlError> {
    let sql = format!(
        "SELECT seq, at, type, node, detail, {} FROM events WHERE packet_id = ? ORDER BY seq",
        if patches { "patch" } else { "NULL AS patch" }
    );
    let mut stmt = db.prepare(&sql).map_err(internal)?;
    let rows = stmt
        .query_map([id], |r| {
            Ok(RawEvent {
                seq: r.get(0)?,
                at: r.get(1)?,
                kind: r.get(2)?,
                node: r.get(3)?,
                detail: unjson(r.get(4)?)?,
                patch: unjson(r.get(5)?)?,
            })
        })
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;
    Ok(rows)
}

/// One packet's trace (spec §8): the packet, then every step it took with the data after it, when it ran, how long it
/// took, its attempts and errors, then its branch copies' traces. A copy id (`<packet_id>:<branch>`) traces that copy.
/// None when the journal has never seen the id.
pub fn packet_trace(db: &Connection, id: &str) -> Result<Option<Value>, ControlError> {
    let patches = has_patch_column(db)?;
    let row = db.query_row("SELECT * FROM packets WHERE id = ?", [id], trace_row).optional().map_err(internal)?;
    if let Some(row) = row {
        return unit_trace(db, row, patches).map(Some);
    }
    let events = events_of(db, id, patches)?;
    let Some(purged) = events.iter().rev().find(|e| e.kind == "dlq.purged") else { return Ok(None) };
    Ok(Some(json!({
        "packet": null,
        "steps": [],
        "pending": null,
        "events": events.iter().map(RawEvent::view).collect::<Vec<_>>(),
        "copies": [],
        "purged": { "at": purged.at, "detail": purged.detail },
    })))
}

type TraceRow = (PacketCols, Option<String>, String, Value, Value);

fn trace_row(r: &rusqlite::Row) -> rusqlite::Result<TraceRow> {
    Ok((PacketCols::read(r)?, r.get("root")?, r.get("branch")?, unjson(r.get("data")?)?, unjson(r.get("result")?)?))
}

fn unit_trace(
    db: &Connection,
    (p, root, branch, data, result): TraceRow,
    patches: bool,
) -> Result<Value, ControlError> {
    let events = events_of(db, &p.id, patches)?;
    let (steps, retries, notes) = build_steps(&events);
    let copies: i64 =
        db.query_row("SELECT COUNT(*) FROM packets WHERE parent = ?", [&p.id], |r| r.get(0)).map_err(internal)?;
    let mut packet = p.summary(0);
    packet.insert("copies".into(), json!(copies));
    packet.insert("root".into(), json!(root));
    packet.insert("branch".into(), json!(branch));
    packet.insert("data".into(), data);
    packet.insert("result".into(), result);
    let pending = if p.in_flight() {
        let since = steps.last().map_or(json!(p.received_at), |s| s["at"].clone());
        json!({ "node": packet["node"], "since": since, "retries": retries, "notes": notes })
    } else {
        Value::Null
    };
    let mut stmt = db.prepare("SELECT * FROM packets WHERE parent = ? ORDER BY branch").map_err(internal)?;
    let children: Vec<TraceRow> =
        stmt.query_map([&p.id], trace_row).map_err(internal)?.collect::<Result<_, _>>().map_err(internal)?;
    let copies = children.into_iter().map(|c| unit_trace(db, c, patches)).collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "packet": packet,
        "steps": steps,
        "pending": pending,
        "events": events.iter().map(RawEvent::view).collect::<Vec<_>>(),
        "copies": copies,
    }))
}

fn looks_like_error(v: &Value) -> bool {
    v.get("code").is_some_and(Value::is_string) && v.get("message").is_some_and(Value::is_string)
}

/// A field of `v` unless it is absent or null (`v?.key ?? fallback`).
fn field<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.get(key).filter(|x| !x.is_null())
}

/// The steps, then the retries and notes of the step still in progress.
fn build_steps(events: &[RawEvent]) -> (Vec<Value>, Vec<Value>, Vec<Value>) {
    let legacy = !events.iter().any(|e| truthy(&e.patch));
    let mut steps: Vec<Value> = vec![];
    let mut retries: Vec<Value> = vec![];
    let mut notes: Vec<Value> = vec![];
    let mut data = Value::Null;
    let mut known = false;
    let mut prev_at: Option<i64> = None;
    for (i, e) in events.iter().enumerate() {
        let next = events.get(i + 1);
        let transition = if legacy {
            LEGACY_TRANSITIONS.contains(&e.kind.as_str())
                // Before D33 a fan-out logged the step's own event just before packet.fanned_out.
                && !(e.kind == "node.done" && next.is_some_and(|n| n.kind == "packet.fanned_out" && n.node == e.node))
        } else {
            truthy(&e.patch) && e.patch.as_object().is_some_and(|p| p.contains_key("state") || p.contains_key("cursor"))
        };
        if !transition {
            if e.kind == "step.retry" {
                let attempt = field(&e.detail, "attempt").cloned().unwrap_or(json!(retries.len() + 1));
                retries.push(json!({
                    "attempt": attempt,
                    "at": e.at,
                    "wait_ms": field(&e.detail, "wait").cloned().unwrap_or(Value::Null),
                    "error": field(&e.detail, "error").cloned().unwrap_or(Value::Null),
                }));
            } else {
                notes.push(json!({ "type": e.kind, "at": e.at, "detail": e.detail }));
            }
            continue;
        }
        let empty = Map::new();
        let patch = e.patch.as_object().unwrap_or(&empty);
        let mut changed = false;
        if let Some(d) = patch.get("data") {
            changed = !known || serde_json::to_string(d).ok() != serde_json::to_string(&data).ok();
            data = d.clone();
            known = true;
        }
        let error = match patch.get("error") {
            Some(err) => err.clone(),
            None if looks_like_error(&e.detail) => e.detail.clone(),
            None => Value::Null,
        };
        let started = prev_at.unwrap_or(e.at);
        let first = steps.is_empty();
        let attempts = match field(&error, "attempts") {
            Some(a) => a.clone(),
            None if !retries.is_empty() => {
                let last = retries.last().and_then(|r| field(r, "attempt")).map_or(0.0, js_to_number);
                crate::expr::js_number(last + 1.0)
            }
            None => json!(1),
        };
        let node = match &e.node {
            Some(n) => json!(n),
            None if first && e.kind != "packet.branched" => json!("input"),
            None => Value::Null,
        };
        let state =
            patch.get("state").filter(|s| !s.is_null()).cloned().unwrap_or_else(|| json!(legacy_state(&e.kind)));
        let mut step = Map::new();
        step.insert("node".into(), node);
        step.insert("event".into(), json!(e.kind));
        step.insert("state".into(), state);
        step.insert("started_at".into(), json!(started));
        step.insert("at".into(), json!(e.at));
        step.insert("duration_ms".into(), json!(e.at - started));
        step.insert("attempts".into(), attempts);
        step.insert("retries".into(), Value::Array(std::mem::take(&mut retries)));
        step.insert("error".into(), error);
        if known {
            step.insert("data".into(), data.clone());
        }
        step.insert("changed".into(), json!(changed));
        step.insert("notes".into(), Value::Array(std::mem::take(&mut notes)));
        steps.push(Value::Object(step));
        prev_at = Some(e.at);
    }
    (steps, retries, notes)
}

fn legacy_state(kind: &str) -> Option<&'static str> {
    match kind {
        "packet.accepted" => Some("accepted"),
        "packet.rejected" => Some("rejected"),
        "packet.filtered" | "packet.dropped" => Some("filtered"),
        "packet.dead_lettered" => Some("dead_lettered"),
        "packet.delivered" => Some("delivered"),
        "packet.fanned_out" => Some(BRANCHED),
        _ => None,
    }
}

// ── shared dispatch and offline reads ────────────────────────────────────────

/// Answer a read op against a journal database (the runner's own, or a read-only one). `current` is the version a
/// running runner gives new packets (D38); None when reading the journal alone.
pub fn read(
    db: &Connection,
    op: &str,
    args: &Map<String, Value>,
    pipeline: &str,
    current: Option<i64>,
) -> Result<Value, ControlError> {
    match op {
        "packets" => list_packets(db, args),
        "dlq" => list_dlq(db, args),
        "versions" => list_versions(db, current),
        "version" => get_version(db, version_arg(args.get("version"), "version")?, pipeline),
        "diff" => {
            diff_versions(db, version_arg(args.get("from"), "from")?, version_arg(args.get("to"), "to")?, pipeline)
        }
        "proposals" => list_proposals(db, args),
        "proposal" => get_proposal(db, args.get("id"), pipeline),
        "packet" => {
            let id = packet_id_arg(args.get("packet_id"), "packet")?;
            packet_trace(db, &id)?.ok_or_else(|| {
                ControlError::new(
                    "not_found",
                    format!("no packet '{id}' in {pipeline}"),
                    format!("list packets with pipo packets {pipeline}; a fan-out copy's id is <packet_id>:<branch>"),
                )
            })
        }
        _ => Err(ControlError::new(
            "unknown_op",
            format!("'{op}' is not a read op"),
            format!("use one of {}", READ_OPS.join(", ")),
        )),
    }
}

/// Change proposals, newest first (§9.3, D45); an older journal without the table has none.
fn list_proposals(db: &Connection, args: &Map<String, Value>) -> Result<Value, ControlError> {
    let state = match args.get("state") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if PROPOSAL_STATES.contains(&s.as_str()) => Some(s.as_str()),
        Some(other) => {
            return Err(ControlError::new(
                "bad_request",
                format!("`state` must be one of {}, got {}", PROPOSAL_STATES.join(", "), crate::expr::js_json(other)),
                "omit state to list every proposal",
            ));
        }
    };
    let limit = match args.get("limit") {
        None | Some(Value::Null) => None,
        Some(v) => {
            let n = js_to_number(v);
            if !is_whole(n) || n < 1.0 || n > MAX_LIMIT as f64 {
                return Err(ControlError::new(
                    "bad_request",
                    format!("`limit` must be a whole number from 1 to {MAX_LIMIT}"),
                    "omit it for 50",
                ));
            }
            Some(n as i64)
        }
    };
    let list = read_list(db, state, limit).map_err(internal)?;
    Ok(json!({ "proposals": list }))
}

fn get_proposal(db: &Connection, id: Option<&Value>, pipeline: &str) -> Result<Value, ControlError> {
    let id = id.and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| {
        ControlError::new(
            "bad_request",
            "proposal needs `id`: the proposal's id",
            format!("pipo proposals {pipeline} lists them"),
        )
    })?;
    let p = read_get(db, id).map_err(internal)?.ok_or_else(|| {
        ControlError::new(
            "not_found",
            format!("{pipeline} has no proposal {id}"),
            format!("list them with pipo proposals {pipeline}"),
        )
    })?;
    Ok(p.to_value())
}

/// Remove payloads (packet data and result, the data after each step) from a read result, recursively.
pub fn withhold_payloads(value: &Value, reason: &str) -> Value {
    match value {
        Value::Array(a) => Value::Array(a.iter().map(|v| withhold_payloads(v, reason)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| {
                    let v = if k == "data" || k == "result" {
                        Value::String(format!("[withheld: {reason}]"))
                    } else {
                        withhold_payloads(v, reason)
                    };
                    (k.clone(), v)
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// The secrets a version declares, from its stored compiled form; None when they can't be known here (no compiled
/// form, from a runner before the Rust port, and a source that mentions secrets).
fn declared_secrets(compiled: Option<&str>, source: &str) -> Option<Map<String, Value>> {
    if let Some(text) = compiled {
        let c: Value = serde_json::from_str(text).ok()?;
        let p = c.get("pipeline").filter(|p| p.is_object())?;
        return Some(p.get("secrets").and_then(Value::as_object).cloned().unwrap_or_default());
    }
    // With no YAML parser here, a source that never says `secrets` (and has no escapes that could spell it) has none.
    if !source.contains("secrets") && !source.contains('\\') { Some(Map::new()) } else { None }
}

/// Redaction for reading a journal without its runner (D34): the secrets every stored version declares, resolved
/// from `env:` only (no `op` prompt from a read). When any can't be resolved here, payloads are withheld, since the
/// values they might contain can't be masked; errors and events were already redacted by the runner when written.
pub fn offline_redaction(db: &Connection) -> Result<(Secrets, Option<String>), ControlError> {
    let mut stmt = db.prepare("PRAGMA table_info(versions)").map_err(internal)?;
    let has_compiled = stmt
        .query_map([], |r| r.get::<_, String>("name"))
        .map_err(internal)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?
        .iter()
        .any(|c| c == "compiled");
    let sql =
        format!("SELECT version, source, {} FROM versions", if has_compiled { "compiled" } else { "NULL AS compiled" });
    let mut stmt = db.prepare(&sql).map_err(internal)?;
    let rows: Vec<(i64, String, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;
    let mut values = Map::new();
    let mut missing: Vec<String> = vec![];
    let mut unknown: Vec<String> = vec![];
    for (version, source, compiled) in rows {
        let Some(refs) = declared_secrets(compiled.as_deref(), &source) else {
            unknown.push(format!("v{version}"));
            continue;
        };
        for (name, reference) in refs {
            let reference = reference.as_str().map(str::to_owned).unwrap_or_else(|| reference.to_string());
            match reference.strip_prefix("env:").and_then(|v| std::env::var(v).ok()) {
                Some(value) => {
                    values.insert(format!("{name}@{version}"), Value::String(value));
                }
                None if !missing.contains(&name) => missing.push(name),
                None => {}
            }
        }
    }
    let withheld = if !missing.is_empty() {
        Some(format!(
            "secret(s) {} can't be resolved without the runner; start the pipeline to see payloads",
            missing.join(", ")
        ))
    } else if !unknown.is_empty() {
        Some(format!(
            "the secrets of {} can't be read without the runner (no compiled form is stored); start the pipeline to see payloads",
            unknown.join(", ")
        ))
    } else {
        None
    };
    Ok((Secrets::from_values(values, vec![]), withheld))
}

/// A read op answered from `<home>/pipelines/<name>/journal.db` while no runner runs, redacted like the runner's
/// answers: `{result, withheld}`, or None when the pipeline has no journal.
pub fn offline_read(
    path: &Path,
    op: &str,
    args: &Map<String, Value>,
    pipeline: &str,
) -> Result<Option<Value>, ControlError> {
    if !path.exists() {
        return Ok(None);
    }
    let db = crate::journal::open_readonly(path, crate::journal::BUSY_RETRY_MS).map_err(internal)?;
    let (secrets, withheld) = offline_redaction(&db)?;
    let raw = read(&db, op, args, pipeline, None)?;
    let redacted = secrets.redact_value(&raw);
    let result = match &withheld {
        Some(reason) => withhold_payloads(&redacted, reason),
        None => redacted,
    };
    Ok(Some(json!({ "result": result, "withheld": withheld })))
}
