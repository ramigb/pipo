// What a runner prepares at start for its agent nodes (docs/spec.md §3.4, §3.11, D36, D67). Port of agents/runtime.ts
// and of `priceFor`/`costOf` in @pipo/spec: a provider per `agent:` value (the API one with its key resolved from a
// secret reference, or a CLI one found installed and logged in) and the price table per provider. For an API provider,
// a model without a price refuses the start: an unpriced call would make the daily cap meaningless.

use super::AgentProvider;
use super::claude::ClaudeProvider;
use super::cli::{CliProvider, cli_readiness};
use super::window::is_time_zone;
use crate::pipeline::Pipeline;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::rc::Rc;

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

fn setup_error(message: String, hint: String) -> AgentSetupError {
    AgentSetupError { message, hint }
}

/// Price of `model` in a provider's pricing table: an exact key, else the longest key the model id contains (the first
/// of equally long ones); { input, output } USD per Mtok.
pub fn price_for(pricing: &Value, model: &str) -> Option<(f64, f64)> {
    let table = pricing.as_object()?;
    let price = |v: &Value| Some((v.get("input")?.as_f64()?, v.get("output")?.as_f64()?));
    if let Some(v) = table.get(model) {
        return price(v);
    }
    let mut best: Option<&str> = None;
    for key in table.keys() {
        // An empty key never wins: `best` is tested for truth in priceFor.
        if !key.is_empty() && model.contains(key.as_str()) && best.is_none_or(|b| key.len() > b.len()) {
            best = Some(key);
        }
    }
    best.and_then(|k| price(&table[k]))
}

/// USD for a call (costOf in @pipo/spec).
pub fn cost_of(price: (f64, f64), input_tokens: u64, output_tokens: u64) -> f64 {
    (input_tokens as f64 * price.0 + output_tokens as f64 * price.1) / 1_000_000.0
}

