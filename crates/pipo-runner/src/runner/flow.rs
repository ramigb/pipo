// Packet flow (docs/spec.md §2.1, §3.4–§3.10, §7.3). Port of the intake, processing, batch, delivery-check,
// agent hand-over and resolve parts of runner.ts. Every transition commits to the journal before the next step runs.

use super::*;
use crate::agents::{AgentRequest, cost_of, packet_stop, price_for};
use crate::connectors::{Commit, Intake, IntakeResult, Origin, StepInput, WriteItem};
use crate::crashpoint::crash_point;
use crate::expr::{evaluate, render, render_string, to_text, truthy};
use crate::ids::ulid;
use crate::journal::{BATCH_STEP, BRANCHED, IN_FLIGHT, NewPacket, OUTPUT_STEP, PacketPatch, VERIFY_STEP};
use crate::pipeline::{NodeKind, fn_ref};
use crate::policy::{Attempted, ResolvedPolicy, StepError, attempt, resolve_policy};
use std::time::Instant;

/// What `resolve` does with a unit waiting for the agent (D50).
pub const RESOLVE_ACTIONS: &[&str] = &["retry", "dead_letter", "drop"];

/// A failure on its way to a policy's final action.
#[derive(Debug, Clone, Default)]
pub(super) struct Failure {
    pub code: String,
    pub message: String,
    pub attempts: Option<u32>,
    pub elapsed: Option<u64>,
    pub rule: Option<String>,
}

type Emitted = Vec<(String, Option<Value>)>;

/// What a step decided for its packet.
pub(super) enum Transition {
    Move { to: String, data: Value, iteration: Option<i64>, result: Option<Value>, event: String, extra: Emitted },
    /// Fan-out (spec §3.4, D22): the step's result goes to several consumers, one copy each.
    Split { to: Vec<String>, data: Value, event: String, extra: Emitted },
    End { state: &'static str, error: Option<PacketError>, event: String, extra: Emitted },
    Hold { pause: bool, error: PacketError, reason: Option<String>, detail: Map<String, Value> },
    /// Handed to the agent (§3.9, §9, D50): after the policy's retries (`error`), or a stall (`stall`).
    Escalate { stall_reason: bool, error: PacketError, stall: Option<String> },
}

fn with_extra(t: Transition, extra: Emitted) -> Transition {
    if extra.is_empty() {
        return t;
    }
    match t {
        Transition::Move { to, data, iteration, result, event, .. } => Transition::Move { to, data, iteration, result, event, extra },
        Transition::Split { to, data, event, .. } => Transition::Split { to, data, event, extra },
        Transition::End { state, error, event, .. } => Transition::End { state, error, event, extra },
        other => other,
    }
}

fn end(state: &'static str, event: &str) -> Transition {
    Transition::End { state, error: None, event: event.into(), extra: vec![] }
}

fn ctx(data: &Value, meta: &Value, env: &Value) -> Value {
    json!({ "data": data, "meta": meta, "env": env })
}

/// Output batching (spec §3.5.1, D20): collects packets journaled at `$batch` and flushes them at `size` packets or
/// `within` after the first one joined. Memory only: the journal is the durable copy.
pub(super) struct Batch {
    size: usize,
    within: u64,
    pending: RefCell<Vec<PacketRow>>,
    /// Packets pending or mid-flush, so a packet never sits in two batches.
    members: RefCell<HashSet<String>>,
    timer: RefCell<Option<JoinHandle<()>>>,
    /// Flushes run one at a time, in order.
    lock: Rc<tokio::sync::Mutex<()>>,
    closed: Cell<bool>,
    runner: Weak<Runner>,
    version: i64,
    me: Weak<Batch>,
}

impl Batch {
    pub fn count(&self) -> usize {
        self.members.borrow().len()
    }

    fn add(&self, row: PacketRow) {
        if self.closed.get() || self.members.borrow().contains(&row.id) {
            return;
        }
        self.members.borrow_mut().insert(row.id.clone());
        self.pending.borrow_mut().push(row);
        if self.pending.borrow().len() >= self.size {
            self.spawn_flush();
        } else if self.timer.borrow().is_none() {
            let me = self.me.clone();
            let within = self.within;
            *self.timer.borrow_mut() = Some(tokio::task::spawn_local(async move {
                tokio::time::sleep(Duration::from_millis(within)).await;
                if let Some(b) = me.upgrade() {
                    b.timer.borrow_mut().take();
                    b.spawn_flush();
                }
            }));
        }
    }

    pub fn spawn_flush(&self) {
        let fut = self.flush();
        tokio::task::spawn_local(fut);
    }

    /// Flush whatever is pending now; resolves when this flush (and those queued before it) is done.
    pub fn flush(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>> {
        if let Some(t) = self.timer.borrow_mut().take() {
            t.abort();
        }
        let rows: Vec<PacketRow> = self.pending.borrow_mut().drain(..).collect();
        let lock = self.lock.clone();
        let me = self.me.clone();
        let runner = self.runner.clone();
        let version = self.version;
        Box::pin(async move {
            let _turn = lock.lock().await;
            if rows.is_empty() {
                return;
            }
            if let Some(r) = runner.upgrade() {
                match r.plan(version).await {
                    Ok(plan) => {
                        let p = &plan.pipeline;
                        let policy = resolve_policy(p.errors.as_ref(), p.output.on_error.as_ref());
                        r.flush_group(&plan, &policy, rows.clone()).await;
                    }
                    Err(e) => r.log("error", &format!("internal error flushing a batch: {e}")),
                }
            }
            if let Some(b) = me.upgrade() {
                // A held packet may already have been released and re-added to a newer batch.
                let waiting: HashSet<String> = b.pending.borrow().iter().map(|p| p.id.clone()).collect();
                let mut members = b.members.borrow_mut();
                for row in &rows {
                    if !waiting.contains(&row.id) {
                        members.remove(&row.id);
                    }
                }
            }
        })
    }

    /// The runner settled this packet (written, failed or held), so it may join a later batch again.
    fn release(&self, id: &str) {
        self.members.borrow_mut().remove(id);
    }

    /// Stop timers and ignore new packets; whatever still waits stays journaled at `$batch`.
    pub fn close(&self) {
        self.closed.set(true);
        if let Some(t) = self.timer.borrow_mut().take() {
            t.abort();
        }
    }
}

impl Runner {
    // ── intake ───────────────────────────────────────────────────────────────────

    pub(super) fn intake_fn(&self) -> Intake {
        let me = self.me.clone();
        Rc::new(move |payload: Value, origin: Origin, commit: Option<Commit>| {
            let me = me.clone();
            Box::pin(async move {
                match me.upgrade() {
                    Some(r) => r.intake(payload, origin, commit).await,
                    None => IntakeResult::Unavailable { reason: "pipeline is stopped".into() },
                }
            })
        })
    }

    pub(super) fn await_terminal_fn(&self) -> connectors::AwaitTerminal {
        let me = self.me.clone();
        Rc::new(move |id: String, ms: u64| {
            let me = me.clone();
            Box::pin(async move {
                match me.upgrade() {
                    Some(r) => r.await_terminal(&id, ms).await,
                    None => None,
                }
            })
        })
    }

