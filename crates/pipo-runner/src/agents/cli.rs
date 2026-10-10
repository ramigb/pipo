// CLI agents (docs/spec.md §3.4, D67): `claude_code`, `codex`, `pi` and `opencode` hand the rendered prompt to a
// coding-agent CLI installed and logged in on this machine, running as the user. Port of agents/cli.ts (`runCli` is
// `crate::proc::run_cli`). Each call gets its own temp folder: the prompt goes in on stdin from a file, and the CLI's
// stdout and stderr (and Codex's last message) go to files read once the process exits. The CLI runs in its own process
// group, killed whole when the call is aborted. Without `allow_tools` the CLI runs with its tools off (or read-only),
// in an empty folder unless `cwd` names one.

use super::{AgentCallError, AgentProvider, AgentRequest, AgentResult, AgentUsage, js_string, num, present, tokens};
use crate::connectors::LocalBoxFuture;
use crate::expr::js_json;
use crate::proc::{CliRun, RunOptions, exit_text, run_cli, tail};
use serde_json::{Map, Value, json};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use tokio::sync::Notify;

pub const CLI_AGENTS: [&str; 4] = ["claude_code", "codex", "pi", "opencode"];

/// The models offered for Claude (Claude Code takes the aliases too); there is no CLI command that lists them.
pub const CLAUDE_MODELS: [&str; 8] = [
    "sonnet",
    "opus",
    "haiku",
    "fable",
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-haiku-4-5",
    "claude-fable-5-1",
];

const PROBE_MS: u64 = 20_000;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Readiness {
    pub ready: bool,
    pub version: Option<String>,
    pub reason: Option<String>,
    pub hint: Option<String>,
}

fn not_ready(reason: &str, hint: &str) -> Readiness {
    Readiness { ready: false, version: None, reason: Some(reason.into()), hint: Some(hint.into()) }
}

/// What a call hands the CLI's argument and environment builders.
struct Call<'a> {
    model: &'a str,
    allow_tools: bool,
    /// The schema the CLI enforces itself, or None: then it is asked for in the prompt.
    native: Option<&'a Value>,
    /// The call's folder: `schema.json` and `last.txt` live here.
    dir: &'a Path,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cli {
    ClaudeCode,
    Codex,
    Pi,
    Opencode,
}

async fn probe(command: &str, args: &[&str]) -> Result<CliRun, String> {
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    run_cli(command, &args, RunOptions { timeout_ms: Some(PROBE_MS), ..Default::default() }).await
}

impl Cli {
    fn of(provider: &str) -> Option<Cli> {
        match provider {
            "claude_code" => Some(Cli::ClaudeCode),
            "codex" => Some(Cli::Codex),
            "pi" => Some(Cli::Pi),
            "opencode" => Some(Cli::Opencode),
            _ => None,
        }
    }

    /// `AGENTS[provider].label` in @pipo/spec.
    fn label(self) -> &'static str {
        match self {
            Cli::ClaudeCode => "Claude Code",
            Cli::Codex => "Codex",
            Cli::Pi => "pi",
            Cli::Opencode => "opencode",
        }
    }

    fn install(self) -> &'static str {
        match self {
            Cli::ClaudeCode => {
                "install Claude Code (curl -fsSL https://claude.ai/install.sh | bash, or npm install -g @anthropic-ai/claude-code)"
            }
            Cli::Codex => "install the Codex CLI (npm install -g @openai/codex)",
            Cli::Pi => "install pi (npm install -g @earendil-works/pi-coding-agent)",
            Cli::Opencode => "install opencode (curl -fsSL https://opencode.ai/install | bash)",
        }
    }

    /// The schema this CLI can enforce (as given, or rewritten), or None when it can't.
    fn native(self, schema: &Value) -> Option<Value> {
        match self {
            Cli::ClaudeCode => Some(schema.clone()),
            Cli::Codex => strict_schema(schema),
            Cli::Pi | Cli::Opencode => None,
        }
    }

    fn args(self, c: &Call) -> Vec<String> {
        let mut a: Vec<String> = vec![];
        let mut push = |xs: &[&str]| a.extend(xs.iter().map(|x| x.to_string()));
        let model = |push: &mut dyn FnMut(&[&str])| {
            if !c.model.is_empty() {
                push(&["--model", c.model]);
            }
        };
        match self {
            Cli::ClaudeCode => {
                push(&["-p", "--output-format", "json"]);
                if let Some(n) = c.native {
                    push(&["--json-schema", &js_json(n)]);
                }
                // No hooks, plugins, MCP servers or CLAUDE.md from the user's setup: the node's prompt is the whole context.
                push(&["--no-session-persistence", "--safe-mode"]);
                model(&mut push);
                if c.allow_tools { push(&["--permission-mode", "bypassPermissions"]) } else { push(&["--tools", ""]) }
            }
            Cli::Codex => {
                push(&["exec", "--skip-git-repo-check", "--ephemeral", "--color", "never", "--json"]);
                if c.native.is_some() {
                    push(&["--output-schema", &c.dir.join("schema.json").to_string_lossy()]);
                }
                push(&["--output-last-message", &c.dir.join("last.txt").to_string_lossy()]);
                push(&["--sandbox", if c.allow_tools { "workspace-write" } else { "read-only" }]);
                model(&mut push);
                push(&["-"]);
            }
            Cli::Pi => {
                push(&[
                    "-p",
                    "--mode",
                    "json",
                    "--no-session",
                    "--no-context-files",
                    "--no-extensions",
                    "--no-skills",
                    "--no-prompt-templates",
                    "--no-themes",
                ]);
                model(&mut push);
                if !c.allow_tools {
                    push(&["--no-tools"]);
                }
            }
            Cli::Opencode => {
                push(&["run", "--format", "json"]);
                model(&mut push);
                if c.allow_tools {
                    push(&["--auto"]);
                }
            }
        }
        a
    }

    fn env(self, c: &Call) -> HashMap<String, String> {
        let mut env = HashMap::new();
        // Tools off: opencode asks for nothing, and every tool is denied on top of the empty folder.
        if self == Cli::Opencode && !c.allow_tools {
            let deny: Map<String, Value> =
                ["read", "edit", "glob", "grep", "list", "bash", "task", "webfetch", "websearch", "external_directory"]
                    .iter()
                    .map(|k| (k.to_string(), json!("deny")))
                    .collect();
            env.insert("OPENCODE_PERMISSION".into(), js_json(&Value::Object(deny)));
        }
        env
    }

    fn parse(self, run: &CliRun, c: &Call) -> Result<(Value, AgentUsage), AgentCallError> {
        match self {
            Cli::ClaudeCode => parse_claude_code(run),
            Cli::Codex => parse_codex(run, c.dir),
            Cli::Pi => parse_pi(run),
            Cli::Opencode => parse_opencode(run),
        }
    }

    /// Logged in (or set up with at least one model), once installed.
    async fn auth(self, command: &str) -> Result<Readiness, String> {
        let ready = Readiness { ready: true, ..Default::default() };
        match self {
            Cli::ClaudeCode => {
                let run = probe(command, &["auth", "status", "--json"]).await?;
                let status = json_lines(&run.stdout).into_iter().next();
                if status.as_ref().and_then(|s| s.get("loggedIn")) == Some(&Value::Bool(true)) {
                    return Ok(ready);
                }
                Ok(not_ready(
                    "Claude Code is installed but not logged in",
                    "run `claude auth login` (or start `claude` and use /login), then try again",
                ))
            }
            Cli::Codex => {
                let run = probe(command, &["login", "status"]).await?;
                if run.code == Some(0) && format!("{}{}", run.stdout, run.stderr).to_lowercase().contains("logged in") {
                    return Ok(ready);
                }
                Ok(not_ready("the Codex CLI is installed but not logged in", "run `codex login`, then try again"))
            }
            Cli::Pi => {
                if !self.models(command).await?.is_empty() {
                    return Ok(ready);
                }
                Ok(not_ready(
                    "pi has no model with credentials set up",
                    "set up a provider in pi (start `pi` and use /login, or export a provider API key), then try again",
                ))
            }
            Cli::Opencode => {
                if !self.models(command).await?.is_empty() {
                    return Ok(ready);
                }
                Ok(not_ready("opencode has no model set up", "run `opencode auth login`, then try again"))
            }
        }
    }

    async fn models(self, command: &str) -> Result<Vec<String>, String> {
        match self {
            Cli::ClaudeCode => Ok(CLAUDE_MODELS.iter().map(|m| m.to_string()).collect()),
            Cli::Codex => {
                let run = probe(command, &["debug", "models"]).await?;
                let parsed: Value = serde_json::from_str(&run.stdout).unwrap_or(Value::Null);
                let Some(list) = parsed.get("models").and_then(Value::as_array) else { return Ok(vec![]) };
                Ok(list
                    .iter()
                    .filter(|m| present(m.get("visibility")).is_none_or(|v| v == "list"))
                    .filter_map(|m| m.get("slug").and_then(Value::as_str).map(str::to_owned))
                    .collect())
            }
            Cli::Pi => {
                let run = probe(command, &["--list-models"]).await?;
                if run.code != Some(0) {
                    return Ok(vec![]);
                }
                Ok(run
                    .stdout
                    .split('\n')
                    .skip(1)
                    .filter_map(|l| {
                        let c: Vec<&str> = l.split_whitespace().collect();
                        (c.len() >= 2).then(|| format!("{}/{}", c[0], c[1]))
                    })
                    .collect())
            }
            Cli::Opencode => {
                let run = probe(command, &["models"]).await?;
                if run.code != Some(0) {
                    return Ok(vec![]);
                }
                Ok(run.stdout.split('\n').map(str::trim).filter(|l| is_model_id(l)).map(str::to_owned).collect())
            }
        }
    }
}

