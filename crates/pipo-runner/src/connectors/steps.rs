// Taps and transforms (docs/spec.md §3.4, D16). Port of steps.ts: `tap: http | file | emit | telegram`,
// `transform: http` (exec is in exec.rs). A tap's side effect may run again after a crash before its step commits
// (at-least-once, §7.3): http sends `Idempotency-Key: <packet_id>:<node>`, file skips a repeat of the same
// packet+node, emit only returns events, which the runner commits in the step's own transition.

use super::file_out::FileOutput;
use super::http_out::http_call;
use super::telegram::telegram_send;
use super::{LocalBoxFuture, StepAdapter, StepInput, StepResult, WriteItem, string_of};
use crate::bots::Bots;
use crate::expr::to_text;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::rc::Rc;

fn key(i: &StepInput) -> String {
    format!("{}:{}", i.packet_id, i.node)
}

pub struct HttpTap;

impl StepAdapter for HttpTap {
    fn run(&self, i: StepInput) -> LocalBoxFuture<'_, Result<StepResult, String>> {
        Box::pin(async move {
            http_call(&i.with, &i.data, &key(&i), &format!("nodes.{}", i.node)).await?;
            Ok(StepResult::default())
        })
    }
}

pub struct HttpTransform;

impl StepAdapter for HttpTransform {
    fn run(&self, i: StepInput) -> LocalBoxFuture<'_, Result<StepResult, String>> {
        Box::pin(async move {
            let res = http_call(&i.with, &i.data, &key(&i), &format!("nodes.{}", i.node)).await?;
            if res.content_type.to_lowercase().contains("json") {
                return match serde_json::from_str::<Value>(&res.text) {
                    Ok(v) => Ok(StepResult { data: Some(v), events: vec![] }),
                    Err(_) => Err(format!(
                        "{} answered with content type {} but the body is not valid JSON",
                        i.with.get("url").map(to_text).unwrap_or_default(),
                        res.content_type
                    )),
                };
            }
            Ok(StepResult { data: Some(Value::String(res.text)), events: vec![] })
        })
    }
}

pub struct TelegramTap {
    pub bots: Option<Rc<Bots>>,
    pub dir: PathBuf,
}

impl StepAdapter for TelegramTap {
    fn run(&self, i: StepInput) -> LocalBoxFuture<'_, Result<StepResult, String>> {
        Box::pin(async move {
            let owner = format!("nodes.{}", i.node);
            telegram_send(self.bots.as_deref(), &self.dir, &i.with, &i.data, i.origin.as_ref(), &owner).await?;
            Ok(StepResult::default())
        })
    }
}

pub struct FileTap {
    file: FileOutput,
}

impl FileTap {
    pub fn new(dir: &Path) -> FileTap {
        FileTap { file: FileOutput::new(dir) }
    }
}

impl StepAdapter for FileTap {
    fn run(&self, i: StepInput) -> LocalBoxFuture<'_, Result<StepResult, String>> {
        Box::pin(async move {
            if !i.with.get("path").is_some_and(super::truthy) {
                return Err(format!("nodes.{}.with.path is empty after rendering; check the template", i.node));
            }
            let item = WriteItem { packet_id: key(&i), data: i.data, with: i.with, origin: None };
            self.file.write_now(std::slice::from_ref(&item))?;
            Ok(StepResult::default())
        })
    }

    fn close(&self) {
        super::OutputAdapter::close(&self.file);
    }
}

pub struct EmitTap;

