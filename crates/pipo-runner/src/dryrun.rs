// The dry run of a change proposal (docs/spec.md §9.3 step 3, D48) and the replay core it shares with `pipo test`
// (§10.3). Port of dryrun.ts.
//
// `agent.verify: last N` replays the last N delivered packets through the proposed definition, in memory, with every
// side effect mocked: outputs and taps are recorded, not called; agent nodes and `transform: http` are stubbed from the
// packet's own trail; filters, routes, `map` and `fn` transforms run for real. Nothing here writes: the journal is
// only read. A packet that was delivered diverges when, under the proposed version, it is rejected by the input's
// schema or `validate`, any step fails (except a tap with `then: continue`), a stubbed result no longer matches the
// agent node's schema, a stubbed node has nothing recorded to replay, or it fails `output.validate` or its
// `output.with` can't be rendered.

use crate::expr::{EvalOptions, evaluate_with, render_with, truthy};
use crate::journal::OUTPUT_STEP;
use crate::jsfn::JsFns;
use crate::output_key::resolve_key;
use crate::pipeline::{Node, NodeKind, fn_ref};
use crate::plan::Plan;
use crate::policy::{ResolvedPolicy, resolve_policy};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};

/// The most `last N` may ask for (MAX_VERIFY in @pipo/spec check.ts).
pub const MAX_VERIFY: u32 = 1000;
/// Steps one replayed packet may take (all copies together); loops are bounded by `pipo check`, this is a backstop.
const MAX_STEPS: u32 = 10_000;
/// Reasons kept per packet and characters per message, so a report stays small in the journal.
const MAX_REASONS: usize = 5;
const MAX_MESSAGE: usize = 500;

/// `agent.verify` as its N, or None unless it is `last N` with 1 ≤ N ≤ MAX_VERIFY (parseVerify, P055).
pub fn parse_verify(text: &str) -> Option<u32> {
    let rest = text.trim().strip_prefix("last")?;
    let n = rest.trim_start();
    if n.len() == rest.len()
        || n.is_empty()
        || n.len() > 4
        || n.starts_with('0')
        || !n.chars().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    n.parse::<u32>().ok().filter(|n| (1..=MAX_VERIFY).contains(n))
}

// ── the replay core, shared with `pipo test` (testing.rs) ─────────────────────────────────────────────────────────

/// One journal unit in a replay: the packet, or a fan-out copy (`packet_id:<branch>`, D22).
#[derive(Debug, Clone)]
pub struct ReplayUnit {
    pub id: String,
    pub root: Option<String>,
    pub branch: String,
    pub cursor: String,
    pub data: Value,
    pub hops: u32,
    pub iteration: u32,
    /// The steps this unit ran, in order: node ids (a route as `<id>.<branch>`), then `output`.
    pub path: Vec<String>,
}

/// Why a unit can't go on when no error policy applies (nothing to replay, a harness limit).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AbortReason {
    pub step: String,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl AbortReason {
    pub fn new(step: &str, code: &str, message: impl Into<String>) -> AbortReason {
        AbortReason { step: step.into(), code: code.into(), message: message.into(), hint: None }
    }
}

/// A step that failed once its policy's retries ran out.
#[derive(Debug, Clone)]
pub struct ReplayFailure {
    pub step: String,
    /// `node.failed`, `loop.max`, `output.invalid` or `output.failed`.
    pub code: String,
    pub message: String,
    pub rule: Option<String>,
    pub attempts: u32,
    pub policy: ResolvedPolicy,
    /// The unit's data where it failed (a `loop.max` failure keeps the last pass's result).
    pub data: Value,
    pub meta: Value,
}

pub enum ReplayEnd {
    Written,
    Filtered,
    Branched(Vec<String>),
    Failed(Box<ReplayFailure>),
    Aborted(AbortReason),
}

/// The input's schema or `validate` rejected the packet.
pub struct Rejected {
    /// `input.schema` or `input.invalid`.
    pub code: String,
    pub rule: String,
    pub message: String,
    pub meta: Value,
}

/// What a hook gets for one attempt of a step.
pub struct Scope {
    pub meta: Value,
    pub attempt: u32,
    env: Value,
    secrets: Value,
}

impl Scope {
    /// The template context for `with:` blocks: data, meta, env and the (placeholder) secrets.
    pub fn ctx(&self, data: &Value) -> Value {
        json!({ "data": data, "meta": self.meta, "env": self.env, "secrets": self.secrets })
    }
}