    pub async fn intake(&self, payload: Value, origin: Origin, commit: Option<Commit>) -> IntakeResult {
        // The lifetime reason first: once a limit is reached the pipeline is draining, but the limit is the cause.
        if let Some(why) = self.s.borrow().lifetime_end {
            return IntakeResult::Unavailable { reason: self.lifetime_reason(why) };
        }
        let state = self.state();
        if state != RunnerState::Active && state != RunnerState::Paused {
            return IntakeResult::Unavailable { reason: format!("pipeline is {}", state.as_str()) };
        }
        let max = self.pipeline().buffer.as_ref().and_then(|b| b.max).unwrap_or(10_000);
        if self.journal.borrow().count_in_flight().unwrap_or(0) as u64 >= max {
            return IntakeResult::Unavailable { reason: format!("buffer full ({max} packets pending)") };
        }

        // The version is taken before the await: a version applied meanwhile (D38) is for the packets after this one.
        let version = self.version();
        let plan = match self.plan(version).await {
            Ok(p) => p,
            Err(e) => return IntakeResult::Unavailable { reason: format!("v{version} can't run: {e}") },
        };
        let id = ulid();
        let received_at = now_ms();
        let base = PacketRow::new_root(&id, version, payload.clone(), &origin.trigger, &origin.source, received_at);
        let meta = self.meta(&plan, &base, "input", 1);
        let c = ctx(&payload, &meta, &self.env);

        if let Some(failed) = self.first_failed_rule(&plan, &payload, &c) {
            let inv = plan.pipeline.input.on_invalid.clone();
            let mut ectx = c.clone();
            ectx["error"] = json!({ "code": failed.code, "message": failed.message, "rule": failed.rule, "node": "input" });
            let message = self.message(inv.as_ref().and_then(|i| i.message.as_deref()), &ectx, &failed.message);
            let error = PacketError { code: failed.code.clone(), message: message.clone(), node: Some("input".into()), attempts: None };
            let to_agent = inv.as_ref().and_then(|i| i.then.as_deref()) == Some("agent");
            let error_json = serde_json::to_value(&error).unwrap_or(Value::Null);
            let id2 = id.clone();
            let r = self.journal.borrow_mut().insert(
                NewPacket { state: "rejected".into(), cursor: None, error: Some(error), ..NewPacket::from_row(&base) },
                "packet.rejected",
                Some(json!({ "rule": failed.rule })),
                Some(Box::new(move |j: &mut Journal| {
                    if let Some(c) = commit {
                        c(j)?;
                    }
                    // Never accepted, so it can't wait: the agent is told, in the same transaction (D50).
                    if to_agent {
                        j.event(
                            "packet.escalated",
                            Some(json!({ "reason": "rejected", "waiting": false, "error": error_json })),
                            Some(&id2),
                            Some("input"),
                        )?;
                    }
                    Ok(())
                })),
            );
            if let Err(e) = r {
                return IntakeResult::Unavailable { reason: format!("journal write failed: {e}") };
            }
            return IntakeResult::Rejected {
                packet_id: id,
                rule: failed.rule,
                message,
                respond: inv.and_then(|i| i.respond),
            };
        }
        // No await between this check and the insert, so concurrent requests can't overshoot max_packets.
        self.check_lifetime();
        if let Some(why) = self.s.borrow().lifetime_end {
            return IntakeResult::Unavailable { reason: self.lifetime_reason(why) };
        }
        let first = plan.next_of("input").to_vec();
        if first.len() == 1 {
            let r = self.journal.borrow_mut().insert(
                NewPacket { state: "accepted".into(), cursor: Some(first[0].clone()), error: None, ..NewPacket::from_row(&base) },
                "packet.accepted",
                None,
                commit.map(|c| Box::new(move |j: &mut Journal| c(j)) as Box<dyn FnOnce(&mut Journal) -> Result<(), String>>),
            );
            if let Err(e) = r {
                return IntakeResult::Unavailable { reason: format!("journal write failed: {e}") };
            }
            self.s.borrow_mut().queue.push_back(id.clone());
            self.wake(false);
        } else {
            // The input fans out: the packet and all its copies are journaled together, before the ack.
            let mut root = base.clone();
            root.state = BRANCHED.into();
            root.cursor = None;
            let copies = copies(&root, &first, &payload, 0);
            let branches: Vec<String> = copies.iter().map(|c| c.branch.clone()).collect();
            let id2 = id.clone();
            let root2 = root.clone();
            let copies2 = copies.clone();
            let r = self.journal.borrow_mut().insert(
                NewPacket { state: BRANCHED.into(), cursor: None, error: None, ..NewPacket::from_row(&base) },
                "packet.accepted",
                None,
                Some(Box::new(move |j: &mut Journal| {
                    if let Some(c) = commit {
                        c(j)?;
                    }
                    j.event("packet.fanned_out", Some(json!({ "branches": branches })), Some(&id2), Some("input"))?;
                    j.insert_copies(&root2, &copies2, Some("input"))
                })),
            );
            if let Err(e) = r {
                return IntakeResult::Unavailable { reason: format!("journal write failed: {e}") };
            }
            {
                let mut s = self.s.borrow_mut();
                for c in &copies {
                    s.queue.push_back(c.id.clone());
                }
            }
            self.wake(true);
        }
        self.check_lifetime();
        IntakeResult::Accepted { packet_id: id }
    }

    fn lifetime_reason(&self, why: &str) -> String {
        let lt = self.pipeline().lifetime.clone().unwrap_or_else(|| crate::pipeline::Lifetime {
            ttl: None,
            max_packets: None,
            until: None,
            on_end: None,
            drain_timeout: None,
        });
        if why == "max_packets" {
            format!(
                "pipeline reached lifetime.max_packets ({}); it is no longer accepting packets",
                lt.max_packets.map(|m| m.to_string()).unwrap_or_default()
            )
        } else {
            format!("pipeline reached lifetime.until ({}); it is no longer accepting packets", lt.until.unwrap_or_default())
        }
    }

    /// Enforce `lifetime.max_packets` and `lifetime.until` (§3.8) from journal counts: on reaching either, intake
    /// stops and the pipeline drains (or stops, per `on_end`).
    pub(super) fn check_lifetime(&self) {
        let p = self.pipeline();
        let Some(lt) = p.lifetime.as_ref() else { return };
        {
            let s = self.s.borrow();
            if s.lifetime_end.is_some() || s.stopping || s.closed {
                return;
            }
        }
        if lt.max_packets.is_none() && lt.until.is_none() {
            return;
        }
        let Ok(stats) = compute_stats(&self.journal.borrow(), self.started_at(), now_ms()) else { return };
        let mut why: Option<&'static str> = None;
        if let Some(max) = lt.max_packets {
            if stats.accepted as u64 >= max {
                why = Some("max_packets");
            }
        }
        if why.is_none() {
            if let Some(until) = &lt.until {
                match evaluate(until, &json!({ "stats": stats.to_value(), "env": self.env })) {
                    Ok(v) if truthy(&v) => why = Some("until"),
                    Ok(_) => {}
                    Err(e) => {
                        // Logged once, never fatal; the pipeline keeps running.
                        let message = e.to_string();
                        let first = self.s.borrow().until_failed.as_deref() != Some(message.as_str());
                        if first {
                            self.s.borrow_mut().until_failed = Some(message.clone());
                            self.event("pipeline.lifetime_error", Some(json!({ "until": until, "error": message })), None, None);
                            self.log(
                                "warn",
                                &format!(
                                    "lifetime.until could not be evaluated: {message}. Fix the expression; the pipeline keeps running without it"
                                ),
                            );
                        }
                    }
                }
            }
        }
        let Some(why) = why else { return };
        self.s.borrow_mut().lifetime_end = Some(why);
        self.event("pipeline.lifetime", Some(json!({ "reason": why, "stats": stats.to_value() })), None, None);
        self.log("info", &self.lifetime_reason(why).replace("; it is no longer accepting packets", "; draining"));
        // Deferred so the packet that hit the limit is answered before the input shuts down.
        let me = self.rc();
        let stop = lt.on_end.as_deref() == Some("stop");
        tokio::task::spawn_local(async move {
            tokio::task::yield_now().await;
            if stop { me.stop(0).await } else { me.drain().await }
        });
    }

    /// Stall detection (§3.10, D23): pending packets and no delivery progress for `after`. Fires once per episode;
    /// a delivery ends it. Not checked while paused.
    pub(super) fn check_stall(&self) {
        let p = self.pipeline();
        let Some(stall) = p.delivered.as_ref().and_then(|d| d.stall.clone()) else { return };
        {
            let s = self.s.borrow();
            if s.stopping || s.closed || s.state != RunnerState::Active || s.stalled {
                return;
            }
        }
        let now = now_ms();
        // Units waiting for an agent (D50) are pending, but the runner isn't moving them: no stall.
        if self.journal.borrow().count_moving().unwrap_or(0) <= 0 {
            self.s.borrow_mut().progress_at = now;
            return;
        }
        let Ok(stats) = compute_stats(&self.journal.borrow(), self.started_at(), now) else { return };
        let idle = now - self.s.borrow().progress_at;
        if idle < parse_duration(&stall.after).unwrap_or(0) as i64 {
            return;
        }
        let oldest = self.journal.borrow().oldest_pending().ok().flatten();
        let stall_ctx = json!({
            "pending": stats.pending,
            "duration": format_duration(idle as u64),
            "oldest": {
                "packet_id": oldest.as_ref().map(|(r, _)| r.root.clone().unwrap_or_else(|| r.id.clone())).unwrap_or_default(),
                "node": oldest.as_ref().and_then(|(r, _)| r.cursor.clone()).unwrap_or_default(),
                "age": oldest.as_ref().map(|(r, _)| format_duration((now - r.received_at).max(0) as u64)).unwrap_or_default(),
                "attempt": oldest.as_ref().map(|(r, _)| r.attempt).unwrap_or(0),
                "last_error": oldest.as_ref().and_then(|(_, e)| e.clone()).unwrap_or_default(),
            },
        });
        let c = json!({ "stats": stats.to_value(), "env": self.env, "stall": stall_ctx });
        let fallback = format!(
            "Pipeline jammed: {} packet(s) pending and none delivered for {}.",
            stats.pending,
            format_duration(idle as u64)
        );
        let message = match &stall.message {
            Some(m) => match render_string(m, &c) {
                Ok(v) => to_text(&v.to_json()).trim().to_string(),
                Err(e) => format!("{fallback} (stall.message could not be rendered: {e})"),
            },
            None => fallback,
        };
        let message = self.secrets.redact(&message);
        let then = stall.then.clone().unwrap_or_else(|| "notify".into());
        {
            let mut s = self.s.borrow_mut();
            s.stalled = true;
            s.stall_info = Some(StallInfo {
                node: stall_ctx["oldest"]["node"].as_str().unwrap_or_default().to_string(),
                since: iso(now),
            });
        }
        self.event(
            "pipeline.stall",
            Some(json!({ "message": message, "then": then, "stall": stall_ctx, "stats": stats.to_value() })),
            None,
            None,
        );
        self.log("warn", &message);
        self.write_registry();
        // `then: agent` flags the stall and tells the agent; `on_stall: handle` hands it the units (D50).
        let handle = p.agent.as_ref().and_then(|a| a.on_stall.as_deref()) == Some("handle");
        if then == "agent" || handle {
            let units = if handle { Some(self.hand_over_stalled(&message)) } else { None };
            let mut detail = json!({ "reason": "stall", "message": message, "then": then, "handle": handle });
            if let Some((escalated, marked)) = units {
                detail["units"] = json!({ "escalated": escalated, "marked": marked });
            }
            detail["stall"] = stall_ctx;
            self.event("pipeline.escalated", Some(detail), None, None);
            self.log(
                "warn",
                &match units {
                    Some((e, m)) => format!("stall handed to the agent: {e} waiting unit(s) now, {m} at their next step"),
                    None => "stall escalated to the agent".into(),
                },
            );
        }
        if then == "pause" {
            self.pause("stall", Map::new());
        }
    }