/// `^[\w.-]+\/\S+$`: an opencode `provider/model` line.
fn is_model_id(l: &str) -> bool {
    let Some((provider, model)) = l.split_once('/') else { return false };
    !provider.is_empty()
        && provider.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
        && !model.is_empty()
        && !model.chars().any(char::is_whitespace)
}

/// JSON lines of a CLI's event stream (or one JSON document); lines that aren't JSON (banners, warnings) are skipped.
fn json_lines(text: &str) -> Vec<Value> {
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        return vec![v];
    }
    text.split('\n')
        .map(str::trim)
        .filter(|l| l.starts_with('{'))
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

fn kind(v: &Value) -> Option<&str> {
    v.get("type").and_then(Value::as_str)
}

/// JavaScript truthiness of an optional JSON value.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn parse_claude_code(run: &CliRun) -> Result<(Value, AgentUsage), AgentCallError> {
    let lines = json_lines(&run.stdout);
    let Some(body) = lines.iter().rev().find(|j| kind(j) == Some("result")) else {
        return Err(AgentCallError::new(exit_text("Claude Code", run), None));
    };
    let u = body.get("usage").cloned().unwrap_or(Value::Null);
    let usage = AgentUsage {
        input_tokens: tokens(
            num(u.get("input_tokens"))
                + num(u.get("cache_creation_input_tokens"))
                + num(u.get("cache_read_input_tokens")),
        ),
        output_tokens: tokens(num(u.get("output_tokens"))),
        cost_usd: Some(num(body.get("total_cost_usd"))),
    };
    if truthy(body.get("is_error")) || body.get("subtype").and_then(Value::as_str) != Some("success") {
        let why = present(body.get("result"))
            .or(present(body.get("subtype")))
            .map(js_string)
            .unwrap_or_else(|| "failed".into());
        return Err(AgentCallError::new(format!("Claude Code: {}", tail(&why, 300)), Some(usage)));
    }
    let output = match body.get("structured_output") {
        Some(o) => o.clone(),
        None => {
            let text = present(body.get("result")).map(js_string).unwrap_or_default();
            extract_json(&text).map_err(|e| {
                AgentCallError::new(format!("Claude Code returned no structured output: {e}"), Some(usage.clone()))
            })?
        }
    };
    Ok((output, usage))
}

fn parse_codex(run: &CliRun, dir: &Path) -> Result<(Value, AgentUsage), AgentCallError> {
    let events = json_lines(&run.stdout);
    let (mut input, mut output) = (0.0, 0.0);
    for e in events.iter().filter(|e| kind(e) == Some("turn.completed")) {
        // cached_input_tokens is part of input_tokens, and reasoning_output_tokens part of output_tokens.
        let u = e.get("usage");
        input += num(u.and_then(|u| u.get("input_tokens")));
        output += num(u.and_then(|u| u.get("output_tokens")));
    }
    let usage = AgentUsage { input_tokens: tokens(input), output_tokens: tokens(output), cost_usd: None };
    if let Some(failed) = events.iter().rev().find(|e| matches!(kind(e), Some("turn.failed" | "error"))) {
        let raw = present(failed.get("error").and_then(|e| e.get("message")))
            .or(present(failed.get("message")))
            .map(js_string)
            .unwrap_or_else(|| "failed".into());
        // The API's own message, when the CLI wraps its JSON answer.
        let message = serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|v| present(v.get("error").and_then(|e| e.get("message"))).map(js_string))
            .unwrap_or(raw);
        return Err(AgentCallError::new(format!("Codex: {}", tail(&message, 300)), Some(usage)));
    }
    let last =
        std::fs::read(dir.join("last.txt")).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    if last.trim().is_empty() {
        return Err(AgentCallError::new(exit_text("Codex returned no answer;", run), Some(usage)));
    }
    match extract_json(&last) {
        Ok(v) => Ok((v, usage)),
        Err(e) => Err(AgentCallError::new(format!("Codex: {e}"), Some(usage))),
    }
}

fn parse_pi(run: &CliRun) -> Result<(Value, AgentUsage), AgentCallError> {
    let (mut input, mut output, mut cost) = (0.0, 0.0, 0.0);
    let mut last: Option<Value> = None;
    for e in json_lines(&run.stdout) {
        let Some(message) = e.get("message").filter(|_| kind(&e) == Some("message_end")) else { continue };
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let u = message.get("usage").cloned().unwrap_or(Value::Null);
        input += num(u.get("input")) + num(u.get("cacheRead")) + num(u.get("cacheWrite"));
        output += num(u.get("output"));
        cost += num(u.get("cost").and_then(|c| c.get("total")));
        last = Some(message.clone());
    }
    let usage = AgentUsage { input_tokens: tokens(input), output_tokens: tokens(output), cost_usd: Some(cost) };
    let Some(last) = last else { return Err(AgentCallError::new(exit_text("pi", run), None)) };
    let stop = last.get("stopReason").and_then(Value::as_str);
    if matches!(stop, Some("error" | "aborted")) {
        let why = present(last.get("errorMessage"))
            .map(js_string)
            .unwrap_or_else(|| format!("request {}", stop.unwrap_or_default()));
        return Err(AgentCallError::new(format!("pi: {}", tail(&why, 300)), Some(usage)));
    }
    let text: String = last
        .get("content")
        .and_then(Value::as_array)
        .map(|c| {
            c.iter()
                .filter(|p| kind(p) == Some("text"))
                .map(|p| p.get("text").map(js_string).unwrap_or_else(|| "undefined".into()))
                .collect()
        })
        .unwrap_or_default();
    match extract_json(&text) {
        Ok(v) => Ok((v, usage)),
        Err(e) => Err(AgentCallError::new(format!("pi: {e}"), Some(usage))),
    }
}

