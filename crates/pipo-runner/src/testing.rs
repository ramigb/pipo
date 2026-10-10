// `pipo test` (docs/spec.md §10.3, D52, D62): run a pipeline against fixture packets on the dry run's replay core
// (dryrun.rs). Port of testing.ts. Filters, routes, loops, fan-out, `map` and `fn` transforms run for real; taps and
// the output are mocked (their `with:` is rendered and recorded); agent nodes and `transform: http` return stubbed
// responses. Error policies apply, with retries counted but never waited for. Nothing touches a journal, a port or
// the disk, and secrets are never resolved: every `secrets.*` renders as `***`. Results are deterministic: the packet
// id is the fixture's name, and `meta.received_at`, `now()` and `iso()` read a fixed clock.
//
// Fixture files are read by the CLI (TypeScript); this side takes them as JSON (`pipo-runner test` on stdin).

use crate::dryrun::{
    AbortReason, HookError, PacketInput, Rejected, ReplayEnd, ReplayEnv, ReplayFailure, ReplayHooks, ReplayUnit, Scope,
    replay_packet,
};
use crate::duration::format_duration;
use crate::expr::{Clock, EvalOptions, render_string_with, to_text};
use crate::jsfn::JsFns;
use crate::output_key::output_key;
use crate::pipeline::{Node, NodeKind, Pipeline, fn_ref};
use crate::plan::{self, Plan};
use crate::support::{Gap, gaps};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::rc::Rc;

/// The fixed clock of a test run unless `now` is given: 2026-01-01T00:00:00Z.
pub const TEST_NOW: i64 = 1_767_225_600_000;
/// `meta.version` in a test run: the file under test, as its first version.
pub const TEST_VERSION: i64 = 1;
const SECRET: &str = "***";
/// `meta.source` unless the fixture sets it.
const SOURCE: &str = "test";
const FORM: &str = r#"a fixture is the packet's data as JSON, or {"data": …, "meta": {…}, "stubs": {…}}"#;
const META_KEYS: &[&str] = &["trigger", "source", "received_at"];
pub const TEST_OUTCOMES: &[&str] =
    &["delivered", "filtered", "rejected", "dead_lettered", "escalated", "paused", "halted", "failed"];
const RANK: &[&str] = &["failed", "halted", "paused", "escalated", "dead_lettered", "delivered", "filtered"];

#[derive(Debug, Clone, Default)]
pub struct Fixture {
    pub name: String,
    pub data: Value,
    pub meta: Option<Map<String, Value>>,
    pub stubs: Option<Map<String, Value>>,
    pub file: Option<String>,
}

pub struct TestOptions {
    pub file: std::path::PathBuf,
    pub home: std::path::PathBuf,
    /// The definition to test instead of the file's content.
    pub source: Option<String>,
    pub fixtures: Vec<Fixture>,
    pub stubs: Option<Value>,
    pub now: Option<i64>,
    pub env: Map<String, Value>,
    pub trace: bool,
}

/// Why nothing ran: the pipeline can't be tested (`prepare`), or a fixture can't be used (`fixture`).
#[derive(Debug, Clone, Default)]
pub struct TestError {
    pub kind: &'static str,
    pub message: String,
    pub hint: Option<String>,
    pub diagnostics: Vec<Value>,
    pub gaps: Vec<Gap>,
}

impl TestError {
    fn fixture(message: impl Into<String>, hint: Option<&str>) -> TestError {
        TestError { kind: "fixture", message: message.into(), hint: hint.map(str::to_owned), ..Default::default() }
    }
    fn prepare(message: impl Into<String>) -> TestError {
        TestError { kind: "prepare", message: message.into(), ..Default::default() }
    }
    pub fn to_value(&self) -> Value {
        let mut v = json!({ "kind": self.kind, "message": self.message });
        if let Some(h) = &self.hint {
            v["hint"] = json!(h);
        }
        if !self.diagnostics.is_empty() {
            v["diagnostics"] = json!(self.diagnostics);
        }
        if !self.gaps.is_empty() {
            v["gaps"] = serde_json::to_value(&self.gaps).unwrap_or(Value::Null);
        }
        v
    }
}

#[derive(Debug, Clone, Serialize)]
struct StepError {
    step: String,
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    rule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attempts: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    then: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<String>,
}