    /// A delivery or filter is progress: restart the stall clock and clear a flagged stall.
    fn progress(&self) {
        let was = {
            let mut s = self.s.borrow_mut();
            s.progress_at = now_ms();
            let was = s.stalled;
            s.stalled = false;
            s.stall_info = None;
            was
        };
        if !was {
            return;
        }
        self.event("pipeline.unjammed", None, None, None);
        self.log("info", "no longer jammed: a packet reached the output again");
        self.write_registry();
    }

    /// Resolves when the packet is terminal; None if `ms` passes or the runner stops first.
    pub async fn await_terminal(&self, id: &str, ms: u64) -> Option<Settled> {
        let row = self.journal.borrow().get(id).ok().flatten();
        // Waiting for an agent (D50) has no end in sight, so a caller waiting for the result gets that state now.
        if let Some(r) = row {
            if is_terminal(&r.state) || r.state == ESCALATED {
                return Some(Settled { state: r.state.clone(), error: error_value(&r.error) });
            }
        }
        let (tx, rx) = oneshot::channel();
        self.s.borrow_mut().settle_waiters.entry(id.to_string()).or_default().push(tx);
        let out = tokio::time::timeout(Duration::from_millis(ms), rx).await.ok().and_then(|r| r.ok()).flatten();
        // Drop our sender if it timed out (closed senders are pruned).
        let mut s = self.s.borrow_mut();
        if let Some(ws) = s.settle_waiters.get_mut(id) {
            ws.retain(|w| !w.is_closed());
            if ws.is_empty() {
                s.settle_waiters.remove(id);
            }
        }
        out
    }

    fn notify_settled(&self, id: &str, state: &str, error: &Option<PacketError>) {
        let waiters = self.s.borrow_mut().settle_waiters.remove(id).unwrap_or_default();
        for w in waiters {
            let _ = w.send(Some(Settled { state: state.to_string(), error: error_value(error) }));
        }
    }

    fn first_failed_rule(&self, plan: &Plan, data: &Value, c: &Value) -> Option<Failure> {
        if let Some(schema) = &plan.input_schema {
            if let Some(e) = schema.check(data) {
                return Some(Failure { code: "input.schema".into(), rule: Some("schema".into()), message: format!("schema: {e}"), ..Default::default() });
            }
        }
        for rule in plan.pipeline.input.validate.clone().unwrap_or_default() {
            match evaluate(&rule, c) {
                Ok(v) if truthy(&v) => {}
                Ok(_) => {
                    return Some(Failure { code: "input.invalid".into(), message: format!("rule '{rule}' failed"), rule: Some(rule), ..Default::default() });
                }
                Err(e) => {
                    return Some(Failure {
                        code: "input.invalid".into(),
                        message: format!("rule '{rule}' could not be evaluated: {e}"),
                        rule: Some(rule),
                        ..Default::default()
                    });
                }
            }
        }
        None
    }

    // ── processing ───────────────────────────────────────────────────────────────

    pub(super) async fn work(&self) {
        loop {
            let st = self.state();
            if st == RunnerState::Stopped || st == RunnerState::Failed {
                return;
            }
            let id = if self.holding() { None } else { self.s.borrow_mut().queue.pop_front() };
            let Some(id) = id else {
                self.wakeup.notified().await;
                continue;
            };
            self.s.borrow_mut().busy += 1;
            if let Err(e) = self.process(&id).await {
                // A bug, not a pipeline error: leave the packet where it is so it resumes on restart.
                self.log("error", &format!("internal error on packet {id}: {e}"));
            }
            self.s.borrow_mut().busy -= 1;
        }
    }

    async fn process(&self, id: &str) -> Result<(), String> {
        let mut row = self.journal.borrow().get(id)?;
        loop {
            let Some(r) = row.as_ref() else { return Ok(()) };
            let Some(step) = r.cursor.clone() else { return Ok(()) };
            let st = self.state();
            if st == RunnerState::Stopped || st == RunnerState::Failed {
                return Ok(());
            }
            // Escalated (D50) or settled meanwhile: nothing to run.
            if !IN_FLIGHT.contains(&r.state.as_str()) {
                return Ok(());
            }
            let r = r.clone();
            let stalled = self.s.borrow().hand_over.get(id).cloned();
            if let Some(message) = stalled {
                let t = stall_escalation(&r, &message);
                self.escalate(id, &step, t);
                return Ok(());
            }
            if self.holding() {
                self.s.borrow_mut().held.push(id.to_string());
                return Ok(());
            }
            let plan = self.plan(r.version).await?;
            if step == BATCH_STEP {
                self.batch_for(&plan).add(r);
                return Ok(());
            }
            let began = Instant::now();
            let t = if step == OUTPUT_STEP {
                Some(self.write_step(&plan, &r).await)
            } else if step == VERIFY_STEP {
                if plan.pipeline.delivered.as_ref().and_then(|d| d.check.as_deref()) == Some("external") {
                    self.await_ack(&plan, &r)
                } else {
                    Some(self.verify_step(&plan, &r).await)
                }
            } else {
                Some(self.node_step(&plan, &r, &step).await)
            };
            let Some(t) = t else { return Ok(()) }; // parked until its ack or deadline
            // A completed node or output step records how long it took, on its transition (D54).
            let ms = if step == VERIFY_STEP { None } else { Some(began.elapsed().as_secs_f64() * 1000.0) };
            match t {
                Transition::Escalate { .. } => {
                    self.escalate(id, &step, t);
                    return Ok(());
                }
                Transition::Hold { .. } => {
                    self.hold(id, &step, t);
                    return Ok(());
                }
                Transition::End { .. } => {
                    self.end(id, &step, t, ms);
                    return Ok(());
                }
                Transition::Split { .. } => {
                    self.split(&r, &step, t, ms);
                    return Ok(());
                }
                Transition::Move { to, data, iteration, result, event, extra } => {
                    let state = if to == OUTPUT_STEP || to == BATCH_STEP {
                        "writing"
                    } else if to == VERIFY_STEP {
                        "verifying"
                    } else {
                        "processing"
                    };
                    let patch = PacketPatch {
                        state: Some(state.into()),
                        cursor: Some(Some(to.clone())),
                        data: Some(data),
                        // Joining a batch is not a step of its own: the flush counts the hop.
                        hops: Some(if to == BATCH_STEP { r.hops } else { r.hops + 1 }),
                        attempt: Some(0),
                        iteration,
                        result,
                        ..Default::default()
                    };
                    self.journal.borrow_mut().update(id, &patch, &event, Some(&step), None, &extra, ms)?;
                    // It moved on, so it is no longer stalled (D50).
                    self.s.borrow_mut().hand_over.remove(id);
                    row = self.journal.borrow().get(id)?;
                }
            }
        }
    }

    /// Commit a fan-out: the parent's step and every copy in one transaction, so a crash never splits it halfway.
    fn split(&self, row: &PacketRow, step: &str, t: Transition, ms: Option<f64>) {
        let Transition::Split { to, data, event, extra } = t else { return };
        self.s.borrow_mut().hand_over.remove(&row.id);
        let cs = copies(row, &to, &data, row.hops + 1);
        let branches: Vec<String> = cs.iter().map(|c| c.branch.clone()).collect();
        let mut extra = extra;
        extra.push((event, None));
        let r = self.journal.borrow_mut().atomically(|j| {
            j.update(
                &row.id,
                &PacketPatch {
                    state: Some(BRANCHED.into()),
                    cursor: Some(None),
                    data: Some(data.clone()),
                    hops: Some(row.hops + 1),
                    attempt: Some(0),
                    ..Default::default()
                },
                "packet.fanned_out",
                Some(step),
                Some(json!({ "branches": branches })),
                &extra,
                ms,
            )?;
            j.insert_copies(row, &cs, Some(step))
        });
        if let Err(e) = r {
            self.log("error", &format!("internal error on packet {}: {e}", row.id));
            return;
        }
        {
            let mut s = self.s.borrow_mut();
            for c in &cs {
                s.queue.push_back(c.id.clone());
            }
        }
        self.wake(true);
    }

    fn end(&self, id: &str, step: &str, t: Transition, ms: Option<f64>) {
        let Transition::End { state, error, event, extra } = t else { return };
        self.s.borrow_mut().hand_over.remove(id);
        // A copy's end and the settling of the packet it belongs to commit together (D22).
        let settled = self.journal.borrow_mut().atomically(|j| {
            j.update(
                id,
                &PacketPatch { state: Some(state.into()), cursor: Some(None), error: Some(error.clone()), ..Default::default() },
                &event,
                Some(step),
                error_value(&error),
                &extra,
                ms,
            )?;
            j.settle_ancestors(id)
        });
        let settled = match settled {
            Ok(s) => s,
            Err(e) => {
                self.log("error", &format!("internal error on packet {id}: {e}"));
                return;
            }
        };
        if state == "delivered" || state == "filtered" {
            self.progress();
        }
        self.notify_settled(id, state, &error);
        for a in &settled {
            self.notify_settled(&a.id, &a.state, &a.error);
        }
        self.check_lifetime();
        if state == "dead_lettered" {
            self.log(
                "warn",
                &format!("packet {id} dead-lettered at {step}: {}", error.as_ref().map(|e| e.message.as_str()).unwrap_or("")),
            );
        }
    }

    // ── agent hand-over (spec §3.9, §3.10, §9, D50) ──────────────────────────────

