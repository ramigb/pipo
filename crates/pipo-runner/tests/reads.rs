// Packet, version and proposal reads (docs/spec.md §6, §8, D33, D34, D38) over journals built with the Rust Journal:
// paging and filters, a packet's trace, the DLQ, versions and diffs, proposals, offline reads with redaction and
// withheld payloads, old journals, and the `pipo-runner read` mode. The same reads are compared key for key with the
// TypeScript implementation (tests/support/ts-read.ts) when bun is available; unifiedDiff against fixtures/proposals.json.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Once;
use std::sync::atomic::{AtomicUsize, Ordering};

use pipo_runner::control::ControlError;
use pipo_runner::control::reads::{offline_read, read};
use pipo_runner::control::versions::unified_diff;
use pipo_runner::journal::*;
use rusqlite::Connection;
use serde_json::{Map, Value, json};

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        static N: AtomicUsize = AtomicUsize::new(0);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "pipo-reads-{}-{nanos}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const TOKEN: &str = "s3cr3t-reads-token";

/// Every test sets the environment through this first, so nothing reads it while it changes.
fn env() {
    static ONCE: Once = Once::new();
    // SAFETY: inside call_once, which every test calls before it reads the environment.
    ONCE.call_once(|| unsafe { std::env::set_var("PIPO_READS_TOKEN", TOKEN) });
}

fn bun() -> bool {
    Command::new("bun").arg("--version").output().is_ok()
}

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

fn args(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap()
}

fn rd(db: &Connection, op: &str, a: Value) -> Result<Value, ControlError> {
    read(db, op, &args(a), "demo", None)
}

fn source(secret: &str, extra: &str) -> String {
    format!(
        "pipo: 1\nname: demo\nsecrets: {{ tok: \"{secret}\" }}\ninput: {{ via: push }}\nnodes:\n  a: {{ from: input, transform: map, with: {{ data: {{ x: 1 }} }} }}\noutput: {{ from: a, to: stdout }}\n{extra}"
    )
}

/// The compiled form a Rust runner stores with a version: what reads need of it is `pipeline.secrets`.
fn compiled(secret: &str) -> String {
    json!({ "diagnostics": [], "pipeline": { "pipo": 1, "name": "demo", "secrets": { "tok": secret } } }).to_string()
}

fn packet(id: &str, version: i64, state: &str, cursor: Option<&str>, data: Value, received_at: i64) -> NewPacket {
    NewPacket {
        id: id.into(),
        version,
        state: state.into(),
        cursor: cursor.map(Into::into),
        data,
        trigger: "push".into(),
        source: "test".into(),
        error: None,
        received_at,
    }
}

fn err(code: &str, message: &str, node: Option<&str>, attempts: Option<u32>) -> PacketError {
    PacketError { code: code.into(), message: message.into(), node: node.map(Into::into), attempts }
}

fn step(j: &mut Journal, id: &str, patch: PacketPatch, event: &str, node: Option<&str>, detail: Option<Value>) {
    j.update(id, &patch, event, node, detail.as_ref(), &[], Some(1.0)).unwrap();
}

fn to(state: &str, cursor: Option<&str>) -> PacketPatch {
    PacketPatch { state: Some(state.into()), cursor: Some(cursor.map(Into::into)), ..Default::default() }
}