/// A provider per `agent:` value and the price table per provider (runtime.ts `prepareAgents`).
pub async fn prepare_agents(
    pipeline: &Pipeline,
    settings: &AgentSettings,
    manifests: &Map<String, Value>,
) -> Result<AgentRuntime, AgentSetupError> {
    let mut rt = AgentRuntime::empty();
    rt.manifests = manifests.clone();
    let nodes: Vec<(&String, &crate::pipeline::Node, &String)> =
        pipeline.nodes.iter().filter_map(|(id, n)| n.agent.as_ref().map(|a| (id, n, a))).collect();
    // Budget days are reckoned in this zone; `pipo compile` checked the name against Bun's own zone list.
    if !nodes.is_empty() && !is_time_zone(&settings.timezone) {
        return Err(setup_error(
            format!("engine.timezone '{}' is not in this system's time zone database", settings.timezone),
            "install the time zone database (the tzdata package, /usr/share/zoneinfo), or set engine.timezone in config.yaml to UTC".into(),
        ));
    }
    for (id, node, name) in nodes {
        let manifest = manifests.get(name.as_str());
        let config = settings.agents.get(name.as_str());
        let (Some(manifest), Some(config)) = (manifest, config) else {
            return Err(setup_error(
                format!("agent node '{id}': no provider '{name}'"),
                format!("use one of {}", manifests.keys().cloned().collect::<Vec<_>>().join(", ")),
            ));
        };
        let runs = manifest.get("runs").and_then(Value::as_str).unwrap_or("");
        if !rt.pricing.contains_key(name.as_str()) {
            let table =
                config.get("pricing").filter(|p| p.is_object()).cloned().unwrap_or_else(|| Value::Object(Map::new()));
            rt.pricing.insert(name.clone(), table);
        }
        let model = node.with.as_ref().and_then(|w| w.get("model")).and_then(Value::as_str);
        if let Some(model) = model
            && runs == "api"
            && !model.contains("${")
            && price_for(&rt.pricing[name.as_str()], model).is_none()
        {
            return Err(setup_error(
                format!(
                    "agent node '{id}': no price for model '{model}', so its cost can't be counted against agent_budget"
                ),
                format!(
                    "add agents.{name}.pricing.{model}: {{ input: <USD per Mtok>, output: <USD per Mtok> }} to config.yaml in the Pipo home"
                ),
            ));
        }
        if rt.providers.contains_key(name.as_str()) {
            continue;
        }
        let label = manifest.get("label").and_then(Value::as_str).unwrap_or(name);
        if runs == "cli" {
            let command = config
                .get("command")
                .and_then(Value::as_str)
                .or_else(|| manifest.get("command").and_then(Value::as_str))
                .unwrap_or(name)
                .to_string();
            let ready = cli_readiness(name, &command).await;
            if !ready.ready {
                return Err(setup_error(
                    format!(
                        "agent node '{id}' uses {label} (agent: {name}), which can't run here: {}",
                        ready.reason.unwrap_or_default()
                    ),
                    ready.hint.unwrap_or_else(|| format!("make '{command}' work in a terminal, then start again")),
                ));
            }
            let provider = CliProvider::new(name, &command).map_err(|m| setup_error(m, String::new()))?;
            rt.providers.insert(name.clone(), Rc::new(provider));
            continue;
        }
        let reference = config.get("api_key").and_then(Value::as_str).unwrap_or("undefined");
        let api_key = crate::secrets::resolve_ref(reference).await.map_err(|e| {
            setup_error(
                format!("agent provider '{name}' needs an API key ({reference}): {e}"),
                format!("set it there, or point agents.{name}.api_key in config.yaml at a secret reference such as op://vault/item/field (1Password)"),
            )
        })?;
        rt.hidden.push(api_key.clone());
        let base_url = config.get("base_url").and_then(Value::as_str).unwrap_or("https://api.anthropic.com");
        rt.providers.insert(name.clone(), Rc::new(ClaudeProvider::new(api_key, base_url)));
    }
    Ok(rt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn defaults() -> Value {
        // AGENT_DEFAULTS of claude_api with `claude-sonnet-5-5` added, as parseAgentsConfig merges it.
        json!({
            "opus": { "input": 5, "output": 25 },
            "sonnet": { "input": 3, "output": 15 },
            "haiku": { "input": 1, "output": 5 },
            "claude-sonnet-5-5": { "input": 4, "output": 20 },
        })
    }

    #[test]
    fn prices_an_exact_model_id_else_the_longest_key_it_contains() {
        let t = defaults();
        assert_eq!(price_for(&t, "claude-sonnet-5-5"), Some((4.0, 20.0)));
        assert_eq!(price_for(&t, "claude-sonnet-4-5"), Some((3.0, 15.0)));
        assert_eq!(price_for(&t, "claude-haiku-4-5"), Some((1.0, 5.0)));
        assert_eq!(price_for(&t, "gpt-x"), None);
        // The longest contained key wins over a shorter family key, wherever it sits in the id.
        let t = json!({ "son": { "input": 9, "output": 9 }, "sonnet": { "input": 3, "output": 15 }, "net": { "input": 7, "output": 7 } });
        assert_eq!(price_for(&t, "x-sonnet-y"), Some((3.0, 15.0)));
        // Equally long keys: the first in the table.
        let t = json!({ "abc": { "input": 1, "output": 1 }, "bcd": { "input": 2, "output": 2 } });
        assert_eq!(price_for(&t, "abcd"), Some((1.0, 1.0)));
        // Matching is case-sensitive, and the empty model (a CLI's default) matches no key.
        assert_eq!(price_for(&defaults(), "Claude-Opus"), None);
        assert_eq!(price_for(&defaults(), ""), None);
        assert_eq!(price_for(&json!({ "": { "input": 1, "output": 1 } }), "m"), None);
        assert_eq!(price_for(&json!({}), "m"), None);
    }

    #[test]
    fn cost_of_a_call() {
        assert!((cost_of((100.0, 100.0), 1000, 500) - 0.15).abs() < 1e-12);
        assert!((cost_of((3.0, 15.0), 1_000_000, 0) - 3.0).abs() < 1e-12);
    }

    fn pipeline(nodes: Value) -> Pipeline {
        Pipeline::from_value(json!({
            "pipo": 1, "name": "a", "input": { "via": "push" }, "nodes": nodes,
            "output": { "from": "c", "to": "stdout" },
        }))
        .unwrap()
    }

    fn manifests() -> Map<String, Value> {
        json!({
            "claude_api": { "label": "Claude API", "runs": "api", "timeout": "60s" },
            "codex": { "label": "Codex", "runs": "cli", "command": "codex", "timeout": "5m" },
        })
        .as_object()
        .cloned()
        .unwrap()
    }

    fn settings(agents: Value) -> AgentSettings {
        AgentSettings { agents: agents.as_object().cloned().unwrap(), timezone: "UTC".into(), engine_budget: None }
    }

    #[tokio::test]
    async fn the_start_refuses_unknown_providers_unpriced_api_models_missing_keys_and_unready_clis() {
        let api = json!({ "claude_api": { "pricing": { "sonnet": { "input": 3, "output": 15 } }, "api_key": "env:PIPO_TEST_NO_SUCH_KEY_VAR", "base_url": "http://127.0.0.1:9" } });
        let node = |agent: &str, model: &str| json!({ "c": { "from": "input", "agent": agent, "with": { "model": model, "prompt": "p", "schema": "./s.json" } } });

        let e = prepare_agents(&pipeline(node("gpt", "m")), &settings(api.clone()), &manifests()).await.err().unwrap();
        assert_eq!(e.message, "agent node 'c': no provider 'gpt'");
        assert_eq!(e.hint, "use one of claude_api, codex");

        let e = prepare_agents(&pipeline(node("claude_api", "gpt-x")), &settings(api.clone()), &manifests())
            .await
            .err()
            .unwrap();
        assert_eq!(
            e.message,
            "agent node 'c': no price for model 'gpt-x', so its cost can't be counted against agent_budget"
        );
        assert_eq!(
            e.hint,
            "add agents.claude_api.pricing.gpt-x: { input: <USD per Mtok>, output: <USD per Mtok> } to config.yaml in the Pipo home"
        );

        // A templated model is priced per call instead.
        let e = prepare_agents(&pipeline(node("claude_api", "${data.m}")), &settings(api.clone()), &manifests())
            .await
            .err()
            .unwrap();
        assert_eq!(
            e.message,
            "agent provider 'claude_api' needs an API key (env:PIPO_TEST_NO_SUCH_KEY_VAR): environment variable PIPO_TEST_NO_SUCH_KEY_VAR is not set"
        );
        assert!(e.hint.contains("op://vault/item/field (1Password)"));

        let cli = json!({ "codex": { "pricing": {}, "command": "/nonexistent/pipo-test/codex" } });
        let e = prepare_agents(&pipeline(node("codex", "gpt-5.5")), &settings(cli.clone()), &manifests())
            .await
            .err()
            .unwrap();
        assert_eq!(
            e.message,
            "agent node 'c' uses Codex (agent: codex), which can't run here: Codex isn't installed here (no '/nonexistent/pipo-test/codex' on PATH)"
        );
        assert!(e.hint.contains("npm install -g @openai/codex"));

        let mut bad_zone = settings(api);
        bad_zone.timezone = "Mars/Base".into();
        let e = prepare_agents(&pipeline(node("claude_api", "sonnet")), &bad_zone, &manifests()).await.err().unwrap();
        assert_eq!(e.message, "engine.timezone 'Mars/Base' is not in this system's time zone database");
    }

    #[tokio::test]
    async fn an_api_provider_with_its_key_resolved_and_hidden() {
        // Any variable that is set will do as the key; HOME always is.
        let key = std::env::var("HOME").unwrap();
        let api = json!({ "claude_api": { "pricing": { "sonnet": { "input": 3, "output": 15 } }, "api_key": "env:HOME", "base_url": "http://127.0.0.1:9" } });
        let p = pipeline(json!({
            "c": { "from": "input", "agent": "claude_api", "with": { "model": "claude-sonnet-5-5", "prompt": "p", "schema": "./s.json" } },
            "d": { "from": "c", "agent": "claude_api", "with": { "model": "claude-sonnet-4-5", "prompt": "p", "schema": "./s.json" } },
        }));
        let rt = prepare_agents(&p, &settings(api), &manifests()).await.unwrap();
        assert_eq!(rt.hidden, vec![key]);
        assert!(rt.providers.contains_key("claude_api"));
        assert_eq!(rt.pricing["claude_api"], json!({ "sonnet": { "input": 3, "output": 15 } }));
        assert!(!rt.is_cli("claude_api"));
        assert!(rt.is_cli("codex"));
    }
}