    /// Hand a unit to the agent: state `escalated`, with the error and the cursor a retry resumes at, and a
    /// `packet.escalated` event, in one transaction. Nothing runs it again until `resolve`.
    fn escalate(&self, id: &str, step: &str, t: Transition) {
        let Transition::Escalate { stall_reason, error, stall } = t else { return };
        self.s.borrow_mut().hand_over.remove(id);
        let cursor = if step == BATCH_STEP || step == VERIFY_STEP { OUTPUT_STEP } else { step };
        crash_point("escalate.prepared");
        let mut detail = json!({ "reason": if stall_reason { "stall" } else { "error" }, "error": error });
        if let Some(s) = &stall {
            detail["stall"] = json!(s);
        }
        let r = self.journal.borrow_mut().update(
            id,
            &PacketPatch {
                state: Some(ESCALATED.into()),
                cursor: Some(Some(cursor.into())),
                error: Some(Some(error.clone())),
                ..Default::default()
            },
            "packet.escalated",
            Some(step),
            Some(detail),
            &[],
            None,
        );
        if let Err(e) = r {
            self.log("error", &format!("internal error on packet {id}: {e}"));
            return;
        }
        self.notify_settled(id, ESCALATED, &Some(error.clone()));
        self.log(
            "warn",
            &format!(
                "packet {id} handed to the agent at {}{}: {}; it waits until it is resolved (retry, dead_letter or drop)",
                error.node.as_deref().unwrap_or(""),
                if stall_reason { " (stall)" } else { "" },
                error.message
            ),
        );
    }

    /// `agent.on_stall: handle` (D50): every unit in flight when the stall fires goes to the agent. Waiting units
    /// are escalated now; a unit a worker or a batch holds is marked and escalated at its next safe point.
    fn hand_over_stalled(&self, message: &str) -> (usize, usize) {
        let in_flight = self.journal.borrow().in_flight().unwrap_or_default();
        let mut now: Vec<PacketRow> = vec![];
        let mut marked = 0;
        {
            let mut s = self.s.borrow_mut();
            let queued: HashSet<String> = s.queue.iter().cloned().collect();
            let held: HashSet<String> = s.held.iter().cloned().collect();
            for row in in_flight {
                if queued.contains(&row.id) || held.contains(&row.id) || s.awaiting.contains_key(&row.id) {
                    now.push(row);
                } else if !s.hand_over.contains_key(&row.id) {
                    s.hand_over.insert(row.id.clone(), message.to_string());
                    marked += 1;
                }
            }
            let taken: HashSet<String> = now.iter().map(|r| r.id.clone()).collect();
            s.queue.retain(|id| !taken.contains(id));
            s.held.retain(|id| !taken.contains(id));
            for id in &taken {
                if let Some(t) = s.awaiting.remove(id) {
                    t.abort();
                }
            }
        }
        for chunk in now.chunks(HANDOVER_CHUNK) {
            let r = self.journal.borrow_mut().atomically(|j| {
                for row in chunk {
                    let Transition::Escalate { error, .. } = stall_escalation(row, message) else { continue };
                    let cursor = match row.cursor.as_deref() {
                        Some(c) if c == BATCH_STEP || c == VERIFY_STEP => Some(OUTPUT_STEP.to_string()),
                        other => other.map(str::to_owned),
                    };
                    j.update(
                        &row.id,
                        &PacketPatch {
                            state: Some(ESCALATED.into()),
                            cursor: Some(cursor),
                            error: Some(Some(error.clone())),
                            ..Default::default()
                        },
                        "packet.escalated",
                        row.cursor.as_deref(),
                        Some(json!({ "reason": "stall", "error": error, "stall": message })),
                        &[],
                        None,
                    )?;
                }
                Ok(())
            });
            if let Err(e) = r {
                self.log("error", &format!("internal error handing units to the agent: {e}"));
                continue;
            }
            for row in chunk {
                if let Transition::Escalate { error, .. } = stall_escalation(row, message) {
                    self.notify_settled(&row.id, ESCALATED, &Some(error));
                }
            }
        }
        (now.len(), marked)
    }

    /// Resolve units waiting for the agent (D50), all or nothing, in one transaction.
    pub fn resolve(&self, ids: &[String], action: &str, by: &str, by_kind: Option<&str>, reason: Option<&str>) -> Result<Value, ControlError> {
        let p = self.pipeline();
        let name = p.name.clone();
        let st = self.state();
        if st != RunnerState::Active && st != RunnerState::Paused {
            return Err(ControlError::new(
                "invalid_state",
                format!("cannot resolve: pipeline is {}", st.as_str()),
                "resolve works while the pipeline is active or paused; start it again (pipo start)",
            ));
        }
        if by_kind == Some("agent") && p.agent.as_ref().and_then(|a| a.control) != Some(true) {
            return Err(ControlError::new(
                "invalid_state",
                format!("agents can't resolve packets of {name}: agent.control is off in v{}", self.version()),
                "a person can resolve them, or turn agent.control on in the pipeline file",
            ));
        }
        let internal = |e: String| ControlError::new("internal", e, "try again");
        for id in ids {
            let row = self.journal.borrow().get(id).map_err(internal)?;
            let Some(row) = row else {
                return Err(ControlError::new(
                    "not_found",
                    format!("no packet '{id}' in {name}"),
                    format!("list the packets waiting for an agent: the packets op with state escalated (pipo packets {name})"),
                ));
            };
            if row.state != ESCALATED {
                let all = self.journal.borrow().copies(row.root.as_deref().unwrap_or(&row.id)).map_err(internal)?;
                let waiting: Vec<String> = all
                    .into_iter()
                    .filter(|c| c.state == ESCALATED && (row.root.is_none() || c.id.starts_with(&format!("{id}/"))))
                    .map(|c| c.id)
                    .collect();
                return Err(ControlError::new(
                    "invalid_state",
                    format!("packet {id} is {}, not waiting for an agent", row.state),
                    if waiting.is_empty() {
                        format!("pipo inspect {name} {id} shows where it is")
                    } else {
                        format!("its copies wait on their own; resolve them by id: {}", waiting.join(", "))
                    },
                ));
            }
            if action == "drop" && row.cursor.as_deref() == Some(OUTPUT_STEP) {
                return Err(ControlError::new(
                    "invalid_state",
                    format!("packet {id} waits at the output, where drop is not allowed (spec §3.9)"),
                    "retry it or dead_letter it",
                ));
            }
        }
        let mut settled: Vec<(String, String, Option<PacketError>)> = vec![];
        let mut resolved: Vec<Value> = vec![];
        let by_r = self.secrets.redact(by);
        let reason_r = reason.map(|r| self.secrets.redact(r));
        let result = self.journal.borrow_mut().atomically(|j| {
            for id in ids {
                let row = j.get(id)?.ok_or_else(|| format!("packet {id} was resolved meanwhile"))?;
                if row.state != ESCALATED {
                    return Err(format!("\u{0}stale:packet {id} was resolved meanwhile"));
                }
                // Free text from the caller: a secret pasted into it must never reach the journal.
                let detail = json!({ "action": action, "by": by_r, "by_kind": by_kind, "reason": reason_r, "error": row.error });
                if action == "retry" {
                    let state = if row.cursor.as_deref() == Some(OUTPUT_STEP) { "writing" } else { "processing" };
                    let loop_max = row.error.as_ref().map(|e| e.code == "loop.max").unwrap_or(false);
                    j.update(
                        id,
                        &PacketPatch {
                            state: Some(state.into()),
                            error: Some(None),
                            attempt: Some(0),
                            iteration: if loop_max { Some(0) } else { None },
                            ..Default::default()
                        },
                        "packet.resolved",
                        row.cursor.as_deref(),
                        Some(detail),
                        &[],
                        None,
                    )?;
                    resolved.push(json!({ "packet_id": id, "state": state, "node": row.cursor }));
                    continue;
                }
                let state = if action == "drop" { "filtered" } else { "dead_lettered" };
                j.update(
                    id,
                    &PacketPatch { state: Some(state.into()), cursor: Some(None), ..Default::default() },
                    if action == "drop" { "packet.dropped" } else { "packet.dead_lettered" },
                    row.cursor.as_deref(),
                    error_value(&row.error),
                    &[("packet.resolved".to_string(), Some(detail))],
                    None,
                )?;
                settled.push((id.clone(), state.to_string(), row.error.clone()));
                for a in j.settle_ancestors(id)? {
                    settled.push((a.id, a.state, a.error));
                }
                resolved.push(json!({ "packet_id": id, "state": state, "node": row.error.as_ref().and_then(|e| e.node.clone()) }));
            }
            Ok(())
        });
        if let Err(e) = result {
            if let Some(m) = e.strip_prefix("\u{0}stale:") {
                return Err(ControlError::new("invalid_state", m, "nothing was resolved; retry"));
            }
            return Err(internal(e));
        }
        crash_point("resolve.committed");
        if action == "retry" {
            self.requeue(ids.to_vec());
        }
        for (id, state, error) in &settled {
            self.notify_settled(id, state, error);
        }
        if action == "drop" {
            self.progress();
        }
        self.check_lifetime();
        self.log("info", &format!("{by} resolved {} packet(s) waiting for the agent: {action}", ids.len()));
        Ok(json!({ "action": action, "resolved": resolved }))
    }

    fn hold(&self, id: &str, step: &str, t: Transition) {
        let Transition::Hold { pause, error, reason, detail } = t else { return };
        self.event(
            "packet.held",
            Some(json!({ "how": if pause { "pause" } else { "halt" }, "error": error })),
            Some(id),
            Some(step),
        );
        if pause {
            self.s.borrow_mut().held.push(id.to_string());
            self.pause(&reason.unwrap_or_else(|| format!("error at {step}")), detail);
        } else if self.state() != RunnerState::Failed {
            self.s.borrow_mut().state = RunnerState::Failed;
            self.log("error", &format!("halted by {step}: {}", error.message));
            let me = self.rc();
            tokio::task::spawn_local(async move { me.stop(0).await });
        }
    }