/// A hook's failure: an abort ends the unit at once; a failure is a step error under its policy.
pub enum HookError {
    Abort(AbortReason),
    Fail(String),
}

impl From<String> for HookError {
    fn from(m: String) -> HookError {
        HookError::Fail(m)
    }
}

pub trait ReplayHooks {
    /// Run a failing step again up to its policy's `retry` (never waiting), or fail on the first attempt.
    fn retry(&self) -> bool;
    fn rejected(&mut self, f: Rejected);
    /// A unit was created (the packet, or a copy of `parent`), in creation order.
    fn started(&mut self, _u: &ReplayUnit, _parent: Option<&ReplayUnit>) {}
    /// A tap was reached (mocked).
    fn tap(&mut self, u: &ReplayUnit, id: &str, node: &Node, s: &Scope) -> Result<(), HookError>;
    /// An agent node or a `transform` other than `map` and `fn.*`: its result.
    fn call(&mut self, u: &ReplayUnit, id: &str, node: &Node, kind: &str, s: &Scope) -> Result<Value, HookError>;
    /// The unit passed `output.validate`: the mocked write.
    fn write(&mut self, u: &ReplayUnit, s: &Scope) -> Result<(), HookError>;
    /// A step succeeded: the data leaving it.
    fn stepped(&mut self, _u: &ReplayUnit, _step: &str, _data: &Value) {}
    /// A tap failed and `then: continue` passed the data on unchanged.
    fn continued(&mut self, u: &ReplayUnit, f: &ReplayFailure);
    fn ended(&mut self, u: &ReplayUnit, end: ReplayEnd);
}

pub struct PacketInput {
    pub id: String,
    pub trigger: String,
    pub source: String,
    pub received_at: i64,
    /// The payload as the input received it.
    pub input: Value,
    /// The input it came through (D76).
    pub input_name: String,
    /// `meta.upstream` (D77), null unless it came from another pipeline.
    pub upstream: Value,
}

/// What a replay runs with.
pub struct ReplayEnv<'a> {
    pub plan: &'a Plan,
    pub fns: &'a JsFns,
    pub env: Value,
    pub secrets: Value,
    pub opts: EvalOptions,
}

enum Next {
    Moved,
    Ended,
    Split(Vec<String>, Value),
}

impl ReplayEnv<'_> {
    fn meta(&self, p: &PacketInput, u: &ReplayUnit, node: &str, attempt: u32) -> Value {
        let mut m = json!({
            "packet_id": u.root.clone().unwrap_or_else(|| u.id.clone()),
            "branch": u.branch,
            "pipeline": self.plan.pipeline.name,
            "version": self.plan.version,
            "node": node,
            "trigger": p.trigger,
            "source": p.source,
            "received_at": p.received_at,
            "attempt": attempt,
            "hops": u.hops,
            "iteration": u.iteration,
            "input": p.input_name,
            "upstream": p.upstream,
            "key": u.id,
        });
        if node == "output" {
            let ctx = json!({ "data": u.data, "meta": m, "env": self.env, "secrets": self.secrets });
            m["key"] = json!(resolve_key(&self.plan.pipeline.output, &u.id, &ctx));
        }
        m
    }

    fn scope(&self, p: &PacketInput, u: &ReplayUnit, node: &str, attempt: u32) -> Scope {
        Scope { meta: self.meta(p, u, node, attempt), attempt, env: self.env.clone(), secrets: self.secrets.clone() }
    }

    fn eval(&self, expr: &str, ctx: &Value) -> Result<bool, String> {
        evaluate_with(expr, ctx, &self.opts).map(|v| truthy(&v)).map_err(|e| e.to_string())
    }

    pub fn render(&self, with: Option<&Map<String, Value>>, ctx: &Value) -> Result<Value, String> {
        render_with(&Value::Object(with.cloned().unwrap_or_default()), ctx, &self.opts).map_err(|e| e.to_string())
    }
}

/// How a step's attempts ended: its value and attempt count, or the last error and the attempts made.
type Tried<T> = Result<(T, u32), (String, u32)>;

