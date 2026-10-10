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
    let ms = |v: Option<&String>, fallback: &str| parse_duration(v.map(String::as_str).unwrap_or(fallback)).unwrap_or(0) as i64;
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
            args.push(BATCH.into());
            let tx = db.unchecked_transaction()?;
            let n = tx.execute(&sql, params_from_iter(args))?;
            tx.commit()?;
            out.cleared += n;
            if (n as i64) < BATCH {
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
            args.push(BATCH.into());
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
