// The data plane for one pipeline (docs/spec.md §7.1). Port of runner.ts: accepts packets, moves each one through
// its steps, writes and verifies it, and commits every transition to the journal.
//
// The runner is single-threaded: a current-thread tokio runtime with a LocalSet, state in `RefCell`s, tasks
// spawned with `spawn_local`. Like the TS runner on Bun's event loop, code between two `.await`s runs without
// interleaving, and several invariants rely on that ("no await between this check and that insert"). A `RefCell`
// borrow is never held across an `.await`.

pub mod apply;
mod flow;

use crate::agents::{AgentBudget, AgentRuntime, AgentSettings, BudgetCap, EngineCap};
use crate::bots::Bots;
use crate::compile::Compiled;
use crate::connectors::{self, ConnectorContext, InputAdapter, OutputAdapter, Settled, StepAdapter};
use crate::control::ControlError;
use crate::control::protocol::{socket_path, socket_path_problem};
use crate::control::server::ControlServer;
use crate::duration::{format_duration, parse_duration};
use crate::jsfn::JsFns;
use crate::journal::{ESCALATED, Journal, PacketError, PacketRow, TERMINAL};
use crate::lifecycle::{journaled_pause, lifetime_anchor, ttl_override_problem};
use crate::liveness::{entry_alive_json, own_proc_start};
use crate::pipeline::Pipeline;
use crate::plan::{self, Plan};
use crate::proposals::Proposals;
use crate::secrets::Secrets;
use crate::stats::compute_stats;
use crate::support::{Gap, gaps};
use crate::time::{iso, now_ms, parse_iso};
use crate::versions::{StartPlan, file_changes, plan_start};
use serde_json::{Map, Value, json};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::rc::{Rc, Weak};
use std::time::Duration;
use tokio::sync::{Notify, oneshot, watch};
use tokio::task::JoinHandle;

pub use flow::RESOLVE_ACTIONS;

/// `output.batch.within` when the file leaves it out (D20).
const DEFAULT_BATCH_WITHIN: &str = "1s";
/// `with.timeout` and `with.max_tokens` of an agent node when the file leaves them out (D36).
const AGENT_TIMEOUT: &str = "60s";
const AGENT_MAX_TOKENS: u64 = 4096;
/// Units per transaction when a stall hands waiting units to the agent.
const HANDOVER_CHUNK: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerState {
    Starting,
    Active,
    Paused,
    Draining,
    Stopped,
    Failed,
}

impl RunnerState {
    pub fn as_str(&self) -> &'static str {
        match self {
            RunnerState::Starting => "starting",
            RunnerState::Active => "active",
            RunnerState::Paused => "paused",
            RunnerState::Draining => "draining",
            RunnerState::Stopped => "stopped",
            RunnerState::Failed => "failed",
        }
    }
}

#[derive(Clone, Default)]
pub struct RunnerOptions {
    /// Path to the .pipo file.
    pub file: PathBuf,
    /// Pipo home (journals, registry).
    pub home: PathBuf,
    /// Port for an http input; overrides input.with.listen. 0 picks a free port.
    pub listen: Option<u16>,
    pub hostname: Option<String>,
    /// Environment variables exposed to expressions as `env` (engine.env_allow in the spec).
    pub env_allow: Vec<String>,
    /// The engine that started this runner; written to the registry entry as `engine_id` (§7.2).
    pub engine_id: Option<String>,
    /// Started detached (§7.2, D30): written to the registry entry as `detached`.
    pub detached: bool,
    /// `lifetime.ttl` for this start (`pipo start --ttl`, D57).
    pub ttl: Option<String>,
    /// Where log lines go; stdout when None.
    pub log: Option<Rc<dyn Fn(&str)>>,
    /// Where a stdout output prints; stdout when None.
    pub print: Option<Rc<dyn Fn(&str)>>,
}

/// Why a start was refused: the message, and the diagnostics or gaps behind it.
#[derive(Debug, Clone, Default)]
pub struct StartError {
    pub message: String,
    pub diagnostics: Vec<Value>,
    pub gaps: Vec<Gap>,
}

impl StartError {
    pub fn new(message: impl Into<String>) -> StartError {
        StartError { message: message.into(), ..Default::default() }
    }
}

impl From<String> for StartError {
    fn from(message: String) -> StartError {
        StartError::new(message)
    }
}

/// Where a stall flagged the pipeline (D21, D23): the oldest in-flight unit's node and when it was flagged.
#[derive(Debug, Clone, PartialEq)]
pub struct StallInfo {
    pub node: String,
    pub since: String,
}

/// The runner's mutable state. Borrowed briefly, never across an `.await`.
struct State {
    state: RunnerState,
    /// Why the pipeline is paused (`manual`, `agent`, `stall`, `error at <step>`, `budget`); None unless paused.
    pause_reason: Option<String>,
    queue: VecDeque<String>,
    held: Vec<String>,
    busy: usize,
    stopping: bool,
    /// Set just before the journal closes; late batch flushes then leave their packets at `$batch`.
    closed: bool,
    /// Why intake stopped under `lifetime` (§3.8): `max_packets` or `until`.
    lifetime_end: Option<&'static str>,
    started_at: i64,
    /// Packets parked at `$verify` waiting for an `external` ack (§3.10, D24), with their deadline timers.
    awaiting: HashMap<String, JoinHandle<()>>,
    /// Stall detection (§3.10, D23): when delivery progress was last seen, and whether this episode already fired.
    progress_at: i64,
    stalled: bool,
    stall_info: Option<StallInfo>,
    until_failed: Option<String>,
    settle_waiters: HashMap<String, Vec<oneshot::Sender<Option<Settled>>>>,
    /// Units a stall handed to the agent (D50) that a worker or a batch holds, with the stall message.
    hand_over: HashMap<String, String>,
    /// The active definition and its version: what newly accepted packets use (§7.3).
    pipeline: Rc<Pipeline>,
    version: i64,
    version_hash: String,
    applying: bool,
    budget_resume_at: Option<i64>,
    budget_cap: BudgetCap,
    budget_timer: Option<JoinHandle<()>>,
    timers: Vec<JoinHandle<()>>,
    workers: Vec<JoinHandle<()>>,
    retention: Option<JoinHandle<()>>,
}