fn parse_opencode(run: &CliRun) -> Result<(Value, AgentUsage), AgentCallError> {
    let (mut input, mut output, mut cost) = (0.0, 0.0, 0.0);
    let usage = |input: f64, output: f64, cost: f64| AgentUsage {
        input_tokens: tokens(input),
        output_tokens: tokens(output),
        cost_usd: Some(cost),
    };
    let mut text: Option<String> = None;
    for e in json_lines(&run.stdout) {
        let part = e.get("part");
        match kind(&e) {
            Some("text") => {
                if let Some(t) = part.and_then(|p| p.get("text")).and_then(Value::as_str) {
                    text = Some(t.to_string());
                }
            }
            Some("step_finish") => {
                let t = part.and_then(|p| p.get("tokens"));
                let cache = t.and_then(|t| t.get("cache"));
                input += num(t.and_then(|t| t.get("input")))
                    + num(cache.and_then(|c| c.get("read")))
                    + num(cache.and_then(|c| c.get("write")));
                output += num(t.and_then(|t| t.get("output")));
                cost += num(part.and_then(|p| p.get("cost")));
            }
            Some("error") => {
                let err = e.get("error");
                let why = present(err.and_then(|x| x.get("data")).and_then(|d| d.get("message")))
                    .or(present(err.and_then(|x| x.get("name"))))
                    .map(js_string)
                    .unwrap_or_else(|| "failed".into());
                return Err(AgentCallError::new(
                    format!("opencode: {}", tail(&why, 300)),
                    Some(usage(input, output, cost)),
                ));
            }
            _ => {}
        }
    }
    let usage = usage(input, output, cost);
    let Some(text) = text else {
        return Err(AgentCallError::new(exit_text("opencode returned no answer;", run), Some(usage)));
    };
    match extract_json(&text) {
        Ok(v) => Ok((v, usage)),
        Err(e) => Err(AgentCallError::new(format!("opencode: {e}"), Some(usage))),
    }
}

/// The JSON value in a model's text answer: the whole text, a fenced block, or the outermost {…} / […].
pub fn extract_json(text: &str) -> Result<Value, String> {
    let t = text.trim();
    let mut tries: Vec<&str> = vec![t];
    if let Some(fenced) = fence(t).map(str::trim).filter(|f| !f.is_empty()) {
        tries.push(fenced);
    }
    for (open, close) in [('{', '}'), ('[', ']')] {
        if let (Some(a), Some(b)) = (t.find(open), t.rfind(close))
            && b > a
        {
            tries.push(&t[a..=b]);
        }
    }
    for s in tries {
        if let Ok(v) = serde_json::from_str::<Value>(s) {
            return Ok(v);
        }
    }
    let shown = tail(t, 200);
    Err(format!("the answer is not JSON: {}", if shown.is_empty() { "(empty)".into() } else { shown }))
}

/// The body of the first fenced block, as /```(?:json)?\s*([\s\S]*?)```/i finds it.
fn fence(t: &str) -> Option<&str> {
    let open = t.find("```")?;
    let mut rest = &t[open + 3..];
    if rest.get(..4).is_some_and(|w| w.eq_ignore_ascii_case("json")) {
        rest = &rest[4..];
    }
    let rest = rest.trim_start();
    let close = rest.find("```")?;
    Some(&rest[..close])
}

/// A non-object schema is asked for as `{ value }` (structured output wants an object) and unwrapped again.
fn wrap_schema(schema: &Value) -> (Value, bool) {
    let mut rest = schema.as_object().cloned().unwrap_or_default();
    rest.shift_remove("$schema");
    rest.shift_remove("$id");
    if rest.get("type").and_then(Value::as_str) == Some("object") {
        return (Value::Object(rest), false);
    }
    (
        json!({ "type": "object", "properties": { "value": Value::Object(rest) }, "required": ["value"], "additionalProperties": false }),
        true,
    )
}

/// OpenAI's strict structured output (Codex): every object closed and every property required, the optional ones
/// nullable (their nulls are dropped from the answer again). None for a schema it can't express, such as an object
/// without `properties`; that schema is then asked for in the prompt instead.
pub fn strict_schema(schema: &Value) -> Option<Value> {
    let Some(obj) = schema.as_object() else {
        return if schema.is_null() { None } else { Some(schema.clone()) };
    };
    let mut out = obj.clone();
    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(Value::Array(list)) = obj.get(key) {
            let list: Option<Vec<Value>> = list.iter().map(strict_schema).collect();
            out.insert(key.into(), Value::Array(list?));
        }
    }
    for key in ["$defs", "definitions"] {
        if let Some(Value::Object(defs)) = obj.get(key) {
            let mut strict = Map::new();
            for (k, v) in defs {
                strict.insert(k.clone(), strict_schema(v)?);
            }
            out.insert(key.into(), Value::Object(strict));
        }
    }
    if let Some(items @ Value::Object(_)) = obj.get("items") {
        out.insert("items".into(), strict_schema(items)?);
    }
    // "Anything" ({}, or a schema without a type) can't be said strictly.
    if !["type", "anyOf", "oneOf", "allOf", "enum", "const", "$ref", "properties"].iter().any(|k| obj.contains_key(*k))
    {
        return None;
    }
    let object_type = match obj.get("type") {
        Some(Value::Array(types)) => types.iter().any(|t| t == "object"),
        Some(t) => t == "object",
        None => false,
    };
    if object_type || truthy(obj.get("properties")) {
        let props = obj.get("properties").and_then(Value::as_object)?;
        if props.is_empty() || truthy(obj.get("additionalProperties")) {
            return None;
        }
        let required = required_of(obj);
        let mut closed = Map::new();
        for (k, v) in props {
            let sub = strict_schema(v)?;
            let sub = if required.contains(k.as_str()) { sub } else { json!({ "anyOf": [sub, { "type": "null" }] }) };
            closed.insert(k.clone(), sub);
        }
        out.insert("properties".into(), Value::Object(closed));
        out.insert("required".into(), Value::Array(props.keys().map(|k| Value::String(k.clone())).collect()));
        out.insert("additionalProperties".into(), Value::Bool(false));
    }
    Some(Value::Object(out))
}

fn required_of(schema: &Map<String, Value>) -> HashSet<&str> {
    schema
        .get("required")
        .and_then(Value::as_array)
        .map(|r| r.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// Drop the nulls strict_schema let optional properties have, so the answer matches the node's own schema.
fn drop_nulls(value: Value, schema: Option<&Value>) -> Value {
    let Some(schema) = schema.and_then(Value::as_object) else { return value };
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(|v| drop_nulls(v, schema.get("items"))).collect()),
        Value::Object(fields) => {
            let Some(props) = schema.get("properties").and_then(Value::as_object) else { return Value::Object(fields) };
            let required = required_of(schema);
            let mut out = Map::new();
            for (k, v) in fields {
                if v.is_null() && !required.contains(k.as_str()) && truthy(props.get(&k)) {
                    continue;
                }
                let sub = drop_nulls(v, props.get(&k));
                out.insert(k, sub);
            }
            Value::Object(out)
        }
        other => other,
    }
}

