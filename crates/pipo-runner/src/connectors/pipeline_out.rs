// `to: pipeline` (docs/spec.md §3.14, D77): each packet is handed to another pipeline of the same home through its
// control socket (`deliver`), which journals it, deduplicated on (sender, key), before answering. The `downstream`
// delivery check reads the receiver's packet (`packet`) until it settles.

use super::{LocalBoxFuture, OutputAdapter, WriteItem, string_of};
use crate::liveness::entry_alive_json;
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

/// How long one call to the receiver may take; a timeout is a retryable write error (the retry is deduplicated).
const TIMEOUT: Duration = Duration::from_secs(10);

pub struct PipelineOutput {
    /// This pipeline's name: the receiver checks it against its input's `from` list.
    pub sender: String,
    pub home: PathBuf,
    /// `downstream` errors that end the check at once (the receiver settled the packet some other way).
    finals: RefCell<HashSet<String>>,
}

impl PipelineOutput {
    pub fn new(sender: String, home: PathBuf) -> PipelineOutput {
        PipelineOutput { sender, home, finals: RefCell::default() }
    }

    fn not_running(&self, target: &str) -> String {
        format!("pipeline '{target}' is not running (downstream_unavailable); start it with: pipo start {target}")
    }

    /// One op on the receiver's control socket, found through its registry entry. Err is `(code, message)`.
    async fn call(&self, target: &str, op: &str, args: Value) -> Result<Value, (String, String)> {
        let entry = std::fs::read_to_string(self.home.join("run").join(format!("{target}.json")))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .filter(entry_alive_json)
            .ok_or_else(|| ("unavailable".to_string(), self.not_running(target)))?;
        let socket = entry
            .get("socket")
            .and_then(|s| s.as_str())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.home.join("run").join(format!("{target}.sock")));
        let talk = async {
            let mut stream = UnixStream::connect(&socket).await.map_err(|_| self.not_running(target))?;
            let line = format!("{}\n", json!({ "id": 1, "op": op, "args": args }));
            stream.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
            let mut reply = String::new();
            BufReader::new(stream).read_line(&mut reply).await.map_err(|e| e.to_string())?;
            serde_json::from_str::<Value>(&reply).map_err(|_| format!("pipeline '{target}' gave no answer"))
        };
        let reply = match tokio::time::timeout(TIMEOUT, talk).await {
            Ok(Ok(r)) => r,
            Ok(Err(m)) => return Err(("unavailable".into(), m)),
            Err(_) => {
                return Err((
                    "unavailable".into(),
                    format!("pipeline '{target}' didn't answer within 10s (downstream_unavailable)"),
                ));
            }
        };
        if reply.get("ok").and_then(|o| o.as_bool()) == Some(true) {
            return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
        }
        let e = reply.get("error").cloned().unwrap_or(Value::Null);
        let text = |k: &str| e.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let hint = text("hint");
        let message = if hint.is_empty() { text("message") } else { format!("{}; {hint}", text("message")) };
        Err((text("code"), message))
    }

    async fn deliver(&self, item: WriteItem) -> Result<Value, String> {
        let target = item.with.get("pipeline").map(string_of).unwrap_or_default();
        if target.is_empty() {
            return Err("output.with.pipeline is empty after rendering".into());
        }
        let data = item.with.get("data").cloned().unwrap_or(item.data);
        let root = item.packet_id.split(':').next().unwrap_or(&item.packet_id).to_string();
        let args = json!({
            "from": self.sender,
            "key": item.packet_id,
            "data": data,
            "upstream": { "packet_id": root, "depth": item.chain_depth + 1 },
        });
        let answer = self.call(&target, "deliver", args).await;
        // Test-only: the receiver has the packet, the sender hasn't committed its write (D49 crash points).
        crate::crashpoint::crash_point("pipeline.delivered");
        match answer {
            Ok(r) => Ok(json!({
                "pipeline": target,
                "packet_id": r.get("packet_id").cloned().unwrap_or(Value::Null),
                "duplicate": r.get("duplicate").and_then(|d| d.as_bool()).unwrap_or(false),
            })),
            Err((code, message)) if code == "rejected" => {
                Err(format!("pipeline '{target}' rejected the packet (downstream_rejected): {message}"))
            }
            Err((code, message)) if code == "unavailable" => Err(if message.contains("downstream_unavailable") {
                message
            } else {
                format!("pipeline '{target}' can't take packets now (downstream_unavailable): {message}")
            }),
            Err((_, message)) => Err(format!("pipeline '{target}': {message}")),
        }
    }
}

impl OutputAdapter for PipelineOutput {
    fn write(&self, items: Vec<WriteItem>) -> LocalBoxFuture<'_, Result<Vec<Value>, String>> {
        Box::pin(async move {
            let mut out = vec![];
            for item in items {
                out.push(self.deliver(item).await?);
            }
            Ok(out)
        })
    }

    fn verify<'a>(
        &'a self,
        check: &'a str,
        _: &'a Map<String, Value>,
        _: &'a WriteItem,
        result: &'a Value,
    ) -> LocalBoxFuture<'a, Result<bool, String>> {
        Box::pin(async move {
            if check != "downstream" {
                return Err(format!("pipeline output does not support delivery check '{check}'"));
            }
            let target = result.get("pipeline").and_then(|p| p.as_str()).unwrap_or_default().to_string();
            let id = result.get("packet_id").and_then(|p| p.as_str()).unwrap_or_default().to_string();
            let settled = |e: String| {
                self.finals.borrow_mut().insert(e.clone());
                Err(e)
            };
            match self.call(&target, "packet", json!({ "packet_id": id })).await {
                Ok(trace) => {
                    let p = trace.get("packet").cloned().unwrap_or(Value::Null);
                    let state = p.get("state").and_then(|s| s.as_str()).unwrap_or("gone").to_string();
                    let why = p.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str());
                    let why = why.map(|m| format!(": {m}")).unwrap_or_default();
                    match state.as_str() {
                        "delivered" => Ok(true),
                        "dead_lettered" | "filtered" | "rejected" | "gone" => {
                            settled(format!("pipeline '{target}' ended packet {id} as {state}{why}"))
                        }
                        _ => Ok(false),
                    }
                }
                Err((code, _)) if code == "not_found" => {
                    settled(format!("pipeline '{target}' no longer has packet {id}"))
                }
                Err((_, message)) => Err(message),
            }
        })
    }

    fn is_final(&self, error: &str) -> bool {
        self.finals.borrow_mut().remove(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(with: Value) -> WriteItem {
        WriteItem {
            packet_id: "01P:a".into(),
            data: json!({"n": 1}),
            with: with.as_object().cloned().unwrap(),
            origin: None,
            chain_depth: 0,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_receiver_that_is_not_running_is_unavailable() {
        let home = std::env::temp_dir().join(format!("pipo-pout-{}", std::process::id()));
        let out = PipelineOutput::new("a".into(), home.clone());
        let e = out.write(vec![item(json!({"pipeline": "b"}))]).await.unwrap_err();
        assert!(e.contains("pipeline 'b' is not running (downstream_unavailable)"), "{e}");
        assert!(e.contains("pipo start b"), "{e}");
        let e = out.write(vec![item(json!({"pipeline": ""}))]).await.unwrap_err();
        assert!(e.contains("empty"), "{e}");
        let r =
            out.verify("downstream", &Map::new(), &item(json!({})), &json!({"pipeline": "b", "packet_id": "x"})).await;
        let e = r.unwrap_err();
        assert!(!out.is_final(&e), "an unreachable receiver is re-checked until within");
    }
}