/// Attempts as the runner's policy runs them, without the backoff waits. An abort is never retried.
async fn tries<T, F, Fut>(policy: &ResolvedPolicy, retry: bool, mut work: F) -> Result<Tried<T>, AbortReason>
where
    F: FnMut(u32) -> Fut,
    Fut: std::future::Future<Output = Result<T, HookError>>,
{
    let max = if retry { policy.retry + 1 } else { 1 };
    let mut n = 1;
    loop {
        match work(n).await {
            Ok(v) => return Ok(Ok((v, n))),
            Err(HookError::Abort(a)) => return Err(a),
            Err(HookError::Fail(m)) if n >= max => return Ok(Err((m, n))),
            Err(HookError::Fail(_)) => n += 1,
        }
    }
}

fn fan_out(
    parent: &ReplayUnit,
    to: &[String],
    data: &Value,
    hops: u32,
    h: &mut dyn ReplayHooks,
    queue: &mut VecDeque<ReplayUnit>,
) {
    let base = parent.root.clone().unwrap_or_else(|| parent.id.clone());
    let copies: Vec<ReplayUnit> = to
        .iter()
        .map(|cursor| {
            let segment = if cursor == OUTPUT_STEP { "output" } else { cursor.as_str() };
            let branch =
                if parent.branch.is_empty() { segment.to_string() } else { format!("{}/{segment}", parent.branch) };
            ReplayUnit {
                id: format!("{base}:{branch}"),
                root: Some(base.clone()),
                branch,
                cursor: cursor.clone(),
                data: data.clone(),
                hops,
                iteration: parent.iteration,
                path: vec![],
            }
        })
        .collect();
    h.ended(parent, ReplayEnd::Branched(copies.iter().map(|c| c.id.clone()).collect()));
    for c in &copies {
        h.started(c, Some(parent));
    }
    queue.extend(copies);
}

/// Replay one packet through the plan in memory, as the runner runs it (§7.3). Units run one after another in
/// creation order, so a replay is deterministic. Errs only on something no policy covers (a loop's `until` that
/// can't be evaluated).
pub async fn replay_packet(e: &ReplayEnv<'_>, p: &PacketInput, h: &mut dyn ReplayHooks) -> Result<(), String> {
    let plan = e.plan;
    let root = ReplayUnit {
        id: p.id.clone(),
        root: None,
        branch: String::new(),
        cursor: String::new(),
        data: p.input.clone(),
        hops: 0,
        iteration: 0,
        path: vec![],
    };
    // Input: the schema and `validate` rules of the packet's own input see the original payload.
    let in_meta = e.meta(p, &root, &p.input_name, 1);
    let Some(input) = plan.pipeline.input_named(&p.input_name) else {
        h.rejected(Rejected {
            code: "input.unknown".into(),
            rule: "input".into(),
            message: format!("the pipeline has no input '{}'", p.input_name),
            meta: in_meta,
        });
        return Ok(());
    };
    if let Some(schema) = plan.input_schemas.get(&p.input_name)
        && let Some(err) = schema.check(&p.input)
    {
        h.rejected(Rejected {
            code: "input.schema".into(),
            rule: "schema".into(),
            message: format!("schema: {err}"),
            meta: in_meta,
        });
        return Ok(());
    }
    for rule in input.validate.clone().unwrap_or_default() {
        let ctx = json!({ "data": p.input, "meta": in_meta, "env": e.env });
        let message = match e.eval(&rule, &ctx) {
            Ok(true) => None,
            Ok(false) => Some(format!("rule '{rule}' failed")),
            Err(err) => Some(format!("rule '{rule}' could not be evaluated: {err}")),
        };
        if let Some(message) = message {
            h.rejected(Rejected { code: "input.invalid".into(), rule, message, meta: in_meta });
            return Ok(());
        }
    }

    let mut queue: VecDeque<ReplayUnit> = VecDeque::new();
    let first = plan.next_of(&p.input_name).to_vec();
    if first.len() == 1 {
        let u = ReplayUnit { cursor: first[0].clone(), ..root.clone() };
        h.started(&u, None);
        queue.push_back(u);
    } else {
        h.started(&root, None);
        fan_out(&root, &first, &p.input, 0, h, &mut queue);
    }

    let mut steps = 0;
    while let Some(mut u) = queue.pop_front() {
        let ended: Result<(), AbortReason> = loop {
            steps += 1;
            if steps > MAX_STEPS {
                break Err(AbortReason::new(&u.cursor, "too_many_steps", format!("more than {MAX_STEPS} steps")));
            }
            if u.cursor == OUTPUT_STEP {
                break output(e, p, &mut u, h).await;
            }
            match step(e, p, &mut u, h).await {
                Err(a) => break Err(a),
                Ok(Err(internal)) => return Err(internal),
                Ok(Ok(Next::Moved)) => {}
                Ok(Ok(Next::Ended)) => break Ok(()),
                Ok(Ok(Next::Split(to, data))) => {
                    let hops = u.hops + 1;
                    fan_out(&u, &to, &data, hops, h, &mut queue);
                    break Ok(());
                }
            }
        };
        if let Err(a) = ended {
            h.ended(&u, ReplayEnd::Aborted(a));
        }
    }
    Ok(())
}

