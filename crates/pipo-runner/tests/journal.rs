// The journal (docs/spec.md §7.3) on temp files, and its on-disk format against the TypeScript Journal.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use pipo_runner::journal::*;
use rusqlite::Connection;
use serde_json::{Map, Value, json};

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        static N: AtomicUsize = AtomicUsize::new(0);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "pipo-journal-{}-{nanos}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        Tmp(dir)
    }
    fn db(&self) -> PathBuf {
        self.0.join("journal.db")
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn packet(id: &str, version: i64, data: Value) -> NewPacket {
    NewPacket {
        id: id.into(),
        version,
        state: "processing".into(),
        cursor: Some("a".into()),
        data,
        trigger: "http".into(),
        source: "in".into(),
        error: None,
        received_at: 1000,
        input: "input".into(),
        upstream: serde_json::Value::Null,
    }
}

fn err(code: &str, message: &str, node: Option<&str>) -> PacketError {
    PacketError { code: code.into(), message: message.into(), node: node.map(Into::into), attempts: None }
}

fn state(j: &Journal, id: &str) -> String {
    j.get(id).unwrap().map_or("gone".into(), |r| r.state)
}

fn end(j: &mut Journal, id: &str, to: &str, error: Option<PacketError>) -> Vec<Settled> {
    j.atomically(|j| {
        let patch =
            PacketPatch { state: Some(to.into()), cursor: Some(None), error: Some(error), ..Default::default() };
        j.update(id, &patch, &format!("packet.{to}"), Some("n"), None, &[], None)?;
        j.settle_ancestors(id)
    })
    .unwrap()
}

/// A packet `P` that fanned out into `P:a` and `P:b`.
fn fanned_out(j: &mut Journal) {
    let v = j.version("h", "src", "human", None, None).unwrap();
    j.insert(&packet("P", v, json!({ "x": 1 })), "packet.accepted", None, None).unwrap();
    let row = j.get("P").unwrap().unwrap();
    j.atomically(|j| {
        let patch = PacketPatch { state: Some(BRANCHED.into()), cursor: Some(None), ..Default::default() };
        j.update("P", &patch, "packet.fanned_out", Some("a"), None, &[], None)?;
        let copy = |b: &str| NewCopy {
            id: format!("P:{b}"),
            branch: b.into(),
            state: "processing".into(),
            cursor: b.into(),
            data: json!({ "x": 1 }),
            hops: 1,
        };
        j.insert_copies(&row, &[copy("a"), copy("b")], Some("a"))
    })
    .unwrap();
}

fn text(db: &Connection, sql: &str) -> Option<String> {
    db.query_row(sql, [], |r| r.get(0)).unwrap()
}

#[test]
fn creates_the_schema_and_reopens() {
    let t = Tmp::new();
    {
        let mut j = Journal::open(t.db()).unwrap();
        let mode: String = j.db().query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode, "wal");
        let fk: i64 = j.db().query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(fk, 1);
        let sync: i64 = j.db().query_row("PRAGMA synchronous", [], |r| r.get(0)).unwrap();
        assert_eq!(sync, 2);
        assert_eq!(j.latest_version().unwrap(), None);
        let v = j.version("h1", "source one", "human", None, Some(r#"{"pipeline":{}}"#)).unwrap();
        assert_eq!(v, 1);
        assert_eq!(j.version("h1", "source one", "human", None, None).unwrap(), 1);
        j.insert(&packet("p1", v, json!({ "a": "b" })), "packet.accepted", Some(&json!({ "n": 1 })), None).unwrap();
        j.close().unwrap();
    }
    let mut j = Journal::open(t.db()).unwrap();
    assert_eq!(j.latest_version().unwrap(), Some(LatestVersion { version: 1, hash: "h1".into() }));
    assert_eq!(j.version_compiled(1).unwrap().as_deref(), Some(r#"{"pipeline":{}}"#));
    assert_eq!(j.version_compiled(9).unwrap(), None);
    assert_eq!(j.version_source(1).unwrap(), "source one");
    assert_eq!(j.version_source(2).unwrap_err().to_string(), "journal has no version 2");
    let p = j.get("p1").unwrap().unwrap();
    assert_eq!((p.state.as_str(), p.cursor.as_deref(), p.branch.as_str()), ("processing", Some("a"), ""));
    assert_eq!(p.data, json!({ "a": "b" }));
    assert_eq!((p.error, p.result), (None, Value::Null));
    // Versions are a timeline (D38): an earlier source again is a new version.
    assert_eq!(j.version("h2", "two", "human", None, None).unwrap(), 2);
    assert_eq!(j.version("h1", "source one", "human", Some("rollback"), None).unwrap(), 3);
    assert!(Journal::open(t.db()).is_ok(), "a second connection opens alongside");
}

#[test]
fn migrates_an_old_journal() {
    let t = Tmp::new();
    std::fs::create_dir_all(&t.0).unwrap();
    {
        let db = Connection::open(t.db()).unwrap();
        db.execute_batch(
            "CREATE TABLE versions (version INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
               author TEXT NOT NULL DEFAULT 'human', created_at INTEGER NOT NULL);
             CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE packets (id TEXT PRIMARY KEY, version INTEGER NOT NULL REFERENCES versions(version),
               state TEXT NOT NULL, cursor TEXT, data TEXT, trigger TEXT NOT NULL, source TEXT NOT NULL,
               attempt INTEGER NOT NULL DEFAULT 0, iteration INTEGER NOT NULL DEFAULT 0, hops INTEGER NOT NULL DEFAULT 0,
               error TEXT, result TEXT, received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, packet_id TEXT,
               type TEXT NOT NULL, node TEXT, detail TEXT);
             INSERT INTO versions (version, hash, source, author, created_at) VALUES (1, 'h1', 'old source', 'human', 5);
             INSERT INTO packets (id, version, state, cursor, data, trigger, source, error, received_at, updated_at)
               VALUES ('old', 1, 'delivered', NULL, '{\"k\":1}', 'http', 'in', 'null', 10, 20);
             INSERT INTO events (at, packet_id, type, node, detail) VALUES (10, 'old', 'packet.accepted', NULL, NULL);",
        )
        .unwrap();
    }
    let mut j = Journal::open(t.db()).unwrap();
    let sql = text(j.db(), "SELECT sql FROM sqlite_master WHERE name = 'versions'").unwrap();
    assert!(!sql.to_uppercase().contains("UNIQUE"), "{sql}");
    let cols = |table: &str| -> Vec<String> {
        let mut s = j.db().prepare(&format!("PRAGMA table_info({table})")).unwrap();
        s.query_map([], |r| r.get::<_, String>("name")).unwrap().map(Result::unwrap).collect()
    };
    assert_eq!(
        cols("versions"),
        ["version", "hash", "source", "author", "reason", "created_at", "author_kind", "proposal", "files", "compiled"]
    );
    let tail = ["root", "parent", "branch", "input", "upstream"].map(String::from);
    assert!(cols("packets").ends_with(&tail));
    assert!(cols("events").ends_with(&["patch".into(), "ms".into()]));
    let old = j.get("old").unwrap().unwrap();
    assert_eq!((old.branch.as_str(), old.root.clone(), old.data.clone()), ("", None, json!({ "k": 1 })));
    // A packet from before several inputs came through the input named `input` (D76).
    assert_eq!((old.input.as_str(), old.upstream.clone()), ("input", serde_json::Value::Null));
    assert_eq!(j.version_source(1).unwrap(), "old source");
    assert_eq!(j.version_files(1).unwrap(), None);
    assert_eq!(j.version_compiled(1).unwrap(), None);
    // The hash is no longer unique: going back to it is a new version.
    j.version("h2", "two", "human", None, None).unwrap();
    assert_eq!(j.version("h1", "old source", "human", None, None).unwrap(), 3);
    let broken: i64 = j.db().query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
    assert_eq!(broken, 0);
    drop(j);
    Journal::open(t.db()).unwrap();
}

#[test]
fn nested_atomically_rolls_back_as_a_whole() {
    let t = Tmp::new();
    let mut j = Journal::open(t.db()).unwrap();
    let v = j.version("h", "s", "human", None, None).unwrap();
    j.insert(&packet("p1", v, json!(1)), "packet.accepted", None, None).unwrap();
    let seq = j.last_seq().unwrap();
    let attempt = |n| PacketPatch { attempt: Some(n), ..Default::default() };

    let out: Result<()> = j.atomically(|j| {
        j.update("p1", &attempt(1), "step.retry", None, None, &[], None)?;
        j.atomically(|j| {
            j.update("p1", &attempt(2), "step.retry", None, None, &[], None)?;
            j.insert(&packet("p2", v, json!(2)), "packet.accepted", None, None)
        })?;
        Err("stop".into())
    });
    assert_eq!(out.unwrap_err().to_string(), "stop");
    assert_eq!(j.get("p1").unwrap().unwrap().attempt, 0);
    assert_eq!(j.get("p2").unwrap(), None);
    assert_eq!(j.last_seq().unwrap(), seq);
    assert!(j.db().is_autocommit());

    // An inner failure the outer handles rolls back only the inner part (a savepoint).
    j.atomically(|j| {
        j.update("p1", &attempt(3), "step.retry", None, None, &[], None)?;
        let inner: Result<()> = j.atomically(|j| {
            j.update("p1", &attempt(4), "step.retry", None, None, &[], None)?;
            Err("inner".into())
        });
        assert!(inner.is_err());
        Ok(())
    })
    .unwrap();
    assert_eq!(j.get("p1").unwrap().unwrap().attempt, 3);
    assert_eq!(j.last_seq().unwrap(), seq + 1);

    // A failing statement inside a method rolls back that method's transaction.
    let dup = j.insert(&packet("p1", v, json!(1)), "packet.accepted", None, None);
    assert!(dup.is_err());
    assert_eq!(j.last_seq().unwrap(), seq + 1);
    assert!(j.db().is_autocommit());
}

#[test]
fn settles_ancestors_with_a_summary() {
    let t = Tmp::new();
    let mut j = Journal::open(t.db()).unwrap();
    fanned_out(&mut j);
    let copies = j.copies("P").unwrap();
    assert_eq!(copies.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["P:a", "P:b"]);
    assert_eq!((copies[0].root.as_deref(), copies[0].parent.as_deref(), copies[0].hops), (Some("P"), Some("P"), 1));
    assert_eq!(j.count_in_flight().unwrap(), 1);
    assert_eq!(j.count_moving().unwrap(), 2);

    assert_eq!(end(&mut j, "P:a", "delivered", None), vec![]);
    assert_eq!(state(&j, "P"), BRANCHED);
    let settled = end(&mut j, "P:b", "dead_lettered", Some(err("http.500", "boom", Some("b"))));
    let error = err("branch.dead_lettered", "branch 'b' dead-lettered: boom", Some("b"));
    assert_eq!(settled, vec![Settled { id: "P".into(), state: "dead_lettered".into(), error: Some(error.clone()) }]);
    let p = j.get("P").unwrap().unwrap();
    assert_eq!((p.state.as_str(), p.cursor.clone(), p.error.clone()), ("dead_lettered", None, Some(error)));
    let last = j.latest_event("P", &["packet.dead_lettered"]).unwrap().unwrap();
    assert_eq!(last.detail, json!({ "branches": { "delivered": 1, "filtered": 0, "dead_lettered": 1 } }));
    assert_eq!(
        text(j.db(), "SELECT patch FROM events WHERE packet_id = 'P' ORDER BY seq DESC LIMIT 1").unwrap(),
        r#"{"state":"dead_lettered","cursor":null,"error":{"code":"branch.dead_lettered","message":"branch 'b' dead-lettered: boom","node":"b"}}"#
    );
    assert_eq!(j.counts().unwrap().get("dead_lettered"), Some(&1));
    assert_eq!(j.count_in_flight().unwrap(), 0);
}

#[test]
fn replays_and_purges_the_dead_letter_queue() {
    let t = Tmp::new();
    let mut j = Journal::open(t.db()).unwrap();
    fanned_out(&mut j);
    end(&mut j, "P:a", "delivered", None);
    end(&mut j, "P:b", "dead_lettered", Some(err("x", "boom", Some("b"))));

    let leaves = j.dead_leaves("P").unwrap();
    assert_eq!(leaves.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), ["P:b"]);
    assert_eq!(j.dead_leaves("P:a").unwrap(), vec![]);
    let leaf = |id: &str| ReplayLeaf { id: id.into(), cursor: "b".into(), state: "processing".into(), iteration: None };
    let item = |leaves| ReplayItem { packet_id: "P".into(), leaves };

    // A leaf that isn't dead-lettered fails the whole replay.
    let e = j.replay(&[item(vec![leaf("P:b")]), item(vec![leaf("P:a")])], "me").unwrap_err();
    assert_eq!(e.to_string(), "packet P:a is delivered, not dead-lettered; nothing was replayed");
    let e = j.replay(&[item(vec![leaf("nope")])], "me").unwrap_err();
    assert_eq!(e.to_string(), "packet nope is gone, not dead-lettered; nothing was replayed");
    assert_eq!(state(&j, "P:b"), "dead_lettered");
    assert_eq!(state(&j, "P"), "dead_lettered");

    j.replay(&[item(vec![leaf("P:b")])], "me").unwrap();
    let b = j.get("P:b").unwrap().unwrap();
    assert_eq!((b.state.as_str(), b.cursor.as_deref(), b.error.clone(), b.attempt), ("processing", Some("b"), None, 0));
    assert_eq!(state(&j, "P"), BRANCHED);
    assert_eq!(
        text(j.db(), "SELECT patch FROM events WHERE packet_id = 'P:b' AND type = 'dlq.replayed'").unwrap(),
        r#"{"state":"processing","cursor":"b","error":null,"attempt":0}"#
    );
    let ev = j.latest_event("P", &["dlq.replayed"]).unwrap().unwrap();
    assert_eq!(ev.detail["error"]["code"], "branch.dead_lettered");
    assert_eq!(ev.detail["by"], "me");

    let e = j.purge(&["P".into()], "me").unwrap_err();
    assert_eq!(e.to_string(), "packet P is branched, not dead-lettered; nothing was purged");
    let e = j.purge(&["nope".into()], "me").unwrap_err();
    assert_eq!(e.to_string(), "packet nope is gone, not dead-lettered; nothing was purged");

    end(&mut j, "P:b", "dead_lettered", Some(err("x", "boom again", Some("b"))));
    let e = j.purge(&["P:b".into()], "me").unwrap_err();
    assert_eq!(e.to_string(), "packet P:b is dead_lettered, not dead-lettered; nothing was purged");
    j.purge(&["P".into()], "me").unwrap();
    assert_eq!(j.get("P").unwrap(), None);
    assert_eq!(j.copies("P").unwrap(), vec![]);
    assert!(j.events("P:a").unwrap().is_empty());
    let ev = j.events("P").unwrap();
    assert_eq!(ev.len(), 1);
    assert_eq!((ev[0].kind.as_str(), ev[0].node.as_deref()), ("dlq.purged", Some("b")));
    assert_eq!(ev[0].detail["copies"], 2);
    assert_eq!(ev[0].detail["version"], 1);
    assert!(ev[0].detail["events"].as_i64().unwrap() >= 8);
}

/// A step that moves `id` on to `cursor` with new data, as the runner commits it.
fn moved(j: &mut Journal, id: &str, node: &str, cursor: &str, data: Value, hops: u32) {
    let patch = PacketPatch {
        state: Some("processing".into()),
        cursor: Some(Some(cursor.into())),
        data: Some(data),
        hops: Some(hops),
        attempt: Some(0),
        ..Default::default()
    };
    j.update(id, &patch, "node.done", Some(node), None, &[], None).unwrap();
}

#[test]
fn entry_of_finds_the_data_a_unit_first_reached_a_step_with() {
    let t = Tmp::new();
    let mut j = Journal::open(t.db()).unwrap();
    let v = j.version("h", "src", "human", None, None).unwrap();
    j.insert(&packet("P", v, json!({ "x": 1 })), "packet.accepted", None, None).unwrap();
    moved(&mut j, "P", "a", "b", json!({ "x": 2 }), 1);
    // A loop back to b: the first entry counts, so a rerun starts the loop over.
    moved(&mut j, "P", "b", "c", json!({ "x": 3 }), 2);
    moved(&mut j, "P", "c", "b", json!({ "x": 4 }), 3);
    moved(&mut j, "P", "b", OUTPUT_STEP, json!({ "x": 5 }), 4);
    assert_eq!(j.entry_of("P", &["a"]).unwrap(), Some((json!({ "x": 1 }), 0)));
    assert_eq!(j.entry_of("P", &["b"]).unwrap(), Some((json!({ "x": 2 }), 1)));
    assert_eq!(j.entry_of("P", &[OUTPUT_STEP, BATCH_STEP]).unwrap(), Some((json!({ "x": 5 }), 4)));
    assert_eq!(j.entry_of("P", &["zzz"]).unwrap(), None);
    assert_eq!(j.entry_of("nope", &["a"]).unwrap(), None);
    // A copy starts at its packet.branched transition, with the hops it was made with.
    let t = Tmp::new();
    let mut j = Journal::open(t.db()).unwrap();
    fanned_out(&mut j);
    assert_eq!(j.entry_of("P:b", &["b"]).unwrap(), Some((json!({ "x": 1 }), 1)));
    assert!(!j.data_cleared("P:b").unwrap());
    assert!(j.data_cleared("nope").unwrap());
}

#[test]
fn rerun_reopens_settled_units_and_their_ancestors() {
    let t = Tmp::new();
    let mut j = Journal::open(t.db()).unwrap();
    fanned_out(&mut j);
    moved(&mut j, "P:b", "b", OUTPUT_STEP, json!({ "x": 9 }), 2);
    end(&mut j, "P:a", "filtered", None);
    end(&mut j, "P:b", "delivered", None);
    assert_eq!(state(&j, "P"), "delivered");
    let v2 = j.version("h2", "src2", "human", None, None).unwrap();
    let unit = |id: &str| RerunUnit {
        id: id.into(),
        cursor: "b".into(),
        state: "processing".into(),
        data: json!({ "x": 1 }),
        hops: 1,
    };

    let item = |version, units| RerunItem { packet_id: "P".into(), version, units };

    // A unit that isn't settled fails the whole rerun.
    let e = j.rerun(&[item(v2, vec![unit("P:b")]), item(1, vec![unit("nope")])], "b", "me").unwrap_err();
    assert_eq!(e.to_string(), "packet nope is gone, not delivered or filtered; nothing was rerun");
    assert_eq!(state(&j, "P:b"), "delivered");

    j.rerun(&[item(v2, vec![unit("P:b")])], "b", "me").unwrap();
    let e = j.rerun(&[item(v2, vec![unit("P:b")])], "b", "me").unwrap_err();
    assert_eq!(e.to_string(), "packet P:b is processing, not delivered or filtered; nothing was rerun");
    let b = j.get("P:b").unwrap().unwrap();
    assert_eq!(
        (b.state.as_str(), b.cursor.as_deref(), b.data.clone(), b.hops, b.version, b.result.clone()),
        ("processing", Some("b"), json!({ "x": 1 }), 1, v2, Value::Null)
    );
    let p = j.get("P").unwrap().unwrap();
    assert_eq!((p.state.as_str(), p.version), (BRANCHED, v2));
    // The sibling that wasn't rerun stays as it was.
    let a = j.get("P:a").unwrap().unwrap();
    assert_eq!((a.state.as_str(), a.version), ("filtered", 1));
    let ev = j.latest_event("P:b", &["packet.rerun"]).unwrap().unwrap();
    assert_eq!(ev.detail, json!({ "by": "me", "from": "b", "version": v2, "was": "delivered", "from_version": 1 }));
    assert_eq!(
        text(j.db(), "SELECT patch FROM events WHERE packet_id = 'P:b' AND type = 'packet.rerun'").unwrap(),
        r#"{"state":"processing","cursor":"b","data":{"x":1},"hops":1,"error":null,"attempt":0,"iteration":0,"result":null}"#
    );
    let ev = j.latest_event("P", &["packet.rerun"]).unwrap().unwrap();
    assert_eq!(ev.detail["was"], "delivered");

    // It settles again once the rerun copy does.
    end(&mut j, "P:b", "delivered", None);
    assert_eq!(state(&j, "P"), "delivered");
}

#[test]
fn input_state_joins_the_intake_transaction() {
    let t = Tmp::new();
    let mut j = Journal::open(t.db()).unwrap();
    let v = j.version("h", "s", "human", None, None).unwrap();
    assert_eq!(j.input_state("watch:*.csv").load().unwrap(), None);
    let mut entries = Map::new();
    entries.insert("a.csv".into(), json!({ "size": 3 }));
    j.input_state("watch:*.csv").baseline(&entries).unwrap();
    assert_eq!(j.input_state("watch:*.csv").load().unwrap(), Some(entries.clone()));
    // A new scope replaces the old one.
    j.input_state("other").baseline(&Map::new()).unwrap();
    assert_eq!(j.input_state("watch:*.csv").load().unwrap(), None);
    assert_eq!(j.input_state("other").load().unwrap(), Some(Map::new()));

    let mut commit = |j: &mut Journal| j.input_state("other").put("cursor", Some(&json!(7)));
    j.insert(&packet("p1", v, json!(1)), "packet.accepted", None, Some(&mut commit)).unwrap();
    assert_eq!(j.input_load("other").unwrap().unwrap()["cursor"], json!(7));

    // A failing commit rolls back the packet and the state write together.
    let mut failing = |j: &mut Journal| -> Result<()> {
        j.input_put("other", "cursor", Some(&json!(8)))?;
        Err("cursor write failed".into())
    };
    let e = j.insert(&packet("p2", v, json!(2)), "packet.accepted", None, Some(&mut failing)).unwrap_err();
    assert_eq!(e.to_string(), "cursor write failed");
    assert_eq!(j.get("p2").unwrap(), None);
    assert_eq!(j.input_load("other").unwrap().unwrap()["cursor"], json!(7));

    j.input_state("other").put("cursor", None).unwrap();
    assert_eq!(j.input_load("other").unwrap(), Some(Map::new()));
}

#[test]
fn each_input_keeps_its_own_state_and_old_scopes_belong_to_input() {
    let t = Tmp::new();
    {
        let mut j = Journal::open(t.db()).unwrap();
        let mut entries = Map::new();
        entries.insert("offset".into(), json!(41));
        // Written as a journal from before D76 would have it: no input prefix.
        j.input_state("telegram:123").baseline(&entries).unwrap();
    }
    let mut j = Journal::open(t.db()).unwrap();
    assert_eq!(j.input_load("telegram:123").unwrap(), None);
    assert_eq!(j.input_load("input|telegram:123").unwrap().unwrap()["offset"], json!(41));
    // A baseline replaces only the same input's scopes (D76).
    j.input_state("hook|watch:/a/*").baseline(&Map::new()).unwrap();
    assert!(j.input_load("input|telegram:123").unwrap().is_some());
    j.input_state("hook|watch:/b/*").baseline(&Map::new()).unwrap();
    assert_eq!(j.input_load("hook|watch:/a/*").unwrap(), None);
    assert!(j.input_load("hook|watch:/b/*").unwrap().is_some());
    assert!(j.input_load("input|telegram:123").unwrap().is_some());
}

#[test]
fn agent_tokens_restart_after_a_replay() {
    let t = Tmp::new();
    let mut j = Journal::open(t.db()).unwrap();
    let usage = |unit: &str, input, output, at| AgentUsage {
        at,
        unit: unit.into(),
        root: "P".into(),
        node: "ai".into(),
        provider: "claude_api".into(),
        model: "m".into(),
        input_tokens: input,
        output_tokens: output,
        cost_usd: 0.5,
        attempt: 1,
    };
    let seq = j.record_agent_usage(&usage("P:a", 10, 5, 100)).unwrap();
    assert_eq!(seq, j.last_seq().unwrap());
    j.record_agent_usage(&usage("P", 1, 1, 200)).unwrap();
    assert_eq!(j.packet_agent_tokens("P").unwrap(), 17);
    // A replay of one of its copies gives the packet a fresh budget; another packet's replay doesn't.
    j.event("dlq.replayed", None, Some("PX"), None).unwrap();
    assert_eq!(j.packet_agent_tokens("P").unwrap(), 17);
    j.event("dlq.replayed", Some(&json!({ "by": "me" })), Some("P:a"), Some("ai")).unwrap();
    assert_eq!(j.packet_agent_tokens("P").unwrap(), 0);
    j.record_agent_usage(&usage("P:a", 3, 4, 300)).unwrap();
    assert_eq!(j.packet_agent_tokens("P").unwrap(), 7);
    // So does a rerun (D79).
    j.event("packet.rerun", Some(&json!({ "by": "me" })), Some("P"), Some("ai")).unwrap();
    assert_eq!(j.packet_agent_tokens("P").unwrap(), 0);
    assert_eq!(j.agent_spend_since(200).unwrap(), 1.0);
    assert_eq!(j.agent_spend_since(1000).unwrap(), 0.0);
    assert_eq!(
        text(j.db(), "SELECT detail FROM events WHERE type = 'agent.usage' ORDER BY seq LIMIT 1").unwrap(),
        r#"{"node":"ai","provider":"claude_api","model":"m","input_tokens":10,"output_tokens":5,"cost_usd":0.5,"attempt":1}"#
    );
}

#[test]
fn stores_json_text_as_javascript_does() {
    let t = Tmp::new();
    let mut j = Journal::open(t.db()).unwrap();
    let v = j.version("h", "s", "human", None, None).unwrap();
    let data: Value = serde_json::from_str(r#"{"n":3,"f":2.0,"list":[1,1.5,-4.0],"z":{"b":null,"a":"x"}}"#).unwrap();
    j.insert(&packet("p1", v, data.clone()), "packet.accepted", None, None).unwrap();
    let db = j.db();
    assert_eq!(
        text(db, "SELECT data FROM packets").unwrap(),
        r#"{"n":3,"f":2,"list":[1,1.5,-4],"z":{"b":null,"a":"x"}}"#
    );
    // TS writes JSON.stringify(null) for a null error, and leaves result unset.
    assert_eq!(text(db, "SELECT error FROM packets").unwrap(), "null");
    assert_eq!(text(db, "SELECT result FROM packets"), None);
    assert_eq!(text(db, "SELECT detail FROM events"), None);
    assert_eq!(
        text(db, "SELECT patch FROM events").unwrap(),
        r#"{"state":"processing","cursor":"a","data":{"n":3,"f":2,"list":[1,1.5,-4],"z":{"b":null,"a":"x"}}}"#
    );

    let patch = PacketPatch {
        result: Some(json!({ "id": 9 })),
        attempt: Some(0),
        hops: Some(2),
        cursor: Some(Some(VERIFY_STEP.into())),
        state: Some("verifying".into()),
        ..Default::default()
    };
    let extra = [ExtraEvent { kind: "output.batch".into(), detail: Some(Value::Null) }];
    j.update("p1", &patch, "output.written", Some(OUTPUT_STEP), Some(&json!({ "batch": 1 })), &extra, Some(12.5))
        .unwrap();
    let db = j.db();
    assert_eq!(
        text(db, "SELECT patch FROM events WHERE type = 'output.written'").unwrap(),
        r#"{"state":"verifying","cursor":"$verify","hops":2,"attempt":0,"result":{"id":9}}"#
    );
    assert_eq!(text(db, "SELECT detail FROM events WHERE type = 'output.batch'").unwrap(), "null");
    assert_eq!(text(db, "SELECT patch FROM events WHERE type = 'output.batch'"), None);
    assert_eq!(text(db, "SELECT result FROM packets").unwrap(), r#"{"id":9}"#);
    assert_eq!(j.step_durations(OUTPUT_STEP, 10).unwrap(), vec![13]);
    let row = j.get("p1").unwrap().unwrap();
    assert_eq!((row.hops, row.result.clone()), (2, json!({ "id": 9 })));
    assert_eq!(serde_json::to_string(&row.error).unwrap(), "null", "a null error reads back as None, like TS's unjson");

    // The rest of the reads.
    assert_eq!(j.in_flight().unwrap().len(), 1);
    assert_eq!(j.oldest_pending_received_at().unwrap(), Some(1000));
    j.update(
        "p1",
        &PacketPatch { attempt: Some(1), ..Default::default() },
        "step.retry",
        Some("a"),
        Some(&json!({ "attempt": 1, "wait": 10, "error": "timed out" })),
        &[],
        None,
    )
    .unwrap();
    let oldest = j.oldest_pending().unwrap().unwrap();
    assert_eq!((oldest.row.id.as_str(), oldest.last_error.as_deref()), ("p1", Some("timed out")));
    assert_eq!(j.accepted_since(1000).unwrap(), 1);
    assert_eq!(j.accepted_since(1001).unwrap(), 0);
    assert_eq!(j.last_delivered_at().unwrap(), None);
    assert_eq!(j.count_escalated().unwrap(), 0);
    j.event("pipeline.started", Some(&json!({ "version": 1 })), None, None).unwrap();
    j.event("pipeline.started", Some(&json!({ "other": 1 })), None, None).unwrap();
    assert_eq!(j.last_pipeline_event("pipeline.started").unwrap().unwrap().detail, json!({ "other": 1 }));
    assert_eq!(
        j.last_pipeline_event_with("pipeline.started", "version").unwrap().unwrap().detail,
        json!({ "version": 1 })
    );
    let after = j.events_after(j.last_seq().unwrap() - 2, 10).unwrap();
    assert_eq!(after.len(), 2);
    assert_eq!((after[0].packet_id.clone(), after[0].kind.as_str()), (None, "pipeline.started"));
    j.set_meta("file_hash", "a").unwrap();
    j.set_meta("file_hash", "b").unwrap();
    assert_eq!(j.meta("file_hash").unwrap().as_deref(), Some("b"));
    assert_eq!(j.meta("nope").unwrap(), None);
}

#[test]
fn versions_commit_start_and_apply() {
    let t = Tmp::new();
    let mut j = Journal::open(t.db()).unwrap();
    let append = |hash: &str| PlannedAppend {
        hash: hash.into(),
        source: format!("source {hash}"),
        reason: "start".into(),
        compiled: Some(format!("{{\"hash\":\"{hash}\"}}")),
    };
    let files: FileHashes = [("./z.json".to_string(), "2".to_string()), ("./a.ts".into(), "1".into())].into();
    let v = j.commit_start(&PlannedStart { latest: None, append: Some(append("h1")) }, "fh", Some(&files)).unwrap();
    assert_eq!(v, 1);
    assert_eq!(text(j.db(), "SELECT files FROM versions").unwrap(), r#"{"./a.ts":"1","./z.json":"2"}"#);
    assert_eq!(text(j.db(), "SELECT author_kind FROM versions").unwrap(), "human");
    assert_eq!(j.version_files(1).unwrap(), Some(files));
    assert_eq!(j.version_compiled(1).unwrap().as_deref(), Some(r#"{"hash":"h1"}"#));
    assert_eq!(j.meta("file_hash").unwrap().as_deref(), Some("fh"));

    let e = j.commit_start(&PlannedStart { latest: None, append: None }, "fh2", None).unwrap_err();
    assert_eq!(e.to_string(), "the journal's latest version is v1, not none, as it was a moment ago");
    assert_eq!(j.meta("file_hash").unwrap().as_deref(), Some("fh"));
    assert_eq!(j.commit_start(&PlannedStart { latest: Some(1), append: None }, "fh2", None).unwrap(), 1);

    let audit = VersionAudit { author_kind: Some("agent".into()), proposal: Some("pr1".into()), files: None };
    let e =
        j.add_version("h2", "two", "bot", None, Some(Applied { expect: 3, previous: 1 }), &audit, None).unwrap_err();
    assert_eq!(e.to_string(), "the journal's next version is v2, not v3; another writer added one");
    let v = j.add_version("h2", "two", "bot", None, Some(Applied { expect: 2, previous: 1 }), &audit, None).unwrap();
    assert_eq!(v, 2);
    assert_eq!(
        text(j.db(), "SELECT detail FROM events WHERE type = 'version.applied'").unwrap(),
        r#"{"version":2,"previous":1,"author":"bot","author_kind":"agent","reason":null,"hash":"h2","proposal":"pr1"}"#
    );
}

#[test]
fn open_readonly_reads_a_journal() {
    let t = Tmp::new();
    let mut j = Journal::open(t.db()).unwrap();
    j.version("h", "s", "human", None, None).unwrap();
    let ro = open_readonly(t.db(), BUSY_RETRY_MS).unwrap();
    let n: i64 = ro.query_row("SELECT count(*) FROM versions", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
    assert!(ro.execute("DELETE FROM versions", []).is_err());
    assert!(open_readonly(t.0.join("missing.db"), 100).is_err());
}

// ── cross-implementation: the TypeScript Journal reads what Rust writes, and the reverse ───────────────────────

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

/// Run a bun script with `Journal` imported from the TS runner and `J` set to the journal path; its stdout.
fn bun(script: &str, journal: &Path) -> Option<String> {
    if Command::new("bun").arg("--version").output().is_err() {
        eprintln!("skipping the cross-implementation check: bun isn't on PATH");
        return None;
    }
    let ts = repo_root().join("packages/runner/src/journal.ts");
    let src = format!("import {{ Journal }} from {:?};\nconst J = process.env.J;\n{script}", ts.to_str().unwrap());
    let out = Command::new("bun").arg("-e").arg(src).env("J", journal).output().expect("bun runs");
    assert!(out.status.success(), "bun failed: {}", String::from_utf8_lossy(&out.stderr));
    Some(String::from_utf8(out.stdout).unwrap())
}

/// The one write TypeScript still makes: the engine journals the stop of a runner it killed (journalStop, D46),
/// opening the Rust-written journal with the TS `Journal`. Rust then reads it back, with nothing else changed.
#[test]
fn typescript_journals_a_stop_and_rust_reads_it() {
    let t = Tmp::new();
    {
        let mut j = Journal::open(t.db()).unwrap();
        let start = PlannedStart {
            latest: None,
            append: Some(PlannedAppend {
                hash: "h1".into(),
                source: "src".into(),
                reason: "start".into(),
                compiled: Some(r#"{"pipeline":{"name":"x"}}"#.into()),
            }),
        };
        j.commit_start(&start, "fh", None).unwrap();
        j.insert(&packet("p1", 1, json!({ "n": 1, "f": 2.5 })), "packet.accepted", None, None).unwrap();
        j.close().unwrap();
    }
    let script = r#"
const j = new Journal(J);
j.event("pipeline.stopped", { reason: "killed after stop_timeout", by: "e1" });
j.close();
"#;
    if bun(script, &t.db()).is_none() {
        return;
    }
    let j = Journal::open(t.db()).unwrap();
    assert_eq!(j.latest_version().unwrap(), Some(LatestVersion { version: 1, hash: "h1".into() }));
    assert_eq!(j.version_compiled(1).unwrap().as_deref(), Some(r#"{"pipeline":{"name":"x"}}"#));
    assert_eq!(j.get("p1").unwrap().unwrap().data, json!({ "n": 1, "f": 2.5 }));
    let last: (String, String) = j
        .db()
        .query_row("SELECT type, detail FROM events WHERE packet_id IS NULL ORDER BY seq DESC LIMIT 1", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(last.0, "pipeline.stopped");
    assert_eq!(
        serde_json::from_str::<Value>(&last.1).unwrap(),
        json!({ "reason": "killed after stop_timeout", "by": "e1" })
    );
}

#[test]
fn rust_writes_and_typescript_reads() {
    let t = Tmp::new();
    {
        let mut j = Journal::open(t.db()).unwrap();
        let files: FileHashes = [("./f.ts".to_string(), "abc".to_string())].into();
        let start = PlannedStart {
            latest: None,
            append: Some(PlannedAppend {
                hash: "h1".into(),
                source: "src".into(),
                reason: "start".into(),
                compiled: Some(r#"{"pipeline":{"name":"x"}}"#.into()),
            }),
        };
        j.commit_start(&start, "fh", Some(&files)).unwrap();
        fanned_out_v1(&mut j);
        end(&mut j, "P:a", "delivered", None);
        end(&mut j, "P:b", "filtered", None);
        j.update(
            "Q",
            &PacketPatch { attempt: Some(1), ..Default::default() },
            "step.retry",
            Some("a"),
            Some(&json!({ "error": "slow" })),
            &[],
            Some(7.0),
        )
        .unwrap();
        j.input_state("s").baseline(&[("k".to_string(), json!([1, 2]))].into_iter().collect()).unwrap();
        j.close().unwrap();
    }
    let script = r#"
const j = new Journal(J);
console.log(JSON.stringify({
  compiled: j.db.query("SELECT compiled FROM versions WHERE version = 1").get().compiled,
  P: j.get("P"),
  copies: ["P:a", "P:b"].map((id) => j.get(id)).map((c) => [c.id, c.state, c.root, c.parent, c.branch]),
  events: j.events("P").map((e) => e.type),
}));
j.close();
"#;
    let Some(out) = bun(script, &t.db()) else { return };
    let got: Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(got["compiled"], r#"{"pipeline":{"name":"x"}}"#);
    let p = &got["P"];
    assert_eq!(
        (&p["state"], &p["cursor"], &p["error"], &p["data"]),
        (&json!("delivered"), &Value::Null, &Value::Null, &json!({ "x": 1 }))
    );
    // Rust's PacketRow serializes in the same key order as TS's decoded row.
    let rust_row = serde_json::to_value(Journal::open(t.db()).unwrap().get("P").unwrap().unwrap()).unwrap();
    assert_eq!(
        rust_row.as_object().unwrap().keys().collect::<Vec<_>>(),
        p.as_object().unwrap().keys().collect::<Vec<_>>()
    );
    assert_eq!(&rust_row, p);
    assert_eq!(got["copies"], json!([["P:a", "delivered", "P", "P", "a"], ["P:b", "filtered", "P", "P", "b"]]));
    assert_eq!(got["events"], json!(["packet.accepted", "packet.fanned_out", "packet.delivered"]));
}

/// `fanned_out` on a journal that already has version 1, plus a second packet `Q` in flight.
fn fanned_out_v1(j: &mut Journal) {
    j.insert(&packet("Q", 1, json!({ "q": true })), "packet.accepted", None, None).unwrap();
    fanned_out(j);
}