pub struct Runner {
    me: Weak<Runner>,
    pub opts: RunnerOptions,
    pub home: PathBuf,
    /// The .pipo file, absolute.
    pub file: PathBuf,
    /// Its folder: relative paths resolve from here.
    pub dir: PathBuf,
    /// The control socket, `<home>/run/<name>.sock` (§7.2).
    pub socket: PathBuf,
    pub registry_path: PathBuf,
    pub journal: Rc<RefCell<Journal>>,
    pub secrets: Secrets,
    /// `env` in expressions: the allowed environment variables.
    pub env: Value,
    output: Box<dyn OutputAdapter>,
    input: RefCell<Option<Rc<dyn InputAdapter>>>,
    control: RefCell<Option<ControlServer>>,
    s: RefCell<State>,
    plans: RefCell<HashMap<i64, Rc<tokio::sync::OnceCell<Rc<Plan>>>>>,
    steps: RefCell<HashMap<String, Rc<dyn StepAdapter>>>,
    batches: RefCell<HashMap<i64, Rc<flow::Batch>>>,
    pub fns: JsFns,
    wakeup: Notify,
    finished: watch::Sender<Option<i32>>,
    pub agents: AgentRuntime,
    budget: Option<AgentBudget>,
    pub bots: Option<Rc<Bots>>,
    /// The telegram bot id this runner's input polls, in its registry entry so a second poller refuses to start.
    polls_bot: RefCell<Option<String>>,
    pub proposals: Proposals,
    /// The compiled form of the active version, as `pipo compile` gave it.
    compiled: RefCell<Rc<Compiled>>,
}