/// A journal with two versions and packets in every shape a trace has: delivered with retries and notes, dead-lettered,
/// in flight with a pending retry, fanned out with copies (one escalated), purged; and two proposals.
fn build(path: &Path) {
    let mut j = Journal::open(path).unwrap();
    let v1 = j.version("h1", &source("env:PIPO_READS_TOKEN", ""), "human", Some("first start"), Some(&compiled("env:PIPO_READS_TOKEN"))).unwrap();
    // p1: accepted → a (one retry, a log) → output → delivered; its data holds the secret.
    j.insert(&packet("01P1", v1, "processing", Some("a"), json!({ "name": "Ada", "tok": TOKEN }), 1000), "packet.accepted", None, None).unwrap();
    j.event("step.retry", Some(&json!({ "attempt": 1, "wait": 30, "error": "boom" })), Some("01P1"), Some("a")).unwrap();
    j.event("log", Some(&json!({ "level": "info", "message": "seen" })), Some("01P1"), Some("a")).unwrap();
    step(&mut j, "01P1", PacketPatch { data: Some(json!({ "name": "Ada", "tok": TOKEN, "x": 1 })), ..to("processing", Some("$output")) }, "node.done", Some("a"), None);
    step(&mut j, "01P1", PacketPatch { result: Some(json!({ "ok": true })), ..to("verifying", Some("$verify")) }, "output.written", Some("$output"), None);
    step(&mut j, "01P1", PacketPatch { error: Some(None), ..to("delivered", None) }, "packet.delivered", Some("$verify"), None);
    // p2: dead-lettered at a, after 3 attempts.
    j.insert(&packet("01P2", v1, "processing", Some("a"), json!({ "n": 2 }), 2000), "packet.accepted", None, None).unwrap();
    let e = err("node.failed", "a failed", Some("a"), Some(3));
    step(&mut j, "01P2", PacketPatch { error: Some(Some(e.clone())), ..to("dead_lettered", None) }, "packet.dead_lettered", Some("a"), Some(serde_json::to_value(&e).unwrap()));
    let v2 = j.version("h2", &source("op://vault/item/field", "description: two\n"), "cli", Some("applied"), Some(&compiled("op://vault/item/field"))).unwrap();
    // p3: in flight at a on v2, with a retry pending.
    j.insert(&packet("01P3", v2, "processing", Some("a"), json!({ "n": 3 }), 3000), "packet.accepted", None, None).unwrap();
    j.event("step.retry", Some(&json!({ "attempt": 1, "error": "slow" })), Some("01P3"), Some("a")).unwrap();
    // p4: fanned out into p4:a (delivered) and p4:b (escalated).
    j.insert(&packet("01P4", v2, "processing", Some("a"), json!({ "n": 4 }), 4000), "packet.accepted", None, None).unwrap();
    let row = j.get("01P4").unwrap().unwrap();
    j.atomically(|j| {
        j.update("01P4", &to(BRANCHED, None), "packet.fanned_out", Some("a"), None, &[], None)?;
        let copy = |b: &str| NewCopy { id: format!("01P4:{b}"), branch: b.into(), state: "processing".into(), cursor: "$output".into(), data: json!({ "n": 4, "b": b }), hops: 1 };
        j.insert_copies(&row, &[copy("a"), copy("b")], Some("a"))
    })
    .unwrap();
    step(&mut j, "01P4:a", to("delivered", None), "packet.delivered", Some("$verify"), None);
    let stall = err("stall", "stalled", Some("$output"), None);
    step(&mut j, "01P4:b", PacketPatch { error: Some(Some(stall)), ..to(ESCALATED, Some("$output")) }, "packet.escalated", Some("$output"), Some(json!({ "reason": "stall" })));
    // p5: dead-lettered, then purged.
    j.insert(&packet("01P5", v2, "processing", Some("a"), json!({ "n": 5 }), 5000), "packet.accepted", None, None).unwrap();
    step(&mut j, "01P5", PacketPatch { error: Some(Some(err("node.failed", "x", Some("a"), None))), ..to("dead_lettered", None) }, "packet.dead_lettered", Some("a"), None);
    j.purge(&["01P5".to_string()], "test").unwrap();
    // Two proposals, as the store writes them.
    for (id, state, at) in [("pr_01A", "validated", 10), ("pr_01B", "rejected", 20)] {
        j.db()
            .execute(
                "INSERT INTO proposals (id, pipeline, base_version, source, diff, added, removed, changed_paths, author, author_kind,
                   reason, state, problems, diagnostics, verify, verification, created_at)
                 VALUES (?, 'demo', 2, 'pipo: 1', '--- a', 1, 2, '[\"nodes.a\"]', 'agent-ops', 'agent', 'why', ?, ?, '[]', NULL, ?, ?)",
                rusqlite::params![
                    id,
                    state,
                    if state == "rejected" { r#"[{"code":"stale_base","message":"m","hint":"h"}]"# } else { "[]" },
                    if state == "rejected" { Some(r#"{"replayed":1}"#) } else { None },
                    at
                ],
            )
            .unwrap();
    }
    j.close().unwrap();
}

fn show(r: Result<Value, ControlError>) -> Value {
    match r {
        Ok(v) => json!({ "ok": v }),
        Err(e) => {
            let mut b = Map::new();
            b.insert("code".into(), json!(e.code));
            b.insert("message".into(), json!(e.message));
            if let Some(h) = e.hint {
                b.insert("hint".into(), json!(h));
            }
            json!({ "error": b })
        }
    }
}

#[test]
fn packets_page_newest_first_with_filters_and_bad_arguments() {
    env();
    let t = Tmp::new();
    build(&t.path("journal.db"));
    let db = open_readonly(t.path("journal.db"), 1000).unwrap();
    let page = rd(&db, "packets", json!({ "limit": 2 })).unwrap();
    assert_eq!(page["total"], 4);
    let ids: Vec<&str> = page["packets"].as_array().unwrap().iter().map(|p| p["packet_id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["01P4", "01P3"]);
    assert_eq!(page["next"], "01P3");
    let rest = rd(&db, "packets", json!({ "limit": "10", "after": "01P3" })).unwrap();
    assert_eq!(rest["packets"].as_array().unwrap().len(), 2);
    assert_eq!(rest["next"], Value::Null);
    let p4 = &page["packets"][0];
    assert_eq!(p4["copies"], 2);
    assert_eq!(p4["node"], Value::Null);
    assert_eq!(page["packets"][1]["node"], "a");
    let dlq = rd(&db, "dlq", json!({})).unwrap();
    assert_eq!(dlq["total"], 1);
    assert_eq!(dlq["packets"][0]["node"], "a");
    assert_eq!(dlq["packets"][0]["error"], json!({ "code": "node.failed", "message": "a failed", "node": "a", "attempts": 3 }));
    let esc = rd(&db, "packets", json!({ "state": "escalated" })).unwrap();
    assert_eq!(esc["packets"][0]["packet_id"], "01P4:b");
    let keys: Vec<&String> = dlq["packets"][0].as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        ["packet_id", "state", "node", "version", "trigger", "source", "attempt", "error", "copies", "received_at", "updated_at"]
    );
    let bad = rd(&db, "packets", json!({ "state": "lost" })).unwrap_err();
    assert_eq!((bad.code, bad.message.as_str()), ("bad_request", "unknown packet state \"lost\""));
    assert!(bad.hint.unwrap().contains("dead_lettered"));
    for limit in [json!(0), json!(1001), json!(1.5), json!("x"), json!(" "), json!(true)] {
        assert_eq!(rd(&db, "packets", json!({ "limit": limit })).unwrap_err().code, "bad_request", "{limit}");
    }
    assert_eq!(rd(&db, "packets", json!({ "after": 5 })).unwrap_err().code, "bad_request");
}

#[test]
fn a_packet_trace_has_data_timings_retries_notes_and_copies() {
    env();
    let t = Tmp::new();
    build(&t.path("journal.db"));
    let db = open_readonly(t.path("journal.db"), 1000).unwrap();
    let tr = rd(&db, "packet", json!({ "packet_id": "01P1" })).unwrap();
    assert_eq!(tr["packet"]["data"], json!({ "name": "Ada", "tok": TOKEN, "x": 1 }));
    assert_eq!(tr["packet"]["result"], json!({ "ok": true }));
    let steps = tr["steps"].as_array().unwrap();
    let nodes: Vec<&Value> = steps.iter().map(|s| &s["node"]).collect();
    assert_eq!(nodes, [&json!("input"), &json!("a"), &json!("$output"), &json!("$verify")]);
    assert_eq!(steps[0]["state"], "processing");
    assert_eq!(steps[0]["changed"], true);
    assert_eq!(steps[1]["retries"], json!([{ "attempt": 1, "at": steps[1]["retries"][0]["at"], "wait_ms": 30, "error": "boom" }]));
    assert_eq!(steps[1]["attempts"], 2);
    assert_eq!(steps[1]["notes"][0]["type"], "log");
    assert_eq!(steps[1]["changed"], true);
    assert_eq!(steps[2]["changed"], false);
    assert_eq!(steps[3]["state"], "delivered");
    assert_eq!(tr["pending"], Value::Null);
    assert!(tr["events"][0].get("patch").is_none());
    let keys: Vec<&String> = steps[1].as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        ["node", "event", "state", "started_at", "at", "duration_ms", "attempts", "retries", "error", "data", "changed", "notes"]
    );

    let dead = rd(&db, "packet", json!({ "packet_id": "01P2" })).unwrap();
    assert_eq!(dead["steps"][1]["attempts"], 3);
    assert_eq!(dead["steps"][1]["error"]["code"], "node.failed");

    let pending = rd(&db, "packet", json!({ "packet_id": "01P3" })).unwrap();
    assert_eq!(pending["pending"]["node"], "a");
    assert_eq!(pending["pending"]["retries"][0]["error"], "slow");
    assert_eq!(pending["pending"]["since"], pending["steps"][0]["at"]);

    let fan = rd(&db, "packet", json!({ "packet_id": "01P4" })).unwrap();
    assert_eq!(fan["packet"]["copies"], 2);
    let copies: Vec<&Value> = fan["copies"].as_array().unwrap().iter().map(|c| &c["packet"]["packet_id"]).collect();
    assert_eq!(copies, [&json!("01P4:a"), &json!("01P4:b")]);
    assert_eq!(fan["copies"][1]["packet"]["branch"], "b");
    assert_eq!(fan["copies"][1]["steps"][0]["node"], "a");

    let purged = rd(&db, "packet", json!({ "packet_id": "01P5" })).unwrap();
    assert_eq!(purged["packet"], Value::Null);
    assert_eq!(purged["purged"]["detail"]["by"], "test");

    let missing = rd(&db, "packet", json!({ "packet_id": "nope" })).unwrap_err();
    assert_eq!((missing.code, missing.message.as_str()), ("not_found", "no packet 'nope' in demo"));
    assert!(missing.hint.unwrap().contains("pipo packets demo"));
    assert_eq!(rd(&db, "packet", json!({})).unwrap_err().code, "bad_request");
}

#[test]
fn versions_version_and_diff() {
    env();
    let t = Tmp::new();
    build(&t.path("journal.db"));
    let db = open_readonly(t.path("journal.db"), 1000).unwrap();
    let h = read(&db, "versions", &Map::new(), "demo", Some(2)).unwrap();
    assert_eq!((h["current"].clone(), h["latest"].clone()), (json!(2), json!(2)));
    let v2 = &h["versions"][0];
    let keys: Vec<&String> = v2.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["version", "hash", "author", "reason", "author_kind", "proposal", "files", "created_at", "pending"]);
    // p3 is in flight and p4 branched on v2; p4's copies don't count.
    assert_eq!(v2["pending"], 2);
    let v = rd(&db, "version", json!({ "version": "v2" })).unwrap();
    assert_eq!(v["definition"], source("op://vault/item/field", "description: two\n"));
    assert_eq!(v["diff"], "--- demo v1\n+++ demo v2\n@@ -1,7 +1,8 @@\n pipo: 1\n name: demo\n-secrets: { tok: \"env:PIPO_READS_TOKEN\" }\n+secrets: { tok: \"op://vault/item/field\" }\n input: { via: push }\n nodes:\n   a: { from: input, transform: map, with: { data: { x: 1 } } }\n output: { from: a, to: stdout }\n+description: two");
    assert_eq!(rd(&db, "version", json!({ "version": 1 })).unwrap()["diff"], Value::Null);
    let missing = rd(&db, "version", json!({ "version": 7 })).unwrap_err();
    assert_eq!(missing.message, "demo has no version 7 (versions are v1 to v2)");
    assert_eq!(missing.hint.as_deref(), Some("list them with pipo history demo"));
    let bad = rd(&db, "version", json!({ "version": "latest" })).unwrap_err();
    assert_eq!(bad.message, "`version` must be a version number, got \"latest\"");
    assert_eq!(rd(&db, "diff", json!({ "from": 1 })).unwrap_err().message, "`to` must be a version number, got null");
    let d = rd(&db, "diff", json!({ "from": "1", "to": "V2" })).unwrap();
    assert_eq!((d["identical"].clone(), d["added"].clone(), d["removed"].clone()), (json!(false), json!(2), json!(1)));
    let same = rd(&db, "diff", json!({ "from": 2, "to": 2 })).unwrap();
    assert_eq!(same, json!({ "from": 2, "to": 2, "identical": true, "diff": "", "added": 0, "removed": 0 }));
}

#[test]
fn proposals_list_and_get() {
    env();
    let t = Tmp::new();
    build(&t.path("journal.db"));
    let db = open_readonly(t.path("journal.db"), 1000).unwrap();
    let list = rd(&db, "proposals", json!({})).unwrap();
    let ids: Vec<&Value> = list["proposals"].as_array().unwrap().iter().map(|p| &p["id"]).collect();
    assert_eq!(ids, [&json!("pr_01B"), &json!("pr_01A")]);
    assert!(list["proposals"][0].get("source").is_none());
    assert_eq!(rd(&db, "proposals", json!({ "state": "validated", "limit": "1" })).unwrap()["proposals"][0]["id"], "pr_01A");
    let p = rd(&db, "proposal", json!({ "id": "pr_01B" })).unwrap();
    assert_eq!(p["verification"], json!({ "replayed": 1 }));
    assert_eq!(p["problems"][0]["code"], "stale_base");
    let bad = rd(&db, "proposals", json!({ "state": "bogus" })).unwrap_err();
    assert_eq!(bad.message, "`state` must be one of validated, verified, applied, rejected, got \"bogus\"");
    assert_eq!(rd(&db, "proposals", json!({ "limit": 0 })).unwrap_err().code, "bad_request");
    let missing = rd(&db, "proposal", json!({ "id": "pr_nope" })).unwrap_err();
    assert_eq!((missing.code, missing.message.as_str()), ("not_found", "demo has no proposal pr_nope"));
    assert_eq!(rd(&db, "proposal", json!({})).unwrap_err().code, "bad_request");
}

#[test]
fn offline_reads_redact_and_withhold_payloads_when_a_secret_cant_be_resolved() {
    env();
    let t = Tmp::new();
    let path = t.path("journal.db");
    {
        let mut j = Journal::open(&path).unwrap();
        let v = j.version("h1", &source("env:PIPO_READS_TOKEN", ""), "human", None, Some(&compiled("env:PIPO_READS_TOKEN"))).unwrap();
        j.insert(&packet("01P1", v, "processing", Some("a"), json!({ "v": TOKEN }), 1), "packet.accepted", None, None).unwrap();
    }
    let page = offline_read(&path, "packets", &Map::new(), "demo").unwrap().unwrap();
    assert_eq!(page["result"]["packets"][0]["packet_id"], "01P1");
    let trace = offline_read(&path, "packet", &args(json!({ "packet_id": "01P1" })), "demo").unwrap().unwrap();
    assert_eq!(trace["withheld"], Value::Null);
    assert_eq!(trace["result"]["packet"]["data"], json!({ "v": "***" }));
    assert_eq!(offline_read(&t.path("none.db"), "packets", &Map::new(), "demo").unwrap(), None);
    let missing = offline_read(&path, "packet", &args(json!({ "packet_id": "nope" })), "demo").unwrap_err();
    assert_eq!(missing.message, "no packet 'nope' in demo");

    // A version that declares an op:// secret: it can't be resolved without the runner, so payloads are withheld.
    Journal::open(&path).unwrap().version("h2", &source("op://vault/item/field", ""), "human", None, Some(&compiled("op://vault/item/field"))).unwrap();
    let withheld = offline_read(&path, "packet", &args(json!({ "packet_id": "01P1" })), "demo").unwrap().unwrap();
    assert_eq!(
        withheld["withheld"],
        "secret(s) tok can't be resolved without the runner; start the pipeline to see payloads"
    );
    assert!(withheld["result"]["packet"]["data"].as_str().unwrap().starts_with("[withheld:"));
    assert!(withheld["result"]["steps"][0]["data"].as_str().unwrap().starts_with("[withheld:"));
    assert!(!withheld.to_string().contains(TOKEN));

    // A version stored without its compiled form (by the TS runner) whose source mentions secrets: unknown, withheld.
    Journal::open(&path).unwrap().version("h3", &source("env:PIPO_READS_TOKEN", "description: three\n"), "human", None, None).unwrap();
    let j = Journal::open(&path).unwrap();
    j.db().execute("DELETE FROM versions WHERE version = 2", []).unwrap();
    j.close().unwrap();
    let unknown = offline_read(&path, "packets", &Map::new(), "demo").unwrap().unwrap();
    assert_eq!(
        unknown["withheld"],
        "the secrets of v3 can't be read without the runner (no compiled form is stored); start the pipeline to see payloads"
    );
}

#[test]
fn journals_from_before_patches_trace_by_event_type() {
    env();
    let t = Tmp::new();
    let path = t.path("old.db");
    {
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            r#"CREATE TABLE versions (version INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
                 author TEXT NOT NULL DEFAULT 'human', created_at INTEGER NOT NULL);
               CREATE TABLE packets (id TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL, cursor TEXT, data TEXT,
                 trigger TEXT NOT NULL, source TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, iteration INTEGER NOT NULL DEFAULT 0,
                 hops INTEGER NOT NULL DEFAULT 0, error TEXT, result TEXT, received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
               CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, packet_id TEXT, type TEXT NOT NULL,
                 node TEXT, detail TEXT);
               INSERT INTO versions VALUES (1, 'h', 'pipo: 1', 'human', 1);
               INSERT INTO packets VALUES ('p1', 1, 'delivered', NULL, '{"a":1}', 'push', 'cli', 0, 0, 2, NULL, NULL, 100, 300);
               INSERT INTO events (at, packet_id, type, node, detail) VALUES (100, 'p1', 'packet.accepted', NULL, NULL),
                 (150, 'p1', 'node.done', 'n', NULL), (300, 'p1', 'packet.delivered', '$verify', NULL);"#,
        )
        .unwrap();
    }
    // Before D22 a journal has no branch columns: a read-only read can't page it, so the Journal migrates it first.
    Journal::open(&path).unwrap().close().unwrap();
    let r = offline_read(&path, "packet", &args(json!({ "packet_id": "p1" })), "old").unwrap().unwrap();
    assert_eq!(r["withheld"], Value::Null);
    let steps: Vec<Value> =
        r["result"]["steps"].as_array().unwrap().iter().map(|s| json!([s["node"], s["state"], s["duration_ms"]])).collect();
    assert_eq!(steps, [json!(["input", "accepted", 0]), json!(["n", null, 50]), json!(["$verify", "delivered", 150])]);
    assert!(r["result"]["steps"][0].get("data").is_none());
}

