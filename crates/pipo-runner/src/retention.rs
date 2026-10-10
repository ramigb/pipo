// Retention clean-up and daily compaction (docs/spec.md §3.12, D39). Port of retention.ts. Only settled packets
// are touched: pending ones, versions and pipeline-level events (pause/resume state) are kept.

use crate::duration::parse_duration;
use crate::pipeline::Retention;
use rusqlite::{Connection, OptionalExtension, params_from_iter};

const DAY: i64 = 86_400_000;
const BATCH: i64 = 500;
/// Time between clean-up passes.
pub const INTERVAL_MS: u64 = 600_000;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RetentionPolicy {
    pub data: i64,
    pub trail: i64,
    pub rejected: i64,
    /// None keeps dead letters until they are handled.
    pub dlq: Option<i64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct RetentionResult {
    pub cleared: usize,
    pub deleted: usize,
    pub events: usize,
}

pub fn retention_policy(spec: Option<&Retention>) -> RetentionPolicy {
    let ms = |v: Option<&String>, fallback: &str| {
        parse_duration(v.map(String::as_str).unwrap_or(fallback)).unwrap_or(0) as i64
    };
    RetentionPolicy {
        data: ms(spec.and_then(|s| s.data.as_ref()), "7d"),
        trail: ms(spec.and_then(|s| s.trail.as_ref()), "30d"),
        rejected: ms(spec.and_then(|s| s.rejected.as_ref()), "3d"),
        dlq: match spec.and_then(|s| s.dlq.as_deref()) {
            None | Some("forever") => None,
            Some(d) => parse_duration(d).ok().map(|v| v as i64),
        },
    }
}

fn marks(n: usize) -> String {
    vec!["?"; n].join(",")
}

/// One clean-up pass: bounded batches, each in its own transaction. Rerunning it is a no-op.
pub fn apply_retention(db: &Connection, policy: &RetentionPolicy, now: i64) -> rusqlite::Result<RetentionResult> {
    apply_retention_in(db, policy, now, BATCH)
}

fn apply_retention_in(
    db: &Connection,
    policy: &RetentionPolicy,
    now: i64,
    batch: i64,
) -> rusqlite::Result<RetentionResult> {
    let mut out = RetentionResult::default();
    let clear = |states: &[&str], older_than: i64, out: &mut RetentionResult| -> rusqlite::Result<()> {
        let sql = format!(
            "UPDATE packets SET data = NULL, result = NULL WHERE id IN (
               SELECT id FROM packets WHERE state IN ({}) AND updated_at < ? AND (data IS NOT NULL OR result IS NOT NULL) LIMIT ?)",
            marks(states.len())
        );
        loop {
            let mut args: Vec<rusqlite::types::Value> = states.iter().map(|s| s.to_string().into()).collect();
            args.push(older_than.into());
            args.push(batch.into());
            let tx = db.unchecked_transaction()?;
            let n = tx.execute(&sql, params_from_iter(args))?;
            tx.commit()?;
            out.cleared += n;
            if (n as i64) < batch {
                return Ok(());
            }
        }
    };
    // Leaves first: a packet with fan-out copies stays until its copies are gone.
    let remove = |states: &[&str], older_than: i64, out: &mut RetentionResult| -> rusqlite::Result<()> {
        let sql = format!(
            "SELECT id FROM packets p WHERE state IN ({}) AND updated_at < ?
               AND NOT EXISTS (SELECT 1 FROM packets c WHERE c.parent = p.id) LIMIT ?",
            marks(states.len())
        );
        loop {
            let mut args: Vec<rusqlite::types::Value> = states.iter().map(|s| s.to_string().into()).collect();
            args.push(older_than.into());
            args.push(batch.into());
            let ids: Vec<String> =
                db.prepare(&sql)?.query_map(params_from_iter(args), |r| r.get(0))?.collect::<Result<_, _>>()?;
            if ids.is_empty() {
                return Ok(());
            }
            let tx = db.unchecked_transaction()?;
            for id in &ids {
                out.events += tx.execute("DELETE FROM events WHERE packet_id = ?", [id])?;
                out.deleted += tx.execute("DELETE FROM packets WHERE id = ?", [id])?;
            }
            tx.commit()?;
        }
    };
    clear(&["delivered", "filtered"], now - policy.data, &mut out)?;
    clear(&["rejected"], now - policy.rejected, &mut out)?;
    remove(&["delivered", "filtered", "rejected"], now - policy.trail, &mut out)?;
    if let Some(dlq) = policy.dlq {
        remove(&["dead_lettered"], now - dlq, &mut out)?;
    }
    Ok(out)
}

