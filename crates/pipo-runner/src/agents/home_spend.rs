// The engine-wide agent budget (docs/spec.md §3.11, D58): the spend of every pipeline of one Pipo home, summed from the
// `agent_spend` rows of each `<home>/pipelines/*/journal.db`, the others opened read-only. Port of agents/home-spend.ts
// (`homeAgentBudget` stays TS: it reads config.yaml).

use super::round;
use super::window::{BudgetWindow, budget_window};
use crate::journal::{BUSY_RETRY_MS, open_readonly};
use crate::time::iso;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;

/// USD spent on agent calls at or after `since` (ms), per pipeline name; `own` (name, connection) is read through
/// its open connection. A journal that can't be read is an error, never $0.
pub fn home_agent_spend(
    home: &Path,
    since: i64,
    own: Option<(&str, &Connection)>,
) -> Result<BTreeMap<String, f64>, String> {
    let dir = home.join("pipelines");
    let mut out = BTreeMap::new();
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter_map(|e| e.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    for name in names {
        if let Some((own_name, db)) = own.filter(|(n, _)| *n == name) {
            out.insert(own_name.to_string(), sum_since(db, since).map_err(|e| e.to_string())?);
            continue;
        }
        let path = dir.join(&name).join("journal.db");
        if !path.exists() {
            continue;
        }
        let read = open_readonly(&path, BUSY_RETRY_MS)
            .map_err(|e| e.to_string())
            .and_then(|db| sum_since(&db, since).map_err(|e| e.to_string()));
        match read {
            Ok(c) => {
                out.insert(name, c);
            }
            // A journal from before agent nodes (D36) has spent nothing; anything else must not be read as $0.
            Err(e) if e.to_lowercase().contains("no such table") => {}
            Err(e) => return Err(format!("cannot read the agent spend of '{name}' from {}: {e}", path.display())),
        }
    }
    if let Some((name, db)) = own
        && !out.contains_key(name)
    {
        out.insert(name.to_string(), sum_since(db, since).map_err(|e| e.to_string())?);
    }
    Ok(out)
}

fn sum_since(db: &Connection, since: i64) -> rusqlite::Result<f64> {
    db.query_row("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM agent_spend WHERE at >= ?", [since], |r| r.get(0))
}

/// What `pipo status` and `GET /api/agent-budget` show (D58).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EngineSpend {
    /// `engine.agent_budget.per_day` (USD), or None when the engine config sets none.
    pub per_day: Option<f64>,
    /// USD spent by every pipeline of the home in the current engine budget day.
    pub spent_usd: f64,
    /// The engine budget day: a calendar day in `engine.timezone`, from midnight (ISO).
    pub window_start: String,
    pub resets_at: String,
    pub timezone: String,
    /// Per pipeline name, in the same day (pipelines that spent nothing are left out).
    pub pipelines: BTreeMap<String, f64>,
}

/// The engine budget day containing `now`: engine-wide, so midnight in `engine.timezone` (no `reset_at`).
pub fn engine_window(now: i64, timezone: &str) -> BudgetWindow {
    budget_window(now, timezone, None)
}

pub fn engine_spend(home: &Path, per_day: Option<f64>, timezone: &str, now: i64) -> Result<EngineSpend, String> {
    let w = engine_window(now, timezone);
    let per = home_agent_spend(home, w.start, None)?;
    Ok(EngineSpend {
        per_day,
        spent_usd: round(per.values().sum()),
        window_start: iso(w.start),
        resets_at: iso(w.end),
        timezone: timezone.to_string(),
        pipelines: per.into_iter().filter(|(_, v)| *v > 0.0).map(|(k, v)| (k, round(v))).collect(),
    })
}