fn fail(u: &ReplayUnit, f: ReplayFailure, h: &mut dyn ReplayHooks) -> Next {
    h.ended(u, ReplayEnd::Failed(Box::new(f)));
    Next::Ended
}

async fn output(
    e: &ReplayEnv<'_>,
    p: &PacketInput,
    u: &mut ReplayUnit,
    h: &mut dyn ReplayHooks,
) -> Result<(), AbortReason> {
    u.path.push("output".into());
    let out = &e.plan.pipeline.output;
    let m = e.meta(p, u, "output", 1);
    let output_json = serde_json::to_value(out).unwrap_or(Value::Null);
    for rule in out.validate.clone().unwrap_or_default() {
        let ctx = json!({ "data": u.data, "meta": m, "env": e.env, "output": output_json });
        let (ok, why) = match e.eval(&rule, &ctx) {
            Ok(ok) => (ok, format!("rule '{rule}' failed")),
            Err(err) => (false, format!("rule '{rule}' could not be evaluated: {err}")),
        };
        if !ok {
            // Never retried: the same data fails the same way (spec §3.9).
            let mut policy = resolve_policy(None, None);
            policy.then = out.on_invalid.as_ref().and_then(|i| i.then.clone()).unwrap_or_else(|| "dead_letter".into());
            policy.message = out.on_invalid.as_ref().and_then(|i| i.message.clone());
            let f = ReplayFailure {
                step: "output".into(),
                code: "output.invalid".into(),
                message: why,
                rule: Some(rule),
                attempts: 1,
                policy,
                data: u.data.clone(),
                meta: m,
            };
            fail(u, f, h);
            return Ok(());
        }
    }
    let policy = resolve_policy(e.plan.pipeline.errors.as_ref(), out.on_error.as_ref());
    let unit = u.clone();
    let retry = h.retry();
    let hooks = RefCell::new(&mut *h);
    let run = tries(&policy, retry, |n| {
        let s = e.scope(p, &unit, "output", n);
        let r = hooks.borrow_mut().write(&unit, &s);
        async move { r }
    })
    .await?;
    let h = hooks.into_inner();
    match run {
        Err((message, attempts)) => {
            let f = ReplayFailure {
                step: "output".into(),
                code: "output.failed".into(),
                message,
                rule: None,
                attempts,
                policy,
                data: u.data.clone(),
                meta: m,
            };
            fail(u, f, h);
        }
        Ok(_) => {
            h.stepped(u, "output", &u.data);
            h.ended(u, ReplayEnd::Written);
        }
    }
    Ok(())
}

enum Out {
    Data(Value),
    Pass(bool),
    Branch(Option<String>),
}

