// `via: schedule` (docs/spec.md §3.3, §7.4). Port of schedule-input.ts. The runner owns the timer. Each tick is
// handed to the runner's intake, which journals the packet; only then is the next fire armed. Fires missed while
// the runner was down or suspended are skipped, not replayed (spec §14).

use super::cron_port::{Cron, next_cron, parse_cron};
use super::{InputAdapter, InputRuntime, Intake, IntakeResult, LocalBoxFuture, Log, Origin, Stopper};
use crate::duration::{format_duration, parse_duration};
use crate::time::{iso, now_ms};
use serde_json::{Map, Value};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use tokio::task::JoinHandle;

/// Wall-clock time and timers, injectable so tests can crank time by hand.
pub trait Clock {
    fn now(&self) -> i64;
    fn sleep(&self, ms: u64) -> LocalBoxFuture<'static, ()>;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> i64 {
        now_ms()
    }
    fn sleep(&self, ms: u64) -> LocalBoxFuture<'static, ()> {
        Box::pin(tokio::time::sleep(std::time::Duration::from_millis(ms)))
    }
}

/// The longest single wait (as setTimeout's limit in TS); longer waits are re-armed.
const MAX_WAIT: i64 = (1 << 31) - 1;

pub struct ScheduleOptions {
    pub cron: Option<String>,
    pub every: Option<String>,
    pub payload: Option<Value>,
    pub log: Option<Log>,
}

enum When {
    Cron(String, Cron),
    Every(i64),
}

struct Inner {
    when: When,
    payload: Value,
    log: Option<Log>,
    clock: Rc<dyn Clock>,
    stop: Stopper,
    next_tick: Cell<Option<i64>>,
}

pub struct ScheduleInput {
    inner: Rc<Inner>,
    task: RefCell<Option<JoinHandle<()>>>,
}

impl ScheduleInput {
    pub fn new(o: ScheduleOptions, clock: Rc<dyn Clock>) -> Result<ScheduleInput, String> {
        let when = match (o.cron, o.every) {
            (Some(c), None) => {
                let parsed = parse_cron(&c)?;
                When::Cron(c, parsed)
            }
            (None, Some(e)) => {
                let ms = parse_duration(&e)?;
                if ms < 1 {
                    return Err("schedule `every` must be at least 1ms".into());
                }
                When::Every(ms as i64)
            }
            _ => return Err("schedule needs exactly one of `cron` or `every`".into()),
        };
        let inner = Inner {
            when,
            payload: o.payload.filter(|p| !p.is_null()).unwrap_or_else(|| Value::Object(Map::new())),
            log: o.log,
            clock,
            stop: Stopper::default(),
            next_tick: Cell::new(None),
        };
        Ok(ScheduleInput { inner: Rc::new(inner), task: RefCell::new(None) })
    }
}

impl Inner {
    fn log(&self, level: &str, message: &str) {
        if let Some(l) = &self.log {
            l(level, message);
        }
    }

    /// The first tick strictly after `tick` and not in the past, and how many ticks that skips.
    fn following(&self, tick: i64, now: i64) -> Option<(i64, i64)> {
        match &self.when {
            When::Every(every) => {
                let n = ((now - tick).div_euclid(*every) + 1).max(1);
                Some((tick + n * every, n - 1))
            }
            When::Cron(_, c) => next_cron(c, tick.max(now)).map(|t| (t, 0)),
        }
    }

    async fn run(self: Rc<Self>, intake: Intake) {
        let now = self.clock.now();
        let Some((mut tick, _)) = self.following(now, now) else { return };
        loop {
            self.next_tick.set(Some(tick));
            loop {
                if self.stop.stopped() {
                    return;
                }
                let wait = tick - self.clock.now();
                let chunk = wait.clamp(0, MAX_WAIT);
                tokio::select! {
                    _ = self.clock.sleep(chunk as u64) => {}
                    _ = self.stop.wait() => return,
                }
                if wait <= MAX_WAIT {
                    break;
                }
            }
            let source = iso(tick);
            match intake(self.payload.clone(), Origin { trigger: "schedule".into(), source: source.clone() }, None).await {
                IntakeResult::Accepted { .. } => {}
                IntakeResult::Rejected { message, .. } => {
                    self.log("warn", &format!("schedule tick {source} was not accepted: {message}"))
                }
                IntakeResult::Unavailable { reason } => {
                    self.log("warn", &format!("schedule tick {source} was not accepted: {reason}"))
                }
            }
            // The packet is journaled (or refused) by now; arm the next tick from this one, not from the clock, so a
            // timer that fires a few ms early cannot produce the same tick twice.
            let Some((next, missed)) = self.following(tick, self.clock.now()) else {
                self.log("error", "schedule has no next tick within 10 years; stopped");
                return;
            };
            if missed > 0 {
                self.log("warn", &format!("skipped {missed} missed schedule tick(s) (no catch-up)"));
            }
            tick = next;
        }
    }
}