fn read_registry(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Another live runner of the home whose input polls telegram bot `id` (its registry entry's `telegram_bot`).
fn bot_poller(home: &Path, me: &str, id: &str) -> Option<(String, i64)> {
    let dir = home.join("run");
    for entry in std::fs::read_dir(&dir).ok()?.flatten() {
        let f = entry.file_name().to_string_lossy().to_string();
        if !f.ends_with(".json") || f == format!("{me}.json") || f == "engine.json" {
            continue;
        }
        let Some(e) = read_registry(&entry.path()) else { continue };
        if e.get("telegram_bot").and_then(|b| b.as_str()) == Some(id) && entry_alive_json(&e) {
            return Some((f.trim_end_matches(".json").to_string(), e.get("pid").and_then(|p| p.as_i64()).unwrap_or(0)));
        }
    }
    None
}

impl Runner {
    // ── open ─────────────────────────────────────────────────────────────────────

    /// Check (through `pipo compile`), gate and prepare a pipeline. Errs with diagnostics when it can't run.
    pub async fn open(opts: RunnerOptions) -> Result<Rc<Runner>, StartError> {
        let file = std::path::absolute(&opts.file).unwrap_or_else(|_| opts.file.clone());
        let home = opts.home.clone();
        if let Some(problem) = opts.ttl.as_deref().and_then(ttl_override_problem) {
            return Err(StartError::new(format!("{problem}; use for example --ttl 30m, 8h or 2d")));
        }
        let shown = opts.file.display().to_string();
        let text = std::fs::read_to_string(&file).map_err(|e| StartError::new(format!("can't read {shown}: {e}")))?;
        // The file is compiled first: its name says which journal to look in (D38).
        let from_file = crate::compile::compile(&file, &home, None).await.map_err(StartError::new)?;
        let refuse = |c: &Compiled, start: Option<&StartPlan>| -> StartError {
            let errors = c.errors().len();
            let message = match start.and_then(|s| s.from_journal.as_ref()) {
                Some(j) => format!(
                    "v{} of the pipeline in {shown} ({} by {}; it runs instead of the file, which is unchanged since the last start, D38) has {errors} error(s); edit the file to run it instead: a changed file wins on the next start",
                    j.version,
                    j.reason.as_deref().unwrap_or("applied"),
                    j.author
                ),
                None => format!("{shown} has {errors} error(s)"),
            };
            StartError { message, diagnostics: c.diagnostics.clone(), gaps: vec![] }
        };
        if !from_file.errors().is_empty() {
            return Err(refuse(&from_file, None));
        }
        let name = from_file
            .pipeline
            .as_ref()
            .and_then(|p| p.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or_default()
            .to_string();
        let start = plan_start(&home, &name, &text).map_err(StartError::new)?;
        let compiled = if start.from_journal.is_some() {
            let c = crate::compile::compile(&file, &home, Some(&start.source)).await.map_err(StartError::new)?;
            if !c.errors().is_empty() {
                return Err(refuse(&c, Some(&start)));
            }
            c
        } else {
            from_file
        };
        let compiled = Rc::new(compiled);
        let pipeline = Pipeline::from_value(compiled.pipeline.clone().unwrap_or(Value::Null)).map_err(StartError::new)?;

        // Agent settings come from the home's config.yaml through `pipo compile` (§3.11, D36).
        let has_agents = pipeline.nodes.iter().any(|(_, n)| n.agent.is_some());
        let mut settings: Option<AgentSettings> = None;
        if has_agents {
            let raw = compiled.agents.clone().unwrap_or(Value::Null);
            let problems: Vec<String> = raw
                .get("problems")
                .and_then(|p| p.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
                .unwrap_or_default();
            if !problems.is_empty() {
                return Err(StartError::new(format!(
                    "the agent settings in {} have {} problem(s):\n{}\nfix or remove those keys (docs/spec.md §3.11)",
                    home.join("config.yaml").display(),
                    problems.len(),
                    problems.iter().map(|p| format!("  {p}")).collect::<Vec<_>>().join("\n")
                )));
            }
            let s = raw.get("settings").cloned().unwrap_or(Value::Null);
            settings = Some(AgentSettings {
                agents: s.get("agents").and_then(|a| a.as_object()).cloned().unwrap_or_default(),
                timezone: s
                    .get("timezone")
                    .and_then(|t| t.as_str())
                    .map(str::to_owned)
                    .unwrap_or_else(crate::agents::system_time_zone),
                engine_budget: s.get("engine_budget").and_then(|b| b.get("per_day")).and_then(|p| p.as_f64()),
            });
        }
        let found = gaps(&pipeline);
        if found.iter().any(|g| g.level == "refuse") {
            return Err(StartError {
                message: format!("{} uses features this runner does not implement yet", pipeline.name),
                diagnostics: vec![],
                gaps: found,
            });
        }

        // An exec step's program must be there before the first packet needs it (D71).
        let dir = file.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
        for (id, n) in pipeline.nodes.iter() {
            if n.tap.as_deref() != Some("exec") && n.transform.as_deref() != Some("exec") {
                continue;
            }
            let Some(command) = n.with.as_ref().and_then(|w| w.get("command")).and_then(|c| c.as_str()) else { continue };
            if command.contains("${") || connectors::find_command(command, &dir).is_some() {
                continue;
            }
            return Err(StartError::new(format!(
                "nodes.{id}.with.command: '{command}' is not installed or not on PATH; install it (for example `brew install {command}` or `apt install {command}`), or set the full path to the program"
            )));
        }

        let registry_path = home.join("run").join(format!("{}.json", pipeline.name));
        if let Some(existing) = read_registry(&registry_path) {
            let pid = existing.get("pid").and_then(|p| p.as_i64()).unwrap_or(0);
            if pid != std::process::id() as i64 && entry_alive_json(&existing) {
                return Err(StartError::new(format!("{} is already running (pid {pid})", pipeline.name)));
            }
        }
        let socket = socket_path(&home, &pipeline.name);
        if let Some((message, hint)) = socket_path_problem(&socket) {
            return Err(StartError::new(format!("{message}; {hint}")));
        }
        let mut agents = AgentRuntime::empty();
        agents.manifests = compiled.agent_manifests.as_object().cloned().unwrap_or_default();
        if let Some(settings) = &settings {
            agents = crate::agents::prepare_agents(&pipeline, settings, &agents.manifests)
                .await
                .map_err(|e| StartError::new(format!("{}; {}", e.message, e.hint)))?;
        }

        // Chat bots come from the home's bots.json (§3.13, D69); their tokens are redacted like secrets.
        let mut bots: Option<Rc<Bots>> = None;
        if !crate::bots::telegram_uses(&pipeline).is_empty() {
            bots = Some(Rc::new(crate::bots::load_bots(&home, &pipeline).await.map_err(StartError::new)?));
        }
        let mut hidden = agents.hidden.clone();
        if let Some(b) = &bots {
            hidden.extend(b.tokens());
        }

        let journal = Journal::open(&home.join("pipelines").join(&pipeline.name).join("journal.db")).map_err(StartError::new)?;
        let journal = Rc::new(RefCell::new(journal));
        let secrets = Secrets::resolve(pipeline.secrets.as_ref(), hidden).await.map_err(StartError::new)?;
        let mut env = Map::new();
        for k in &opts.env_allow {
            if let Ok(v) = std::env::var(k) {
                env.insert(k.clone(), Value::String(v));
            }
        }
        let pipeline = Rc::new(pipeline);
        let redactor = {
            let s = secrets.clone();
            Rc::new(move |t: &str| s.redact(t)) as Rc<dyn Fn(&str) -> String>
        };
        let ctx = ConnectorContext {
            pipeline: pipeline.clone(),
            dir: dir.clone(),
            log: Rc::new(|_, _| {}),
            print: opts.print.clone(),
            listen: opts.listen,
            hostname: opts.hostname.clone(),
            with: Map::new(),
            home: home.clone(),
            bots: bots.clone(),
            redact: redactor,
        };
        let output = connectors::make_output(&ctx).map_err(|e| StartError::new(e.0))?;
        let (finished, _) = watch::channel(None);
        let state = State {
            state: RunnerState::Starting,
            pause_reason: None,
            queue: VecDeque::new(),
            held: vec![],
            busy: 0,
            stopping: false,
            closed: false,
            lifetime_end: None,
            started_at: now_ms(),
            awaiting: HashMap::new(),
            progress_at: now_ms(),
            stalled: false,
            stall_info: None,
            until_failed: None,
            settle_waiters: HashMap::new(),
            hand_over: HashMap::new(),
            pipeline: pipeline.clone(),
            version: 0,
            version_hash: String::new(),
            applying: false,
            budget_resume_at: None,
            budget_cap: BudgetCap::Pipeline,
            budget_timer: None,
            timers: vec![],
            workers: vec![],
            retention: None,
        };
        let engine_cap = settings.as_ref().and_then(|s| s.engine_budget).map(|per_day| EngineCap {
            home: home.clone(),
            name: pipeline.name.clone(),
            per_day,
        });
        let timezone = settings.as_ref().map(|s| s.timezone.clone());
        let runner = Rc::new_cyclic(|me: &Weak<Runner>| {
            let budget = timezone.map(|tz| {
                let limits_of = me.clone();
                AgentBudget::new(
                    journal.clone(),
                    Rc::new(move || limits_of.upgrade().and_then(|r| r.pipeline().agent_budget.clone())),
                    tz,
                    Rc::new(now_ms),
                    engine_cap,
                )
            });
            Runner {
                me: me.clone(),
                opts: opts.clone(),
                home: home.clone(),
                file: file.clone(),
                dir: dir.clone(),
                socket: socket.clone(),
                registry_path,
                journal: journal.clone(),
                secrets,
                env: Value::Object(env),
                output,
                input: RefCell::new(None),
                control: RefCell::new(None),
                s: RefCell::new(state),
                plans: RefCell::new(HashMap::new()),
                steps: RefCell::new(HashMap::new()),
                batches: RefCell::new(HashMap::new()),
                fns: JsFns::new(),
                wakeup: Notify::new(),
                finished,
                agents,
                budget,
                bots,
                polls_bot: RefCell::new(None),
                proposals: Proposals::new(),
                compiled: RefCell::new(compiled.clone()),
            }
        });

        let input = runner.make_input().map_err(StartError::new)?;
        if let Some(bot) = input.polls_bot() {
            if let Some((other, pid)) = bot_poller(&home, &pipeline.name, &bot) {
                return Err(StartError::new(format!(
                    "telegram bot {bot} is already polled by pipeline '{other}' (pid {pid}); Telegram lets only one reader take a bot's messages. Stop that pipeline, or give this one another bot"
                )));
            }
            *runner.polls_bot.borrow_mut() = Some(bot);
        }
        *runner.input.borrow_mut() = Some(input);
        // Binding the socket is also the lock: a live runner still answering on it makes this one refuse.
        let server = ControlServer::listen(&socket, runner.clone()).await.map_err(|e| {
            StartError::new(format!("{}; {}", e.message, e.hint.unwrap_or_default()))
        })?;
        *runner.control.borrow_mut() = Some(server);
        // Recorded only now that this runner holds the socket (the start lock), in one transaction (D38).
        let files = crate::versions::file_hashes(&compiled.files);
        let planned = crate::journal::PlannedStart {
            latest: start.latest,
            append: start.append.as_ref().map(|a| crate::journal::PlannedAppend {
                hash: a.hash.clone(),
                source: a.source.clone(),
                reason: a.reason.clone(),
                compiled: Some(compiled.raw.clone()),
            }),
        };
        let committed = runner.journal.borrow_mut().commit_start(&planned, &start.file_hash, Some(&files));
        let version = match committed {
            Ok(v) => v,
            Err(e) => {
                runner.close_control().await;
                return Err(StartError::new(format!("{e}; is another runner of {} starting? Try again", pipeline.name)));
            }
        };
        {
            let mut s = runner.s.borrow_mut();
            s.version = version;
            s.version_hash = start.hash.clone();
        }
        for g in &found {
            runner.log("warn", &format!("not implemented yet, ignored: {} ({})", g.feature, g.path));
        }
        Ok(runner)
    }

    fn rc(&self) -> Rc<Runner> {
        self.me.upgrade().expect("runner is alive")
    }

    // ── lifecycle ────────────────────────────────────────────────────────────────

    pub async fn start(&self) -> Result<(), StartError> {
        let version = self.version();
        let compiled = self.compiled.borrow().clone();
        let built = plan::build(version, compiled, &self.fns).await.map_err(StartError::new)?;
        self.set_plan(version, Rc::new(built));
        let p = self.pipeline();

        // A pause outlives a crash (D32): taken from the journal before any worker runs.
        let restored = journaled_pause(&self.journal.borrow());
        if let Some(r) = &restored {
            let mut s = self.s.borrow_mut();
            s.pause_reason = Some(r.reason.clone());
            if r.reason == "budget" {
                let at = r.detail.get("resume_at").and_then(|v| v.as_str()).and_then(parse_iso);
                s.budget_resume_at = at.or_else(|| self.budget.as_ref().map(|b| b.window().end));
                s.budget_cap = if r.detail.get("cap").and_then(|c| c.as_str()) == Some("engine") {
                    BudgetCap::Engine
                } else {
                    BudgetCap::Pipeline
                };
            }
        }
        let recovered = self.journal.borrow().in_flight().map_err(StartError::new)?;
        {
            let mut s = self.s.borrow_mut();
            for row in &recovered {
                s.queue.push_back(row.id.clone());
            }
        }
        for _ in 0..p.concurrency() {
            let me = self.rc();
            let handle = tokio::task::spawn_local(async move { me.work().await });
            self.s.borrow_mut().workers.push(handle);
        }

        let input = self.input.borrow().clone().ok_or_else(|| StartError::new("runner has no input"))?;
        self.s.borrow_mut().started_at = now_ms();
        let runtime = connectors::InputRuntime { journal: self.journal.clone(), await_terminal: self.await_terminal_fn() };
        if let Err(e) = input.start(self.intake_fn(), runtime).await {
            // No registry entry was written yet; don't leave a socket behind that nothing will answer on.
            self.close_control().await;
            return Err(StartError::new(e));
        }
        // Paused when the journal said so, or when a recovered packet's `then: pause` held it while the input started.
        {
            let mut s = self.s.borrow_mut();
            s.state = if s.pause_reason.is_none() { RunnerState::Active } else { RunnerState::Paused };
        }
        self.write_registry();
        let mut detail = json!({ "version": self.version(), "recovered": recovered.len() });
        if let Some(ttl) = &self.opts.ttl {
            detail["ttl"] = json!(ttl);
        }
        self.event("pipeline.started", Some(detail), None, None);
        self.start_retention();
        if let Some(r) = &restored {
            let mut d = r.detail.clone();
            d.insert("reason".into(), json!(r.reason));
            d.insert("restored".into(), json!(true));
            self.event("pipeline.paused", Some(Value::Object(d)), None, None);
        }
        let resuming = if recovered.is_empty() {
            String::new()
        } else {
            format!(", {} {} packet(s)", if restored.is_some() { "holding" } else { "resuming" }, recovered.len())
        };
        self.log(
            "info",
            &format!(
                "started v{}{}, input: {}{resuming}",
                self.version(),
                if self.opts.detached { " (detached)" } else { "" },
                input.describe()
            ),
        );
        if let Some(r) = &restored {
            self.log(
                "warn",
                &format!(
                    "paused ({}), as it was when its last run ended; still accepting packets into the journal until resumed",
                    r.reason
                ),
            );
        }
        let mut versions: Vec<i64> = recovered.iter().map(|r| r.version).collect();
        versions.push(self.version());
        for w in self.start_file_warnings(versions) {
            self.log("warn", &format!("{}; {}", w.message, w.hint));
        }
        let waiting = self.journal.borrow().count_escalated().unwrap_or(0);
        if waiting > 0 {
            self.log(
                "warn",
                &format!(
                    "{waiting} packet(s) wait for the agent (then: agent or a stall); resolve them with retry, dead_letter or drop"
                ),
            );
        }
        if self.state() == RunnerState::Paused && self.pause_reason().as_deref() == Some("budget") {
            self.arm_budget_resume();
        }

        let lt = p.lifetime.clone();
        if lt.as_ref().and_then(|l| l.until.as_ref()).is_some() {
            let me = self.rc();
            self.add_timer(tokio::task::spawn_local(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(1));
                tick.tick().await;
                loop {
                    tick.tick().await;
                    me.check_lifetime();
                }
            }));
        }
        self.check_lifetime();
        if let Some(stall) = p.delivered.as_ref().and_then(|d| d.stall.as_ref()) {
            let after = parse_duration(&stall.after).unwrap_or(60_000);
            self.s.borrow_mut().progress_at = now_ms();
            let every = (after / 4).clamp(50, 1000);
            let me = self.rc();
            self.add_timer(tokio::task::spawn_local(async move {
                let mut tick = tokio::time::interval(Duration::from_millis(every));
                tick.tick().await;
                loop {
                    tick.tick().await;
                    me.check_stall();
                }
            }));
        }
        // A start's --ttl replaces the file's (D57); either counts from the lifetime's anchor.
        let ttl = self.opts.ttl.clone().or_else(|| lt.as_ref().and_then(|l| l.ttl.clone()));
        if let Some(t) = &self.opts.ttl {
            self.log(
                "info",
                &format!(
                    "lifetime ttl {t} from the start (the file's: {})",
                    lt.as_ref().and_then(|l| l.ttl.clone()).unwrap_or_else(|| "none".into())
                ),
            );
        }
        if let Some(ttl) = ttl {
            self.arm_ttl(&ttl, lt.as_ref().and_then(|l| l.on_end.clone()));
        }
        Ok(())
    }

    /// Arm `lifetime.ttl` (§3.8) from the lifetime's anchor in the journal, not from this run: a restart after a
    /// crash gets only the time that is left, and one that finds it over ends at once.
    fn arm_ttl(&self, ttl: &str, on_end: Option<String>) {
        let started = self.s.borrow().started_at;
        let anchor = lifetime_anchor(&self.journal.borrow()).unwrap_or(started);
        let deadline = anchor + parse_duration(ttl).unwrap_or(0) as i64;
        if anchor < started {
            let left = deadline - now_ms();
            self.log(
                "info",
                &format!(
                    "lifetime ttl {ttl} counts from {}, when a run that did not stop cleanly started: {}",
                    iso(anchor),
                    if left > 0 { format!("{} left", format_duration(left as u64)) } else { "already over".into() }
                ),
            );
        }
        let me = self.rc();
        let ttl = ttl.to_string();
        self.add_timer(tokio::task::spawn_local(async move {
            let left = (deadline - now_ms()).max(0) as u64;
            tokio::time::sleep(Duration::from_millis(left)).await;
            me.log("info", &format!("lifetime ttl {ttl} reached"));
            if on_end.as_deref() == Some("stop") {
                me.stop(0).await;
            } else {
                me.drain().await;
            }
        }));
    }

    pub fn address(&self) -> Option<String> {
        self.input.borrow().as_ref().map(|i| i.describe())
    }

    pub fn port(&self) -> Option<u16> {
        self.input.borrow().as_ref().and_then(|i| i.port())
    }

    pub fn started_at(&self) -> i64 {
        self.s.borrow().started_at
    }

    pub fn state(&self) -> RunnerState {
        self.s.borrow().state
    }

    pub fn pause_reason(&self) -> Option<String> {
        self.s.borrow().pause_reason.clone()
    }

    pub fn pipeline(&self) -> Rc<Pipeline> {
        self.s.borrow().pipeline.clone()
    }

    pub fn version(&self) -> i64 {
        self.s.borrow().version
    }

    pub fn stall_info(&self) -> Option<StallInfo> {
        self.s.borrow().stall_info.clone()
    }

    /// Packets waiting for an `external` ack right now.
    pub fn awaiting_ack(&self) -> usize {
        self.s.borrow().awaiting.len()
    }

    /// "jammed" while a stall is flagged and the pipeline still runs (§2.2); otherwise the plain state.
    pub fn status(&self) -> &'static str {
        let s = self.s.borrow();
        if s.state == RunnerState::Active && s.stalled { "jammed" } else { s.state.as_str() }
    }

    /// Resolves with the exit code once the runner has stopped.
    pub async fn finished(&self) -> i32 {
        let mut rx = self.finished.subscribe();
        loop {
            if let Some(code) = *rx.borrow() {
                return code;
            }
            if rx.changed().await.is_err() {
                return 1;
            }
        }
    }

    fn add_timer(&self, h: JoinHandle<()>) {
        self.s.borrow_mut().timers.push(h);
    }

    pub fn pause(&self, reason: &str, detail: Map<String, Value>) {
        let starting = {
            let s = self.s.borrow();
            // While starting (a recovered packet held with `then: pause`), start() turns the reason into `paused`.
            let starting = s.state == RunnerState::Starting && s.pause_reason.is_none();
            if s.state != RunnerState::Active && !starting {
                return;
            }
            starting
        };
        {
            let mut s = self.s.borrow_mut();
            if !starting {
                s.state = RunnerState::Paused;
            }
            s.pause_reason = Some(reason.to_string());
        }
        let mut d = detail.clone();
        d.insert("reason".into(), json!(reason));
        self.event("pipeline.paused", Some(Value::Object(d)), None, None);
        self.spawn_flush_batches();
        if reason == "budget" {
            let at = detail.get("resume_at").and_then(|v| v.as_str()).and_then(parse_iso);
            {
                let mut s = self.s.borrow_mut();
                s.budget_resume_at = at.or_else(|| self.budget.as_ref().map(|b| b.window().end));
                s.budget_cap =
                    if detail.get("cap").and_then(|c| c.as_str()) == Some("engine") { BudgetCap::Engine } else { BudgetCap::Pipeline };
            }
            let message =
                detail.get("message").and_then(|m| m.as_str()).unwrap_or("agent_budget.per_day reached").to_string();
            self.log(
                "warn",
                &format!(
                    "paused (budget): {message}; still accepting packets into the journal. `pipo resume` goes over the cap until then"
                ),
            );
            if !starting {
                self.arm_budget_resume();
            }
        } else {
            self.log("warn", &format!("paused ({reason}); still accepting packets into the journal"));
        }
        if !starting {
            self.write_registry();
        }
    }

    /// Resume. `window` is the automatic resume of a `budget` pause when the next budget day opens (§3.11); any
    /// other resume of a `budget` pause goes over the daily cap until that day ends, and says so in its event.
    pub fn resume(&self, by_window: bool) {
        let (budget, cap) = {
            let mut s = self.s.borrow_mut();
            if s.state != RunnerState::Paused {
                return;
            }
            let budget = s.pause_reason.as_deref() == Some("budget");
            s.state = RunnerState::Active;
            s.pause_reason = None;
            s.progress_at = now_ms();
            s.stalled = false;
            s.stall_info = None;
            if let Some(t) = s.budget_timer.take() {
                t.abort();
            }
            s.budget_resume_at = None;
            let held: Vec<String> = s.held.drain(..).collect();
            for id in held.into_iter().rev() {
                s.queue.push_front(id);
            }
            (budget, s.budget_cap)
        };
        if !budget {
            self.event("pipeline.resumed", None, None, None);
            self.log("info", "resumed");
        } else if by_window {
            self.event("pipeline.resumed", Some(json!({ "reason": "budget_window" })), None, None);
            self.log("info", "resumed: a new agent budget day started");
        } else if let Some(b) = &self.budget {
            let w = b.override_today(cap);
            let until = iso(w.end);
            if cap == BudgetCap::Engine {
                self.event(
                    "pipeline.resumed",
                    Some(json!({ "engine_budget_override": iso(w.start), "until": until })),
                    None,
                    None,
                );
                self.log(
                    "warn",
                    &format!(
                        "resumed over engine.agent_budget.per_day: this pipeline's agent calls continue past the engine cap until {until}"
                    ),
                );
            } else {
                self.event("pipeline.resumed", Some(json!({ "budget_override": iso(w.start), "until": until })), None, None);
                self.log("warn", &format!("resumed over agent_budget.per_day: agent calls continue past the cap until {until}"));
            }
        }
        self.write_registry();
        // Every worker: a backlog accepted (or recovered) while paused can be longer than one.
        self.wake(true);
    }

    /// Resume a `budget` pause once its window ends (§3.11, D37). Re-arms when the timer fires early.
    fn arm_budget_resume(&self) {
        let at = {
            let s = self.s.borrow();
            s.budget_resume_at.or_else(|| self.budget.as_ref().map(|b| b.window().end)).unwrap_or_else(now_ms)
        };
        let me = self.rc();
        let handle = tokio::task::spawn_local(async move {
            loop {
                let wait = (at - now_ms()).max(0) as u64;
                tokio::time::sleep(Duration::from_millis(wait)).await;
                let ok = {
                    let s = me.s.borrow();
                    !s.stopping && !s.closed && s.state == RunnerState::Paused && s.pause_reason.as_deref() == Some("budget")
                };
                if !ok {
                    return;
                }
                if now_ms() >= at {
                    me.s.borrow_mut().budget_timer = None;
                    me.resume(true);
                    return;
                }
            }
        });
        let mut s = self.s.borrow_mut();
        if let Some(old) = s.budget_timer.replace(handle) {
            old.abort();
        }
    }

    /// USD spent on agent calls in the current budget day (§3.11), from the journal.
    pub fn agent_spend_today(&self) -> f64 {
        self.budget.as_ref().map(|b| crate::agents::round(b.spent_today())).unwrap_or(0.0)
    }

    /// When a `budget` pause resumes (ISO), or None.
    pub fn budget_resumes_at(&self) -> Option<String> {
        let s = self.s.borrow();
        if s.state == RunnerState::Paused && s.pause_reason.as_deref() == Some("budget") {
            s.budget_resume_at.map(iso)
        } else {
            None
        }
    }

    /// No packet moves: paused, or starting with a pause taken over from the journal (D32).
    fn holding(&self) -> bool {
        let s = self.s.borrow();
        s.state == RunnerState::Paused || (s.state == RunnerState::Starting && s.pause_reason.is_some())
    }

    fn idle(&self) -> bool {
        let s = self.s.borrow();
        s.queue.is_empty() && s.busy == 0 && s.awaiting.is_empty()
    }

    /// Stop intake, let in-flight packets finish (bounded by drain_timeout), then stop.
    pub async fn drain(&self) {
        let (draining, stopping) = {
            let s = self.s.borrow();
            (s.state == RunnerState::Draining, s.stopping)
        };
        if draining || stopping {
            self.finished().await;
            return;
        }
        if self.state() == RunnerState::Paused {
            self.resume(false);
        }
        self.s.borrow_mut().state = RunnerState::Draining;
        self.event("pipeline.draining", None, None, None);
        self.log("info", "draining");
        let input = self.input.borrow().clone();
        if let Some(i) = input {
            i.stop().await;
        }
        let timeout = parse_duration(
            self.pipeline().lifetime.as_ref().and_then(|l| l.drain_timeout.as_deref()).unwrap_or("2m"),
        )
        .unwrap_or(120_000);
        let deadline = now_ms() + timeout as i64;
        // Packets parked for an `external` ack are in flight too: drain waits for their ack or deadline.
        self.spawn_flush_batches();
        while (!self.idle() || self.batched() > 0) && now_ms() < deadline {
            // Nothing upstream can join a partial batch any more, so write it now rather than after `within`.
            if self.idle() {
                self.spawn_flush_batches();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if !self.idle() || self.batched() > 0 {
            self.log(
                "warn",
                &format!("drain timed out after {}; unfinished packets resume on next start", format_duration(timeout)),
            );
        }
        self.stop(0).await;
    }

    /// Stop now. Packets mid-step stay in the journal and resume on the next start.
    pub async fn stop(&self, code: i32) {
        let failed = {
            let mut s = self.s.borrow_mut();
            if s.stopping {
                return;
            }
            s.stopping = true;
            let failed = s.state == RunnerState::Failed;
            s.state = if failed { RunnerState::Failed } else { RunnerState::Stopped };
            for t in s.timers.drain(..) {
                t.abort();
            }
            if let Some(t) = s.budget_timer.take() {
                t.abort();
            }
            if let Some(t) = s.retention.take() {
                t.abort();
            }
            for (_, t) in s.awaiting.drain() {
                t.abort();
            }
            s.hand_over.clear();
            for (_, ws) in s.settle_waiters.drain() {
                for w in ws {
                    let _ = w.send(None);
                }
            }
            failed
        };
        let input = self.input.borrow().clone();
        if let Some(i) = input {
            i.stop().await;
        }
        self.wake(true);
        let workers: Vec<JoinHandle<()>> = self.s.borrow_mut().workers.drain(..).collect();
        let all = futures_join_all(workers);
        let _ = tokio::time::timeout(Duration::from_secs(1), all).await;
        // Write any partial batch; a flush that can't finish in time is abandoned and its packets, still journaled at
        // `$batch`, are written again (idempotently) on the next start.
        let _ = tokio::time::timeout(Duration::from_secs(2), self.flush_batches()).await;
        for b in self.batches.borrow().values() {
            b.close();
        }
        self.s.borrow_mut().closed = true;
        self.event(if failed { "pipeline.failed" } else { "pipeline.stopped" }, None, None, None);
        self.log("info", if failed { "stopped after halt" } else { "stopped" });
        self.output.close();
        for a in self.steps.borrow().values() {
            a.close();
        }
        self.close_control().await;
                let _ = std::fs::remove_file(&self.registry_path);
        let _ = self.finished.send(Some(if failed { 2 } else { code }));
    }

    async fn close_control(&self) {
        let server = self.control.borrow_mut().take();
        if let Some(s) = server {
            s.close().await;
        }
    }

    /// At start (D60): the files each version that runs now recorded, against those it runs with.
    fn start_file_warnings(&self, mut versions: Vec<i64>) -> Vec<crate::versions::VersionWarning> {
        versions.sort_unstable();
        versions.dedup();
        let runs = crate::versions::file_hashes(&self.compiled.borrow().files);
        let name = self.pipeline().name.clone();
        let mut out = vec![];
        for v in versions {
            let recorded = self.journal.borrow().version_files(v).ok().flatten();
            out.extend(file_changes(recorded.as_ref(), &runs, v, &name, None));
        }
        out
    }

    // ── helpers ──────────────────────────────────────────────────────────────────

    fn set_plan(&self, version: i64, plan: Rc<Plan>) {
        let cell = Rc::new(tokio::sync::OnceCell::new_with(Some(plan)));
        self.plans.borrow_mut().insert(version, cell);
    }

    /// The plan of `version`: a packet accepted by an older version finishes on that version's definition and code.
    pub async fn plan(&self, version: i64) -> Result<Rc<Plan>, String> {
        let cell = self.plans.borrow_mut().entry(version).or_insert_with(|| Rc::new(tokio::sync::OnceCell::new())).clone();
        cell.get_or_try_init(|| async {
            let compiled = self.compiled_version(version).await?;
            plan::build(version, compiled, &self.fns).await.map(Rc::new)
        })
        .await
        .cloned()
    }

    /// A version's compiled form: stored with the version, or compiled again from its source when it has none
    /// (a version an older runner recorded).
    pub async fn compiled_version(&self, version: i64) -> Result<Rc<Compiled>, String> {
        if version == self.version() {
            return Ok(self.compiled.borrow().clone());
        }
        let stored = self.journal.borrow().version_compiled(version)?;
        if let Some(text) = stored {
            return Compiled::from_json(&text).map(Rc::new);
        }
        let source = self.journal.borrow().version_source(version)?;
        let c = crate::compile::compile(&self.file, &self.home, Some(&source)).await?;
        if !c.errors().is_empty() {
            return Err(format!("v{version} no longer passes pipo check ({} error(s))", c.errors().len()));
        }
        Ok(Rc::new(c))
    }

    /// A version's pipeline (for ops that read a pinned version, like a DLQ replay).
    pub async fn pipeline_of(&self, version: i64) -> Result<Rc<Pipeline>, String> {
        Ok(self.plan(version).await?.pipeline.clone())
    }

    pub fn meta(&self, plan: &Plan, row: &PacketRow, node: &str, attempt: u32) -> Value {
        let mut meta = json!({
            "packet_id": row.root.clone().unwrap_or_else(|| row.id.clone()),
            "branch": row.branch,
            "pipeline": plan.pipeline.name,
            "version": plan.version,
            "node": node,
            "trigger": row.trigger,
            "source": row.source,
            "received_at": row.received_at,
            "attempt": attempt,
            "hops": row.hops,
            "iteration": row.iteration,
            "key": row.id,
        });
        // At the output and the delivery check, `meta.key` is what the output writes with (D55).
        if node == "output" || node == "delivered" {
            let ctx = json!({ "data": row.data, "meta": meta, "env": self.env, "secrets": self.secrets.values });
            meta["key"] = json!(crate::output_key::resolve_key(&plan.pipeline.output, &row.id, &ctx));
        }
        meta
    }

    /// Render a policy message; fall back to the raw error if the template itself fails. Always redacted.
    fn message(&self, template: Option<&str>, ctx: &Value, fallback: &str) -> String {
        let mut text = fallback.to_string();
        if let Some(t) = template.filter(|t| !t.is_empty()) {
            match crate::expr::render_string(t, ctx) {
                Ok(v) => text = crate::expr::to_text(&v.to_json()).trim().to_string(),
                Err(e) => text = format!("{fallback} (message template failed: {e})"),
            }
        }
        self.secrets.redact(&text)
    }

    fn make_input(&self) -> Result<Rc<dyn InputAdapter>, String> {
        let p = self.pipeline();
        let ctx_vars = json!({ "env": self.env, "secrets": self.secrets.values });
        let with = crate::expr::render(&Value::Object(p.input.with.clone().unwrap_or_default()), &ctx_vars)
            .map_err(|e| format!("input.with: {e}"))?;
        let me = self.me.clone();
        let ctx = ConnectorContext {
            pipeline: p.clone(),
            dir: self.dir.clone(),
            log: Rc::new(move |level: &str, message: &str| {
                if let Some(r) = me.upgrade() {
                    r.log(level, message);
                }
            }),
            print: self.opts.print.clone(),
            listen: self.opts.listen,
            hostname: self.opts.hostname.clone(),
            with: with.as_object().cloned().unwrap_or_default(),
            home: self.home.clone(),
            bots: self.bots.clone(),
            redact: self.redactor(),
        };
        connectors::make_input(&ctx).map(Rc::from).map_err(|e| e.0)
    }

    pub fn redactor(&self) -> Rc<dyn Fn(&str) -> String> {
        let s = self.secrets.clone();
        Rc::new(move |t: &str| s.redact(t))
    }

    pub fn write_registry(&self) {
        if self.s.borrow().stopping {
            return;
        }
        let _ = std::fs::create_dir_all(self.registry_path.parent().unwrap_or(Path::new(".")));
        let s = self.s.borrow();
        let mut entry = Map::new();
        entry.insert("pipeline".into(), json!(s.pipeline.name));
        entry.insert("version".into(), json!(s.version));
        entry.insert("pid".into(), json!(std::process::id()));
        entry.insert("file".into(), json!(self.file.display().to_string()));
        entry.insert("socket".into(), json!(self.socket.display().to_string()));
        entry.insert("listen".into(), json!(self.port()));
        if let Some(bot) = self.polls_bot.borrow().as_ref() {
            entry.insert("telegram_bot".into(), json!(bot));
        }
        entry.insert("detached".into(), json!(self.opts.detached));
        if let Some(ttl) = &self.opts.ttl {
            entry.insert("ttl".into(), json!(ttl));
        }
        let status = if s.state == RunnerState::Active && s.stalled { "jammed" } else { s.state.as_str() };
        entry.insert("state".into(), json!(status));
        entry.insert("started_at".into(), json!(iso(s.started_at)));
        entry.insert("proc_start".into(), json!(own_proc_start()));
        if let Some(e) = &self.opts.engine_id {
            entry.insert("engine_id".into(), json!(e));
        }
        drop(s);
        let tmp = self.registry_path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(&Value::Object(entry)).unwrap_or_default();
        // Atomic replace so readers never see a half-written entry.
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &self.registry_path);
        }
    }

    /// Secret values in `text` replaced, for control ops that journal caller text.
    pub fn redact(&self, text: &str) -> String {
        self.secrets.redact(text)
    }

    pub fn log(&self, level: &str, message: &str) {
        let line = format!(
            "{} {:<5} [{}] {}",
            iso(now_ms()),
            level.to_uppercase(),
            self.pipeline().name,
            self.secrets.redact(message)
        );
        match &self.opts.log {
            Some(f) => f(&line),
            None => println!("{line}"),
        }
    }

    /// A journal event; a failed write is logged, never fatal (the TS runner let it throw into the caller).
    pub fn event(&self, kind: &str, detail: Option<Value>, packet_id: Option<&str>, node: Option<&str>) {
        let r = self.journal.borrow().event(kind, detail.as_ref(), packet_id, node);
        if let Err(e) = r {
            self.log("error", &format!("journal write failed ({kind}): {e}"));
        }
    }

    fn start_retention(&self) {
        let policy = crate::retention::retention_policy(self.pipeline().retention.as_ref());
        let journal = self.journal.clone();
        let handle = tokio::task::spawn_local(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(crate::retention::INTERVAL_MS));
            loop {
                tick.tick().await;
                let j = journal.borrow();
                crate::retention::tick(j.db(), &policy, now_ms());
            }
        });
        self.s.borrow_mut().retention = Some(handle);
    }

    fn wake(&self, all: bool) {
        if all {
            self.wakeup.notify_waiters();
        }
        self.wakeup.notify_one();
    }

    /// Process units whose transition is already committed (a DLQ replay, D33; a resolve retry, D50).
    pub fn requeue(&self, ids: Vec<String>) {
        self.s.borrow_mut().queue.extend(ids);
        self.wake(true);
    }
}

/// Await every handle (no `futures` dependency for one join).
async fn futures_join_all(handles: Vec<JoinHandle<()>>) {
    for h in handles {
        let _ = h.await;
    }
}

/// The packet error as JSON, for events and settle notices.
fn error_value(e: &Option<PacketError>) -> Option<Value> {
    e.as_ref().map(|e| serde_json::to_value(e).unwrap_or(Value::Null))
}

fn is_terminal(state: &str) -> bool {
    TERMINAL.contains(&state)
}
