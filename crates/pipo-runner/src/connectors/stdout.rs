// `to: stdout` (docs/spec.md §3.5). Port of stdout-output.ts. Supports only the universal delivery checks.

use super::{LocalBoxFuture, OutputAdapter, WriteItem};
use crate::expr::{js_json, to_text};
use serde_json::{Map, Value, json};

pub struct StdoutOutput {
    pub print: Option<super::Print>,
}

impl StdoutOutput {
    fn print(&self, line: &str) {
        match &self.print {
            Some(p) => p(line),
            None => println!("{line}"),
        }
    }
}

impl OutputAdapter for StdoutOutput {
    fn write(&self, items: Vec<WriteItem>) -> LocalBoxFuture<'_, Result<Vec<Value>, String>> {
        Box::pin(async move {
            let mut out = vec![];
            for item in items {
                let format = item.with.get("format").and_then(|f| f.as_str()).unwrap_or("jsonl");
                let record = json!({ "packet_id": item.packet_id, "data": item.data });
                match format {
                    "text" => self.print(&to_text(&item.data)),
                    // JSON.stringify(v, null, 2): serde's pretty printer uses the same two-space layout.
                    "json" => self.print(&serde_json::to_string_pretty(&record).unwrap_or_default()),
                    _ => self.print(&js_json(&record)),
                }
                out.push(Value::Null);
            }
            Ok(out)
        })
    }

    fn verify<'a>(
        &'a self,
        check: &'a str,
        _: &'a Map<String, Value>,
        _: &'a WriteItem,
        _: &'a Value,
    ) -> LocalBoxFuture<'a, Result<bool, String>> {
        Box::pin(async move { Err(format!("stdout does not support delivery check '{check}'")) })
    }
}
