// The `stats` expression context (docs/spec.md §3.2) and the built-in metrics of §7.6 (D54). Port of stats.ts:
// counts come from the journal, so they survive restarts. Counts are per packet: branch copies don't count (D22).

use crate::journal::{Journal, OUTPUT_STEP};
use crate::time::iso;
use serde::Serialize;
use serde_json::{Map, Value, json};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Stats {
    pub accepted: i64,
    pub delivered: i64,
    pub pending: i64,
    pub escalated: i64,
    pub dead_lettered: i64,
    pub uptime: i64,
    pub in_per_min: i64,
    pub last_delivery_at: Option<String>,
}

impl Stats {
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("stats serialize")
    }
}

pub fn compute_stats(journal: &Journal, started_at: i64, now: i64) -> Result<Stats, String> {
    let c = journal.counts()?;
    let n = |s: &str| c.get(s).copied().unwrap_or(0);
    let accepted: i64 = c.iter().filter(|(state, _)| state.as_str() != "rejected").map(|(_, k)| *k).sum();
    Ok(Stats {
        accepted,
        delivered: n("delivered"),
        pending: accepted - n("delivered") - n("filtered") - n("dead_lettered"),
        escalated: journal.count_escalated()?,
        dead_lettered: n("dead_lettered"),
        uptime: ((now - started_at) / 1000).max(0),
        in_per_min: journal.accepted_since(now - 60_000)?,
        last_delivery_at: journal.last_delivered_at()?.map(iso),
    })
}

/// Completed steps per node that latency is computed over: the latest ones, whatever their age (D54).
pub const LATENCY_WINDOW: i64 = 100;

/// Nearest-rank percentile of sorted samples.
pub fn percentile(sorted: &[i64], p: f64) -> Option<i64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    Some(sorted[rank.clamp(1, sorted.len()) - 1])
}

pub fn node_latency(samples: &[i64]) -> Value {
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    json!({
        "count": sorted.len(),
        "p50_ms": percentile(&sorted, 50.0),
        "p95_ms": percentile(&sorted, 95.0),
        "max_ms": sorted.last(),
    })
}

