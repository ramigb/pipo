// `agent_budget` (docs/spec.md §3.11, D37, D58). Port of agents/budget.ts. Every number comes from the journal's
// `agent_spend` rows, so a restart (clean or a crash) never resets a packet's tokens or the day's spend. The runner
// applies the outcomes: a `budget.packet` dead letter, a `budget` pause until the next window, a `budget.warning`
// event. The engine-wide cap is checked the same way, against the sum of every journal of the home.

use super::home_spend::home_agent_spend;
use super::round;
use super::window::{BudgetWindow, window_in, zone};
use crate::journal::Journal;
use crate::pipeline::AgentBudget as BudgetLimits;
use crate::time::{iso, parse_iso};
use jiff::tz::TimeZone;
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

/// Which cap a `budget` pause came from: the pipeline's `agent_budget.per_day`, or `engine.agent_budget.per_day`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetCap {
    Pipeline,
    Engine,
}

/// A budget limit stops the call; never retried.
#[derive(Debug, Clone, PartialEq)]
pub struct BudgetStop {
    /// `packet` or `day`.
    pub kind: &'static str,
    pub message: String,
    pub detail: Map<String, Value>,
}

/// A budget check that stopped the call, or couldn't be made (a journal read failed: a node error, never $0).
#[derive(Debug, Clone, PartialEq)]
pub enum BudgetError {
    Stop(BudgetStop),
    Failed(String),
}

pub fn packet_stop(used: u64, per_packet: u64) -> BudgetStop {
    let mut detail = Map::new();
    detail.insert("tokens".into(), used.into());
    detail.insert("per_packet".into(), per_packet.into());
    BudgetStop {
        kind: "packet",
        message: format!("packet used {used} agent tokens, reaching agent_budget.per_packet ({per_packet})"),
        detail,
    }
}

/// The engine-wide cap (D58).
#[derive(Debug, Clone, PartialEq)]
pub struct EngineCap {
    /// The Pipo home whose pipeline journals share the cap.
    pub home: PathBuf,
    /// This pipeline's name: its own spend is read through its open journal.
    pub name: String,
    pub per_day: f64,
}

#[derive(Debug, Clone, Default)]
pub struct BudgetState {
    /// Start of the window a manual `pipo resume` overrode the daily cap for (§3.11): no budget pause until it ends.
    pub override_start: Option<i64>,
    /// Start of the engine budget day a manual resume of an engine-cap pause overrode (D58).
    pub engine_override: Option<i64>,
    /// Start of the window a `budget.warning` was already emitted for.
    pub warned: Option<i64>,
}

pub struct AgentBudget {
    pub journal: Rc<RefCell<Journal>>,
    /// The limits of the version in force (they change with a live apply).
    pub limits: Rc<dyn Fn() -> Option<BudgetLimits>>,
    pub timezone: String,
    pub now: Rc<dyn Fn() -> i64>,
    pub engine: Option<EngineCap>,
    pub state: RefCell<BudgetState>,
    zone: TimeZone,
}

/// `$n` with 4 decimals under a dollar, else 2 (budget.ts `usd`).
fn usd(n: f64) -> String {
    format!("${}", to_fixed(n, if n < 1.0 { 4 } else { 2 }))
}

/// `Number.prototype.toFixed`: an exact tie rounds up, where Rust's formatting rounds it to even.
fn to_fixed(n: f64, digits: usize) -> String {
    let exact = format!("{:.60}", n.abs());
    let frac = exact.split_once('.').map(|(_, f)| f).unwrap_or("");
    let tie = frac.get(digits..digits + 1) == Some("5") && frac[digits + 1..].bytes().all(|b| b == b'0');
    let n = if tie { if n > 0.0 { n.next_up() } else { n.next_down() } } else { n };
    format!("{n:.digits$}")
}

fn number(n: f64) -> Value {
    crate::expr::js_number(n)
}

