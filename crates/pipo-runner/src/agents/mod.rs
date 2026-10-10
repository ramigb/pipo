// Agent nodes (docs/spec.md §3.4, §3.11, D36, D37, D58, D67): providers, settings and budgets. Port of agents/*.ts;
// probe.ts and settings.ts stay TypeScript (the CLI and engine use them, and `pipo compile` hands the settings over).

mod budget;
mod claude;
mod cli;
mod home_spend;
mod runtime;
mod window;

pub use budget::{AgentBudget, BudgetCap, BudgetError, BudgetState, BudgetStop, EngineCap, packet_stop};
pub use claude::ClaudeProvider;
pub use cli::{
    CLAUDE_MODELS, CLI_AGENTS, CliProvider, Readiness, cli_models, cli_readiness, extract_json, strict_schema,
};
pub use home_spend::{EngineSpend, engine_spend, engine_window, home_agent_spend};
pub use runtime::{AgentRuntime, AgentSettings, AgentSetupError, cost_of, prepare_agents, price_for};
pub use window::{BudgetWindow, budget_window, is_time_zone, system_time_zone};

use crate::connectors::LocalBoxFuture;
use serde_json::Value;
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

impl AgentCallError {
    pub fn new(message: impl Into<String>, usage: Option<AgentUsage>) -> AgentCallError {
        AgentCallError { message: message.into(), usage }
    }
}

pub trait AgentProvider {
    fn complete(&self, req: AgentRequest) -> LocalBoxFuture<'_, Result<AgentResult, AgentCallError>>;
}

pub fn round(n: f64) -> f64 {
    (n * 1e6).round() / 1e6
}

/// A JSON number as the TS `num` helper reads it: finite, else 0.
fn num(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).filter(|n| n.is_finite()).unwrap_or(0.0)
}

/// Summed token counts as whole tokens.
fn tokens(n: f64) -> u64 {
    if n > 0.0 { n.round() as u64 } else { 0 }
}

/// `String(v)` for the values a provider's JSON holds.
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(a) => {
            a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(",")
        }
        other => crate::expr::js_json(other),
    }
}

/// `a ?? b` over JSON: the value when it is there and not null.
fn present(v: Option<&Value>) -> Option<&Value> {
    v.filter(|x| !x.is_null())
}