/// Run the node at `u.cursor`: move `u` on, or say it ended or fanned out. The inner Err is an internal error.
async fn step(
    e: &ReplayEnv<'_>,
    p: &PacketInput,
    u: &mut ReplayUnit,
    h: &mut dyn ReplayHooks,
) -> Result<Result<Next, String>, AbortReason> {
    let id = u.cursor.clone();
    let pipeline = &e.plan.pipeline;
    let Some(node) = pipeline.nodes.get(&id).cloned() else {
        return Err(AbortReason::new(&id, "node.failed", format!("no node '{id}' in the proposed version")));
    };
    u.path.push(id.clone());
    let kind = node.kind();
    let policy = resolve_policy(pipeline.errors.as_ref(), node.on_error.as_ref());
    // Filters and routes are deterministic: retrying them can't change the outcome (as in the runner).
    let mut effective = policy.clone();
    if matches!(kind, Some(NodeKind::Filter) | Some(NodeKind::Route)) {
        effective.retry = 0;
    }
    let unit = u.clone();
    let retry = h.retry();
    let hooks = RefCell::new(&mut *h);
    let run = tries(&effective, retry, |n| {
        let s = e.scope(p, &unit, &id, n);
        let (node, unit, id, hooks) = (&node, &unit, &id, &hooks);
        async move {
            let ctx = json!({ "data": unit.data, "meta": s.meta, "env": e.env });
            match kind {
                Some(NodeKind::Filter) => Ok(Out::Pass(e.eval(node.filter.as_deref().unwrap_or("true"), &ctx)?)),
                Some(NodeKind::Route) => {
                    for (branch, expr) in node.routes() {
                        if expr == "else" || e.eval(&expr, &ctx)? {
                            return Ok(Out::Branch(Some(branch)));
                        }
                    }
                    Ok(Out::Branch(None))
                }
                Some(NodeKind::Tap) => {
                    hooks.borrow_mut().tap(unit, id, node, &s)?;
                    Ok(Out::Data(unit.data.clone()))
                }
                Some(NodeKind::Transform) => {
                    let t = node.transform.clone().unwrap_or_default();
                    let data = match fn_ref(&t) {
                        Some(name) if e.plan.fns.contains(&t) => {
                            e.fns.call(e.plan.version as u32, name, &unit.data, &s.meta).await?
                        }
                        _ if t == "map" => e.render(node.with.as_ref(), &s.ctx(&unit.data))?.get("data").cloned(),
                        _ => Some(hooks.borrow_mut().call(unit, id, node, "transform", &s)?),
                    };
                    data.map(Out::Data)
                        .ok_or_else(|| HookError::Fail(format!("{t} returned nothing; return the new data")))
                }
                Some(NodeKind::Agent) => Ok(Out::Data(hooks.borrow_mut().call(unit, id, node, "agent", &s)?)),
                None => Err(HookError::Fail("node kind 'undefined' is not implemented".into())),
            }
        }
    })
    .await?;
    let h = hooks.into_inner();
    let value = match run {
        Ok((v, _)) => v,
        Err((message, attempts)) => {
            let f = ReplayFailure {
                step: id.clone(),
                code: "node.failed".into(),
                message,
                rule: None,
                attempts,
                policy: policy.clone(),
                data: u.data.clone(),
                meta: e.meta(p, u, &id, 1),
            };
            if kind == Some(NodeKind::Tap) && policy.then == "continue" {
                h.continued(u, &f);
                let data = u.data.clone();
                return Ok(Ok(advance(e, u, &id, data, h)));
            }
            return Ok(Ok(fail(u, f, h)));
        }
    };
    let (data, branch) = match value {
        Out::Pass(false) => {
            h.ended(u, ReplayEnd::Filtered);
            return Ok(Ok(Next::Ended));
        }
        Out::Pass(true) => (u.data.clone(), None),
        Out::Data(d) => (d, None),
        Out::Branch(b) => (u.data.clone(), Some(b)),
    };
    if let Some(lp) = &node.loop_ {
        let ctx = json!({ "data": data, "meta": e.meta(p, u, &id, 1), "env": e.env });
        let done = match e.eval(&lp.until, &ctx) {
            Ok(d) => d,
            Err(err) => return Ok(Err(err)),
        };
        if !done {
            if u.iteration < lp.max {
                h.stepped(u, &id, &data);
                u.cursor = lp.back_to.clone();
                u.data = data;
                u.iteration += 1;
                u.hops += 1;
                return Ok(Ok(Next::Moved));
            }
            let mut loop_policy = policy.clone();
            loop_policy.then = lp.then.clone().unwrap_or_else(|| "dead_letter".into());
            let f = ReplayFailure {
                step: id.clone(),
                code: "loop.max".into(),
                message: format!("loop reached max {} without '{}'", lp.max, lp.until),
                rule: None,
                attempts: 1,
                policy: loop_policy,
                data,
                meta: e.meta(p, u, &id, 1),
            };
            return Ok(Ok(fail(u, f, h)));
        }
    }
    if kind == Some(NodeKind::Route) {
        return Ok(Ok(match branch.flatten() {
            None => {
                h.ended(u, ReplayEnd::Filtered);
                Next::Ended
            }
            Some(b) => {
                let r = format!("{id}.{b}");
                if let Some(last) = u.path.last_mut() {
                    *last = r.clone();
                }
                advance(e, u, &r, data, h)
            }
        }));
    }
    Ok(Ok(advance(e, u, &id, data, h)))
}