fn validate_fixture(fx: &Fixture) -> Result<(), TestError> {
    let place = fx.file.clone().unwrap_or_else(|| format!("fixture '{}'", fx.name));
    if fx.name.is_empty() {
        return Err(TestError::fixture("a fixture needs a name", Some(FORM)));
    }
    if let Some(meta) = &fx.meta {
        for (k, v) in meta {
            if !META_KEYS.contains(&k.as_str()) {
                return Err(TestError::fixture(
                    format!("{place}: meta.{k} can't be set"),
                    Some(&format!("a fixture may set meta.{}; the rest comes from the run", META_KEYS.join(", meta."))),
                ));
            }
            let ok = if k == "received_at" { v.as_f64().map(f64::is_finite).unwrap_or(false) } else { v.is_string() };
            if !ok {
                let what = if k == "received_at" { "number (ms)" } else { "string" };
                return Err(TestError::fixture(format!("{place}: meta.{k} must be a {what}"), None));
            }
        }
    }
    Ok(())
}

/// A fixture as the CLI sends it: `{name, data, meta?, stubs?, file?}`.
pub fn fixture_from_json(v: &Value) -> Result<Fixture, TestError> {
    let o = v.as_object().ok_or_else(|| TestError::fixture("a fixture must be an object", Some(FORM)))?;
    let place = || o.get("file").and_then(|f| f.as_str()).map(str::to_owned).unwrap_or_else(|| "a fixture".into());
    let meta = match o.get("meta") {
        None | Some(Value::Null) => None,
        Some(Value::Object(m)) => Some(m.clone()),
        Some(_) => return Err(TestError::fixture(format!("{}: meta must be an object", place()), Some(FORM))),
    };
    let stubs = match o.get("stubs") {
        None | Some(Value::Null) => None,
        Some(Value::Object(m)) => Some(m.clone()),
        Some(_) => {
            return Err(TestError::fixture(
                format!("{}: stubs must be an object of node id → response", place()),
                Some(FORM),
            ));
        }
    };
    Ok(Fixture {
        name: o.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_string(),
        data: o.get("data").cloned().unwrap_or(Value::Null),
        meta,
        stubs,
        file: o.get("file").and_then(|f| f.as_str()).map(str::to_owned),
    })
}

/// Run every fixture through the pipeline, one after another.
pub async fn test_pipeline(opts: TestOptions) -> Result<Value, TestError> {
    let compiled =
        crate::compile::compile(&opts.file, &opts.home, opts.source.as_deref()).await.map_err(TestError::prepare)?;
    let shown = opts.file.display().to_string();
    let errors = compiled.errors().len();
    if errors > 0 {
        return Err(TestError {
            diagnostics: compiled.diagnostics.clone(),
            ..TestError::prepare(format!("{shown} has {errors} error(s)"))
        });
    }
    let pipeline =
        Pipeline::from_value(compiled.pipeline.clone().unwrap_or(Value::Null)).map_err(TestError::prepare)?;
    let refused: Vec<Gap> = gaps(&pipeline).into_iter().filter(|g| g.level == "refuse").collect();
    if !refused.is_empty() {
        return Err(TestError {
            gaps: refused,
            ..TestError::prepare(format!("{} uses features this runner does not implement yet", pipeline.name))
        });
    }
    let fns = JsFns::new();
    let plan = plan::build(TEST_VERSION, Rc::new(compiled), &fns)
        .await
        .map_err(|e| TestError::prepare(format!("{} can't be prepared: {e}", pipeline.name)))?;
    let stubs = match &opts.stubs {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(m)) => m.clone(),
        Some(_) => return Err(TestError::fixture("stubs must be an object of node id → response", None)),
    };
    let mut seen = std::collections::HashSet::new();
    for fx in &opts.fixtures {
        validate_fixture(fx)?;
        if !seen.insert(fx.name.clone()) {
            return Err(TestError::fixture(
                format!("two fixtures are named '{}'", fx.name),
                Some("fixture names are packet ids; make them unique"),
            ));
        }
    }
    let now = opts.now.unwrap_or(TEST_NOW);
    let mut results = vec![];
    for fx in &opts.fixtures {
        results.push(run_fixture(&plan, &fns, fx, &stubs, &opts, now).await);
    }
    let mut counts = Map::new();
    for o in TEST_OUTCOMES {
        counts.insert((*o).into(), json!(0));
    }
    for r in &results {
        let o = r["outcome"].as_str().unwrap_or("failed").to_string();
        let n = counts.get(&o).and_then(|v| v.as_i64()).unwrap_or(0);
        counts.insert(o, json!(n + 1));
    }
    Ok(json!({ "pipeline": pipeline.name, "fixtures": results, "counts": counts }))
}