impl AgentBudget {
    pub fn new(
        journal: Rc<RefCell<Journal>>,
        limits: Rc<dyn Fn() -> Option<BudgetLimits>>,
        timezone: String,
        now: Rc<dyn Fn() -> i64>,
        engine: Option<EngineCap>,
    ) -> AgentBudget {
        let mut state = BudgetState::default();
        {
            let j = journal.borrow();
            let at = |detail: Option<crate::journal::TimedDetail>, key: &str| {
                detail.and_then(|d| d.detail.get(key).and_then(Value::as_str).and_then(parse_iso))
            };
            // The latest override of each cap, whatever plain resumes came after it (only the current day's one applies).
            state.override_start =
                at(j.last_pipeline_event_with("pipeline.resumed", "budget_override").ok().flatten(), "budget_override");
            state.engine_override = at(
                j.last_pipeline_event_with("pipeline.resumed", "engine_budget_override").ok().flatten(),
                "engine_budget_override",
            );
            state.warned = at(j.last_pipeline_event("budget.warning").ok().flatten(), "window_start");
        }
        let zone = zone(&timezone);
        AgentBudget { journal, limits, timezone, now, engine, state: RefCell::new(state), zone }
    }

    pub fn window(&self) -> BudgetWindow {
        let limits = (self.limits)();
        window_in((self.now)(), &self.zone, limits.as_ref().and_then(|l| l.reset_at.as_deref()))
    }

    /// The engine budget day (D58): midnight to midnight in the engine's time zone.
    pub fn engine_window(&self) -> BudgetWindow {
        window_in((self.now)(), &self.zone, None)
    }

    fn spent_since(&self, since: i64) -> Result<f64, String> {
        self.journal.borrow().agent_spend_since(since).map_err(|e| e.to_string())
    }

    /// USD spent in the current budget day; 0 when the journal can't be read.
    pub fn spent_today(&self) -> f64 {
        self.spent_since(self.window().start).unwrap_or(0.0)
    }

    /// Stops the call when a daily cap is used up and not overridden for its window: the pipeline's first, then the
    /// engine's (D58). Checked before each call, so calls already under way (in any runner of the home) can go over.
    pub fn check_day(&self) -> Result<(), BudgetError> {
        if let Some(per_day) = (self.limits)().and_then(|l| l.per_day) {
            let w = self.window();
            if self.state.borrow().override_start != Some(w.start) {
                let spent = self.spent_since(w.start).map_err(BudgetError::Failed)?;
                if spent >= per_day {
                    let detail = json!({
                        "cap": "pipeline",
                        "resume_at": iso(w.end),
                        "window_start": iso(w.start),
                        "spent_usd": number(round(spent)),
                        "per_day": number(per_day),
                    });
                    return Err(BudgetError::Stop(BudgetStop {
                        kind: "day",
                        message: format!(
                            "agent spend today {} reached agent_budget.per_day {}; resumes at {}",
                            usd(spent),
                            usd(per_day),
                            iso(w.end)
                        ),
                        detail: detail.as_object().cloned().unwrap_or_default(),
                    }));
                }
            }
        }
        let Some(e) = &self.engine else { return Ok(()) };
        let w = self.engine_window();
        if self.state.borrow().engine_override == Some(w.start) {
            return Ok(());
        }
        let per = {
            let j = self.journal.borrow();
            home_agent_spend(&e.home, w.start, Some((&e.name, j.db()))).map_err(BudgetError::Failed)?
        };
        let spent: f64 = per.values().sum();
        if spent < e.per_day {
            return Ok(());
        }
        let detail = json!({
            "cap": "engine",
            "resume_at": iso(w.end),
            "window_start": iso(w.start),
            "spent_usd": number(round(spent)),
            "per_day": number(e.per_day),
            "pipeline_spent_usd": number(round(per.get(&e.name).copied().unwrap_or(0.0))),
        });
        Err(BudgetError::Stop(BudgetStop {
            kind: "day",
            message: format!(
                "agent spend today across all pipelines of this Pipo home {} reached engine.agent_budget.per_day {}; resumes at {}. To allow more today, raise engine.agent_budget.per_day in {} and restart the pipeline",
                usd(spent),
                usd(e.per_day),
                iso(w.end),
                e.home.join("config.yaml").display()
            ),
            detail: detail.as_object().cloned().unwrap_or_default(),
        }))
    }