    async fn node_step(&self, plan: &Plan, row: &PacketRow, id: &str) -> Transition {
        let emitted: Rc<RefCell<Emitted>> = Rc::new(RefCell::new(vec![]));
        let t = self.run_node(plan, row, id, emitted.clone()).await;
        let extra = emitted.borrow().clone();
        match t {
            Transition::Hold { .. } | Transition::Escalate { .. } => t,
            other => with_extra(other, extra),
        }
    }

    async fn run_node(&self, plan: &Plan, row: &PacketRow, id: &str, emitted: Rc<RefCell<Emitted>>) -> Transition {
        let Some(node) = plan.pipeline.nodes.get(id).cloned() else {
            return self.fail(plan, row, id, &resolve_policy(None, None), Failure { code: "node.failed".into(), message: format!("node '{id}' is not in v{}", plan.version), ..Default::default() }, None);
        };
        let kind = node.kind();
        let policy = resolve_policy(plan.pipeline.errors.as_ref(), node.on_error.as_ref());
        // Filters and routes are deterministic: retrying them can't change the outcome.
        let mut effective = policy.clone();
        if matches!(kind, Some(NodeKind::Filter) | Some(NodeKind::Route)) {
            effective.retry = 0;
        }
        enum Out {
            Data(Value),
            Pass(bool),
            Branch(Option<String>),
        }
        let run = attempt(
            &effective,
            |n| {
                let node = node.clone();
                let emitted = emitted.clone();
                async move {
                    emitted.borrow_mut().clear();
                    let meta = self.meta(plan, row, id, n);
                    let c = ctx(&row.data, &meta, &self.env);
                    match kind {
                        Some(NodeKind::Filter) => {
                            let v = evaluate(node.filter.as_deref().unwrap_or("true"), &c).map_err(|e| StepError::new(e.to_string()))?;
                            Ok(Out::Pass(truthy(&v)))
                        }
                        Some(NodeKind::Route) => {
                            for (branch, expr) in node.routes() {
                                if expr == "else" {
                                    return Ok(Out::Branch(Some(branch)));
                                }
                                let v = evaluate(&expr, &c).map_err(|e| StepError::new(e.to_string()))?;
                                if truthy(&v) {
                                    return Ok(Out::Branch(Some(branch)));
                                }
                            }
                            Ok(Out::Branch(None))
                        }
                        Some(NodeKind::Tap) => {
                            self.action(plan, node.tap.as_deref().unwrap_or(""), "tap", &node, row, &meta, &emitted).await?;
                            Ok(Out::Data(row.data.clone()))
                        }
                        Some(NodeKind::Transform) => {
                            let action = node.transform.clone().unwrap_or_default();
                            match self.action(plan, &action, "transform", &node, row, &meta, &emitted).await? {
                                Some(v) => Ok(Out::Data(v)),
                                None => Err(StepError::new(format!("{action} returned nothing; return the new data"))),
                            }
                        }
                        Some(NodeKind::Agent) => Ok(Out::Data(self.agent_call(plan, &node, row, id, &meta, n).await?)),
                        None => Err(StepError::new("node kind 'undefined' is not implemented")),
                    }
                }
            },
            |err, n, wait| self.retrying(row, id, &err.message, n, wait),
            || self.s.borrow().hand_over.contains_key(&row.id),
        )
        .await;

        let value = match run {
            Attempted::Ok { value, .. } => value,
            Attempted::Failed { error, attempts, elapsed } => {
                if let Some(kind) = error.kind.as_deref().filter(|k| k.starts_with("budget.")) {
                    if kind == "budget.day" {
                        // The packet waits at this node; the pause resumes it when the next budget day opens (§3.11).
                        let message = self.secrets.redact(&error.message);
                        let mut detail = error.detail.clone().and_then(|d| d.as_object().cloned()).unwrap_or_default();
                        detail.insert("message".into(), json!(message));
                        return Transition::Hold {
                            pause: true,
                            error: PacketError { code: kind.into(), message, node: Some(id.into()), attempts: Some(1) },
                            reason: Some("budget".into()),
                            detail,
                        };
                    }
                    // Per-packet cap: dead-lettered whatever `on_error.then` says (§3.11).
                    let mut p = policy.clone();
                    p.then = "dead_letter".into();
                    return self.fail(plan, row, id, &p, Failure { code: kind.into(), message: error.message, attempts: Some(attempts), ..Default::default() }, None);
                }
                if policy.then == "continue" && kind == Some(NodeKind::Tap) {
                    return self.advance(plan, id, row.data.clone(), "node.failed_continued");
                }
                return self.fail(
                    plan,
                    row,
                    id,
                    &policy,
                    Failure { code: "node.failed".into(), message: error.message, attempts: Some(attempts), elapsed: Some(elapsed), rule: None },
                    None,
                );
            }
        };
        let (data, branch) = match value {
            Out::Pass(false) => return end("filtered", "packet.filtered"),
            Out::Pass(true) => (row.data.clone(), None),
            Out::Data(d) => (d, None),
            Out::Branch(b) => (row.data.clone(), Some(b)),
        };

        if let Some(lp) = &node.loop_ {
            let meta = self.meta(plan, row, id, 1);
            let done = evaluate(&lp.until, &ctx(&data, &meta, &self.env)).map(|v| truthy(&v)).unwrap_or(false);
            if !done {
                if row.iteration < lp.max as i64 {
                    return Transition::Move {
                        to: lp.back_to.clone(),
                        data,
                        iteration: Some(row.iteration + 1),
                        result: None,
                        event: "node.looped".into(),
                        extra: vec![],
                    };
                }
                let mut loop_policy = policy.clone();
                loop_policy.then = lp.then.clone().unwrap_or_else(|| "dead_letter".into());
                return self.fail(
                    plan,
                    row,
                    id,
                    &loop_policy,
                    Failure { code: "loop.max".into(), message: format!("loop reached max {} without '{}'", lp.max, lp.until), ..Default::default() },
                    Some(data),
                );
            }
        }
        if kind == Some(NodeKind::Route) {
            return match branch.flatten() {
                None => end("filtered", "packet.filtered"),
                Some(b) => self.advance(plan, &format!("{id}.{b}"), data, "node.done"),
            };
        }
        self.advance(plan, id, data, "node.done")
    }

    /// One agent call (§3.4, §3.11, D36): budget checks, the rendered prompt under `timeout`, the usage journaled as
    /// soon as the provider reports it, then the output checked against `with.schema`.
    async fn agent_call(&self, plan: &Plan, node: &crate::pipeline::Node, row: &PacketRow, id: &str, meta: &Value, attempt_no: u32) -> Result<Value, StepError> {
        let name = node.agent.clone().unwrap_or_default();
        let provider = self.agents.providers.get(&name).cloned().ok_or_else(|| StepError::new(format!("agent provider '{name}' is not available")))?;
        let budget = self.budget.as_ref().ok_or_else(|| StepError::new("agent budget is not set up"))?;
        let root = row.root.clone().unwrap_or_else(|| row.id.clone());
        let per_packet = plan.pipeline.agent_budget.as_ref().and_then(|b| b.per_packet);
        let stop = |b: crate::agents::BudgetStop| StepError {
            message: b.message,
            fatal: true,
            kind: Some(format!("budget.{}", b.kind)),
            detail: Some(Value::Object(b.detail)),
        };
        budget.check_day().map_err(stop)?;
        let used = budget.check_packet(&root, per_packet).map_err(stop)?;

        let c = json!({ "data": row.data, "meta": meta, "env": self.env, "secrets": self.secrets.values });
        let w = render(&Value::Object(node.with.clone().unwrap_or_default()), &c).map_err(|e| StepError::new(e.to_string()))?;
        let cli = self.agents.is_cli(&name);
        // A CLI agent without a model uses the CLI's own default (D67).
        let model = match w.get("model") {
            None | Some(Value::Null) => String::new(),
            Some(m) => to_text(m),
        };
        let price = self.agents.pricing.get(&name).and_then(|p| price_for(p, &model));
        if price.is_none() && !cli {
            return Err(StepError::new(format!("no price for model '{model}'; add agents.{name}.pricing.{model} to config.yaml")));
        }
        let manifest_timeout = self.agents.manifests.get(&name).and_then(|m| m.get("timeout")).and_then(|t| t.as_str()).map(str::to_owned);
        let timeout_text = w.get("timeout").map(to_text).or(manifest_timeout).unwrap_or_else(|| AGENT_TIMEOUT.into());
        let timeout = parse_duration(&timeout_text).map_err(StepError::new)?;
        let mut cwd = None;
        if cli {
            if let Some(dir) = w.get("cwd") {
                let path = self.dir.join(to_text(dir));
                if !path.is_dir() {
                    return Err(StepError::new(format!(
                        "with.cwd: {} is not a folder; create it, or leave cwd out to run in a fresh empty folder",
                        path.display()
                    )));
                }
                cwd = Some(path);
            }
        }
        let configured = w.get("max_tokens").and_then(|m| m.as_f64()).map(|m| m as u64).unwrap_or(AGENT_MAX_TOKENS);
        // Never ask for more output than the packet has left (§3.11).
        let max_tokens = match per_packet {
            None => configured,
            Some(cap) => configured.min(cap.saturating_sub(used)).max(1),
        };
        let schema = plan.agent_schemas.get(id).ok_or_else(|| StepError::new(format!("agent node '{id}' has no schema")))?;
        let record = |usage: &crate::agents::AgentUsage| -> u64 {
            let cost = usage.cost_usd.unwrap_or_else(|| price.map(|p| cost_of(p, usage.input_tokens, usage.output_tokens)).unwrap_or(0.0));
            let r = self.journal.borrow_mut().record_agent_usage(&crate::journal::AgentUsageRow {
                at: now_ms(),
                unit: row.id.clone(),
                root: root.clone(),
                node: id.to_string(),
                provider: name.clone(),
                model: model.clone(),
                input_tokens: usage.input_tokens as i64,
                output_tokens: usage.output_tokens as i64,
                cost_usd: cost,
                attempt: attempt_no as i64,
            });
            if let Err(e) = r {
                self.log("error", &format!("journal write failed (agent.usage): {e}"));
            }
            if let Some(warning) = budget.warning() {
                let message = warning.get("message").map(to_text).unwrap_or_default();
                self.event("budget.warning", Some(Value::Object(warning)), None, None);
                self.log("warn", &message);
            }
            used + usage.input_tokens + usage.output_tokens
        };
        let abort = Rc::new(Notify::new());
        let req = AgentRequest {
            model: model.clone(),
            prompt: w.get("prompt").map(to_text).unwrap_or_default(),
            schema: schema.schema.clone(),
            max_tokens,
            abort: abort.clone(),
            cwd,
            allow_tools: cli && w.get("allow_tools") == Some(&Value::Bool(true)),
        };
        let call = provider.complete(req);
        let result = match tokio::time::timeout(Duration::from_millis(timeout), call).await {
            Ok(r) => r,
            Err(_) => {
                abort.notify_waiters();
                return Err(StepError::new(format!("agent call timed out after {} (with.timeout)", format_duration(timeout))));
            }
        };
        let result = match result {
            Ok(r) => r,
            Err(e) => {
                if let Some(u) = &e.usage {
                    let total = record(u);
                    if let Some(cap) = per_packet {
                        if total > cap {
                            return Err(stop(packet_stop(total, cap)));
                        }
                    }
                }
                return Err(StepError::new(self.secrets.redact(&e.message)));
            }
        };
        let total = record(&result.usage);
        if let Some(cap) = per_packet {
            if total > cap {
                return Err(stop(packet_stop(total, cap)));
            }
        }
        if let Some(mismatch) = schema.check(&result.output) {
            return Err(StepError::new(format!("agent output does not match {}: {}", schema.path, self.secrets.redact(&mismatch))));
        }
        Ok(result.output)
    }