fn advance(e: &ReplayEnv<'_>, u: &mut ReplayUnit, reference: &str, data: Value, h: &mut dyn ReplayHooks) -> Next {
    h.stepped(u, reference, &data);
    let to = e.plan.next_of(reference);
    match to.len() {
        0 => {
            h.ended(u, ReplayEnd::Filtered);
            Next::Ended
        }
        1 => {
            u.cursor = to[0].clone();
            u.data = data;
            u.hops += 1;
            Next::Moved
        }
        _ => Next::Split(to.to_vec(), data),
    }
}

// ── the dry run (§9.3 step 3, D48) ───────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DivergenceReason {
    pub unit: String,
    pub step: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DryRunPacket {
    pub packet_id: String,
    pub version: i64,
    /// `passed`, `filtered` or `diverged`.
    pub outcome: String,
    pub writes: Vec<String>,
    pub taps: u32,
    pub stubbed: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasons: Option<Vec<DivergenceReason>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<DivergenceReason>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DryRunReport {
    pub verify: String,
    pub requested: u32,
    pub base_version: i64,
    pub version: i64,
    pub replayed: usize,
    pub passed: usize,
    pub filtered: usize,
    pub diverged: usize,
    pub skipped: usize,
    pub packets: Vec<DryRunPacket>,
    pub started_at: i64,
    pub ms: i64,
}

struct Delivered {
    id: String,
    version: i64,
    trigger: String,
    source: String,
    received_at: i64,
    input: Value,
    input_name: String,
    upstream: Value,
}

fn clip(s: &str) -> String {
    if s.chars().count() > MAX_MESSAGE {
        format!("{}…", s.chars().take(MAX_MESSAGE).collect::<String>())
    } else {
        s.to_string()
    }
}

/// The newest delivered packets, newest first, up to `n` that still have their input in the trail.
fn delivered_packets(db: &Connection, n: u32) -> rusqlite::Result<(Vec<Delivered>, usize)> {
    let mut picked = vec![];
    let mut skipped = 0;
    let mut page = db.prepare(
        "SELECT id, version, trigger, source, received_at, data IS NULL AS cleared, input, upstream FROM packets
         WHERE branch = '' AND state = 'delivered' ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?",
    )?;
    let mut accepted = db.prepare(
        "SELECT patch FROM events WHERE packet_id = ? AND type = 'packet.accepted' AND patch IS NOT NULL ORDER BY seq LIMIT 1",
    )?;
    let n = n as i64;
    let mut offset = 0;
    // Skipped packets don't count towards N, but the scan is bounded so a journal emptied by retention stays cheap.
    while (picked.len() as i64) < n && offset < n * 4 {
        type Row = (String, i64, String, String, i64, bool, String, Option<String>);
        let rows: Vec<Row> = page
            .query_map([n, offset], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get::<_, i64>(5)? != 0,
                    r.get(6)?,
                    r.get(7)?,
                ))
            })?
            .collect::<Result<_, _>>()?;
        let len = rows.len() as i64;
        for (id, version, trigger, source, received_at, cleared, input_name, upstream) in rows {
            let upstream = upstream.and_then(|u| serde_json::from_str::<Value>(&u).ok()).unwrap_or(Value::Null);
            if picked.len() as i64 >= n {
                break;
            }
            // A payload retention cleared (D39) is gone for good: its copy in the trail is not used either.
            let patch: Option<String> =
                if cleared { None } else { accepted.query_row([&id], |r| r.get(0)).optional()? };
            let data = patch.and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|p| p.get("data").cloned());
            match data {
                Some(input) => {
                    picked.push(Delivered { id, version, trigger, source, received_at, input, input_name, upstream })
                }
                None => skipped += 1,
            }
        }
        if len < n {
            break;
        }
        offset += n;
    }
    Ok((picked, skipped))
}

type Recorded = HashMap<(String, String), Vec<Value>>;