    /// Tokens the packet used so far; stops the call when it already reached `per_packet`.
    pub fn check_packet(&self, root: &str, per_packet: Option<u64>) -> Result<u64, BudgetError> {
        let used = self.journal.borrow().packet_agent_tokens(root).map_err(|e| BudgetError::Failed(e.to_string()))?;
        let used = used.max(0) as u64;
        match per_packet {
            Some(cap) if used >= cap => Err(BudgetError::Stop(packet_stop(used, cap))),
            _ => Ok(used),
        }
    }

    /// After a recorded call: the `budget.warning` detail when spend just crossed `warn_at` for this window.
    pub fn warning(&self) -> Option<Map<String, Value>> {
        let b = (self.limits)()?;
        let per_day = b.per_day?;
        let warn_at = b.warn_at.as_deref().filter(|w| !w.is_empty())?;
        let w = self.window();
        if self.state.borrow().warned == Some(w.start) {
            return None;
        }
        let spent = self.spent_since(w.start).ok()?;
        let pct = parse_float(warn_at);
        if spent < per_day * pct / 100.0 {
            return None;
        }
        self.state.borrow_mut().warned = Some(w.start);
        json!({
            "spent_usd": number(round(spent)),
            "per_day": number(per_day),
            "warn_at": warn_at,
            "window_start": iso(w.start),
            "resets_at": iso(w.end),
            "message": format!(
                "agent spend today {} is {warn_at} or more of agent_budget.per_day {}",
                usd(spent),
                usd(per_day)
            ),
        })
        .as_object()
        .cloned()
    }

    /// A manual resume of a `budget` pause goes over the cap that paused it until that cap's day ends; the other cap
    /// still applies. Returns the window.
    pub fn override_today(&self, cap: BudgetCap) -> BudgetWindow {
        let mut s = self.state.borrow_mut();
        match cap {
            BudgetCap::Engine => {
                let w = self.engine_window();
                s.engine_override = Some(w.start);
                w
            }
            BudgetCap::Pipeline => {
                let w = self.window();
                s.override_start = Some(w.start);
                w
            }
        }
    }
}