    /// Hand the result to whatever consumes `reference`: nothing (filtered), one step, or several (a fan-out).
    fn advance(&self, plan: &Plan, reference: &str, data: Value, event: &str) -> Transition {
        let to = plan.next_of(reference);
        match to.len() {
            0 => end("filtered", "packet.filtered"),
            1 => Transition::Move { to: to[0].clone(), data, iteration: None, result: None, event: event.into(), extra: vec![] },
            _ => Transition::Split { to: to.to_vec(), data, event: event.into(), extra: vec![] },
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn action(
        &self,
        plan: &Plan,
        action: &str,
        kind: &str,
        node: &crate::pipeline::Node,
        row: &PacketRow,
        meta: &Value,
        emitted: &Rc<RefCell<Emitted>>,
    ) -> Result<Option<Value>, StepError> {
        let data = &row.data;
        if let Some(name) = fn_ref(action) {
            if plan.fns.contains(action) {
                let out = self.fns.call(plan.version as u32, name, data, meta).await.map_err(|e| StepError::new(self.secrets.redact(&e)))?;
                return Ok(if kind == "transform" { out } else { None });
            }
        }
        let c = json!({ "data": data, "meta": meta, "env": self.env, "secrets": self.secrets.values });
        let w = render(&Value::Object(node.with.clone().unwrap_or_default()), &c).map_err(|e| StepError::new(e.to_string()))?;
        let w = w.as_object().cloned().unwrap_or_default();
        let node_id = meta.get("node").and_then(|n| n.as_str()).unwrap_or_default().to_string();
        if kind == "tap" && action == "log" {
            let message = match w.get("message") {
                None => crate::expr::js_json(data),
                Some(m) => to_text(m),
            };
            let level = w.get("level").map(to_text).unwrap_or_else(|| "info".into());
            self.log(&level, &message);
            self.event("log", Some(json!({ "level": level, "message": self.secrets.redact(&message) })), Some(&row.id), Some(&node_id));
            return Ok(None);
        }
        if kind == "transform" && action == "map" {
            return Ok(Some(w.get("data").cloned().unwrap_or(Value::Null)));
        }
        let adapter = self.step_adapter(kind, action).map_err(StepError::new)?;
        // Step keys use the journal unit, so a branch copy's key is `<packet_id>:<branch>:<node>` (D16, D22).
        let res = adapter
            .run(StepInput {
                packet_id: row.id.clone(),
                node: node_id,
                data: data.clone(),
                with: w,
                origin: Some(Origin { trigger: row.trigger.clone(), source: row.source.clone() }),
            })
            .await
            .map_err(|e| StepError::new(self.secrets.redact(&e)))?;
        for (t, d) in res.events {
            emitted.borrow_mut().push((t, d.map(|d| self.secrets.redact_value(&d))));
        }
        Ok(if kind == "transform" { res.data } else { None })
    }

    fn step_adapter(&self, kind: &str, action: &str) -> Result<Rc<dyn StepAdapter>, String> {
        let key = format!("{kind}:{action}");
        if let Some(a) = self.steps.borrow().get(&key) {
            return Ok(a.clone());
        }
        let me = self.me.clone();
        let ctx = ConnectorContext {
            pipeline: self.pipeline(),
            dir: self.dir.clone(),
            log: Rc::new(move |l: &str, m: &str| {
                if let Some(r) = me.upgrade() {
                    r.log(l, m);
                }
            }),
            print: self.opts.print.clone(),
            listen: None,
            hostname: None,
            with: Map::new(),
            home: self.home.clone(),
            bots: self.bots.clone(),
            redact: self.redactor(),
        };
        let adapter: Rc<dyn StepAdapter> = Rc::from(connectors::make_step(kind, action, &ctx).map_err(|e| e.0)?);
        self.steps.borrow_mut().insert(key, adapter.clone());
        Ok(adapter)
    }

    async fn write_step(&self, plan: &Plan, row: &PacketRow) -> Transition {
        let out = &plan.pipeline.output;
        let meta = self.meta(plan, row, "output", 1);
        let output_json = serde_json::to_value(out).unwrap_or(Value::Null);
        let c = json!({ "data": row.data, "meta": meta, "env": self.env, "output": output_json });
        for rule in out.validate.clone().unwrap_or_default() {
            let (ok, why) = match evaluate(&rule, &c) {
                Ok(v) => (truthy(&v), format!("rule '{rule}' failed")),
                Err(e) => (false, format!("rule '{rule}' could not be evaluated: {e}")),
            };
            if !ok {
                let mut policy = resolve_policy(None, None);
                policy.then = out.on_invalid.as_ref().and_then(|i| i.then.clone()).unwrap_or_else(|| "dead_letter".into());
                policy.message = out.on_invalid.as_ref().and_then(|i| i.message.clone());
                return self.fail(plan, row, "output", &policy, Failure { code: "output.invalid".into(), rule: Some(rule), message: why, ..Default::default() }, None);
            }
        }
        // Only packets that passed validation join a batch (spec §3.5.1); the flush writes them.
        if out.batch.is_some() {
            return Transition::Move { to: BATCH_STEP.into(), data: row.data.clone(), iteration: None, result: None, event: "output.batched".into(), extra: vec![] };
        }
        let policy = resolve_policy(plan.pipeline.errors.as_ref(), out.on_error.as_ref());
        let run = attempt(
            &policy,
            |n| async move {
                let item = self.write_item(plan, row, n).map_err(StepError::new)?;
                let results = self.output.write(vec![item]).await.map_err(|e| StepError::new(self.secrets.redact(&e)))?;
                Ok(results.into_iter().next().unwrap_or(Value::Null))
            },
            |err, n, wait| self.retrying(row, "output", &err.message, n, wait),
            || self.s.borrow().hand_over.contains_key(&row.id),
        )
        .await;
        match run {
            Attempted::Ok { value, .. } => Transition::Move {
                to: VERIFY_STEP.into(),
                data: row.data.clone(),
                iteration: None,
                result: Some(value),
                event: "output.written".into(),
                extra: vec![],
            },
            Attempted::Failed { error, attempts, elapsed } => self.fail(
                plan,
                row,
                "output",
                &policy,
                Failure { code: "output.failed".into(), message: error.message, attempts: Some(attempts), elapsed: Some(elapsed), rule: None },
                None,
            ),
        }
    }

    // ── output batches (spec §3.5.1, D20) ────────────────────────────────────────

    fn batch_for(&self, plan: &Plan) -> Rc<Batch> {
        if let Some(b) = self.batches.borrow().get(&plan.version) {
            return b.clone();
        }
        let cfg = plan.pipeline.output.batch.clone().unwrap_or(crate::pipeline::Batch { size: 1, within: None });
        let within = parse_duration(cfg.within.as_deref().unwrap_or(DEFAULT_BATCH_WITHIN)).unwrap_or(1000);
        let runner = self.me.clone();
        let batch = Rc::new_cyclic(|me| Batch {
            size: cfg.size.max(1) as usize,
            within,
            pending: RefCell::new(vec![]),
            members: RefCell::new(HashSet::new()),
            timer: RefCell::new(None),
            lock: Rc::new(tokio::sync::Mutex::new(())),
            closed: Cell::new(false),
            runner,
            version: plan.version,
            me: me.clone(),
        });
        self.batches.borrow_mut().insert(plan.version, batch.clone());
        batch
    }

    pub(super) async fn flush_batches(&self) {
        let futures: Vec<_> = self.batches.borrow().values().map(|b| b.flush()).collect();
        for f in futures {
            f.await;
        }
    }

    pub(super) fn spawn_flush_batches(&self) {
        for b in self.batches.borrow().values() {
            b.spawn_flush();
        }
    }

    pub(super) fn batched(&self) -> usize {
        self.batches.borrow().values().map(|b| b.count()).sum()
    }

    /// One flush is one write of every packet in `rows`, retried under `on_error`. When the retries run out the
    /// group is split in half and each half flushed the same way, down to single packets, so only the packets that
    /// still fail get the policy's final action. A successful write commits all its packets' transitions at once.
    fn flush_group<'a>(&'a self, plan: &'a Plan, policy: &'a ResolvedPolicy, rows: Vec<PacketRow>) -> connectors::LocalBoxFuture<'a, ()> {
        Box::pin(async move {
            if self.s.borrow().closed || rows.is_empty() {
                return;
            }
            let batch = self.batch_for(plan);
            let began = Instant::now();
            let rows_ref = &rows;
            let run = attempt(
                policy,
                |n| async move {
                    let mut items = vec![];
                    for row in rows_ref {
                        items.push(self.write_item(plan, row, n).map_err(StepError::new)?);
                    }
                    self.output.write(items).await.map_err(|e| StepError::new(self.secrets.redact(&e)))
                },
                |err, n, wait| self.retrying_batch(rows_ref, &err.message, n, wait),
                // A unit a stall handed over (D50) ends the group's retries, so the split isolates it.
                || {
                    let s = self.s.borrow();
                    s.closed || rows_ref.iter().any(|r| s.hand_over.contains_key(&r.id))
                },
            )
            .await;
            if self.s.borrow().closed {
                return;
            }
            // The output's latency for a batched packet is its group's write, retries included (D54).
            let ms = Some(began.elapsed().as_secs_f64() * 1000.0);
            let (error, attempts, elapsed) = match run {
                Attempted::Ok { value, .. } => {
                    {
                        let mut s = self.s.borrow_mut();
                        for row in &rows {
                            s.hand_over.remove(&row.id);
                        }
                    }
                    let n = rows.len();
                    let r = self.journal.borrow_mut().atomically(|j| {
                        for (i, row) in rows.iter().enumerate() {
                            j.update(
                                &row.id,
                                &PacketPatch {
                                    state: Some("verifying".into()),
                                    cursor: Some(Some(VERIFY_STEP.into())),
                                    hops: Some(row.hops + 1),
                                    attempt: Some(0),
                                    result: Some(value.get(i).cloned().unwrap_or(Value::Null)),
                                    ..Default::default()
                                },
                                "output.written",
                                Some(OUTPUT_STEP),
                                Some(json!({ "batch": n })),
                                &[],
                                ms,
                            )?;
                        }
                        Ok(())
                    });
                    if let Err(e) = r {
                        self.log("error", &format!("internal error flushing a batch: {e}"));
                        return;
                    }
                    {
                        let mut s = self.s.borrow_mut();
                        for row in &rows {
                            batch.release(&row.id);
                            s.queue.push_back(row.id.clone());
                        }
                    }
                    self.wake(true);
                    return;
                }
                Attempted::Failed { error, attempts, elapsed } => (error, attempts, elapsed),
            };
            let failure = Failure { code: "output.failed".into(), message: error.message.clone(), attempts: Some(attempts), elapsed: Some(elapsed), rule: None };
            if rows.len() == 1 {
                let row = &rows[0];
                let t = self.fail(plan, row, "output", policy, failure, None);
                batch.release(&row.id);
                match t {
                    Transition::Hold { .. } => self.hold(&row.id, OUTPUT_STEP, t),
                    Transition::End { .. } => self.end(&row.id, OUTPUT_STEP, t, ms),
                    Transition::Escalate { .. } => self.escalate(&row.id, OUTPUT_STEP, t),
                    _ => {}
                }
                return;
            }
            let half = rows.len().div_ceil(2);
            let message = self.secrets.redact(&error.message);
            self.event(
                "output.batch_split",
                Some(json!({ "size": rows.len(), "into": [half, rows.len() - half], "error": message })),
                None,
                None,
            );
            self.log(
                "warn",
                &format!(
                    "batch of {} failed at output after {attempts} attempt(s): {message}; splitting it to isolate the failing packet(s)",
                    rows.len()
                ),
            );
            self.flush_group(plan, policy, rows[..half].to_vec()).await;
            self.flush_group(plan, policy, rows[half..].to_vec()).await;
        })
    }