fn schema_in_prompt(prompt: &str, schema: &Value) -> String {
    format!(
        "{prompt}\n\n---\nAnswer with only a JSON value that matches this JSON Schema: no other text, no code fences.\n{}\n",
        js_json(schema)
    )
}

/// Whether a CLI agent can run here: installed (answers `--version`) and logged in or set up.
pub async fn cli_readiness(provider: &str, command: &str) -> Readiness {
    let Some(cli) = Cli::of(provider) else {
        return Readiness { reason: Some(format!("'{provider}' is not a CLI agent")), ..Default::default() };
    };
    let label = cli.label();
    let version = match probe(command, &["--version"]).await {
        Ok(run) if run.code != Some(0) => {
            let out = if run.stderr.is_empty() { &run.stdout } else { &run.stderr };
            let why = Some(tail(out, 300)).filter(|t| !t.is_empty()).unwrap_or_else(|| {
                format!("exit {}", run.code.map(|c| c.to_string()).unwrap_or_else(|| "null".into()))
            });
            return not_ready(
                &format!("{label} is installed but '{command} --version' failed: {why}"),
                &format!(
                    "check that '{command}' works in a terminal, or point agents.{provider}.command in config.yaml at a working one"
                ),
            );
        }
        Ok(run) => run.stdout.trim().split('\n').next().unwrap_or("").to_string(),
        Err(e) => {
            let reason = if e.ends_with("ENOENT") {
                format!("{label} isn't installed here (no '{command}' on PATH)")
            } else {
                format!("'{command}' can't be started: {e}")
            };
            return not_ready(
                &reason,
                &format!("{}, or point agents.{provider}.command in config.yaml at it", cli.install()),
            );
        }
    };
    match cli.auth(command).await {
        Ok(r) => Readiness { version: Some(version), ..r },
        Err(e) => Readiness {
            ready: false,
            version: Some(version),
            reason: Some(format!("{label}'s login check failed: {e}")),
            hint: None,
        },
    }
}

/// The models a CLI agent offers here, as its CLI lists them (an empty list when it can't say).
pub async fn cli_models(provider: &str, command: &str) -> Vec<String> {
    match Cli::of(provider) {
        Some(cli) => cli.models(command).await.unwrap_or_default(),
        None => vec![],
    }
}

pub struct CliProvider {
    provider: String,
    cli: Cli,
    command: String,
}

impl CliProvider {
    pub fn new(provider: &str, command: &str) -> Result<CliProvider, String> {
        let cli = Cli::of(provider).ok_or_else(|| format!("'{provider}' is not a CLI agent"))?;
        Ok(CliProvider { provider: provider.to_string(), cli, command: command.to_string() })
    }
}

impl AgentProvider for CliProvider {
    /// The call runs as a task of its own, so when a timeout drops this future the abort still reaches the CLI: its
    /// group is killed and its folder removed, as the TS provider finishes in the background.
    fn complete(&self, req: AgentRequest) -> LocalBoxFuture<'_, Result<AgentResult, AgentCallError>> {
        let (cli, provider, command) = (self.cli, self.provider.clone(), self.command.clone());
        let task = tokio::task::spawn_local(async move { call(cli, &provider, &command, req).await });
        Box::pin(async move {
            task.await.unwrap_or_else(|e| Err(AgentCallError::new(format!("{} call failed: {e}", cli.label()), None)))
        })
    }
}

async fn call(cli: Cli, provider: &str, command: &str, req: AgentRequest) -> Result<AgentResult, AgentCallError> {
    let dir = std::env::temp_dir().join(format!("pipo-{provider}-{}", crate::ids::ulid().to_lowercase()));
    if let Err(e) = std::fs::create_dir_all(dir.join("work")) {
        return Err(AgentCallError::new(format!("can't make a temp folder for {}: {e}", cli.label()), None));
    }
    let result = call_in(cli, command, &req, &dir).await;
    let _ = std::fs::remove_dir_all(&dir);
    result
}