/// `Number.parseFloat`: the longest leading decimal number, NaN when there is none.
fn parse_float(s: &str) -> f64 {
    let t = s.trim_start();
    let b = t.as_bytes();
    let mut end = 0;
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let digits = |i: &mut usize| {
        let from = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i > from
    };
    let mut seen = digits(&mut i);
    if seen {
        end = i;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        if digits(&mut i) || seen {
            seen = true;
            end = i;
        }
    }
    if seen && i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        if digits(&mut j) {
            end = j;
        }
    }
    if !seen {
        return f64::NAN;
    }
    t[..end].parse().unwrap_or(f64::NAN)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::AgentUsage;
    use crate::time::days_from_civil;
    use std::cell::Cell;
    use std::path::Path;

    const DAY: i64 = 86_400_000;

    fn utc(y: i64, mo: i64, d: i64, h: i64) -> i64 {
        days_from_civil(y, mo, d) * DAY + h * 3_600_000
    }

    struct Home(PathBuf);
    impl Drop for Home {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn home(tag: &str) -> Home {
        let dir = std::env::temp_dir().join(format!("pipo-budget-{tag}-{}", crate::ids::ulid().to_lowercase()));
        std::fs::create_dir_all(dir.join("pipelines")).unwrap();
        Home(dir)
    }
    fn journal(home: &Path, name: &str) -> Rc<RefCell<Journal>> {
        Rc::new(RefCell::new(Journal::open(home.join("pipelines").join(name).join("journal.db")).unwrap()))
    }

    fn spend(j: &Rc<RefCell<Journal>>, at: i64, root: &str, tokens: u64, usd: f64) {
        j.borrow_mut()
            .record_agent_usage(&AgentUsage {
                at,
                unit: root.into(),
                root: root.into(),
                node: "classify".into(),
                provider: "claude_api".into(),
                model: "m".into(),
                input_tokens: tokens,
                output_tokens: 0,
                cost_usd: usd,
                attempt: 1,
            })
            .unwrap();
    }

    struct Fixture {
        budget: AgentBudget,
        clock: Rc<Cell<i64>>,
    }

    fn budget(j: &Rc<RefCell<Journal>>, limits: Option<BudgetLimits>, engine: Option<EngineCap>, t: i64) -> Fixture {
        let clock = Rc::new(Cell::new(t));
        let c = clock.clone();
        let budget = AgentBudget::new(
            j.clone(),
            Rc::new(move || limits.clone()),
            "UTC".into(),
            Rc::new(move || c.get()),
            engine,
        );
        Fixture { budget, clock }
    }

    fn limits(
        per_day: Option<f64>,
        reset_at: Option<&str>,
        per_packet: Option<u64>,
        warn_at: Option<&str>,
    ) -> Option<BudgetLimits> {
        Some(BudgetLimits {
            per_day,
            reset_at: reset_at.map(str::to_owned),
            per_packet,
            warn_at: warn_at.map(str::to_owned),
        })
    }

    fn stop(r: Result<(), BudgetError>) -> BudgetStop {
        match r {
            Err(BudgetError::Stop(s)) => s,
            other => panic!("expected a budget stop, got {other:?}"),
        }
    }

    #[test]
    fn the_daily_cap_stops_calls_until_the_next_window_or_an_override() {
        let h = home("day");
        let j = journal(&h.0, "a");
        let day = utc(2026, 10, 3, 12);
        let f = budget(&j, limits(Some(0.3), None, None, None), None, day);
        assert_eq!(f.budget.check_day(), Ok(()));
        spend(&j, day, "p1", 10, 0.15);
        spend(&j, day, "p2", 10, 0.15);
        // Spend of the day before doesn't count.
        spend(&j, day - DAY, "p0", 10, 5.0);
        assert!((f.budget.spent_today() - 0.3).abs() < 1e-9);
        let s = stop(f.budget.check_day());
        assert_eq!(s.kind, "day");
        assert_eq!(
            s.message,
            "agent spend today $0.3000 reached agent_budget.per_day $0.3000; resumes at 2026-10-04T00:00:00.000Z"
        );
        assert_eq!(
            Value::Object(s.detail),
            json!({ "cap": "pipeline", "resume_at": "2026-10-04T00:00:00.000Z", "window_start": "2026-10-03T00:00:00.000Z", "spent_usd": 0.3, "per_day": 0.3 })
        );
        // A manual resume goes over the cap until the day ends.
        let w = f.budget.override_today(BudgetCap::Pipeline);
        assert_eq!((w.start, w.end), (utc(2026, 10, 3, 0), utc(2026, 10, 4, 0)));
        assert_eq!(f.budget.check_day(), Ok(()));
        // The next day is a fresh window.
        f.clock.set(utc(2026, 10, 4, 1));
        assert_eq!(f.budget.check_day(), Ok(()));
        assert_eq!(f.budget.spent_today(), 0.0);
    }

    #[test]
    fn overrides_and_warnings_are_read_back_from_the_journal() {
        let h = home("restore");
        let j = journal(&h.0, "a");
        let day = utc(2026, 10, 3, 12);
        spend(&j, day, "p1", 10, 1.0);
        {
            let jr = j.borrow();
            jr.event(
                "pipeline.resumed",
                Some(&json!({ "engine_budget_override": "2026-10-03T00:00:00.000Z", "until": "x" })),
                None,
                None,
            )
            .unwrap();
            jr.event(
                "pipeline.resumed",
                Some(&json!({ "budget_override": "2026-10-03T00:00:00.000Z", "until": "x" })),
                None,
                None,
            )
            .unwrap();
            jr.event("pipeline.resumed", None, None, None).unwrap();
            jr.event("budget.warning", Some(&json!({ "window_start": "2026-10-03T00:00:00.000Z" })), None, None)
                .unwrap();
        }
        let engine = EngineCap { home: h.0.clone(), name: "a".into(), per_day: 0.5 };
        let f = budget(&j, limits(Some(1.0), None, None, Some("50%")), Some(engine), day);
        let s = f.budget.state.borrow().clone();
        assert_eq!(s.override_start, Some(utc(2026, 10, 3, 0)));
        assert_eq!(s.engine_override, Some(utc(2026, 10, 3, 0)));
        assert_eq!(s.warned, Some(utc(2026, 10, 3, 0)));
        // Both caps are overridden today, and today's warning was already given.
        assert_eq!(f.budget.check_day(), Ok(()));
        assert_eq!(f.budget.warning(), None);
    }

    #[test]
    fn per_packet_tokens() {
        let h = home("packet");
        let j = journal(&h.0, "a");
        let f = budget(&j, limits(None, None, Some(100), None), None, utc(2026, 10, 3, 12));
        assert_eq!(f.budget.check_packet("p1", Some(100)), Ok(0));
        spend(&j, utc(2026, 10, 3, 12), "p1", 60, 0.0);
        assert_eq!(f.budget.check_packet("p1", Some(100)), Ok(60));
        assert_eq!(f.budget.check_packet("p1", None), Ok(60));
        spend(&j, utc(2026, 10, 3, 12), "p1", 40, 0.0);
        let s = f.budget.check_packet("p1", Some(100)).unwrap_err();
        let BudgetError::Stop(s) = s else { panic!("expected a stop") };
        assert_eq!(s.kind, "packet");
        assert_eq!(s.message, "packet used 100 agent tokens, reaching agent_budget.per_packet (100)");
        assert_eq!(Value::Object(s.detail), json!({ "tokens": 100, "per_packet": 100 }));
        assert_eq!(f.budget.check_packet("p2", Some(100)), Ok(0));
    }

    #[test]
    fn warn_at_once_per_window() {
        let h = home("warn");
        let j = journal(&h.0, "a");
        let day = utc(2026, 10, 3, 12);
        let f = budget(&j, limits(Some(2.0), Some("06:00"), None, Some("80%")), None, day);
        spend(&j, day, "p1", 10, 1.5);
        assert_eq!(f.budget.warning(), None);
        spend(&j, day, "p2", 10, 0.1);
        let w = f.budget.warning().expect("a warning at 80%");
        assert_eq!(
            Value::Object(w),
            json!({
                "spent_usd": 1.6, "per_day": 2, "warn_at": "80%",
                "window_start": "2026-10-03T06:00:00.000Z", "resets_at": "2026-10-04T06:00:00.000Z",
                "message": "agent spend today $1.60 is 80% or more of agent_budget.per_day $2.00",
            })
        );
        spend(&j, day, "p3", 10, 0.1);
        assert_eq!(f.budget.warning(), None);
        // No warn_at or no per_day: never.
        let g = budget(&j, limits(Some(1.0), None, None, None), None, day);
        assert_eq!(g.budget.warning(), None);
    }

    #[test]
    fn the_engine_cap_sums_every_journal_of_the_home() {
        let h = home("engine");
        let a = journal(&h.0, "a");
        let b = journal(&h.0, "b");
        // A folder without a journal counts zero; so does a journal from before agent nodes.
        std::fs::create_dir_all(h.0.join("pipelines").join("empty")).unwrap();
        let old = h.0.join("pipelines").join("old");
        std::fs::create_dir_all(&old).unwrap();
        rusqlite::Connection::open(old.join("journal.db")).unwrap().execute_batch("CREATE TABLE t (x)").unwrap();
        let day = utc(2026, 10, 3, 12);
        let engine = |name: &str| Some(EngineCap { home: h.0.clone(), name: name.into(), per_day: 0.4 });
        let fa = budget(&a, limits(Some(0.3), None, None, None), engine("a"), day);
        // b's own day starts at 06:00; the engine day is midnight to midnight.
        let fb = budget(&b, limits(Some(0.3), Some("06:00"), None, None), engine("b"), day);
        spend(&a, day, "a1", 10, 0.15);
        spend(&a, day, "a2", 10, 0.15);
        assert_eq!(fb.budget.check_day(), Ok(()));
        spend(&b, day, "b1", 10, 0.15);
        let s = stop(fb.budget.check_day());
        assert_eq!(
            Value::Object(s.detail.clone()),
            json!({ "cap": "engine", "resume_at": "2026-10-04T00:00:00.000Z", "window_start": "2026-10-03T00:00:00.000Z", "spent_usd": 0.45, "per_day": 0.4, "pipeline_spent_usd": 0.15 })
        );
        assert!(s.message.contains("reached engine.agent_budget.per_day $0.4000"), "{}", s.message);
        assert!(
            s.message.contains(&format!("raise engine.agent_budget.per_day in {}", h.0.join("config.yaml").display())),
            "{}",
            s.message
        );
        // a, at its own cap, stops on that one first.
        assert_eq!(stop(fa.budget.check_day()).detail.get("cap"), Some(&json!("pipeline")));
        // Overriding the engine cap leaves the pipeline's own cap in force.
        let w = fb.budget.override_today(BudgetCap::Engine);
        assert_eq!((w.start, w.end), (utc(2026, 10, 3, 0), utc(2026, 10, 4, 0)));
        assert_eq!(fb.budget.check_day(), Ok(()));
        spend(&b, day, "b2", 10, 0.15);
        assert_eq!(stop(fb.budget.check_day()).detail.get("cap"), Some(&json!("pipeline")));

        let report = super::super::engine_spend(&h.0, Some(0.4), "UTC", day).unwrap();
        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            json!({ "per_day": 0.4, "spent_usd": 0.6, "window_start": "2026-10-03T00:00:00.000Z", "resets_at": "2026-10-04T00:00:00.000Z", "timezone": "UTC", "pipelines": { "a": 0.3, "b": 0.3 } })
        );
        // The next engine day starts from zero.
        fa.clock.set(utc(2026, 10, 4, 0));
        let next = super::super::engine_spend(&h.0, None, "UTC", utc(2026, 10, 4, 1)).unwrap();
        assert_eq!((next.spent_usd, next.per_day, next.pipelines.len()), (0.0, None, 0));
        assert_eq!(fa.budget.check_day(), Ok(()));
    }

    #[test]
    fn an_unreadable_journal_fails_the_check_instead_of_counting_zero() {
        let h = home("bad");
        let a = journal(&h.0, "a");
        let bad = h.0.join("pipelines").join("broken");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join("journal.db"), b"this is not a database, just text that is long enough to be read")
            .unwrap();
        let f = budget(
            &a,
            None,
            Some(EngineCap { home: h.0.clone(), name: "a".into(), per_day: 1.0 }),
            utc(2026, 10, 3, 12),
        );
        match f.budget.check_day() {
            Err(BudgetError::Failed(m)) => {
                assert!(m.starts_with("cannot read the agent spend of 'broken' from "), "{m}")
            }
            other => panic!("expected a failed check, got {other:?}"),
        }
    }

    #[test]
    fn parse_float_reads_like_javascript() {
        assert_eq!(parse_float("80%"), 80.0);
        assert_eq!(parse_float("12.5%"), 12.5);
        assert_eq!(parse_float(" .5"), 0.5);
        assert!(parse_float("%").is_nan());
        assert_eq!(usd(0.4), "$0.4000");
        assert_eq!(usd(12.0), "$12.00");
        assert_eq!(usd(1.125), "$1.13");
        assert_eq!(usd(0.03125), "$0.0313");
    }
}
