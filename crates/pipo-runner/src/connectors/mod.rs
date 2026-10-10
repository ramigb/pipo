// Runtime connector contracts and registry (docs/spec.md §3.3–§3.5). Port of connectors/types.ts and
// connectors/index.ts. Manifests (schemas, capabilities) stay in @pipo/spec, which `pipo compile` checks against.
//
// The runner is single-threaded (a current-thread tokio runtime with a LocalSet), so connectors use `Rc`,
// `RefCell` and non-`Send` futures, the way the TS version relies on one event loop.

pub mod exec;
pub mod file_out;
pub mod http_input;
pub mod http_out;
pub mod push;
pub mod schedule;
pub mod sqlite_out;
pub mod stdout;
pub mod steps;
pub mod system;
pub mod telegram;
pub mod watch;
#[cfg(test)]
pub(crate) mod test_util;

use crate::bots::Bots;
use crate::journal::Journal;
use crate::pipeline::Pipeline;
use serde_json::{Map, Value};
use std::cell::RefCell;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::rc::Rc;

pub type LocalBoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;
pub type Log = Rc<dyn Fn(&str, &str)>;
/// Prints one line (stdout output).
pub type Print = Rc<dyn Fn(&str)>;

#[derive(Debug, Clone, PartialEq)]
pub struct Origin {
    pub trigger: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum IntakeResult {
    Accepted { packet_id: String },
    Rejected { packet_id: String, rule: Option<String>, message: String, respond: Option<u16> },
    Unavailable { reason: String },
}

/// Journal writes an input commits in the same transaction as the packet it hands over (an input's cursor), so
/// the cursor never runs ahead of or behind its packets. Not run when the result is `Unavailable`.
pub type Commit = Box<dyn FnOnce(&mut Journal) -> crate::journal::Result<()>>;

/// Hands a raw payload to the runner, which validates and journals it before answering.
pub type Intake = Rc<dyn Fn(Value, Origin, Option<Commit>) -> LocalBoxFuture<'static, IntakeResult>>;

/// What a packet settled as (`respond: delivered` waits for it, D30).
#[derive(Debug, Clone, PartialEq)]
pub struct Settled {
    pub state: String,
    pub error: Option<Value>,
}

/// Resolves when the packet reaches a terminal state, or None when `ms` passes or the runner stops first.
pub type AwaitTerminal = Rc<dyn Fn(String, u64) -> LocalBoxFuture<'static, Option<Settled>>>;

/// What the runner lends an input at start.
#[derive(Clone)]
pub struct InputRuntime {
    /// For durable input state (spec §14.3): `Journal::input_state(scope)`; inside an intake, use a `Commit`.
    pub journal: Rc<RefCell<Journal>>,
    /// Ends when the packet settles; used by http's `respond: delivered`.
    pub await_terminal: AwaitTerminal,
}

pub trait InputAdapter {
    fn start(&self, intake: Intake, runtime: InputRuntime) -> LocalBoxFuture<'_, Result<(), String>>;
    /// Stop accepting. Safe to call more than once.
    fn stop(&self) -> LocalBoxFuture<'_, ()>;
    /// Human-readable address, e.g. the URL an http input listens on.
    fn describe(&self) -> String;
    /// The port an http input bound (for the registry entry); None for others.
    fn port(&self) -> Option<u16> {
        None
    }
    /// The telegram bot id an input polls (registry `telegram_bot`); None for others.
    fn polls_bot(&self) -> Option<String> {
        None
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct WriteItem {
    /// The idempotency key: `packet_id`, or `packet_id:<branch>` for a fan-out copy (D22).
    pub packet_id: String,
    pub data: Value,
    /// The output's `with:` block, rendered for this packet.
    pub with: Map<String, Value>,
    pub origin: Option<Origin>,
}

pub trait OutputAdapter {
    /// Write one or more packets; one result per item, in order. An error fails the write as a whole.
    fn write(&self, items: Vec<WriteItem>) -> LocalBoxFuture<'_, Result<Vec<Value>, String>>;
    /// A connector-specific delivery check. Universal checks (ack, none, external) never get here.
    fn verify<'a>(
        &'a self,
        check: &'a str,
        check_with: &'a Map<String, Value>,
        item: &'a WriteItem,
        result: &'a Value,
    ) -> LocalBoxFuture<'a, Result<bool, String>>;
    fn close(&self) {}
}

#[derive(Debug, Clone, PartialEq)]
pub struct StepInput {
    pub packet_id: String,
    pub node: String,
    pub data: Value,
    /// The node's `with:` block, rendered for this packet.
    pub with: Map<String, Value>,
    pub origin: Option<Origin>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct StepResult {
    /// Transforms only: the new data.
    pub data: Option<Value>,
    /// Custom events recorded in the packet's trail with the step's transition.
    pub events: Vec<(String, Option<Value>)>,
}

pub trait StepAdapter {
    fn run(&self, input: StepInput) -> LocalBoxFuture<'_, Result<StepResult, String>>;
    fn close(&self) {}
}

/// Everything a factory may need, in one struct so new needs never change the factories' shape.
#[derive(Clone)]
pub struct ConnectorContext {
    pub pipeline: Rc<Pipeline>,
    /// Folder of the .pipo file; relative paths resolve against it.
    pub dir: PathBuf,
    pub log: Log,
    /// Where stdout output prints (the runner's stdout unless a caller captures it).
    pub print: Option<Print>,
    /// Port override for an http input (0 picks a free port).
    pub listen: Option<u16>,
    pub hostname: Option<String>,
    /// The connector's `with:` block, rendered with env and secrets (inputs only).
    pub with: Map<String, Value>,
    pub home: PathBuf,
    pub bots: Option<Rc<Bots>>,
    /// Hides secret values in text a step returns (exec's stdout and stderr).
    pub redact: Rc<dyn Fn(&str) -> String>,
}

/// A factory's settings can't work; the runner turns it into a start error.
#[derive(Debug, Clone, PartialEq)]
pub struct ConnectorError(pub String);

pub const INPUTS: &[&str] = &["http", "push", "schedule", "system", "telegram", "watch"];
pub const OUTPUTS: &[&str] = &["file", "http", "sqlite", "stdout", "telegram"];
pub const TAPS: &[&str] = &["emit", "exec", "file", "http", "telegram"];
pub const TRANSFORMS: &[&str] = &["exec", "http"];

pub fn make_input(ctx: &ConnectorContext) -> Result<Box<dyn InputAdapter>, ConnectorError> {
    let w = &ctx.with;
    match ctx.pipeline.input.via.as_str() {
        "push" => Ok(Box::new(push::PushInput)),
        "http" => Ok(Box::new(http_input::HttpInput::from_context(ctx)?)),
        "schedule" => schedule::ScheduleInput::new(
            schedule::ScheduleOptions {
                cron: w.get("cron").filter(|v| !v.is_null()).map(string_of),
                every: w.get("every").filter(|v| !v.is_null()).map(string_of),
                payload: w.get("payload").cloned(),
                log: Some(ctx.log.clone()),
            },
            Rc::new(schedule::SystemClock),
        )
        .map(|i| Box::new(i) as Box<dyn InputAdapter>)
        .map_err(|e| ConnectorError(format!("schedule input: {e}"))),
        "watch" => Ok(Box::new(watch::WatchInput::new(watch::WatchOptions {
            path: w.get("path").map(string_of).unwrap_or_default(),
            dir: ctx.dir.clone(),
            events: w.get("events").and_then(|e| e.as_array()).map(|a| a.iter().map(string_of).collect()),
            read: w.get("read").and_then(|r| r.as_str()).map(str::to_owned),
            debounce_ms: None,
            poll_ms: None,
            log: Some(ctx.log.clone()),
        }))),
        "system" => system::SystemInput::new(system::SystemOptions {
            every: w.get("every").map(string_of).unwrap_or_default(),
            metrics: w.get("metrics").and_then(|m| m.as_array()).map(|a| a.iter().map(string_of).collect()),
            sampler: None,
            log: Some(ctx.log.clone()),
        })
        .map(|i| Box::new(i) as Box<dyn InputAdapter>)
        .map_err(|e| ConnectorError(format!("system input: {e}"))),
        "telegram" => {
            let make = || -> Result<telegram::TelegramInput, String> {
                let bot = crate::bots::pick_bot(ctx.bots.as_deref(), w, "input")?;
                telegram::TelegramInput::new(telegram::TelegramInputOptions {
                    bot,
                    allow: w.get("allow").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(as_i64).collect()),
                    poll_every: w.get("poll_every").filter(|v| !v.is_null()).map(string_of),
                    download: w.get("download").and_then(|d| d.as_bool()),
                    files_dir: ctx.home.join("pipelines").join(&ctx.pipeline.name).join("files"),
                    log: Some(ctx.log.clone()),
                })
            };
            make().map(|i| Box::new(i) as Box<dyn InputAdapter>).map_err(|e| ConnectorError(format!("telegram input: {e}")))
        }
        other => Err(ConnectorError(format!("no implementation for input '{other}'"))),
    }
}

pub fn make_output(ctx: &ConnectorContext) -> Result<Box<dyn OutputAdapter>, ConnectorError> {
    match ctx.pipeline.output.to.as_str() {
        "stdout" => Ok(Box::new(stdout::StdoutOutput { print: ctx.print.clone() })),
        "file" => Ok(Box::new(file_out::FileOutput::new(&ctx.dir))),
        "sqlite" => Ok(Box::new(sqlite_out::SqliteOutput::new(&ctx.dir))),
        "http" => Ok(Box::new(http_out::HttpOutput)),
        "telegram" => Ok(Box::new(telegram::TelegramOutput { bots: ctx.bots.clone(), dir: ctx.dir.clone() })),
        other => Err(ConnectorError(format!("no implementation for output '{other}'"))),
    }
}

/// A tap (`tap: <action>`) or a transform (`transform: <action>`); `log` and `map` are built into the runner.
pub fn make_step(kind: &str, action: &str, ctx: &ConnectorContext) -> Result<Box<dyn StepAdapter>, ConnectorError> {
    let dir = ctx.dir.clone();
    Ok(match (kind, action) {
        ("tap", "http") => Box::new(steps::HttpTap),
        ("tap", "file") => Box::new(steps::FileTap::new(&dir)),
        ("tap", "emit") => Box::new(steps::EmitTap),
        ("tap", "telegram") => Box::new(steps::TelegramTap { bots: ctx.bots.clone(), dir }),
        ("tap", "exec") => Box::new(exec::ExecStep { dir, transform: false, redact: ctx.redact.clone() }),
        ("transform", "http") => Box::new(steps::HttpTransform),
        ("transform", "exec") => Box::new(exec::ExecStep { dir, transform: true, redact: ctx.redact.clone() }),
        _ => return Err(ConnectorError(format!("{kind} '{action}' is not implemented"))),
    })
}

/// The program an exec step runs, when it can be found (D71): a path with a slash, relative to the pipeline's
/// folder (it only has to exist), or a runnable file on PATH.
pub fn find_command(command: &str, dir: &Path) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    if command.contains('/') {
        let p = resolve_path(dir, command);
        return p.exists().then_some(p);
    }
    let runnable = |p: &Path| p.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false);
    std::env::var_os("PATH")
        .and_then(|paths| std::env::split_paths(&paths).filter(|d| !d.as_os_str().is_empty()).map(|d| d.join(command)).find(|p| runnable(p)))
}