/// Nodes a stub stands in for: agent nodes and transforms other than `map` and `fn.*`.
fn stubbable(pipeline: &Pipeline) -> Vec<String> {
    pipeline
        .nodes
        .iter()
        .filter(|(_, n)| match n.kind() {
            Some(NodeKind::Agent) => true,
            Some(NodeKind::Transform) => {
                let t = n.transform.as_deref().unwrap_or_default();
                t != "map" && fn_ref(t).is_none()
            }
            _ => false,
        })
        .map(|(id, _)| id.clone())
        .collect()
}

fn outcome_of(then: &str) -> &'static str {
    match then {
        "dead_letter" => "dead_lettered",
        "drop" => "filtered",
        "agent" => "escalated",
        "pause" => "paused",
        "halt" => "halted",
        _ => "dead_lettered",
    }
}

/// The row a sqlite output would write (SqliteOutput.row): `columns`, or the data's own fields plus the key.
fn sqlite_record(packet_id: &str, data: &Value, with: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    let key = with.get("key").and_then(|k| k.as_str()).unwrap_or("packet_id");
    let values = match with.get("columns").and_then(|c| c.as_object()) {
        Some(c) => c.clone(),
        None => {
            let mut d = data
                .as_object()
                .cloned()
                .ok_or("data must be an object to map onto columns; set output.with.columns")?;
            d.insert(key.to_string(), json!(packet_id));
            d
        }
    };
    for name in values.keys() {
        let mut chars = name.chars();
        let valid = chars.next().map(|c| c.is_ascii_alphabetic() || c == '_').unwrap_or(false)
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid {
            return Err(format!("'{name}' is not a valid column name"));
        }
    }
    Ok(values)
}

#[derive(Default)]
struct Entry {
    unit: String,
    branch: String,
    path: Vec<String>,
    outcome: &'static str,
    copies: Option<Vec<String>>,
    data: Option<Value>,
    write: Option<Value>,
    error: Option<StepError>,
    warnings: Vec<StepError>,
    steps: Option<Vec<Value>>,
}

struct TestHooks<'a> {
    e: &'a ReplayEnv<'a>,
    trace: bool,
    fixture_data: Value,
    stubs: Map<String, Value>,
    used: HashMap<String, usize>,
    place: String,
    order: Vec<String>,
    entries: HashMap<String, Entry>,
    writes: HashMap<String, Value>,
    taps: Vec<Value>,
    calls: Vec<Value>,
    rejected: Option<StepError>,
}

