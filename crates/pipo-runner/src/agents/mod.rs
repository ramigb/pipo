// Agent nodes (docs/spec.md §3.4, §3.11, D36, D37, D58, D67): providers, settings and budgets. Port of agents/*.ts.
// The interface below is what the runner codes against; the bodies are filled in by the agents port.

use crate::connectors::LocalBoxFuture;
use crate::journal::Journal;
use crate::pipeline::{AgentBudget as BudgetLimits, Pipeline};
use serde_json::{Map, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use tokio::sync::Notify;

pub struct AgentRequest {
    /// Empty for a CLI agent without `with.model`: the CLI's own default (D67).
    pub model: String,
    pub prompt: String,
    /// The node's JSON Schema (`with.schema`, loaded).
    pub schema: Value,
    pub max_tokens: u64,
    /// Notified when the node's `timeout` passes.
    pub abort: Rc<Notify>,
    /// CLI agents: where the CLI runs (`with.cwd`, resolved); a fresh empty folder when None.
    pub cwd: Option<PathBuf>,
    pub allow_tools: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// USD, when the provider reports what the call cost; else it's priced from tokens.
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentResult {
    pub output: Value,
    pub usage: AgentUsage,
}

/// A failed call; `usage` is set when the provider still billed tokens.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentCallError {
    pub message: String,
    pub usage: Option<AgentUsage>,
}

pub trait AgentProvider {
    fn complete(&self, req: AgentRequest) -> LocalBoxFuture<'_, Result<AgentResult, AgentCallError>>;
}

/// What `pipo compile` passes on from `<home>/config.yaml` (`agents` key of its output).
#[derive(Debug, Clone, Default)]
pub struct AgentSettings {
    /// The `agents:` map: provider → { pricing, api_key, base_url, command }.
    pub agents: Map<String, Value>,
    pub timezone: String,
    pub engine_budget: Option<f64>,
}

pub struct AgentRuntime {
    pub providers: HashMap<String, Rc<dyn AgentProvider>>,
    /// Provider → model → { input, output } USD per Mtok.
    pub pricing: Map<String, Value>,
    /// Resolved API keys: redacted from everything the runner logs or journals.
    pub hidden: Vec<String>,
    /// AGENTS from @pipo/spec (`runs`, `timeout`, …), by provider.
    pub manifests: Map<String, Value>,
}

impl AgentRuntime {
    pub fn empty() -> AgentRuntime {
        AgentRuntime { providers: HashMap::new(), pricing: Map::new(), hidden: vec![], manifests: Map::new() }
    }
    pub fn is_cli(&self, provider: &str) -> bool {
        self.manifests.get(provider).and_then(|m| m.get("runs")).and_then(|r| r.as_str()) == Some("cli")
    }
}

/// A start can't set up the agents: a message and a hint.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentSetupError {
    pub message: String,
    pub hint: String,
}

/// A provider per `agent:` value and the price table per provider (runtime.ts `prepareAgents`).
pub async fn prepare_agents(
    _pipeline: &Pipeline,
    _settings: &AgentSettings,
    _manifests: &Map<String, Value>,
) -> Result<AgentRuntime, AgentSetupError> {
    todo!("agents port")
}

/// Price of `model` in a provider's pricing table (priceFor in @pipo/spec): { input, output } USD per Mtok.
pub fn price_for(_pricing: &Value, _model: &str) -> Option<(f64, f64)> {
    todo!("agents port")
}

/// USD for a call (costOf in @pipo/spec).
pub fn cost_of(price: (f64, f64), input_tokens: u64, output_tokens: u64) -> f64 {
    (price.0 * input_tokens as f64 + price.1 * output_tokens as f64) / 1_000_000.0
}

pub fn round(n: f64) -> f64 {
    (n * 1e6).round() / 1e6
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetCap {
    Pipeline,
    Engine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BudgetWindow {
    pub start: i64,
    pub end: i64,
}

/// A budget limit stops the call; never retried.
#[derive(Debug, Clone, PartialEq)]
pub struct BudgetStop {
    /// `packet` or `day`.
    pub kind: &'static str,
    pub message: String,
    pub detail: Map<String, Value>,
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
    pub home: PathBuf,
    pub name: String,
    pub per_day: f64,
}

/// `agent_budget` (§3.11, D37), every number read from the journal's `agent_spend` rows (budget.ts).
pub struct AgentBudget {
    pub journal: Rc<RefCell<Journal>>,
    /// The limits of the version in force (they change with a live apply).
    pub limits: Rc<dyn Fn() -> Option<BudgetLimits>>,
    pub timezone: String,
    pub now: Rc<dyn Fn() -> i64>,
    pub engine: Option<EngineCap>,
    pub state: RefCell<BudgetState>,
}

#[derive(Debug, Clone, Default)]
pub struct BudgetState {
    pub override_start: Option<i64>,
    pub engine_override: Option<i64>,
    pub warned: Option<i64>,
}

impl AgentBudget {
    pub fn new(
        _journal: Rc<RefCell<Journal>>,
        _limits: Rc<dyn Fn() -> Option<BudgetLimits>>,
        _timezone: String,
        _now: Rc<dyn Fn() -> i64>,
        _engine: Option<EngineCap>,
    ) -> AgentBudget {
        todo!("agents port")
    }
    pub fn window(&self) -> BudgetWindow {
        todo!("agents port")
    }
    pub fn spent_today(&self) -> f64 {
        todo!("agents port")
    }
    pub fn check_day(&self) -> Result<(), BudgetStop> {
        todo!("agents port")
    }
    pub fn check_packet(&self, _root: &str, _per_packet: Option<u64>) -> Result<u64, BudgetStop> {
        todo!("agents port")
    }
    pub fn warning(&self) -> Option<Map<String, Value>> {
        todo!("agents port")
    }
    pub fn override_today(&self, _cap: BudgetCap) -> BudgetWindow {
        todo!("agents port")
    }
}

/// The system's own IANA time zone, used when the engine config sets none.
pub fn system_time_zone() -> String {
    todo!("agents port")
}
