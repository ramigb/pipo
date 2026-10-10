// Pipeline state the journal carries across a crash (docs/spec.md §2.2, §3.8, §7.3, D32). Port of
// lifecycle-state.ts: a pipeline paused when its runner died comes back paused with the same reason, and a
// `lifetime.ttl` counts from the lifetime's anchor, not from this run.

use crate::duration::parse_duration;
use crate::journal::Journal;
use rusqlite::OptionalExtension;
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct JournaledPause {
    /// `manual`, `agent`, `stall`, `error at <step>`, `budget`… as journaled.
    pub reason: String,
    /// The rest of the `pipeline.paused` detail, kept as journaled.
    pub detail: Map<String, Value>,
    pub at: i64,
}

/// The pause still in force: the last `pipeline.paused` with no later resume, stop or failure.
pub fn journaled_pause(journal: &Journal) -> Option<JournaledPause> {
    let row: Option<(String, i64, Option<String>)> = journal
        .db()
        .query_row(
            "SELECT type, at, detail FROM events WHERE packet_id IS NULL AND type IN ('pipeline.paused', 'pipeline.resumed', 'pipeline.stopped', 'pipeline.failed') ORDER BY seq DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .ok()
        .flatten();
    let (kind, at, detail) = row?;
    if kind != "pipeline.paused" {
        return None;
    }
    let mut detail = detail
        .and_then(|d| serde_json::from_str::<Value>(&d).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let reason = detail.remove("reason").and_then(|r| r.as_str().filter(|s| !s.is_empty()).map(str::to_owned));
    detail.remove("restored");
    Some(JournaledPause { reason: reason.unwrap_or_else(|| "manual".into()), detail, at })
}

/// When the current lifetime began (ms): the first `pipeline.started` after the last clean end (stopped, failed,
/// completed), or the first ever. None before this run journaled its own `pipeline.started`.
pub fn lifetime_anchor(journal: &Journal) -> Option<i64> {
    journal
        .db()
        .query_row(
            "SELECT at FROM events WHERE packet_id IS NULL AND type = 'pipeline.started' AND seq > COALESCE(
               (SELECT MAX(seq) FROM events WHERE packet_id IS NULL AND type IN ('pipeline.stopped', 'pipeline.failed', 'pipeline.completed')), 0)
             ORDER BY seq LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
}

/// Why `text` can't be a start's ttl override (`pipo start --ttl`, D57), or None when it can.
pub fn ttl_override_problem(text: &str) -> Option<String> {
    match parse_duration(text) {
        Err(_) => Some(format!("ttl '{text}' is not a duration")),
        Ok(ms) if ms < 1 => Some(format!("ttl '{text}' must be longer than 0")),
        Ok(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::test_util::TempDir;

    #[test]
    fn lifetime_anchor_is_the_first_start_after_the_last_clean_stop_halt_or_completion() {
        let dir = TempDir::new();
        let journal = Journal::open(dir.join("journal.db")).unwrap();
        let at = |kind: &str, ms: i64| {
            journal.event(kind, None, None, None).unwrap();
            journal.db().execute("UPDATE events SET at = ?1 WHERE seq = (SELECT MAX(seq) FROM events)", [ms]).unwrap();
        };
        assert_eq!(lifetime_anchor(&journal), None);
        at("pipeline.started", 1000);
        assert_eq!(lifetime_anchor(&journal), Some(1000));
        // A crash writes no end: the restarts keep the first start.
        at("pipeline.paused", 1500);
        at("pipeline.started", 2000);
        at("pipeline.draining", 2500);
        at("pipeline.started", 3000);
        assert_eq!(lifetime_anchor(&journal), Some(1000));
        // A packet's events never count, whatever their type.
        journal.event("pipeline.stopped", None, Some("some-packet"), None).unwrap();
        assert_eq!(lifetime_anchor(&journal), Some(1000));
        // A clean stop ends the lifetime: until the next start there is no anchor, then that start is it.
        at("pipeline.stopped", 4000);
        assert_eq!(lifetime_anchor(&journal), None);
        at("pipeline.started", 5000);
        at("pipeline.started", 6000);
        assert_eq!(lifetime_anchor(&journal), Some(5000));
        // A halt ends it too, and so does a completion.
        at("pipeline.failed", 7000);
        at("pipeline.started", 8000);
        assert_eq!(lifetime_anchor(&journal), Some(8000));
        at("pipeline.completed", 9000);
        at("pipeline.started", 10_000);
        assert_eq!(lifetime_anchor(&journal), Some(10_000));
    }

    #[test]
    fn ttl_overrides_must_be_positive_durations() {
        assert_eq!(ttl_override_problem("2h"), None);
        assert_eq!(ttl_override_problem("soon").unwrap(), "ttl 'soon' is not a duration");
        assert!(ttl_override_problem("0s").unwrap().contains("must be longer than 0"));
    }
}