impl InputAdapter for ScheduleInput {
    fn start(&self, intake: Intake, _runtime: InputRuntime) -> LocalBoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.inner.stop.reset();
            let inner = self.inner.clone();
            *self.task.borrow_mut() = Some(tokio::task::spawn_local(inner.run(intake)));
            Ok(())
        })
    }

    fn stop(&self) -> LocalBoxFuture<'_, ()> {
        Box::pin(async move {
            self.inner.stop.stop();
            let task = self.task.borrow_mut().take();
            if let Some(t) = task {
                let _ = t.await;
            }
        })
    }

    fn describe(&self) -> String {
        let what = match &self.inner.when {
            When::Cron(text, _) => format!("cron '{text}' (UTC)"),
            When::Every(ms) => format!("every {}", format_duration(*ms as u64)),
        };
        let next = self.inner.next_tick.get().map(|t| format!(", next at {}", iso(t))).unwrap_or_default();
        format!("schedule {what}{next}")
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::connectors::test_util::*;
    use serde_json::json;
    use tokio::sync::oneshot;

    /// A hand-cranked clock: timers run only when the test advances time.
    #[derive(Default)]
    pub struct FakeClock {
        pub now: Cell<i64>,
        pending: RefCell<Option<(i64, oneshot::Sender<()>)>>,
    }

    impl Clock for FakeClock {
        fn now(&self) -> i64 {
            self.now.get()
        }
        fn sleep(&self, ms: u64) -> LocalBoxFuture<'static, ()> {
            let (tx, rx) = oneshot::channel();
            *self.pending.borrow_mut() = Some((self.now.get() + ms as i64, tx));
            Box::pin(async move {
                if rx.await.is_err() {
                    std::future::pending::<()>().await;
                }
            })
        }
    }

    impl FakeClock {
        /// When the armed timer is due, if one is armed.
        pub fn wake(&self) -> Option<i64> {
            self.pending.borrow().as_ref().filter(|(_, tx)| !tx.is_closed()).map(|(at, _)| *at)
        }
        /// Move to the armed timer's time (plus `extra` ms), run it, and let the input re-arm.
        pub async fn fire(&self, extra: i64) {
            let (at, tx) = self.pending.borrow_mut().take().expect("no timer armed");
            self.now.set(at + extra);
            let _ = tx.send(());
            for _ in 0..20 {
                tokio::task::yield_now().await;
            }
        }
    }

    fn input(o: ScheduleOptions, clock: Rc<FakeClock>) -> ScheduleInput {
        ScheduleInput::new(o, clock).unwrap()
    }

    fn opts(cron: Option<&str>, every: Option<&str>) -> ScheduleOptions {
        ScheduleOptions { cron: cron.map(str::to_owned), every: every.map(str::to_owned), payload: None, log: None }
    }

    #[test]
    fn settings_errors() {
        let c: Rc<dyn Clock> = Rc::new(SystemClock);
        let err = |o| ScheduleInput::new(o, c.clone()).err().unwrap();
        assert_eq!(err(opts(None, None)), "schedule needs exactly one of `cron` or `every`");
        assert_eq!(err(opts(Some("* * * * *"), Some("1m"))), "schedule needs exactly one of `cron` or `every`");
        assert!(err(opts(Some("99 * * * *"), None)).contains("minute"));
        assert_eq!(err(opts(None, Some("0ms"))), "schedule `every` must be at least 1ms");
        assert!(err(opts(None, Some("soon"))).contains("invalid duration"));
    }

    #[test]
    fn cron_fires_at_each_wall_clock_tick_once_per_tick() {
        local(async {
            let fc = Rc::new(FakeClock::default());
            fc.now.set(crate::time::parse_iso("2026-03-01T08:59:30Z").unwrap());
            let mut o = opts(Some("0 9 * * 1-5"), None);
            o.payload = Some(json!({"a": 1}));
            let input = input(o, fc.clone());
            let (intake, got) = recording_intake(accepted);
            input.start(intake, runtime(&TempDir::new())).await.unwrap();
            tokio::task::yield_now().await;
            // Sunday -> Monday.
            assert_eq!(fc.wake().map(iso).as_deref(), Some("2026-03-02T09:00:00.000Z"));
            assert_eq!(input.describe(), "schedule cron '0 9 * * 1-5' (UTC), next at 2026-03-02T09:00:00.000Z");
            fc.fire(-5).await; // the timer wakes a few ms early: the tick must not repeat
            let seen: Vec<(Value, String)> = got.borrow().iter().map(|(p, o)| (p.clone(), o.source.clone())).collect();
            assert_eq!(seen, vec![(json!({"a": 1}), "2026-03-02T09:00:00.000Z".to_string())]);
            assert_eq!(got.borrow()[0].1.trigger, "schedule");
            assert_eq!(fc.wake().map(iso).as_deref(), Some("2026-03-03T09:00:00.000Z"));
            input.stop().await;
        });
    }

    #[test]
    fn ticks_missed_while_suspended_are_skipped_not_replayed() {
        local(async {
            let fc = Rc::new(FakeClock::default());
            fc.now.set(crate::time::parse_iso("2026-03-02T09:00:00Z").unwrap());
            let logs: Rc<RefCell<Vec<String>>> = Rc::default();
            let l = logs.clone();
            let mut o = opts(None, Some("1m"));
            o.log = Some(Rc::new(move |_: &str, m: &str| l.borrow_mut().push(m.to_string())));
            let input = input(o, fc.clone());
            let (intake, got) = recording_intake(|_| IntakeResult::Unavailable { reason: "paused".into() });
            input.start(intake, runtime(&TempDir::new())).await.unwrap();
            tokio::task::yield_now().await;
            assert_eq!(input.describe(), "schedule every 1m0s, next at 2026-03-02T09:01:00.000Z");
            fc.fire(0).await; // tick at 09:01
            fc.fire(510_000).await; // the 09:02 timer wakes at 09:10:30 after a suspend
            assert_eq!(got.borrow().len(), 2);
            assert_eq!(got.borrow()[0].0, json!({}));
            assert_eq!(fc.wake().map(iso).as_deref(), Some("2026-03-02T09:11:00.000Z"));
            assert!(logs.borrow().iter().any(|l| l.contains("skipped 8 missed schedule tick(s)")));
            assert!(logs.borrow().iter().any(|l| l.contains("was not accepted: paused")));
            input.stop().await;
        });
    }

    #[test]
    fn stop_cancels_the_timer() {
        local(async {
            let fc = Rc::new(FakeClock::default());
            let input = input(opts(None, Some("1s")), fc.clone());
            let (intake, _) = recording_intake(accepted);
            input.start(intake, runtime(&TempDir::new())).await.unwrap();
            tokio::task::yield_now().await;
            assert!(fc.wake().is_some());
            input.stop().await;
            assert!(fc.wake().is_none());
            input.stop().await;
        });
    }

    #[test]
    fn every_runs_on_the_real_clock() {
        local(async {
            let input = ScheduleInput::new(opts(None, Some("20ms")), Rc::new(SystemClock)).unwrap();
            let (intake, got) = recording_intake(accepted);
            input.start(intake, runtime(&TempDir::new())).await.unwrap();
            wait_for(|| got.borrow().len() >= 3, 5000, "three ticks").await;
            input.stop().await;
            let n = got.borrow().len();
            let sources: std::collections::HashSet<String> = got.borrow().iter().map(|(_, o)| o.source.clone()).collect();
            assert_eq!(sources.len(), n);
            tokio::time::sleep(std::time::Duration::from_millis(60)).await;
            assert_eq!(got.borrow().len(), n);
        });
    }
}