/// What each node returned when the packet was delivered, by unit and node, one entry per pass.
fn recorded_results(db: &Connection, root: &str) -> rusqlite::Result<Recorded> {
    let mut stmt = db.prepare(
        "SELECT packet_id, node, patch FROM events
         WHERE (packet_id = ? OR (packet_id >= ? AND packet_id < ?)) AND patch IS NOT NULL
           AND type IN ('node.done', 'node.looped', 'packet.fanned_out') ORDER BY seq",
    )?;
    let rows: Vec<(String, Option<String>, String)> = stmt
        .query_map([root, &format!("{root}:"), &format!("{root};")], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    let mut out: Recorded = HashMap::new();
    for (unit, node, patch) in rows {
        let Some(node) = node else { continue };
        let Some(data) = serde_json::from_str::<Value>(&patch).ok().and_then(|p| p.get("data").cloned()) else {
            continue;
        };
        out.entry((unit, node)).or_default().push(data);
    }
    Ok(out)
}

/// The proposal can't be replayed at all (a schema or fn module that won't load): it is rejected.
#[derive(Debug, Clone, PartialEq)]
pub struct DryRunPrepareError(pub String);

/// Replay up to N delivered packets through `plan` (the proposed version, numbered base + 1).
pub async fn dry_run(
    db: &Connection,
    plan: &Plan,
    fns: &JsFns,
    base_version: i64,
    verify: &str,
    env: Value,
) -> Result<DryRunReport, DryRunPrepareError> {
    let started = crate::time::now_ms();
    let requested = parse_verify(verify).ok_or_else(|| {
        DryRunPrepareError(format!(
            "agent.verify '{verify}' of v{base_version} is not 'last N' with N from 1 to {MAX_VERIFY}"
        ))
    })?;
    // Secret values are never needed: nothing is sent. A placeholder renders like the redacted value would.
    let secrets: Map<String, Value> =
        plan.pipeline.secrets.iter().flatten().map(|(k, _)| (k.clone(), Value::String("***".into()))).collect();
    let e = ReplayEnv { plan, fns, env, secrets: Value::Object(secrets), opts: EvalOptions::default() };
    let (picked, skipped) = delivered_packets(db, requested).map_err(|err| DryRunPrepareError(err.to_string()))?;
    let mut packets = vec![];
    for p in picked {
        packets.push(replay_delivered(db, &e, p).await);
    }
    let count = |o: &str| packets.iter().filter(|p| p.outcome == o).count();
    Ok(DryRunReport {
        verify: verify.to_string(),
        requested,
        base_version,
        version: plan.version,
        replayed: packets.len(),
        passed: count("passed"),
        filtered: count("filtered"),
        diverged: count("diverged"),
        skipped,
        packets,
        started_at: started,
        ms: crate::time::now_ms() - started,
    })
}

struct DryHooks<'a> {
    db: &'a Connection,
    e: &'a ReplayEnv<'a>,
    root: String,
    out: DryRunPacket,
    reasons: Vec<DivergenceReason>,
    warnings: Vec<DivergenceReason>,
    recorded: Option<Recorded>,
    used: HashMap<(String, String), usize>,
}

fn reason(unit: &str, step: &str, code: &str, message: &str) -> DivergenceReason {
    DivergenceReason { unit: unit.into(), step: step.into(), code: code.into(), message: clip(message) }
}

impl DryHooks<'_> {
    fn stub(&mut self, u: &ReplayUnit, id: &str, what: &str) -> Result<Value, HookError> {
        if self.recorded.is_none() {
            self.recorded = Some(recorded_results(self.db, &self.root).unwrap_or_default());
        }
        let k = (u.id.clone(), id.to_string());
        let list = self.recorded.as_ref().and_then(|r| r.get(&k)).cloned().unwrap_or_default();
        let n = self.used.get(&k).copied().unwrap_or(0);
        if n >= list.len() {
            let beyond = if n > 0 { format!(" beyond pass {n}") } else { String::new() };
            return Err(HookError::Abort(AbortReason::new(
                id,
                "unverifiable",
                format!(
                    "{what} '{id}' has no recorded result for {}{beyond} (it did not run there when the packet was delivered), and a dry run never calls it",
                    u.id
                ),
            )));
        }
        self.used.insert(k, n + 1);
        self.out.stubbed += 1;
        Ok(list[n].clone())
    }
}

