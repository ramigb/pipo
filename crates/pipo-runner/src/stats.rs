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
    }
}
