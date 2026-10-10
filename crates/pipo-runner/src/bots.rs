// Chat bot accounts (docs/spec.md §3.13, D69). Port of bots.ts (the runner's side). Interface for the runner; the
// bodies come with the connectors port.

use crate::pipeline::Pipeline;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::Path;

pub const TELEGRAM_API: &str = "https://api.telegram.org";

/// A bot ready to use: its token resolved.
#[derive(Debug, Clone, PartialEq)]
pub struct Bot {
    pub name: String,
    pub token: String,
    pub api: String,
    pub allow: Vec<i64>,
    pub poll_every: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Bots {
    pub telegram: HashMap<String, Bot>,
    pub default: Option<String>,
}

impl Bots {
    /// Every resolved token, to redact like a secret.
    pub fn tokens(&self) -> Vec<String> {
        self.telegram.values().map(|b| b.token.clone()).collect()
    }
}

/// Every telegram `with:` block of a pipeline (input, taps, output), with where it is.
pub fn telegram_uses(p: &Pipeline) -> Vec<(String, Map<String, Value>)> {
    let mut out = vec![];
    if p.input.via == "telegram" {
        out.push(("input".to_string(), p.input.with.clone().unwrap_or_default()));
    }
    for (id, n) in p.nodes.iter() {
        if n.tap.as_deref() == Some("telegram") {
            out.push((format!("nodes.{id}"), n.with.clone().unwrap_or_default()));
        }
    }
    if p.output.to == "telegram" {
        out.push(("output".to_string(), p.output.with.clone().unwrap_or_default()));
    }
    out
}

/// The bots a pipeline uses, tokens resolved.
pub async fn load_bots(_home: &Path, _p: &Pipeline) -> Result<Bots, String> {
    Err("telegram bots are not ported to the Rust runner yet".into())
}