impl TestHooks<'_> {
    fn entry(&mut self, u: &ReplayUnit) -> &mut Entry {
        if !self.entries.contains_key(&u.id) {
            self.order.push(u.id.clone());
            self.entries.insert(
                u.id.clone(),
                Entry { unit: u.id.clone(), branch: u.branch.clone(), outcome: "filtered", ..Default::default() },
            );
        }
        let e = self.entries.get_mut(&u.id).expect("entry");
        e.path = u.path.clone();
        e
    }

    fn end(&mut self, u: &ReplayUnit, outcome: &'static str, data: Value) -> &mut Entry {
        let e = self.entry(u);
        e.outcome = outcome;
        e.data = Some(data);
        e
    }

    fn message(&self, template: Option<&str>, ctx: &Value, fallback: &str) -> String {
        match template {
            Some(t) if !t.is_empty() => match render_string_with(t, ctx, &self.e.opts) {
                Ok(v) => to_text(&v.to_json()).trim().to_string(),
                Err(err) => format!("{fallback} (message template failed: {err})"),
            },
            _ => fallback.to_string(),
        }
    }

    fn error_of(&self, f: &ReplayFailure) -> StepError {
        let error = json!({
            "message": f.message, "code": f.code, "rule": f.rule, "node": f.step, "attempts": f.attempts, "elapsed": format_duration(0),
        });
        let output = serde_json::to_value(&self.e.plan.pipeline.output).unwrap_or(Value::Null);
        let ctx = json!({ "data": f.data, "meta": f.meta, "env": self.e.env, "output": output, "result": null, "error": error });
        StepError {
            step: f.step.clone(),
            code: f.code.clone(),
            message: self.message(f.policy.message.as_deref(), &ctx, &f.message),
            rule: f.rule.clone(),
            attempts: Some(f.attempts),
            then: Some(f.policy.then.clone()),
            hint: None,
        }
    }

    fn take(&mut self, id: &str, what: &str) -> Result<Value, HookError> {
        let Some(s) = self.stubs.get(id).cloned() else {
            return Err(HookError::Abort(AbortReason {
                hint: Some(format!(
                    "add stubs.{id} to {}: {{\"data\": …, \"stubs\": {{\"{id}\": <response>}}}} (a list gives one response per call)",
                    self.place
                )),
                ..AbortReason::new(id, "stub.missing", format!("{what} '{id}' has no stub, and a test never calls it"))
            }));
        };
        let n = self.used.get(id).copied().unwrap_or(0);
        self.used.insert(id.to_string(), n + 1);
        let Value::Array(list) = s else { return Ok(s) };
        list.get(n).cloned().ok_or_else(|| {
            HookError::Abort(AbortReason {
                hint: Some(format!(
                    "add responses to stubs.{id} in {} (one per call, retries and loop passes included)",
                    self.place
                )),
                ..AbortReason::new(
                    id,
                    "stub.exhausted",
                    format!("stubs.{id} has {} response(s), and call {} needs another", list.len(), n + 1),
                )
            })
        })
    }
}

/// `{"$error": "…"}` as a response makes that call fail with the message, so retries and policies can be tested.
fn respond(value: Value) -> Result<Value, HookError> {
    if let Some(o) = value.as_object()
        && o.len() == 1
        && let Some(Value::String(m)) = o.get("$error")
    {
        return Err(HookError::Fail(m.clone()));
    }
    Ok(value)
}