/// `nodes` are the node ids of the version in force; `output` is the output step's write.
pub fn compute_metrics(journal: &Journal, nodes: &[String], now: i64) -> Result<Value, String> {
    let mut latency = Map::new();
    for id in nodes {
        latency.insert(id.clone(), node_latency(&journal.step_durations(id, LATENCY_WINDOW)?));
    }
    latency.insert("output".into(), node_latency(&journal.step_durations(OUTPUT_STEP, LATENCY_WINDOW)?));
    let at = journal.oldest_pending_received_at()?;
    Ok(json!({
        "latency": latency,
        "latency_window": LATENCY_WINDOW,
        "oldest_pending_age_ms": at.map(|a| (now - a).max(0)),
        "oldest_pending_received_at": at.map(iso),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_rank() {
        let s: Vec<i64> = (1..=10).collect();
        assert_eq!(percentile(&s, 50.0), Some(5));
        assert_eq!(percentile(&s, 95.0), Some(10));
        assert_eq!(percentile(&[], 50.0), None);
        assert_eq!(node_latency(&[3, 1, 2]), json!({"count": 3, "p50_ms": 2, "p95_ms": 3, "max_ms": 3}));
        let hundred: Vec<i64> = (1..=100).rev().collect();
        assert_eq!(node_latency(&hundred), json!({"count": 100, "p50_ms": 50, "p95_ms": 95, "max_ms": 100}));
        assert_eq!(node_latency(&[7]), json!({"count": 1, "p50_ms": 7, "p95_ms": 7, "max_ms": 7}));
        assert_eq!(node_latency(&[10, 30]), json!({"count": 2, "p50_ms": 10, "p95_ms": 30, "max_ms": 30}));
        assert_eq!(node_latency(&[]), json!({"count": 0, "p50_ms": null, "p95_ms": null, "max_ms": null}));
        assert_eq!(percentile(&[1, 2, 3, 4], 0.0), Some(1));
    }

    fn journal(dir: &crate::connectors::test_util::TempDir) -> (Journal, i64) {
        let mut j = Journal::open(dir.join("journal.db")).unwrap();
        let v = j.version("h1", "pipo: 1\n", "human", None, None).unwrap();
        (j, v)
    }

    fn add(j: &mut Journal, v: i64, id: &str, state: &str, received_at: i64) {
        let p = crate::journal::NewPacket {
            id: id.into(),
            version: v,
            state: state.into(),
            cursor: None,
            data: json!({}),
            trigger: "push".into(),
            source: "t".into(),
            error: None,
            received_at,
            input: "input".into(),
            upstream: serde_json::Value::Null,
        };
        j.insert(&p, "packet.accepted", None, None).unwrap();
    }

    #[test]
    fn in_per_min_is_the_last_60_s_and_last_delivery_at_outlives_the_window() {
        let dir = crate::connectors::test_util::TempDir::new();
        let (mut j, v) = journal(&dir);
        let now = crate::time::now_ms();
        let s = compute_stats(&j, now, now).unwrap();
        assert_eq!((s.in_per_min, s.last_delivery_at.clone()), (0, None));
        for (i, state) in ["delivered", "delivered", "rejected", "processing"].iter().enumerate() {
            add(&mut j, v, &format!("p{i}"), state, now - 1000);
        }
        let s = compute_stats(&j, now - 5000, now).unwrap();
        assert_eq!((s.accepted, s.delivered, s.pending, s.uptime, s.in_per_min), (3, 2, 1, 5, 3));
        let delivered = s.last_delivery_at.clone().unwrap();
        // A minute later the window is empty, but the last delivery is still known.
        let later = compute_stats(&j, now - 5000, now + 61_000).unwrap();
        assert_eq!(later.in_per_min, 0);
        assert_eq!(later.last_delivery_at, Some(delivered));
    }

    #[test]
    fn latency_covers_the_latest_window_of_completed_steps_per_node_and_output_is_the_output_step() {
        use crate::journal::PacketPatch;
        let dir = crate::connectors::test_util::TempDir::new();
        let (mut j, v) = journal(&dir);
        add(&mut j, v, "p1", "processing", 1000);
        let attempt = |a| PacketPatch { attempt: Some(a), ..Default::default() };
        // 150 completed steps at `a` taking 0..149 ms: only the newest 100 (50..149) count.
        for i in 0..150 {
            j.update("p1", &attempt(0), "node.done", Some("a"), None, &[], Some(i as f64)).unwrap();
        }
        // Events at `a` without a duration (retries, logs) are not samples.
        j.update("p1", &attempt(1), "step.retry", Some("a"), Some(&json!({"attempt": 1})), &[], None).unwrap();
        j.event("log", Some(&json!({"message": "x"})), Some("p1"), Some("a")).unwrap();
        j.update("p1", &attempt(0), "output.written", Some(OUTPUT_STEP), None, &[], Some(12.6)).unwrap();
        let m = compute_metrics(&j, &["a".into(), "b".into()], 5000).unwrap();
        assert_eq!(m["latency_window"], json!(LATENCY_WINDOW));
        assert_eq!(m["latency"]["a"], json!({"count": 100, "p50_ms": 99, "p95_ms": 144, "max_ms": 149}));
        // A node of the version in force with no completed step yet still has a row.
        assert_eq!(m["latency"]["b"], json!({"count": 0, "p50_ms": null, "p95_ms": null, "max_ms": null}));
        assert_eq!(m["latency"]["output"], json!({"count": 1, "p50_ms": 13, "p95_ms": 13, "max_ms": 13}));
        // The window read is an indexed one.
        let plan: Vec<String> = j
            .db()
            .prepare(
                "EXPLAIN QUERY PLAN SELECT ms FROM events WHERE node = ? AND ms IS NOT NULL ORDER BY seq DESC LIMIT ?",
            )
            .unwrap()
            .query_map(rusqlite::params!["a", 100], |r| r.get::<_, String>(3))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(plan.join(" ").contains("events_node_ms"), "{plan:?}");
    }

    #[test]
    fn oldest_pending_age_counts_every_non_terminal_packet_and_is_null_when_none() {
        use crate::journal::PacketPatch;
        let dir = crate::connectors::test_util::TempDir::new();
        let (mut j, v) = journal(&dir);
        let m = compute_metrics(&j, &[], 5000).unwrap();
        assert_eq!(
            (m["oldest_pending_age_ms"].clone(), m["oldest_pending_received_at"].clone()),
            (json!(null), json!(null))
        );
        add(&mut j, v, "done", "delivered", 100);
        add(&mut j, v, "dead", "dead_lettered", 200);
        add(&mut j, v, "bad", "rejected", 300);
        assert_eq!(compute_metrics(&j, &[], 5000).unwrap()["oldest_pending_age_ms"], json!(null));
        add(&mut j, v, "busy", "processing", 2000);
        add(&mut j, v, "waiting", "escalated", 1500);
        add(&mut j, v, "forked", "branched", 1800);
        let m = compute_metrics(&j, &[], 5000).unwrap();
        assert_eq!(m["oldest_pending_age_ms"], json!(3500));
        assert_eq!(m["oldest_pending_received_at"], json!("1970-01-01T00:00:01.500Z"));
        let drop = PacketPatch { state: Some("filtered".into()), cursor: Some(None), ..Default::default() };
        j.update("waiting", &drop, "packet.dropped", None, None, &[], None).unwrap();
        assert_eq!(compute_metrics(&j, &[], 5000).unwrap()["oldest_pending_age_ms"], json!(3200));
        // A clock behind the journal never gives a negative age.
        assert_eq!(compute_metrics(&j, &[], 0).unwrap()["oldest_pending_age_ms"], json!(0));
    }
}