#[test]
fn versions_of_journals_from_before_reasons_and_file_hashes() {
    env();
    let t = Tmp::new();
    let path = t.path("pre.db");
    {
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE versions (version INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
               author TEXT NOT NULL DEFAULT 'human', created_at INTEGER NOT NULL);
             CREATE TABLE packets (id TEXT PRIMARY KEY, version INTEGER, state TEXT, branch TEXT NOT NULL DEFAULT '');
             INSERT INTO versions VALUES (1, 'h', 'pipo: 1', 'human', 5);",
        )
        .unwrap();
    }
    let legacy = offline_read(&path, "versions", &Map::new(), "pre").unwrap().unwrap();
    assert_eq!(
        legacy["result"]["versions"].to_string(),
        json!([{ "version": 1, "hash": "h", "author": "human", "reason": null, "author_kind": null, "proposal": null,
                 "files": null, "created_at": 5, "pending": 0 }])
        .to_string()
    );
    assert_eq!(legacy["result"]["current"], Value::Null);
    let none = offline_read(&path, "proposals", &Map::new(), "pre").unwrap().unwrap();
    assert_eq!(none["result"], json!({ "proposals": [] }));
    let gone = offline_read(&path, "proposal", &args(json!({ "id": "pr_x" })), "pre").unwrap_err();
    assert_eq!(gone.code, "not_found");
}