impl ReplayHooks for TestHooks<'_> {
    fn retry(&self) -> bool {
        true
    }
    fn rejected(&mut self, f: Rejected) {
        let inv = self.e.plan.pipeline.input.on_invalid.clone();
        let ctx = json!({
            "data": self.fixture_data, "meta": f.meta, "env": self.e.env,
            "error": { "code": f.code, "rule": f.rule, "message": f.message, "node": "input" },
        });
        let message = self.message(inv.as_ref().and_then(|i| i.message.as_deref()), &ctx, &f.message);
        self.rejected = Some(StepError {
            step: "input".into(),
            code: f.code,
            message,
            rule: Some(f.rule),
            attempts: None,
            then: None,
            hint: None,
        });
    }
    fn started(&mut self, u: &ReplayUnit, parent: Option<&ReplayUnit>) {
        let trace = self.trace;
        let from_parent = parent.and_then(|p| self.entries.get(&p.id)).and_then(|e| e.steps.clone());
        let data = self.fixture_data.clone();
        let e = self.entry(u);
        if trace {
            e.steps = Some(match parent {
                Some(_) => from_parent.unwrap_or_default(),
                None => vec![json!({ "step": "input", "data": data })],
            });
        }
    }
    fn stepped(&mut self, u: &ReplayUnit, step: &str, data: &Value) {
        if self.trace
            && let Some(steps) = self.entry(u).steps.as_mut()
        {
            steps.push(json!({ "step": step, "data": data }));
        }
    }
    fn tap(&mut self, u: &ReplayUnit, id: &str, node: &Node, s: &Scope) -> Result<(), HookError> {
        let tap = node.tap.clone().unwrap_or_default();
        if self.e.plan.fns.contains(&tap) {
            self.taps.push(json!({ "unit": u.id, "node": id, "tap": tap }));
            return Ok(());
        }
        let w = self.e.render(node.with.as_ref(), &s.ctx(&u.data))?;
        let mut t = json!({ "unit": u.id, "node": id, "tap": tap });
        if node.with.is_some() {
            t["with"] = w;
        }
        self.taps.push(t);
        Ok(())
    }
    fn call(&mut self, u: &ReplayUnit, id: &str, node: &Node, kind: &str, s: &Scope) -> Result<Value, HookError> {
        let w = self.e.render(node.with.as_ref(), &s.ctx(&u.data))?;
        let what = if kind == "agent" {
            "agent node".to_string()
        } else {
            format!("transform: {}", node.transform.clone().unwrap_or_default())
        };
        let value = self.take(id, &what)?;
        self.calls.push(json!({ "unit": u.id, "node": id, "kind": kind, "attempt": s.attempt, "with": w }));
        let data = respond(value)?;
        if kind == "agent"
            && let Some(schema) = self.e.plan.agent_schemas.get(id)
            && let Some(m) = schema.check(&data)
        {
            return Err(HookError::Fail(format!("agent output does not match {}: {m}", schema.path)));
        }
        Ok(data)
    }
    fn write(&mut self, u: &ReplayUnit, s: &Scope) -> Result<(), HookError> {
        let out = &self.e.plan.pipeline.output;
        let w = self.e.render(out.with.as_ref(), &s.ctx(&u.data))?;
        let wm = w.as_object().cloned().unwrap_or_default();
        let mut write = json!({ "key": output_key(&out.to, &wm, &u.id), "to": out.to, "with": w });
        if out.to == "sqlite" {
            write["record"] = Value::Object(sqlite_record(&u.id, &u.data, &wm)?);
        }
        self.writes.insert(u.id.clone(), write);
        Ok(())
    }
    fn continued(&mut self, u: &ReplayUnit, f: &ReplayFailure) {
        let w = StepError {
            step: f.step.clone(),
            code: f.code.clone(),
            message: f.message.clone(),
            rule: None,
            attempts: Some(f.attempts),
            then: Some("continue".into()),
            hint: None,
        };
        self.entry(u).warnings.push(w);
    }
    fn ended(&mut self, u: &ReplayUnit, end: ReplayEnd) {
        match end {
            ReplayEnd::Written => {
                let write = self.writes.get(&u.id).cloned();
                self.end(u, "delivered", u.data.clone()).write = write;
            }
            ReplayEnd::Filtered => {
                self.end(u, "filtered", u.data.clone());
            }
            ReplayEnd::Branched(copies) => {
                let e = self.entry(u);
                e.outcome = "branched";
                e.copies = Some(copies);
            }
            ReplayEnd::Failed(f) => {
                let error = self.error_of(&f);
                self.end(u, outcome_of(&f.policy.then), f.data.clone()).error = Some(error);
            }
            ReplayEnd::Aborted(a) => {
                let error = StepError {
                    step: a.step,
                    code: a.code,
                    message: a.message,
                    rule: None,
                    attempts: None,
                    then: None,
                    hint: a.hint,
                };
                self.end(u, "failed", u.data.clone()).error = Some(error);
            }
        }
    }
}