impl ReplayHooks for DryHooks<'_> {
    fn retry(&self) -> bool {
        // Recorded results are per pass, so an attempt that fails is not retried: it diverges.
        false
    }
    fn rejected(&mut self, f: Rejected) {
        let step = f.meta.get("node").and_then(|n| n.as_str()).unwrap_or("input").to_string();
        self.reasons.push(reason(&self.root, &step, "input.rejected", &f.message));
    }
    fn tap(&mut self, u: &ReplayUnit, _id: &str, node: &Node, s: &Scope) -> Result<(), HookError> {
        // Mocked: rendered (so a template the proposal broke still fails) but never run, `fn` taps included.
        if !self.e.plan.fns.contains(node.tap.as_deref().unwrap_or_default()) {
            self.e.render(node.with.as_ref(), &s.ctx(&u.data))?;
        }
        self.out.taps += 1;
        Ok(())
    }
    fn call(&mut self, u: &ReplayUnit, id: &str, node: &Node, kind: &str, s: &Scope) -> Result<Value, HookError> {
        if kind == "transform" {
            self.e.render(node.with.as_ref(), &s.ctx(&u.data))?;
            return self.stub(u, id, &format!("transform: {}", node.transform.clone().unwrap_or_default()));
        }
        let data = self.stub(u, id, "agent node")?;
        if let Some(schema) = self.e.plan.agent_schemas.get(id)
            && let Some(mismatch) = schema.check(&data)
        {
            return Err(HookError::Abort(AbortReason::new(
                id,
                "agent.schema",
                format!("the recorded agent output does not match {}: {mismatch}", schema.path),
            )));
        }
        Ok(data)
    }
    fn write(&mut self, u: &ReplayUnit, s: &Scope) -> Result<(), HookError> {
        self.e.render(self.e.plan.pipeline.output.with.as_ref(), &s.ctx(&u.data)).map(|_| ()).map_err(|err| {
            HookError::Abort(AbortReason::new(
                "output",
                "output.render",
                format!("output.with can't be rendered: {err}"),
            ))
        })
    }
    fn continued(&mut self, u: &ReplayUnit, f: &ReplayFailure) {
        self.warnings.push(reason(&u.id, &f.step, "node.failed", &f.message));
    }
    fn ended(&mut self, u: &ReplayUnit, end: ReplayEnd) {
        match end {
            ReplayEnd::Written => self.out.writes.push(u.id.clone()),
            ReplayEnd::Aborted(r) => self.reasons.push(reason(&u.id, &r.step, &r.code, &r.message)),
            ReplayEnd::Failed(f) => {
                // Whatever the policy's `then`, a step that fails diverges.
                if f.code == "loop.max" || f.code == "output.invalid" {
                    self.reasons.push(reason(&u.id, &f.step, &f.code, &f.message));
                } else {
                    let m = format!("{} (then: {})", f.message, f.policy.then);
                    self.reasons.push(reason(&u.id, &f.step, "node.failed", &m));
                }
            }
            ReplayEnd::Filtered | ReplayEnd::Branched(_) => {}
        }
    }
}

async fn replay_delivered(db: &Connection, e: &ReplayEnv<'_>, p: Delivered) -> DryRunPacket {
    let mut h = DryHooks {
        db,
        e,
        root: p.id.clone(),
        out: DryRunPacket {
            packet_id: p.id.clone(),
            version: p.version,
            outcome: "filtered".into(),
            writes: vec![],
            taps: 0,
            stubbed: 0,
            reasons: None,
            warnings: None,
        },
        reasons: vec![],
        warnings: vec![],
        recorded: None,
        used: HashMap::new(),
    };
    let input = PacketInput {
        id: p.id.clone(),
        trigger: p.trigger,
        source: p.source,
        received_at: p.received_at,
        input: p.input,
        input_name: p.input_name,
        upstream: p.upstream,
    };
    if let Err(err) = replay_packet(e, &input, &mut h).await {
        h.reasons.push(reason(&p.id, "replay", "node.failed", &err));
    }
    let mut out = h.out;
    if !h.reasons.is_empty() {
        out.outcome = "diverged".into();
        h.reasons.truncate(MAX_REASONS);
        out.reasons = Some(h.reasons);
    } else {
        out.outcome = if out.writes.is_empty() { "filtered".into() } else { "passed".into() };
    }
    if !h.warnings.is_empty() {
        h.warnings.truncate(MAX_REASONS);
        out.warnings = Some(h.warnings);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_is_last_n() {
        assert_eq!(parse_verify("last 5"), Some(5));
        assert_eq!(parse_verify("  last   20 "), Some(20));
        assert_eq!(parse_verify("last 0"), None);
        assert_eq!(parse_verify("last 05"), None);
        assert_eq!(parse_verify("last 1001"), None);
        assert_eq!(parse_verify("last5"), None);
        assert_eq!(parse_verify("first 5"), None);
    }
}