// ── helpers shared by the connectors ───────────────────────────────────────────

/// Node's `path.resolve(base, p)`: an absolute, lexically normalized path (no `.` or `..` left).
pub fn resolve_path(base: &Path, p: &str) -> PathBuf {
    let joined = if Path::new(p).is_absolute() {
        PathBuf::from(p)
    } else if base.is_absolute() {
        base.join(p)
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")).join(base).join(p)
    };
    let mut out = PathBuf::from("/");
    for c in joined.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::Normal(n) => out.push(n),
            _ => {}
        }
    }
    out
}

/// JS `String(v)` for a rendered `with:` value, except that objects and arrays become JSON.
pub fn string_of(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        other => crate::expr::to_text(other),
    }
}

/// JS truthiness of a JSON value.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// A whole number from a JSON value (`1` or `1.0`).
pub fn as_i64(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 9.2e18).map(|f| f as i64))
}

thread_local! {
    static CLIENT: std::cell::OnceCell<reqwest::Client> = const { std::cell::OnceCell::new() };
}

/// One HTTP client per runner thread, so connections are pooled across packets.
pub fn http_client() -> reqwest::Client {
    CLIENT.with(|c| c.get_or_init(|| reqwest::Client::builder().build().unwrap_or_default()).clone())
}

/// A reqwest error in words, with its causes and without the URL (a telegram URL holds the bot token).
pub fn http_error(e: reqwest::Error) -> String {
    let e = e.without_url();
    let mut text = if e.is_timeout() { "the request timed out".to_string() } else { e.to_string() };
    let mut source = std::error::Error::source(&e);
    while let Some(s) = source {
        let s_text = s.to_string();
        if !text.contains(&s_text) {
            text = format!("{text}: {s_text}");
        }
        source = s.source();
    }
    text
}

/// Stop flag plus wake-up for a connector's background tasks (all on the runner's one thread).
#[derive(Default)]
pub struct Stopper {
    stopped: std::cell::Cell<bool>,
    notify: tokio::sync::Notify,
}

impl Stopper {
    pub fn stopped(&self) -> bool {
        self.stopped.get()
    }
    pub fn stop(&self) {
        self.stopped.set(true);
        self.notify.notify_waiters();
    }
    pub fn reset(&self) {
        self.stopped.set(false);
    }
    /// Resolves once `stop` is called (at once if it already was).
    pub async fn wait(&self) {
        let notified = self.notify.notified();
        if self.stopped.get() {
            return;
        }
        notified.await;
    }
    /// Sleeps `ms`; false when stopped first.
    pub async fn sleep(&self, ms: u64) -> bool {
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_millis(ms)) => !self.stopped(),
            _ = self.wait() => false,
        }
    }
}