/// Checkpoint the WAL and rebuild the file. VACUUM needs a quiet moment, so a busy database waits for the next tick.
pub fn compact(db: &Connection) -> bool {
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;").is_ok()
}

/// One retention tick: a pass, then a compaction when a day has passed since the last. Returns what it did when it
/// removed something or compacted; errors (a closing or locked database) skip the tick.
pub fn tick(db: &Connection, policy: &RetentionPolicy, now: i64) -> Option<(RetentionResult, bool)> {
    let run = || -> rusqlite::Result<(RetentionResult, bool)> {
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS retention_state (id INTEGER PRIMARY KEY CHECK (id = 1), compacted_at INTEGER NOT NULL)",
        )?;
        let result = apply_retention(db, policy, now)?;
        let last: Option<i64> =
            db.query_row("SELECT compacted_at FROM retention_state WHERE id = 1", [], |r| r.get(0)).optional()?;
        let mut compacted = false;
        match last {
            // First start: begin the daily cycle without a rebuild.
            None => {
                db.execute("INSERT OR REPLACE INTO retention_state (id, compacted_at) VALUES (1, ?)", [now])?;
            }
            Some(at) if now - at >= DAY && compact(db) => {
                db.execute("INSERT OR REPLACE INTO retention_state (id, compacted_at) VALUES (1, ?)", [now])?;
                compacted = true;
            }
            _ => {}
        }
        Ok((result, compacted))
    };
    match run() {
        Ok((r, compacted)) if compacted || r.cleared > 0 || r.deleted > 0 => Some((r, compacted)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 100 * DAY;

    fn open() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE versions (version INTEGER PRIMARY KEY);
             CREATE TABLE packets (id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL,
               data TEXT, result TEXT, updated_at INTEGER NOT NULL, parent TEXT);
             CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, packet_id TEXT, type TEXT);
             INSERT INTO versions VALUES (1);",
        )
        .unwrap();
        db
    }

    fn add(db: &Connection, id: &str, state: &str, age_days: i64, parent: Option<&str>) {
        let at = NOW - age_days * DAY;
        db.execute(
            "INSERT INTO packets (id, state, data, result, updated_at, parent) VALUES (?, ?, '{}', '{}', ?, ?)",
            rusqlite::params![id, state, at, parent],
        )
        .unwrap();
        db.execute("INSERT INTO events (at, packet_id, type) VALUES (?, ?, 'x')", rusqlite::params![at, id]).unwrap();
    }

    fn ids(db: &Connection) -> Vec<String> {
        let mut stmt = db.prepare("SELECT id FROM packets ORDER BY id").unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    }

    fn has_data(db: &Connection, id: &str) -> bool {
        db.query_row("SELECT data IS NOT NULL FROM packets WHERE id = ?", [id], |r| r.get(0)).unwrap()
    }

    fn count(db: &Connection, sql: &str) -> i64 {
        db.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn policy(data: &str, trail: &str, rejected: &str, dlq: Option<&str>) -> RetentionPolicy {
        retention_policy(Some(&Retention {
            data: Some(data.into()),
            trail: Some(trail.into()),
            rejected: Some(rejected.into()),
            dlq: dlq.map(Into::into),
        }))
    }

    #[test]
    fn defaults_7d_data_30d_trail_3d_rejected_dead_letters_kept() {
        let db = open();
        add(&db, "d-new", "delivered", 1, None);
        add(&db, "d-mid", "delivered", 10, None);
        add(&db, "d-old", "delivered", 31, None);
        add(&db, "f-mid", "filtered", 8, None);
        add(&db, "r-new", "rejected", 1, None);
        add(&db, "r-mid", "rejected", 4, None);
        add(&db, "dl", "dead_lettered", 400, None);
        let res = apply_retention(&db, &retention_policy(None), NOW).unwrap();
        assert_eq!(ids(&db), ["d-mid", "d-new", "dl", "f-mid", "r-mid", "r-new"]);
        assert!(has_data(&db, "d-new"));
        assert!(!has_data(&db, "d-mid"));
        assert!(!has_data(&db, "f-mid"));
        assert!(has_data(&db, "r-new"));
        assert!(!has_data(&db, "r-mid"));
        assert!(has_data(&db, "dl"));
        assert_eq!((res.deleted, res.events), (1, 1));
        assert_eq!(count(&db, "SELECT COUNT(*) FROM events WHERE packet_id = 'd-old'"), 0);
    }

    #[test]
    fn custom_durations_including_a_dlq_expiry() {
        let db = open();
        add(&db, "d", "delivered", 3, None);
        add(&db, "dl-old", "dead_lettered", 6, None);
        add(&db, "dl-new", "dead_lettered", 1, None);
        apply_retention(&db, &policy("1d", "2d", "3d", Some("5d")), NOW).unwrap();
        assert_eq!(ids(&db), ["dl-new"]);
        assert_eq!(policy("1d", "2d", "3d", Some("forever")).dlq, None);
    }

    #[test]
    fn pending_in_flight_and_awaiting_delivery_packets_and_versions_are_never_touched() {
        let db = open();
        for s in ["accepted", "processing", "writing", "verifying", "fanned_out", "escalated", "branched"] {
            add(&db, s, s, 1000, None);
        }
        apply_retention(&db, &policy("1ms", "1ms", "1ms", Some("1ms")), NOW).unwrap();
        assert_eq!(ids(&db).len(), 7);
        assert!(has_data(&db, "accepted"));
        assert_eq!(count(&db, "SELECT COUNT(*) FROM versions"), 1);
    }

    #[test]
    fn fan_out_parents_wait_for_their_copies_and_unrelated_events_are_kept() {
        let db = open();
        add(&db, "p", "delivered", 40, None);
        add(&db, "p#a", "processing", 40, Some("p"));
        db.execute("INSERT INTO events (at, packet_id, type) VALUES (1, NULL, 'pipeline.paused')", []).unwrap();
        apply_retention(&db, &retention_policy(None), NOW).unwrap();
        assert_eq!(ids(&db), ["p", "p#a"]);
        db.execute("UPDATE packets SET state = 'delivered' WHERE id = 'p#a'", []).unwrap();
        apply_retention(&db, &retention_policy(None), NOW).unwrap();
        assert!(ids(&db).is_empty());
        assert_eq!(count(&db, "SELECT COUNT(*) FROM events"), 1);
    }

    #[test]
    fn bounded_batches_drain_everything_and_a_rerun_is_a_no_op() {
        let db = open();
        for i in 0..25 {
            add(&db, &format!("d{i}"), "delivered", 40, None);
        }
        let first = apply_retention_in(&db, &retention_policy(None), NOW, 4).unwrap();
        assert_eq!((first.deleted, first.events), (25, 25));
        assert_eq!(apply_retention_in(&db, &retention_policy(None), NOW, 4).unwrap(), RetentionResult::default());
    }

    #[test]
    fn compaction_runs_once_per_day() {
        let dir = std::env::temp_dir().join(format!("pipo-retention-{}", crate::ids::ulid().to_lowercase()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = open_at(&dir);
        let p = retention_policy(None);
        let stamp = |db: &Connection| count(db, "SELECT compacted_at FROM retention_state");
        // The first tick starts the daily cycle without a rebuild.
        assert_eq!(tick(&db, &p, NOW), None);
        assert_eq!(stamp(&db), NOW);
        assert_eq!(tick(&db, &p, NOW + DAY - 1), None);
        assert_eq!(stamp(&db), NOW);
        add(&db, "old", "delivered", 40, None);
        let (res, compacted) = tick(&db, &p, NOW + DAY).unwrap();
        assert!(compacted);
        assert_eq!(res.deleted, 1);
        assert_eq!(stamp(&db), NOW + DAY);
        assert_eq!(tick(&db, &p, NOW + DAY + DAY / 2), None);
        assert_eq!(stamp(&db), NOW + DAY);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// On a file in WAL mode, as a journal is, so the checkpoint and VACUUM do real work.
    fn open_at(dir: &std::path::Path) -> Connection {
        let db = Connection::open(dir.join("j.db")).unwrap();
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE versions (version INTEGER PRIMARY KEY);
             CREATE TABLE packets (id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL,
               data TEXT, result TEXT, updated_at INTEGER NOT NULL, parent TEXT);
             CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, packet_id TEXT, type TEXT);
             INSERT INTO versions VALUES (1);",
        )
        .unwrap();
        db
    }
}