#[test]
fn the_read_mode_prints_the_result_or_the_error() {
    env();
    let t = Tmp::new();
    let home = t.path("home");
    build(&home.join("pipelines").join("demo").join("journal.db"));
    let run = |a: &[&str]| {
        let out = Command::new(env!("CARGO_BIN_EXE_pipo-runner")).arg("read").args(a).output().unwrap();
        (out.status.code(), String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let home_s = home.to_str().unwrap();
    let (code, out) = run(&["--home", home_s, "--pipeline", "demo", "--op", "dlq"]);
    assert_eq!(code, Some(0));
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["result"]["packets"][0]["packet_id"], "01P2");
    assert!(v["withheld"].as_str().unwrap().contains("tok"));
    let (code, out) = run(&["--home", home_s, "--pipeline", "demo", "--op", "packet", "--args", r#"{"packet_id":"nope"}"#]);
    assert_eq!(code, Some(1));
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["error"]["code"], "not_found");
    let (code, out) = run(&["--home", home_s, "--pipeline", "other", "--op", "versions"]);
    assert_eq!((code, out.as_str()), (Some(0), "null"));
    for bad in [
        vec!["--home", home_s, "--pipeline", "demo", "--op", "push"],
        vec!["--home", home_s, "--pipeline", "../x", "--op", "versions"],
        vec!["--home", home_s, "--pipeline", "demo", "--op", "versions", "--args", "[1]"],
        vec!["--home", home_s, "--op", "versions"],
    ] {
        assert_eq!(run(&bad).0, Some(64), "{bad:?}");
    }
}

/// Every read the TS implementation answers, compared key for key (in order) with the Rust port's answer.
#[test]
fn reads_match_the_typescript_implementation() {
    env();
    if !bun() {
        eprintln!("skipped: bun is not on PATH, so the TypeScript reads can't run");
        return;
    }
    let t = Tmp::new();
    let path = t.path("journal.db");
    build(&path);
    let mut requests: Vec<Value> = vec![];
    let ops: Vec<(&str, Value)> = vec![
        ("packets", json!({})),
        ("packets", json!({ "limit": 2 })),
        ("packets", json!({ "limit": "2", "after": "01P3" })),
        ("packets", json!({ "state": "dead_lettered" })),
        ("packets", json!({ "state": "escalated" })),
        ("packets", json!({ "state": "branched", "limit": 1 })),
        ("packets", json!({ "state": "lost" })),
        ("packets", json!({ "state": 3 })),
        ("packets", json!({ "limit": 0 })),
        ("packets", json!({ "limit": "x" })),
        ("packets", json!({ "limit": "0x10" })),
        ("packets", json!({ "after": "" })),
        ("packets", json!({ "after": 1 })),
        ("dlq", json!({})),
        ("dlq", json!({ "state": "delivered" })),
        ("packet", json!({ "packet_id": "01P1" })),
        ("packet", json!({ "packet_id": "01P2" })),
        ("packet", json!({ "packet_id": "01P3" })),
        ("packet", json!({ "packet_id": "01P4" })),
        ("packet", json!({ "packet_id": "01P4:b" })),
        ("packet", json!({ "packet_id": "01P5" })),
        ("packet", json!({ "packet_id": "nope" })),
        ("packet", json!({})),
        ("versions", json!({})),
        ("version", json!({ "version": 1 })),
        ("version", json!({ "version": "v2" })),
        ("version", json!({ "version": 9 })),
        ("version", json!({ "version": "latest" })),
        ("version", json!({ "version": 0 })),
        ("diff", json!({ "from": 1, "to": "2" })),
        ("diff", json!({ "from": 2, "to": 2 })),
        ("diff", json!({ "from": 1 })),
        ("proposals", json!({})),
        ("proposals", json!({ "state": "rejected" })),
        ("proposals", json!({ "state": "bogus" })),
        ("proposals", json!({ "limit": "1" })),
        ("proposals", json!({ "limit": true })),
        ("proposals", json!({ "limit": 1001 })),
        ("proposal", json!({ "id": "pr_01B" })),
        ("proposal", json!({ "id": "pr_nope" })),
        ("proposal", json!({})),
    ];
    let mut expected: Vec<Value> = vec![];
    let db = open_readonly(&path, 1000).unwrap();
    for offline in [false, true] {
        for (op, a) in &ops {
            requests.push(json!({ "op": op, "args": a, "pipeline": "demo", "offline": offline }));
            expected.push(if offline {
                show(offline_read(&path, op, &args(a.clone()), "demo").map(|r| r.unwrap_or(Value::Null)))
            } else {
                show(read(&db, op, &args(a.clone()), "demo", None))
            });
        }
    }
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/support/ts-read.ts");
    let out = Command::new("bun").arg(&script).arg(&path).arg(Value::Array(requests.clone()).to_string()).current_dir(repo()).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let got: Vec<Value> = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(got.len(), expected.len());
    for ((req, ts), rust) in requests.iter().zip(&got).zip(&expected) {
        assert_eq!(rust.to_string(), ts.to_string(), "{req}");
    }
}

#[test]
fn unified_diff_matches_the_typescript_outputs() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/proposals.json")).expect("fixtures/proposals.json parses");
    for case in fixture["diffs"].as_array().unwrap() {
        let (before, after) = (case["before"].as_str().unwrap(), case["after"].as_str().unwrap());
        let d = unified_diff(before, after, "p v1", "p v2", case["context"].as_u64().unwrap() as usize);
        let expected = &case["expected"];
        assert_eq!(d.diff, expected["diff"].as_str().unwrap(), "{before:?} → {after:?}");
        assert_eq!((d.added as u64, d.removed as u64), (expected["added"].as_u64().unwrap(), expected["removed"].as_u64().unwrap()));
    }
    // Around MAX_CELLS: aligned line by line below it, removed-then-added above it.
    let big = |n: usize, side: &str| {
        let lines: Vec<String> =
            (0..n).map(|i| if i % 100 == 0 { format!("common {i}") } else { format!("{side} {i}") }).collect();
        format!("head\n{}\ntail\n", lines.join("\n"))
    };
    for case in fixture["large"].as_array().unwrap() {
        let n = case["n"].as_u64().unwrap() as usize;
        let d = unified_diff(&big(n, "a"), &big(n, "b"), "a", "b", 3);
        assert_eq!(d.added as u64, case["added"].as_u64().unwrap());
        assert_eq!(d.removed as u64, case["removed"].as_u64().unwrap());
        assert_eq!(d.diff.split('\n').count() as u64, case["lines"].as_u64().unwrap());
        assert_eq!(pipo_runner::versions::sha256(d.diff.as_bytes()), case["sha256"].as_str().unwrap(), "n = {n}");
    }
}

#[test]
fn unified_diff_hunks_edges_and_identical_texts() {
    let a: Vec<String> = (1..=12).map(|i| format!("l{i}")).collect();
    let mut b = vec!["x".to_string(), "l1".into(), "l2".into(), "L3".into()];
    b.extend(a[3..11].iter().cloned());
    let d = unified_diff(&format!("{}\n", a.join("\n")), &format!("{}\n", b.join("\n")), "p v1", "p v2", 3);
    assert_eq!(
        d.diff,
        "--- p v1\n+++ p v2\n@@ -1,6 +1,7 @@\n+x\n l1\n l2\n-l3\n+L3\n l4\n l5\n l6\n@@ -9,4 +10,3 @@\n l9\n l10\n l11\n-l12"
    );
    assert_eq!((d.added, d.removed), (2, 2));
    assert_eq!(unified_diff("a\nb\nc\nd\ne\nf\ng\nh\n", "A\nb\nc\nd\ne\nf\ng\nH\n", "a", "b", 3).diff.matches("@@").count(), 2);
    assert_eq!(unified_diff("x\n", "y\n", "a", "b", 3).diff, "--- a\n+++ b\n@@ -1,1 +1,1 @@\n-x\n+y");
    assert_eq!(unified_diff("", "y\n", "a", "b", 3).diff, "--- a\n+++ b\n@@ -0,0 +1,1 @@\n+y");
    let same = unified_diff("same\n", "same\n", "a", "b", 3);
    assert_eq!((same.diff.as_str(), same.added, same.removed), ("", 0, 0));
    assert_eq!(
        unified_diff("a", "a\n", "a", "b", 3).diff,
        "--- a\n+++ b\n(only the newline at the end of the file differs)"
    );
}
