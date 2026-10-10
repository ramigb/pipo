// Runtime connector contracts and registry (docs/spec.md §3.3–§3.5). Port of connectors/types.ts and
// connectors/index.ts. Manifests (schemas, capabilities) stay in @pipo/spec, which `pipo compile` checks against.
//
// The runner is single-threaded (a current-thread tokio runtime with a LocalSet), so connectors use `Rc`,
// `RefCell` and non-`Send` futures, the way the TS version relies on one event loop.

use crate::bots::Bots;
use crate::journal::Journal;
use crate::pipeline::Pipeline;
use serde_json::{Map, Value};
use std::cell::RefCell;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::rc::Rc;

pub type LocalBoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;
pub type Log = Rc<dyn Fn(&str, &str)>;

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
pub type Commit = Box<dyn FnOnce(&mut Journal) -> Result<(), String>>;

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
    pub print: Option<Rc<dyn Fn(&str)>>,
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

pub const INPUTS: &[&str] = &["push", "schedule", "watch", "system", "telegram", "http"];
pub const OUTPUTS: &[&str] = &["sqlite", "stdout", "file", "http", "telegram"];
pub const TAPS: &[&str] = &["http", "file", "emit", "telegram", "exec"];
pub const TRANSFORMS: &[&str] = &["http", "exec"];

pub fn make_input(_ctx: &ConnectorContext) -> Result<Box<dyn InputAdapter>, ConnectorError> {
    Err(ConnectorError("inputs are not ported yet".into()))
}

pub fn make_output(_ctx: &ConnectorContext) -> Result<Box<dyn OutputAdapter>, ConnectorError> {
    Err(ConnectorError("outputs are not ported yet".into()))
}

/// A tap (`tap: <action>`) or a transform (`transform: <action>`); `log` and `map` are built into the runner.
pub fn make_step(_kind: &str, _action: &str, _ctx: &ConnectorContext) -> Result<Box<dyn StepAdapter>, ConnectorError> {
    Err(ConnectorError("steps are not ported yet".into()))
}