async fn run_fixture(
    plan: &Plan,
    fns: &JsFns,
    fx: &Fixture,
    run_stubs: &Map<String, Value>,
    opts: &TestOptions,
    now: i64,
) -> Value {
    let pipeline = &plan.pipeline;
    let secrets: Map<String, Value> =
        pipeline.secrets.iter().flatten().map(|(k, _)| (k.clone(), json!(SECRET))).collect();
    let base =
        fx.file.as_deref().and_then(|f| std::path::Path::new(f).file_name()).map(|n| n.to_string_lossy().to_string());
    let place = format!("fixtures/{}", base.unwrap_or_else(|| format!("{}.json", fx.name)));
    let mut stubs = run_stubs.clone();
    for (k, v) in fx.stubs.iter().flatten() {
        stubs.insert(k.clone(), v.clone());
    }
    let known = stubbable(pipeline);
    if let Some(unknown) = stubs.keys().find(|id| !known.contains(id)) {
        let hint = if known.is_empty() {
            format!("remove stubs.{unknown}")
        } else {
            format!("nodes that take a stub: {}", known.join(", "))
        };
        return json!({
            "fixture": fx.name, "outcome": "failed", "units": [], "taps": [], "calls": [],
            "error": { "step": unknown, "code": "stub.unknown", "message": format!("stubs.{unknown} names no agent node or transform: http in {}", pipeline.name), "hint": hint },
        });
    }
    let e = ReplayEnv {
        plan,
        fns,
        env: Value::Object(opts.env.clone()),
        secrets: Value::Object(secrets),
        opts: EvalOptions { clock: Clock::Fixed(now as f64) },
    };
    let meta = fx.meta.clone().unwrap_or_default();
    let input = PacketInput {
        id: fx.name.clone(),
        trigger: meta
            .get("trigger")
            .and_then(|t| t.as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| pipeline.input.via.clone()),
        source: meta.get("source").and_then(|t| t.as_str()).unwrap_or(SOURCE).to_string(),
        received_at: meta.get("received_at").and_then(|t| t.as_f64()).map(|f| f as i64).unwrap_or(now),
        input: fx.data.clone(),
    };
    let mut h = TestHooks {
        e: &e,
        trace: opts.trace,
        fixture_data: fx.data.clone(),
        stubs,
        used: HashMap::new(),
        place,
        order: vec![],
        entries: HashMap::new(),
        writes: HashMap::new(),
        taps: vec![],
        calls: vec![],
        rejected: None,
    };
    let mut outcome = "filtered".to_string();
    let mut error: Option<Value> = None;
    if let Err(err) = replay_packet(&e, &input, &mut h).await {
        // Not a step failure (a loop's `until` that can't be evaluated): the fixture fails, the run goes on.
        outcome = "failed".into();
        error = Some(json!({ "step": "replay", "code": "internal", "message": err }));
    }
    if let Some(r) = &h.rejected {
        outcome = "rejected".into();
        error = Some(serde_json::to_value(r).unwrap_or(Value::Null));
    }
    let mut units = vec![];
    let mut leaves = vec![];
    for id in &h.order {
        let en = &h.entries[id];
        let mut u = json!({ "unit": en.unit, "branch": en.branch, "outcome": en.outcome, "path": en.path });
        if let Some(c) = &en.copies {
            u["copies"] = json!(c);
        }
        if let Some(d) = &en.data {
            u["data"] = d.clone();
        }
        if let Some(w) = &en.write {
            u["write"] = w.clone();
        }
        if let Some(er) = &en.error {
            u["error"] = serde_json::to_value(er).unwrap_or(Value::Null);
        }
        if !en.warnings.is_empty() {
            u["warnings"] = serde_json::to_value(&en.warnings).unwrap_or(Value::Null);
        }
        if let Some(s) = &en.steps {
            u["steps"] = json!(s);
        }
        if en.outcome != "branched" {
            leaves.push(en.outcome);
        }
        units.push(u);
    }
    if outcome != "rejected" && outcome != "failed" {
        outcome = RANK.iter().find(|o| leaves.contains(o)).copied().unwrap_or("filtered").to_string();
    }
    let mut out = json!({ "fixture": fx.name, "outcome": outcome, "units": units, "taps": h.taps, "calls": h.calls });
    if let Some(er) = error {
        out["error"] = er;
    }
    out
}

/// `pipo-runner test`: options as JSON on stdin; prints `{"report": …}` or `{"error": …}`; exit 0 or 1.
pub async fn main_test(input: &str) -> (Value, i32) {
    let v: Value = match serde_json::from_str(input) {
        Ok(v) => v,
        Err(e) => return (json!({ "error": { "kind": "usage", "message": format!("bad JSON on stdin: {e}") } }), 64),
    };
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_owned);
    let Some(file) = s("file") else {
        return (json!({ "error": { "kind": "usage", "message": "`file` is required" } }), 64);
    };
    let mut fixtures = vec![];
    for f in v.get("fixtures").and_then(|f| f.as_array()).cloned().unwrap_or_default() {
        match fixture_from_json(&f) {
            Ok(fx) => fixtures.push(fx),
            Err(e) => return (json!({ "error": e.to_value() }), 1),
        }
    }
    let home = s("home").map(std::path::PathBuf::from).unwrap_or_else(|| {
        std::env::var("PIPO_HOME").map(std::path::PathBuf::from).unwrap_or_else(|_| {
            std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(".pipo")
        })
    });
    let opts = TestOptions {
        file: std::path::PathBuf::from(file),
        home,
        source: s("source"),
        fixtures,
        stubs: v.get("stubs").cloned(),
        now: v.get("now").and_then(|n| n.as_f64()).map(|n| n as i64),
        env: v.get("env").and_then(|e| e.as_object()).cloned().unwrap_or_default(),
        trace: v.get("trace").and_then(|t| t.as_bool()).unwrap_or(false),
    };
    match test_pipeline(opts).await {
        Ok(report) => (json!({ "report": report }), 0),
        Err(e) => (json!({ "error": e.to_value() }), 1),
    }
}