    fn retrying_batch(&self, rows: &[PacketRow], error: &str, n: u32, wait: u64) {
        if self.s.borrow().closed {
            return;
        }
        let message = self.secrets.redact(error);
        let r = self.journal.borrow_mut().atomically(|j| {
            for row in rows {
                j.update(
                    &row.id,
                    &PacketPatch { attempt: Some(n as i64), ..Default::default() },
                    "step.retry",
                    Some("output"),
                    Some(json!({ "attempt": n, "wait": wait, "error": message, "batch": rows.len() })),
                    &[],
                    None,
                )?;
            }
            Ok(())
        });
        if let Err(e) = r {
            self.log("error", &format!("journal write failed (step.retry): {e}"));
        }
        self.log(
            "warn",
            &format!("batch of {} failed at output (attempt {n}): {message}; retrying in {}", rows.len(), format_duration(wait)),
        );
    }

    async fn verify_step(&self, plan: &Plan, row: &PacketRow) -> Transition {
        let delivered = plan.pipeline.delivered.clone();
        let check = delivered.as_ref().and_then(|d| d.check.clone()).unwrap_or_else(|| "ack".into());
        if check == "ack" || check == "none" {
            return end("delivered", "packet.delivered");
        }
        let item = match self.write_item(plan, row, 1) {
            Ok(i) => i,
            Err(e) => {
                let policy = resolve_policy(None, delivered.as_ref().and_then(|d| d.on_fail.as_ref()));
                return self.fail(plan, row, "delivered", &policy, Failure { code: "delivery.unverified".into(), message: e, attempts: Some(1), ..Default::default() }, None);
            }
        };
        let meta = self.meta(plan, row, "delivered", 1);
        let c = json!({
            "data": row.data, "meta": meta, "env": self.env, "secrets": self.secrets.values,
            "output": serde_json::to_value(&plan.pipeline.output).unwrap_or(Value::Null), "result": row.result,
        });
        let check_with = render(&Value::Object(delivered.as_ref().and_then(|d| d.with.clone()).unwrap_or_default()), &c)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        let within = parse_duration(delivered.as_ref().and_then(|d| d.within.as_deref()).unwrap_or("10s")).unwrap_or(10_000);
        let started = now_ms();
        let mut last_error: Option<String> = None;
        let mut checks = 0;
        loop {
            checks += 1;
            match self.output.verify(&check, &check_with, &item, &row.result).await {
                Ok(true) => return end("delivered", "packet.delivered"),
                Ok(false) => {}
                Err(e) => last_error = Some(e),
            }
            if now_ms() - started >= within as i64 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(within.min(250))).await;
            let stopped = self.state() == RunnerState::Stopped || self.s.borrow().hand_over.contains_key(&row.id);
            if stopped {
                break;
            }
        }
        let elapsed = (now_ms() - started).max(0) as u64;
        let policy = resolve_policy(None, delivered.as_ref().and_then(|d| d.on_fail.as_ref()));
        let message = match last_error {
            Some(e) => format!("delivery check '{check}' errored: {e}"),
            None => format!("delivery check '{check}' did not pass after {checks} checks over {}", format_duration(elapsed)),
        };
        self.fail(plan, row, "delivered", &policy, Failure { code: "delivery.unverified".into(), message, attempts: Some(checks), elapsed: Some(elapsed), rule: None }, None)
    }

    // ── external acknowledgement (spec §3.10, D24) ───────────────────────────────

    /// The `external` check: deliver once a `packet.acked` event exists; otherwise park the packet, freeing its
    /// worker, until `ack()` or the deadline wakes it. The deadline lives in the journal, so a restart keeps it.
    fn await_ack(&self, plan: &Plan, row: &PacketRow) -> Option<Transition> {
        let acked = self.journal.borrow().latest_event(&row.id, &["packet.acked"]).ok().flatten();
        if acked.is_some() {
            return Some(end("delivered", "packet.delivered"));
        }
        let delivered = plan.pipeline.delivered.clone();
        let within = parse_duration(delivered.as_ref().and_then(|d| d.within.as_deref()).unwrap_or("10s")).unwrap_or(10_000) as i64;
        let mark = self.journal.borrow().latest_event(&row.id, &["output.written", "packet.held", "delivery.awaiting_ack"]).ok().flatten();
        let (deadline, since) = match &mark {
            Some(m) if m.kind == "delivery.awaiting_ack" => (
                m.detail.get("deadline").and_then(|d| d.as_i64()).unwrap_or(0),
                m.detail.get("since").and_then(|d| d.as_i64()).unwrap_or(0),
            ),
            _ => {
                let since = match &mark {
                    Some(m) if m.kind == "output.written" => m.at,
                    _ => now_ms(),
                };
                let deadline = since + within;
                self.event(
                    "delivery.awaiting_ack",
                    Some(json!({ "deadline": deadline, "since": since, "until": iso(deadline) })),
                    Some(&row.id),
                    Some(VERIFY_STEP),
                );
                (deadline, since)
            }
        };
        let left = deadline - now_ms();
        if left > 0 {
            let me = self.me.clone();
            let id = row.id.clone();
            let timer = tokio::task::spawn_local(async move {
                tokio::time::sleep(Duration::from_millis(left as u64)).await;
                if let Some(r) = me.upgrade() {
                    r.unpark(&id);
                }
            });
            self.s.borrow_mut().awaiting.insert(row.id.clone(), timer);
            return None;
        }
        let policy = resolve_policy(None, delivered.as_ref().and_then(|d| d.on_fail.as_ref()));
        Some(self.fail(
            plan,
            row,
            "delivered",
            &policy,
            Failure {
                code: "delivery.unverified".into(),
                message: format!("delivery check 'external' got no ack within {}", format_duration(within as u64)),
                attempts: Some(1),
                elapsed: Some((now_ms() - since).max(0) as u64),
                rule: None,
            },
            None,
        ))
    }