impl StepAdapter for EmitTap {
    fn run(&self, i: StepInput) -> LocalBoxFuture<'_, Result<StepResult, String>> {
        Box::pin(async move {
            let kind = i.with.get("event").filter(|e| !e.is_null()).map(string_of).unwrap_or_default();
            if kind.is_empty() {
                return Err(format!("nodes.{}.with.event is empty after rendering; check the template", i.node));
            }
            Ok(StepResult { data: None, events: vec![(kind, i.with.get("detail").cloned())] })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::test_util::*;
    use serde_json::json;

    fn input(node: &str, w: Value) -> StepInput {
        StepInput { packet_id: "pk".into(), node: node.into(), data: json!({"a": 1}), with: w.as_object().cloned().unwrap(), origin: None }
    }

    #[test]
    fn tap_http_sends_an_idempotency_key_per_node() {
        local(async {
            let s = server(Rc::new(|_| Box::pin(async { Reply::json(200, &json!({"enriched": true})) }))).await;
            let r = HttpTap.run(input("n", json!({"url": format!("{}/x", s.base), "body": {"got": 1}}))).await.unwrap();
            assert_eq!(r, StepResult::default());
            let c = s.calls.borrow()[0].clone();
            assert_eq!(c.json(), json!({"got": 1}));
            assert_eq!(c.header("idempotency-key").as_deref(), Some("pk:n"));
        });
    }

    #[test]
    fn transform_http_replaces_data_with_the_response() {
        local(async {
            let s = server(Rc::new(|c: Call| {
                Box::pin(async move {
                    match c.path.as_str() {
                        "/json" => Reply::json(200, &json!({"enriched": true})),
                        "/bad" => Reply { status: 200, content_type: "application/json", body: b"nope".to_vec() },
                        _ => Reply::text(200, "plain"),
                    }
                })
            }))
            .await;
            let r = HttpTransform.run(input("n", json!({"url": format!("{}/json", s.base)}))).await.unwrap();
            assert_eq!(r.data, Some(json!({"enriched": true})));
            let r = HttpTransform.run(input("n", json!({"url": format!("{}/text", s.base)}))).await.unwrap();
            assert_eq!(r.data, Some(json!("plain")));
            let url = format!("{}/bad", s.base);
            let e = HttpTransform.run(input("n", json!({"url": url}))).await.unwrap_err();
            assert_eq!(e, format!("{url} answered with content type application/json but the body is not valid JSON"));
            let e = HttpTap.run(input("n", json!({"url": ""}))).await.unwrap_err();
            assert_eq!(e, "nodes.n.with.url is empty after rendering; check the template");
        });
    }

    #[test]
    fn a_failing_http_tap_errs_with_its_status() {
        local(async {
            let s = fixed(500, "nope").await;
            let e = HttpTap.run(input("n", json!({"url": format!("{}/x", s.base)}))).await.unwrap_err();
            assert!(e.contains("answered 500") && e.contains("set nodes.n.with.success"), "{e}");
        });
    }

    #[test]
    fn tap_file_writes_and_skips_a_repeat_of_the_same_packet_and_node() {
        local(async {
            let b = TempDir::new();
            let tap = FileTap::new(b.path());
            tap.run(input("n", json!({"path": "out/log.jsonl"}))).await.unwrap();
            FileTap::new(b.path()).run(input("n", json!({"path": "out/log.jsonl"}))).await.unwrap();
            tap.run(input("m", json!({"path": "out/log.jsonl"}))).await.unwrap();
            let text = std::fs::read_to_string(b.join("out/log.jsonl")).unwrap();
            assert_eq!(text, "{\"packet_id\":\"pk:n\",\"data\":{\"a\":1}}\n{\"packet_id\":\"pk:m\",\"data\":{\"a\":1}}\n");
            let e = tap.run(input("n", json!({"path": ""}))).await.unwrap_err();
            assert_eq!(e, "nodes.n.with.path is empty after rendering; check the template");
        });
    }

    #[test]
    fn tap_emit_returns_its_event() {
        local(async {
            let r = EmitTap.run(input("n", json!({"event": "enriched", "detail": {"v": 1}}))).await.unwrap();
            assert_eq!(r.events, vec![("enriched".to_string(), Some(json!({"v": 1})))]);
            assert_eq!(EmitTap.run(input("n", json!({"event": "x"}))).await.unwrap().events, vec![("x".to_string(), None)]);
            let e = EmitTap.run(input("n", json!({}))).await.unwrap_err();
            assert_eq!(e, "nodes.n.with.event is empty after rendering; check the template");
        });
    }
}