async fn call_in(cli: Cli, command: &str, req: &AgentRequest, dir: &Path) -> Result<AgentResult, AgentCallError> {
    let label = cli.label();
    let (schema, wrapped) = wrap_schema(&req.schema);
    let native = cli.native(&schema);
    if let Some(n) = &native {
        std::fs::write(dir.join("schema.json"), js_json(n))
            .map_err(|e| AgentCallError::new(format!("can't write the schema for {label}: {e}"), None))?;
    }
    let c = Call { model: &req.model, allow_tools: req.allow_tools, native: native.as_ref(), dir };
    // run_cli takes the abort through a Notify of its own, so it can be told the call was stopped.
    let stop = Rc::new(Notify::new());
    let stopped = Cell::new(false);
    let opts = RunOptions {
        stdin: Some(if native.is_some() { req.prompt.clone() } else { schema_in_prompt(&req.prompt, &schema) }),
        cwd: Some(req.cwd.clone().unwrap_or_else(|| dir.join("work"))),
        abort: Some(stop.clone()),
        timeout_ms: None,
        dir: Some(PathBuf::from(dir)),
        env: cli.env(&c),
    };
    let args = cli.args(&c);
    let watch = async {
        req.abort.notified().await;
        stopped.set(true);
        stop.notify_one();
        std::future::pending::<()>().await
    };
    let run = tokio::select! {
        r = run_cli(command, &args, opts) => r,
        _ = watch => unreachable!("the abort watcher never ends"),
    };
    let run = run.map_err(|e| AgentCallError::new(format!("{label} can't be started ('{command}'): {e}"), None))?;
    if stopped.get() {
        return Err(AgentCallError::new(format!("{label} was stopped (with.timeout)"), None));
    }
    let (output, usage) = cli.parse(&run, &c)?;
    let output = if native.is_some() && cli == Cli::Codex { drop_nulls(output, Some(&schema)) } else { output };
    let output = if wrapped {
        match output {
            Value::Object(mut o) => o.remove("value").unwrap_or(Value::Null),
            _ => Value::Null,
        }
    } else {
        output
    };
    Ok(AgentResult { output, usage })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// A fake CLI: probes answered by their exact argument string, then a canned answer.
    #[derive(Default)]
    struct Fake {
        probes: Vec<(&'static str, &'static str, i32)>,
        stdout: String,
        stderr: String,
        code: i32,
        /// Written to the file after --output-last-message (Codex).
        last: Option<String>,
        sleep: Option<u32>,
    }

    /// One logged call of a fake CLI.
    #[derive(Debug)]
    struct Logged {
        args: Vec<String>,
        stdin: String,
        cwd: PathBuf,
        pid: i32,
        permission: Option<String>,
        schema: Option<Value>,
    }

    struct Box_ {
        root: PathBuf,
        log: PathBuf,
    }

    impl Drop for Box_ {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn sandbox() -> Box_ {
        let root = std::env::temp_dir().join(format!("pipo-cli-agents-{}", crate::ids::ulid().to_lowercase()));
        let log = root.join("calls");
        std::fs::create_dir_all(&log).unwrap();
        Box_ { root: root.canonicalize().unwrap(), log: log.canonicalize().unwrap() }
    }

    fn q(s: &Path) -> String {
        format!("'{}'", s.display().to_string().replace('\'', "'\\''"))
    }

    impl Box_ {
        /// Write a fake CLI named `name` answering as `f`; returns its path. Every call is logged under `calls/<n>/`.
        fn fake(&self, name: &str, f: Fake) -> String {
            let data = self.root.join(format!("{name}.d"));
            std::fs::create_dir_all(&data).unwrap();
            std::fs::write(data.join("stdout"), &f.stdout).unwrap();
            std::fs::write(data.join("stderr"), &f.stderr).unwrap();
            if let Some(last) = &f.last {
                std::fs::write(data.join("last"), last).unwrap();
            }
            let mut probes = String::new();
            for (i, (args, out, code)) in f.probes.iter().enumerate() {
                std::fs::write(data.join(format!("probe{i}")), out).unwrap();
                probes.push_str(&format!("  '{args}') cat {}; exit {code};;\n", q(&data.join(format!("probe{i}")))));
            }
            let script = format!(
                r#"#!/bin/sh
LOG={log}
n=$(ls "$LOG" | wc -l)
C="$LOG/$n"
mkdir -p "$C"
: > "$C/args"
for a in "$@"; do printf '%s\n' "$a" >> "$C/args"; done
cat > "$C/stdin"
pwd -P > "$C/cwd"
echo $$ > "$C/pid"
if [ "${{OPENCODE_PERMISSION+set}}" = set ]; then printf '%s' "$OPENCODE_PERMISSION" > "$C/permission"; fi
prev=""
LAST=""
for a in "$@"; do
  if [ "$prev" = "--output-schema" ]; then cp "$a" "$C/schema"; fi
  if [ "$prev" = "--output-last-message" ]; then LAST="$a"; fi
  prev="$a"
done
case "$*" in
{probes}esac
{sleep}
if [ -n "$LAST" ] && [ -f {data}/last ]; then cp {data}/last "$LAST"; fi
cat {data}/stdout
cat {data}/stderr >&2
exit {code}
"#,
                log = q(&self.log),
                data = q(&data),
                sleep = f.sleep.map(|s| format!("sleep {s}")).unwrap_or_default(),
                code = f.code,
            );
            let path = self.root.join(name);
            std::fs::write(&path, script).unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path.display().to_string()
        }

        fn calls(&self) -> Vec<Logged> {
            let mut out = vec![];
            for n in 0.. {
                let c = self.log.join(n.to_string());
                if !c.exists() {
                    break;
                }
                let read = |f: &str| std::fs::read_to_string(c.join(f)).ok();
                let args = read("args").unwrap_or_default();
                out.push(Logged {
                    args: args
                        .strip_suffix('\n')
                        .map(|a| a.split('\n').map(str::to_owned).collect())
                        .unwrap_or_default(),
                    stdin: read("stdin").unwrap_or_default(),
                    cwd: PathBuf::from(read("cwd").unwrap_or_default().trim()),
                    pid: read("pid").unwrap_or_default().trim().parse().unwrap_or(0),
                    permission: read("permission"),
                    schema: read("schema").map(|s| serde_json::from_str(&s).unwrap()),
                });
            }
            out
        }
    }

    fn after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).map(String::as_str)
    }

    fn req(schema: Value) -> AgentRequest {
        AgentRequest {
            model: String::new(),
            prompt: "Classify this".into(),
            schema,
            max_tokens: 4096,
            abort: Rc::new(Notify::new()),
            cwd: None,
            allow_tools: false,
        }
    }

    fn schema() -> Value {
        json!({ "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "label": {} } })
    }

    fn label() -> Value {
        json!({ "type": "object", "properties": { "label": { "type": "string" }, "note": { "type": "string" } }, "required": ["label"] })
    }

    fn lines(events: &[Value]) -> String {
        events.iter().map(|e| format!("{e}\n")).collect()
    }

    fn claude_result(extra: Value) -> String {
        let mut r = json!({
            "type": "result", "subtype": "success", "is_error": false, "result": "{\"label\":\"ok\"}",
            "structured_output": { "label": "ok" }, "total_cost_usd": 0.0123,
            "usage": { "input_tokens": 10, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 5, "output_tokens": 20 },
        });
        for (k, v) in extra.as_object().unwrap() {
            r[k] = v.clone();
        }
        r.to_string()
    }

    fn local<F: std::future::Future>(f: F) -> F::Output {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        tokio::task::LocalSet::new().block_on(&rt, f)
    }

    async fn complete(provider: &str, bin: &str, r: AgentRequest) -> Result<AgentResult, AgentCallError> {
        CliProvider::new(provider, bin).unwrap().complete(r).await
    }

    fn usage(input: u64, output: u64, cost: Option<f64>) -> AgentUsage {
        AgentUsage { input_tokens: input, output_tokens: output, cost_usd: cost }
    }

    #[test]
    fn claude_code_prompt_on_stdin_schema_enforced_tools_off_in_a_fresh_empty_folder() {
        local(async {
            let b = sandbox();
            let bin = b.fake("claude", Fake { stdout: claude_result(json!({})), ..Default::default() });
            let r =
                complete("claude_code", &bin, AgentRequest { model: "haiku".into(), ..req(schema()) }).await.unwrap();
            assert_eq!(r, AgentResult { output: json!({ "label": "ok" }), usage: usage(115, 20, Some(0.0123)) });
            let calls = b.calls();
            let c = &calls[0];
            assert_eq!(c.stdin, "Classify this");
            assert_eq!(c.args[..3], ["-p", "--output-format", "json"]);
            let sent: Value = serde_json::from_str(after(&c.args, "--json-schema").unwrap()).unwrap();
            assert_eq!(sent, json!({ "type": "object", "properties": { "label": {} } }));
            assert!(c.args.iter().any(|a| a == "--safe-mode"));
            assert!(c.args.iter().any(|a| a == "--no-session-persistence"));
            assert_eq!(after(&c.args, "--tools"), Some(""));
            assert_eq!(after(&c.args, "--model"), Some("haiku"));
            let cwd = c.cwd.display().to_string();
            assert!(cwd.ends_with("/work") && cwd.contains("/pipo-claude_code-"), "{cwd}");
            // The call's folder is gone afterwards.
            assert!(!c.cwd.exists());
        });
    }

    #[test]
    fn claude_code_allow_tools_and_cwd_and_no_model_means_the_clis_default() {
        local(async {
            let b = sandbox();
            let bin = b.fake("claude", Fake { stdout: claude_result(json!({})), ..Default::default() });
            complete(
                "claude_code",
                &bin,
                AgentRequest { allow_tools: true, cwd: Some(b.root.clone()), ..req(schema()) },
            )
            .await
            .unwrap();
            let c = &b.calls()[0];
            assert!(!c.args.iter().any(|a| a == "--tools" || a == "--model"));
            let at = c.args.iter().position(|a| a == "--permission-mode").unwrap();
            assert_eq!(c.args[at..], ["--permission-mode", "bypassPermissions"]);
            assert_eq!(c.cwd, b.root);
        });
    }

    #[test]
    fn claude_code_an_error_result_fails_the_call_and_still_reports_its_cost() {
        local(async {
            let b = sandbox();
            let out = claude_result(
                json!({ "is_error": true, "result": "There's an issue with the selected model", "total_cost_usd": 0 }),
            );
            let bin = b.fake("claude", Fake { code: 1, stdout: out, ..Default::default() });
            let e = complete("claude_code", &bin, req(schema())).await.unwrap_err();
            assert_eq!(e.message, "Claude Code: There's an issue with the selected model");
            assert_eq!(e.usage, Some(usage(115, 20, Some(0.0))));

            // No structured_output: the JSON in `result`.
            let b = sandbox();
            let out = claude_result(json!({ "result": "Sure: {\"label\":\"from text\"}" }));
            let mut v: Value = serde_json::from_str(&out).unwrap();
            v.as_object_mut().unwrap().remove("structured_output");
            let bin = b.fake("claude", Fake { stdout: v.to_string(), ..Default::default() });
            assert_eq!(
                complete("claude_code", &bin, req(schema())).await.unwrap().output,
                json!({ "label": "from text" })
            );
        });
    }

    #[test]
    fn claude_code_no_json_at_all_names_the_exit_code_and_stderr() {
        local(async {
            let b = sandbox();
            let bin = b.fake("claude", Fake { code: 3, stderr: "boom\nreally".into(), ..Default::default() });
            let e = complete("claude_code", &bin, req(schema())).await.unwrap_err();
            assert_eq!(e, AgentCallError::new("Claude Code exited with code 3: boom really", None));
        });
    }

    #[test]
    fn codex_read_only_strict_schema_file_answer_from_the_last_message_tokens_from_turn_completed() {
        local(async {
            let b = sandbox();
            let bin = b.fake(
                "codex",
                Fake {
                    last: Some(r#"{"label":"ok","note":null}"#.into()),
                    stdout: lines(&[
                        json!({ "type": "thread.started" }),
                        json!({ "type": "item.completed", "item": { "type": "error", "message": "Model metadata not found" } }),
                        json!({ "type": "turn.completed", "usage": { "input_tokens": 1000, "cached_input_tokens": 900, "output_tokens": 16 } }),
                    ]),
                    ..Default::default()
                },
            );
            let r = complete("codex", &bin, AgentRequest { model: "gpt-5.5".into(), ..req(label()) }).await.unwrap();
            // The optional property strict mode made nullable is dropped again.
            assert_eq!(r, AgentResult { output: json!({ "label": "ok" }), usage: usage(1000, 16, None) });
            let c = &b.calls()[0];
            assert_eq!(c.args.first().map(String::as_str), Some("exec"));
            assert_eq!(c.args.last().map(String::as_str), Some("-"));
            assert_eq!(c.stdin, "Classify this");
            assert_eq!(after(&c.args, "--sandbox"), Some("read-only"));
            assert_eq!(after(&c.args, "--model"), Some("gpt-5.5"));
            assert_eq!(after(&c.args, "--color"), Some("never"));
            assert!(c.args.iter().any(|a| a == "--ephemeral") && c.args.iter().any(|a| a == "--skip-git-repo-check"));
            assert!(after(&c.args, "--output-last-message").unwrap().ends_with("/last.txt"));
            assert_eq!(
                c.schema,
                Some(json!({
                    "type": "object",
                    "properties": { "label": { "type": "string" }, "note": { "anyOf": [{ "type": "string" }, { "type": "null" }] } },
                    "required": ["label", "note"],
                    "additionalProperties": false,
                }))
            );
        });
    }

    #[test]
    fn codex_a_schema_strict_mode_cant_say_is_asked_for_in_the_prompt() {
        local(async {
            let b = sandbox();
            let turn = lines(&[json!({ "type": "turn.completed", "usage": {} })]);
            let bin = b.fake(
                "codex",
                Fake { last: Some(r#"Sure: {"anything":1}"#.into()), stdout: turn, ..Default::default() },
            );
            let r = complete("codex", &bin, req(json!({ "type": "object" }))).await.unwrap();
            assert_eq!(r.output, json!({ "anything": 1 }));
            let c = &b.calls()[0];
            assert!(!c.args.iter().any(|a| a == "--output-schema"));
            assert!(c.stdin.contains("Answer with only a JSON value that matches this JSON Schema"));
        });
    }

    #[test]
    fn codex_a_non_object_schema_is_asked_for_as_value_and_unwrapped() {
        local(async {
            let b = sandbox();
            let turn = lines(&[json!({ "type": "turn.completed", "usage": {} })]);
            let bin = b.fake(
                "codex",
                Fake { last: Some(r#"{"value":"positive"}"#.into()), stdout: turn, ..Default::default() },
            );
            let r = complete("codex", &bin, AgentRequest { allow_tools: true, ..req(json!({ "type": "string" })) })
                .await
                .unwrap();
            assert_eq!(r.output, json!("positive"));
            let c = &b.calls()[0];
            assert_eq!(
                c.schema,
                Some(
                    json!({ "type": "object", "properties": { "value": { "type": "string" } }, "required": ["value"], "additionalProperties": false })
                )
            );
            assert_eq!(after(&c.args, "--sandbox"), Some("workspace-write"));
        });
    }

    #[test]
    fn codex_turn_failed_gives_the_apis_own_message() {
        local(async {
            let b = sandbox();
            let msg =
                json!({ "type": "error", "status": 400, "error": { "message": "The 'x' model is not supported" } })
                    .to_string();
            let bin = b.fake(
                "codex",
                Fake {
                    code: 1,
                    stdout: lines(&[json!({ "type": "turn.failed", "error": { "message": msg } })]),
                    ..Default::default()
                },
            );
            let e = complete("codex", &bin, req(schema())).await.unwrap_err();
            assert_eq!(e.message, "Codex: The 'x' model is not supported");
            assert_eq!(e.usage, Some(usage(0, 0, None)));

            // No last message at all.
            let b = sandbox();
            let bin = b.fake("codex", Fake { code: 2, stderr: "bad flag".into(), ..Default::default() });
            let e = complete("codex", &bin, req(schema())).await.unwrap_err();
            assert_eq!(e.message, "Codex returned no answer; exited with code 2: bad flag");
        });
    }

    #[test]
    fn pi_last_assistant_message_fenced_json_usage_and_cost_summed() {
        local(async {
            let b = sandbox();
            let msg = |text: &str, input: u64, cost: f64| {
                json!({ "type": "message_end", "message": {
                    "role": "assistant", "content": [{ "type": "text", "text": text }], "stopReason": "stop",
                    "usage": { "input": input, "output": 5, "cacheRead": 1, "cacheWrite": 0, "cost": { "total": cost } },
                } })
            };
            let bin = b.fake(
                "pi",
                Fake {
                    stdout: lines(&[
                        json!({ "type": "session" }),
                        msg("thinking", 10, 0.01),
                        json!({ "type": "message_end", "message": { "role": "user" } }),
                        msg("Here:\n```json\n{\"label\":\"ok\"}\n```", 20, 0.02),
                    ]),
                    ..Default::default()
                },
            );
            let r = complete("pi", &bin, AgentRequest { model: "anthropic/claude-haiku-4-5".into(), ..req(schema()) })
                .await
                .unwrap();
            assert_eq!(r.output, json!({ "label": "ok" }));
            assert_eq!((r.usage.input_tokens, r.usage.output_tokens), (32, 10));
            assert!((r.usage.cost_usd.unwrap() - 0.03).abs() < 1e-9);
            let c = &b.calls()[0];
            for flag in [
                "--no-tools",
                "--no-session",
                "--no-context-files",
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-themes",
            ] {
                assert!(c.args.iter().any(|a| a == flag), "{flag}");
            }
            assert_eq!(c.args[..3], ["-p", "--mode", "json"]);
            assert_eq!(after(&c.args, "--model"), Some("anthropic/claude-haiku-4-5"));
            assert!(c.stdin.starts_with("Classify this\n\n---\nAnswer with only a JSON value"));
            assert!(c.stdin.contains(r#"{"type":"object","properties":{"label":{}}}"#));
        });
    }

    #[test]
    fn pi_an_errored_message_fails_the_call_with_its_message() {
        local(async {
            let b = sandbox();
            let out = lines(&[
                json!({ "type": "message_end", "message": { "role": "assistant", "content": [], "stopReason": "error", "errorMessage": "No API key for provider" } }),
            ]);
            let bin = b.fake("pi", Fake { stdout: out, ..Default::default() });
            let e = complete("pi", &bin, req(schema())).await.unwrap_err();
            assert_eq!(e.message, "pi: No API key for provider");
            let b = sandbox();
            let bin = b.fake("pi", Fake { code: 1, stderr: "nope".into(), ..Default::default() });
            assert_eq!(
                complete("pi", &bin, req(schema())).await.unwrap_err(),
                AgentCallError::new("pi exited with code 1: nope", None)
            );
        });
    }

    #[test]
    fn opencode_last_text_tokens_and_cost_from_step_finish_every_tool_denied_unless_allow_tools() {
        local(async {
            let b = sandbox();
            let bin = b.fake(
                "opencode",
                Fake {
                    stdout: lines(&[
                        json!({ "type": "step_start", "part": {} }),
                        json!({ "type": "text", "part": { "text": "{\"label\":\"ok\"}" } }),
                        json!({ "type": "step_finish", "part": { "tokens": { "input": 7, "output": 3, "cache": { "read": 2, "write": 1 } }, "cost": 0.5 } }),
                    ]),
                    ..Default::default()
                },
            );
            let r = complete("opencode", &bin, AgentRequest { model: "opencode/big-pickle".into(), ..req(schema()) })
                .await
                .unwrap();
            assert_eq!(r, AgentResult { output: json!({ "label": "ok" }), usage: usage(10, 3, Some(0.5)) });
            complete("opencode", &bin, AgentRequest { allow_tools: true, ..req(schema()) }).await.unwrap();
            let calls = b.calls();
            let off = &calls[0];
            assert_eq!(off.args[..3], ["run", "--format", "json"]);
            assert_eq!(after(&off.args, "--model"), Some("opencode/big-pickle"));
            assert!(!off.args.iter().any(|a| a == "--auto"));
            let permission: Value = serde_json::from_str(off.permission.as_deref().unwrap()).unwrap();
            assert_eq!(
                permission,
                json!({ "read": "deny", "edit": "deny", "glob": "deny", "grep": "deny", "list": "deny", "bash": "deny", "task": "deny", "webfetch": "deny", "websearch": "deny", "external_directory": "deny" })
            );
            let on = &calls[1];
            assert!(on.args.iter().any(|a| a == "--auto"));
            assert_eq!(on.permission, None);
        });
    }

    #[test]
    fn opencode_an_error_event_fails_the_call() {
        local(async {
            let b = sandbox();
            let out = lines(&[
                json!({ "type": "error", "error": { "name": "ProviderAuthError", "data": { "message": "no credentials" } } }),
            ]);
            let bin = b.fake("opencode", Fake { stdout: out, ..Default::default() });
            let e = complete("opencode", &bin, req(schema())).await.unwrap_err();
            assert_eq!(e.message, "opencode: no credentials");
            assert_eq!(e.usage, Some(usage(0, 0, Some(0.0))));
        });
    }

    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[test]
    fn an_aborted_call_kills_the_clis_whole_process_group_and_fails_at_once() {
        local(async {
            let b = sandbox();
            let bin = b.fake("codex", Fake { sleep: Some(30), ..Default::default() });
            let r = req(schema());
            let abort = r.abort.clone();
            tokio::task::spawn_local(async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
                abort.notify_one();
            });
            let started = Instant::now();
            let e = complete("codex", &bin, r).await.unwrap_err();
            assert_eq!(e.message, "Codex was stopped (with.timeout)");
            assert!(started.elapsed() < Duration::from_secs(5));
            let c = &b.calls()[0];
            assert!(!alive(c.pid));
            assert!(!c.cwd.exists());
        });
    }

    #[test]
    fn a_timeout_that_drops_the_call_still_kills_the_cli_and_removes_its_folder() {
        local(async {
            let b = sandbox();
            let bin = b.fake("pi", Fake { sleep: Some(30), ..Default::default() });
            let r = req(schema());
            let abort = r.abort.clone();
            let provider = CliProvider::new("pi", &bin).unwrap();
            // What the runner does: race the call against `with.timeout`, drop it, then notify the abort.
            assert!(tokio::time::timeout(Duration::from_millis(300), provider.complete(r)).await.is_err());
            abort.notify_one();
            let c = &b.calls()[0];
            let deadline = Instant::now() + Duration::from_secs(5);
            while (alive(c.pid) || c.cwd.exists()) && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            assert!(!alive(c.pid));
            assert!(!c.cwd.exists());
        });
    }

    #[tokio::test]
    async fn readiness_not_installed_says_so_and_how_to_fix_it() {
        let r = cli_readiness("codex", "/nonexistent/codex").await;
        assert!(!r.ready);
        assert_eq!(r.reason.as_deref(), Some("Codex isn't installed here (no '/nonexistent/codex' on PATH)"));
        let hint = r.hint.unwrap();
        assert!(hint.contains("npm install -g @openai/codex") && hint.contains("agents.codex.command"), "{hint}");
        let r = cli_readiness("claude_api", "x").await;
        assert_eq!(r.reason.as_deref(), Some("'claude_api' is not a CLI agent"));
    }

    #[tokio::test]
    async fn readiness_installed_but_not_logged_in_and_logged_in() {
        let b = sandbox();
        let out = b.fake(
            "codex-out",
            Fake { probes: vec![("--version", "codex-cli 0.1\n", 0), ("login status", "", 1)], ..Default::default() },
        );
        assert_eq!(
            cli_readiness("codex", &out).await,
            Readiness {
                ready: false,
                version: Some("codex-cli 0.1".into()),
                reason: Some("the Codex CLI is installed but not logged in".into()),
                hint: Some("run `codex login`, then try again".into()),
            }
        );
        let inn = b.fake(
            "codex-in",
            Fake {
                probes: vec![("--version", "codex-cli 0.1\n", 0), ("login status", "Logged in using ChatGPT\n", 0)],
                ..Default::default()
            },
        );
        assert_eq!(
            cli_readiness("codex", &inn).await,
            Readiness { ready: true, version: Some("codex-cli 0.1".into()), ..Default::default() }
        );
        let claude = b.fake(
            "claude",
            Fake {
                probes: vec![
                    ("--version", "2.1 (Claude Code)\n", 0),
                    ("auth status --json", r#"{"loggedIn":false}"#, 0),
                ],
                ..Default::default()
            },
        );
        let r = cli_readiness("claude_code", &claude).await;
        assert_eq!(r.reason.as_deref(), Some("Claude Code is installed but not logged in"));
        assert!(r.hint.unwrap().contains("claude auth login"));
        let ok = b.fake(
            "claude-ok",
            Fake {
                probes: vec![
                    ("--version", "2.1 (Claude Code)\n", 0),
                    ("auth status --json", r#"{"loggedIn":true}"#, 0),
                ],
                ..Default::default()
            },
        );
        assert!(cli_readiness("claude_code", &ok).await.ready);
        let broken =
            b.fake("broken", Fake { probes: vec![("--version", "", 2)], stderr: "x".into(), ..Default::default() });
        let r = cli_readiness("codex", &broken).await;
        assert_eq!(r.reason, Some(format!("Codex is installed but '{broken} --version' failed: exit 2")));
    }

    #[tokio::test]
    async fn pi_and_opencode_are_ready_when_they_list_a_model() {
        let b = sandbox();
        let table = "provider  model  context\nanthropic claude-haiku-4-5 200K\nopenai gpt-5.5 400K\n";
        let pi = b.fake(
            "pi",
            Fake { probes: vec![("--version", "1.0.0", 0), ("--list-models", table, 0)], ..Default::default() },
        );
        assert_eq!(cli_models("pi", &pi).await, vec!["anthropic/claude-haiku-4-5", "openai/gpt-5.5"]);
        assert!(cli_readiness("pi", &pi).await.ready);
        let none = b.fake(
            "pi-none",
            Fake { probes: vec![("--version", "1.0.0", 0), ("--list-models", "", 0)], ..Default::default() },
        );
        let r = cli_readiness("pi", &none).await;
        assert_eq!((r.ready, r.reason.as_deref()), (false, Some("pi has no model with credentials set up")));
        let oc = b.fake(
            "opencode",
            Fake {
                probes: vec![
                    ("--version", "1.18", 0),
                    ("models", "opencode/big-pickle\nnot a model\nanthropic/claude-x\n", 0),
                ],
                ..Default::default()
            },
        );
        assert_eq!(cli_models("opencode", &oc).await, vec!["opencode/big-pickle", "anthropic/claude-x"]);
        assert!(cli_readiness("opencode", &oc).await.ready);
        let codex = b.fake(
            "codex",
            Fake {
                probes: vec![(
                    "debug models",
                    r#"{"models":[{"slug":"gpt-5.5"},{"slug":"hidden","visibility":"hide"},{"slug":"gpt-5.5-mini","visibility":"list"}]}"#,
                    0,
                )],
                ..Default::default()
            },
        );
        assert_eq!(cli_models("codex", &codex).await, vec!["gpt-5.5", "gpt-5.5-mini"]);
        assert_eq!(cli_models("claude_code", "claude").await.len(), CLAUDE_MODELS.len());
    }

    #[test]
    fn extract_json_whole_text_a_fenced_block_or_the_outermost_braces() {
        assert_eq!(extract_json(r#"{"a":1}"#), Ok(json!({ "a": 1 })));
        assert_eq!(extract_json("Sure!\n```json\n{\"a\":2}\n```"), Ok(json!({ "a": 2 })));
        assert_eq!(extract_json("```JSON {\"a\":5}```"), Ok(json!({ "a": 5 })));
        assert_eq!(extract_json(r#"The answer is {"a":{"b":3}} as asked."#), Ok(json!({ "a": { "b": 3 } })));
        assert_eq!(extract_json("[1,2]"), Ok(json!([1, 2])));
        assert_eq!(extract_json("list: [1, 2] done"), Ok(json!([1, 2])));
        assert_eq!(extract_json("no json here"), Err("the answer is not JSON: no json here".into()));
        assert_eq!(extract_json("  "), Err("the answer is not JSON: (empty)".into()));
    }

    #[test]
    fn strict_schema_closes_nested_objects_keeps_arrays_and_unions_refuses_what_it_cant_say() {
        assert_eq!(
            strict_schema(&json!({
                "type": "object",
                "properties": {
                    "tags": { "type": "array", "items": { "type": "object", "properties": { "k": { "type": "string" } } } },
                    "kind": { "anyOf": [{ "type": "string" }, { "type": "integer" }] },
                },
                "required": ["tags"],
            })),
            Some(json!({
                "type": "object",
                "properties": {
                    "tags": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": { "k": { "anyOf": [{ "type": "string" }, { "type": "null" }] } },
                            "required": ["k"],
                            "additionalProperties": false,
                        },
                    },
                    "kind": { "anyOf": [{ "anyOf": [{ "type": "string" }, { "type": "integer" }] }, { "type": "null" }] },
                },
                "required": ["tags", "kind"],
                "additionalProperties": false,
            }))
        );
        assert_eq!(strict_schema(&json!({ "type": "object", "properties": { "x": {} } })), None);
        assert_eq!(
            strict_schema(
                &json!({ "type": "object", "properties": { "x": { "type": "string" } }, "additionalProperties": true })
            ),
            None
        );
        assert_eq!(strict_schema(&json!({ "type": "object" })), None);
        assert_eq!(strict_schema(&json!({ "anyOf": [{ "type": "string" }, {}] })), None);
        assert_eq!(
            strict_schema(&json!({ "$defs": { "n": { "type": "number" } }, "$ref": "#/$defs/n" })),
            Some(json!({ "$defs": { "n": { "type": "number" } }, "$ref": "#/$defs/n" }))
        );
        assert_eq!(strict_schema(&json!({ "$defs": { "n": {} }, "$ref": "#/$defs/n" })), None);
        assert_eq!(strict_schema(&json!(true)), Some(json!(true)));
    }

    #[test]
    fn drop_nulls_only_drops_optional_properties() {
        let s = json!({ "type": "object", "properties": { "a": { "type": "string" }, "b": { "type": "array", "items": { "type": "object", "properties": { "c": {} } } } }, "required": ["a"] });
        assert_eq!(
            drop_nulls(json!({ "a": null, "b": [{ "c": null, "d": null }], "x": null }), Some(&s)),
            json!({ "a": null, "b": [{ "d": null }], "x": null })
        );
    }

    #[test]
    fn arguments_per_cli() {
        let dir = Path::new("/tmp/call");
        let native = json!({ "type": "object" });
        let c = |model, allow_tools, native| Call { model, allow_tools, native, dir };
        assert_eq!(
            Cli::ClaudeCode.args(&c("opus", false, Some(&native))),
            [
                "-p",
                "--output-format",
                "json",
                "--json-schema",
                r#"{"type":"object"}"#,
                "--no-session-persistence",
                "--safe-mode",
                "--model",
                "opus",
                "--tools",
                ""
            ]
        );
        assert_eq!(
            Cli::ClaudeCode.args(&c("", true, None)),
            [
                "-p",
                "--output-format",
                "json",
                "--no-session-persistence",
                "--safe-mode",
                "--permission-mode",
                "bypassPermissions"
            ]
        );
        assert_eq!(
            Cli::Codex.args(&c("gpt-5.5", false, Some(&native))),
            [
                "exec",
                "--skip-git-repo-check",
                "--ephemeral",
                "--color",
                "never",
                "--json",
                "--output-schema",
                "/tmp/call/schema.json",
                "--output-last-message",
                "/tmp/call/last.txt",
                "--sandbox",
                "read-only",
                "--model",
                "gpt-5.5",
                "-",
            ]
        );
        assert_eq!(
            Cli::Codex.args(&c("", true, None)),
            [
                "exec",
                "--skip-git-repo-check",
                "--ephemeral",
                "--color",
                "never",
                "--json",
                "--output-last-message",
                "/tmp/call/last.txt",
                "--sandbox",
                "workspace-write",
                "-"
            ]
        );
        assert_eq!(
            Cli::Pi.args(&c("m", false, None)),
            [
                "-p",
                "--mode",
                "json",
                "--no-session",
                "--no-context-files",
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-themes",
                "--model",
                "m",
                "--no-tools"
            ]
        );
        assert_eq!(Cli::Opencode.args(&c("", true, None)), ["run", "--format", "json", "--auto"]);
        assert_eq!(Cli::Opencode.args(&c("p/m", false, None)), ["run", "--format", "json", "--model", "p/m"]);
        assert!(Cli::Opencode.env(&c("", true, None)).is_empty());
        assert!(Cli::Codex.env(&c("", false, None)).is_empty());
    }
}