    fn unpark(&self, id: &str) {
        let Some(timer) = self.s.borrow_mut().awaiting.remove(id) else { return };
        timer.abort();
        self.s.borrow_mut().queue.push_front(id.to_string());
        self.wake(false);
    }

    /// Record an outside acknowledgement for a journal unit. The `packet.acked` event commits before this returns,
    /// so the ack survives a crash. Repeating an ack is harmless.
    pub async fn ack(&self, id: &str, by: &str) -> Result<Value, ControlError> {
        let name = self.pipeline().name.clone();
        let internal = |e: String| ControlError::new("internal", e, "try again");
        let found = self.journal.borrow().get(id).map_err(internal)?.ok_or_else(|| {
            ControlError::new(
                "not_found",
                format!("no packet '{id}' in {name}"),
                "use the packet id from the push or http reply; a fan-out copy is acked by its output key <packet_id>:<branch>",
            )
        })?;
        // Descendant copies: every copy of a packet, or the copies nested under a copy (`<id>/…`).
        let descendants: Vec<PacketRow> = self
            .journal
            .borrow()
            .copies(found.root.as_deref().unwrap_or(&found.id))
            .map_err(internal)?
            .into_iter()
            .filter(|c| found.root.is_none() || c.id.starts_with(&format!("{id}/")))
            .collect();
        if found.state == BRANCHED || !descendants.is_empty() {
            let copies: Vec<String> = descendants.iter().map(|c| format!("{} ({})", c.id, c.state)).collect();
            return Err(ControlError::new(
                "invalid_state",
                format!("packet {id} fanned out into {} copies; each copy is acked on its own", copies.len()),
                format!("ack the copies by their output key: {}", copies.join(", ")),
            ));
        }
        let plan = self.plan(found.version).await.map_err(internal)?;
        let check = plan.pipeline.delivered.as_ref().and_then(|d| d.check.clone()).unwrap_or_else(|| "ack".into());
        if check != "external" {
            return Err(ControlError::new(
                "invalid_state",
                format!("packet {id} does not wait for an ack: delivered.check is '{check}' in version {}", found.version),
                "only pipelines with delivered.check: external take acks",
            ));
        }
        if self.s.borrow().closed {
            return Err(ControlError::new("unavailable", format!("pipeline is {}", self.state().as_str()), "try again once it runs"));
        }
        // Re-read after the await: the packet may have moved on meanwhile.
        let row = self.journal.borrow().get(id).map_err(internal)?.ok_or_else(|| internal(format!("packet {id} vanished")))?;
        if row.state == "delivered" {
            return Ok(json!({ "packet_id": id, "state": row.state, "acked": true, "already": true }));
        }
        if is_terminal(&row.state) {
            return Err(ControlError::new(
                "invalid_state",
                format!(
                    "packet {id} is {}{}; it no longer waits for an ack",
                    row.state,
                    row.error.as_ref().map(|e| format!(": {}", e.message)).unwrap_or_default()
                ),
                if row.state == "dead_lettered" {
                    "the ack came after delivered.within; replay the packet from the dead-letter queue"
                } else {
                    "nothing to acknowledge"
                },
            ));
        }
        let already = self.journal.borrow().latest_event(id, &["packet.acked"]).map_err(internal)?.is_some();
        if !already {
            self.journal.borrow_mut().event("packet.acked", Some(json!({ "by": by })), Some(id), Some(VERIFY_STEP)).map_err(internal)?;
        }
        self.unpark(id);
        Ok(json!({ "packet_id": id, "state": row.state, "acked": true, "already": already }))
    }

    fn write_item(&self, plan: &Plan, row: &PacketRow, attempt_no: u32) -> Result<WriteItem, String> {
        let meta = self.meta(plan, row, "output", attempt_no);
        let c = json!({ "data": row.data, "meta": meta, "env": self.env, "secrets": self.secrets.values });
        let w = render(&Value::Object(plan.pipeline.output.with.clone().unwrap_or_default()), &c).map_err(|e| e.to_string())?;
        // The journal unit is the default idempotency key: `packet_id`, or `packet_id:<branch>` for a copy (D22).
        Ok(WriteItem {
            packet_id: row.id.clone(),
            data: row.data.clone(),
            with: w.as_object().cloned().unwrap_or_default(),
            origin: Some(Origin { trigger: row.trigger.clone(), source: row.source.clone() }),
        })
    }

    /// Apply a policy's final action to a failed step.
    fn fail(&self, plan: &Plan, row: &PacketRow, step: &str, policy: &ResolvedPolicy, f: Failure, data: Option<Value>) -> Transition {
        let data = data.unwrap_or_else(|| row.data.clone());
        let meta = self.meta(plan, row, step, 1);
        let error_ctx = json!({
            "message": f.message, "code": f.code, "rule": f.rule, "node": step,
            "attempts": f.attempts.unwrap_or(1), "elapsed": format_duration(f.elapsed.unwrap_or(0)),
        });
        let c = json!({
            "data": data, "meta": meta, "env": self.env, "output": serde_json::to_value(&plan.pipeline.output).unwrap_or(Value::Null),
            "result": row.result, "error": error_ctx,
        });
        let message = self.message(policy.message.as_deref(), &c, &f.message);
        let error = PacketError { code: f.code.clone(), message, node: Some(step.into()), attempts: Some(f.attempts.unwrap_or(1)) };
        // A unit a stall handed over goes to the agent whatever its policy says, except past its token cap (D50).
        let stalled = self.s.borrow().hand_over.get(&row.id).cloned();
        if let Some(s) = stalled {
            if f.code != "budget.packet" {
                return Transition::Escalate { stall_reason: true, error, stall: Some(s) };
            }
        }
        match policy.then.as_str() {
            "agent" => Transition::Escalate { stall_reason: false, error, stall: None },
            "drop" => Transition::End { state: "filtered", error: Some(error), event: "packet.dropped".into(), extra: vec![] },
            "pause" => Transition::Hold { pause: true, error, reason: None, detail: Map::new() },
            "halt" => Transition::Hold { pause: false, error, reason: None, detail: Map::new() },
            _ => Transition::End { state: "dead_lettered", error: Some(error), event: "packet.dead_lettered".into(), extra: vec![] },
        }
    }

    fn retrying(&self, row: &PacketRow, step: &str, error: &str, n: u32, wait: u64) {
        let message = self.secrets.redact(error);
        let r = self.journal.borrow_mut().update(
            &row.id,
            &PacketPatch { attempt: Some(n as i64), ..Default::default() },
            "step.retry",
            Some(step),
            Some(json!({ "attempt": n, "wait": wait, "error": message })),
            &[],
            None,
        );
        if let Err(e) = r {
            self.log("error", &format!("journal write failed (step.retry): {e}"));
        }
        self.log(
            "warn",
            &format!("packet {} failed at {step} (attempt {n}): {message}; retrying in {}", row.id, format_duration(wait)),
        );
    }
}

/// The escalation of a unit a stall handed over (D50) at a point where no step of it failed.
fn stall_escalation(row: &PacketRow, message: &str) -> Transition {
    let node = match row.cursor.as_deref() {
        Some(c) if c == OUTPUT_STEP || c == BATCH_STEP => "output".to_string(),
        Some(c) if c == VERIFY_STEP => "delivered".to_string(),
        Some(c) => c.to_string(),
        None => String::new(),
    };
    Transition::Escalate {
        stall_reason: true,
        error: PacketError { code: "stall".into(), message: message.to_string(), node: Some(node), attempts: None },
        stall: Some(message.to_string()),
    }
}

/// The copies a fan-out creates: one per consumer, branch path `<parent branch>/<consumer>` (D22).
fn copies(parent: &PacketRow, to: &[String], data: &Value, hops: i64) -> Vec<crate::journal::NewCopy> {
    to.iter()
        .map(|cursor| {
            let segment = if cursor == OUTPUT_STEP { "output" } else { cursor.as_str() };
            let branch = if parent.branch.is_empty() { segment.to_string() } else { format!("{}/{segment}", parent.branch) };
            let state = if cursor == OUTPUT_STEP { "writing" } else { "processing" };
            crate::journal::NewCopy {
                id: format!("{}:{branch}", parent.root.as_deref().unwrap_or(&parent.id)),
                branch,
                state: state.into(),
                cursor: cursor.clone(),
                data: data.clone(),
                hops,
            }
        })
        .collect()
}
