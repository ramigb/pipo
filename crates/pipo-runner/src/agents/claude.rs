// `agent: claude_api` (docs/spec.md §3.4, D36): the Anthropic Messages API over HTTP, no SDK. Port of agents/claude.ts.
// Structured output comes from one forced tool call whose input schema is the node's schema. Tests point `base_url`
// at a local mock server; nothing in the test suite reaches the network.

use super::{AgentCallError, AgentProvider, AgentRequest, AgentResult, AgentUsage, num, present, tokens};
use crate::connectors::LocalBoxFuture;
use serde_json::{Value, json};

const TOOL: &str = "pipo_output";
const API_VERSION: &str = "2023-06-01";

pub struct ClaudeProvider {
    api_key: String,
    base_url: String,
    client: Option<reqwest::Client>,
}

impl ClaudeProvider {
    pub fn new(api_key: String, base_url: &str) -> ClaudeProvider {
        ClaudeProvider { api_key, base_url: base_url.to_string(), client: reqwest::Client::builder().build().ok() }
    }

    async fn call(&self, req: AgentRequest) -> Result<AgentResult, AgentCallError> {
        // Tool input must be an object: any other schema is wrapped as `{ value }` and unwrapped again.
        let mut schema = req.schema.as_object().cloned().unwrap_or_default();
        schema.shift_remove("$schema");
        schema.shift_remove("$id");
        let wrapped = schema.get("type").and_then(Value::as_str) != Some("object");
        let input_schema = if wrapped {
            json!({ "type": "object", "properties": { "value": Value::Object(schema) }, "required": ["value"] })
        } else {
            Value::Object(schema)
        };
        let body = json!({
            "model": req.model,
            "max_tokens": req.max_tokens,
            "messages": [{ "role": "user", "content": req.prompt }],
            "tools": [{ "name": TOOL, "description": "Return your answer. Its input must match the schema.", "input_schema": input_schema }],
            "tool_choice": { "type": "tool", "name": TOOL },
        });
        let client = self
            .client
            .as_ref()
            .ok_or_else(|| AgentCallError::new("Claude API: no HTTP client could be set up", None))?;
        let send = async {
            let res = client
                .post(format!("{}/v1/messages", self.base_url))
                .header("content-type", "application/json")
                .header("x-api-key", &self.api_key)
                .header("anthropic-version", API_VERSION)
                .body(crate::expr::js_json(&body))
                .send()
                .await?;
            let status = res.status();
            let text = res.text().await?;
            Ok::<_, reqwest::Error>((status, text))
        };
        let (status, text) = tokio::select! {
            r = send => r.map_err(|e| AgentCallError::new(format!("Claude API request failed: {}", chain(&e)), None))?,
            _ = req.abort.notified() => return Err(AgentCallError::new("Claude API call was stopped (with.timeout)", None)),
        };
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if !status.is_success() {
            let why = match present(body.get("error").and_then(|e| e.get("message"))) {
                Some(m) => super::js_string(m),
                None => {
                    let head: String = text.chars().take(200).collect();
                    if head.is_empty() { status.canonical_reason().unwrap_or("").to_string() } else { head }
                }
            };
            return Err(AgentCallError::new(format!("Claude API answered {}: {why}", status.as_u16()), None));
        }
        let u = body.get("usage").cloned().unwrap_or(Value::Null);
        let usage = AgentUsage {
            // Cache reads and writes are input tokens too; they are priced at the input rate (D36).
            input_tokens: tokens(
                num(u.get("input_tokens"))
                    + num(u.get("cache_creation_input_tokens"))
                    + num(u.get("cache_read_input_tokens")),
            ),
            output_tokens: tokens(num(u.get("output_tokens"))),
            cost_usd: None,
        };
        let block = body.get("content").and_then(Value::as_array).and_then(|c| {
            c.iter().find(|b| {
                b.get("type").and_then(Value::as_str) == Some("tool_use")
                    && b.get("name").and_then(Value::as_str) == Some(TOOL)
            })
        });
        let stop_reason = present(body.get("stop_reason")).map(super::js_string);
        let Some(block) = block.filter(|_| stop_reason.as_deref() != Some("max_tokens")) else {
            let cut = stop_reason.as_deref() == Some("max_tokens");
            return Err(AgentCallError::new(
                format!(
                    "Claude API returned no complete structured output (stop_reason: {}){}",
                    stop_reason.as_deref().unwrap_or("unknown"),
                    if cut { "; raise with.max_tokens" } else { "" }
                ),
                Some(usage),
            ));
        };
        let input = block.get("input").cloned().unwrap_or(Value::Null);
        let output = if wrapped { input.get("value").cloned().unwrap_or(Value::Null) } else { input };
        Ok(AgentResult { output, usage })
    }
}

impl AgentProvider for ClaudeProvider {
    fn complete(&self, req: AgentRequest) -> LocalBoxFuture<'_, Result<AgentResult, AgentCallError>> {
        Box::pin(self.call(req))
    }
}

/// An error and its causes, on one line.
fn chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut cur = e.source();
    while let Some(s) = cur {
        let text = s.to_string();
        if !out.contains(&text) {
            out.push_str(": ");
            out.push_str(&text);
        }
        cur = s.source();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::Notify;

    /// What the mock server saw: the request line, headers (lowercased names) and the body.
    #[derive(Default, Debug)]
    struct Seen {
        line: String,
        headers: Vec<(String, String)>,
        body: String,
    }

    impl Seen {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
        }
    }

    /// A local HTTP server answering every request with `status` and `body`, raw over TCP.
    async fn mock(status: u16, body: Value) -> (String, Rc<RefCell<Vec<Seen>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Rc::new(RefCell::new(vec![]));
        let log = seen.clone();
        tokio::task::spawn_local(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let mut buf = vec![];
                let mut chunk = [0u8; 4096];
                let (head_end, length) = loop {
                    let n = sock.read(&mut chunk).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..i]).to_lowercase();
                        let length = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                            .unwrap_or(0);
                        break (i + 4, length);
                    }
                };
                while buf.len() < head_end + length {
                    let n = sock.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                }
                let head = String::from_utf8_lossy(&buf[..head_end - 4]).to_string();
                let mut lines = head.split("\r\n");
                let line = lines.next().unwrap_or("").to_string();
                let headers = lines
                    .filter_map(|l| l.split_once(':'))
                    .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string()))
                    .collect();
                let body_text = String::from_utf8_lossy(&buf[head_end..head_end + length]).to_string();
                log.borrow_mut().push(Seen { line, headers, body: body_text });
                let payload = body.to_string();
                let reply = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                sock.write_all(reply.as_bytes()).await.unwrap();
                let _ = sock.shutdown().await;
            }
        });
        (url, seen)
    }

    fn req(schema: Value) -> AgentRequest {
        AgentRequest {
            model: "claude-sonnet-5-5".into(),
            prompt: "classify".into(),
            schema,
            max_tokens: 100,
            abort: Rc::new(Notify::new()),
            cwd: None,
            allow_tools: false,
        }
    }

    fn local<F: std::future::Future>(f: F) -> F::Output {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        tokio::task::LocalSet::new().block_on(&rt, f)
    }

    #[test]
    fn forces_one_tool_call_with_the_nodes_schema_and_reads_its_input_and_usage() {
        local(async {
            let (url, seen) = mock(
                200,
                json!({
                    "content": [{ "type": "tool_use", "name": "pipo_output", "input": { "label": "urgent" } }],
                    "stop_reason": "tool_use",
                    "usage": { "input_tokens": 120, "output_tokens": 30, "cache_read_input_tokens": 5 },
                }),
            )
            .await;
            let p = ClaudeProvider::new("test-key-not-real".into(), &url);
            let out = p
                .complete(req(
                    json!({ "$schema": "x", "type": "object", "properties": { "label": { "type": "string" } } }),
                ))
                .await
                .unwrap();
            assert_eq!(
                out,
                AgentResult {
                    output: json!({ "label": "urgent" }),
                    usage: AgentUsage { input_tokens: 125, output_tokens: 30, cost_usd: None }
                }
            );
            let seen = seen.borrow();
            assert_eq!(seen[0].line, "POST /v1/messages HTTP/1.1");
            assert_eq!(seen[0].header("x-api-key"), Some("test-key-not-real"));
            assert_eq!(seen[0].header("anthropic-version"), Some("2023-06-01"));
            assert_eq!(seen[0].header("content-type"), Some("application/json"));
            let body: Value = serde_json::from_str(&seen[0].body).unwrap();
            assert_eq!(body["model"], json!("claude-sonnet-5-5"));
            assert_eq!(body["max_tokens"], json!(100));
            assert_eq!(body["messages"], json!([{ "role": "user", "content": "classify" }]));
            assert_eq!(body["tool_choice"], json!({ "type": "tool", "name": "pipo_output" }));
            assert_eq!(
                body["tools"][0]["input_schema"],
                json!({ "type": "object", "properties": { "label": { "type": "string" } } })
            );
        });
    }

    #[test]
    fn a_non_object_schema_is_wrapped_as_value_and_unwrapped() {
        local(async {
            let (url, seen) = mock(
                200,
                json!({ "content": [{ "type": "tool_use", "name": "pipo_output", "input": { "value": "spam" } }], "usage": { "input_tokens": 1, "output_tokens": 1 } }),
            )
            .await;
            let p = ClaudeProvider::new("k".into(), &url);
            assert_eq!(p.complete(req(json!({ "type": "string" }))).await.unwrap().output, json!("spam"));
            let body: Value = serde_json::from_str(&seen.borrow()[0].body).unwrap();
            assert_eq!(body["tools"][0]["input_schema"]["required"], json!(["value"]));
            assert_eq!(body["tools"][0]["input_schema"]["properties"]["value"], json!({ "type": "string" }));
        });
    }

    #[test]
    fn api_errors_and_cut_off_answers_are_errors_and_a_cut_off_still_reports_its_tokens() {
        local(async {
            let (url, _) = mock(529, json!({ "error": { "message": "Overloaded" } })).await;
            let e = ClaudeProvider::new("k".into(), &url).complete(req(json!({ "type": "object" }))).await.unwrap_err();
            assert_eq!(e, AgentCallError::new("Claude API answered 529: Overloaded", None));

            let (url, _) = mock(500, json!("plain")).await;
            let e = ClaudeProvider::new("k".into(), &url).complete(req(json!({ "type": "object" }))).await.unwrap_err();
            assert_eq!(e.message, "Claude API answered 500: \"plain\"");

            let (url, _) =
                mock(200, json!({ "content": [], "stop_reason": "max_tokens", "usage": { "input_tokens": 9, "output_tokens": 100 } })).await;
            let e = ClaudeProvider::new("k".into(), &url).complete(req(json!({ "type": "object" }))).await.unwrap_err();
            assert_eq!(
                e.message,
                "Claude API returned no complete structured output (stop_reason: max_tokens); raise with.max_tokens"
            );
            assert_eq!(e.usage, Some(AgentUsage { input_tokens: 9, output_tokens: 100, cost_usd: None }));

            let (url, _) = mock(200, json!({ "content": [{ "type": "text", "text": "hi" }] })).await;
            let e = ClaudeProvider::new("k".into(), &url).complete(req(json!({ "type": "object" }))).await.unwrap_err();
            assert_eq!(e.message, "Claude API returned no complete structured output (stop_reason: unknown)");
            assert_eq!(e.usage, Some(AgentUsage { input_tokens: 0, output_tokens: 0, cost_usd: None }));
        });
    }

    #[test]
    fn an_unreachable_api_and_an_abort_are_errors() {
        local(async {
            // Nothing listens on the port a dropped listener had.
            let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
            let e = ClaudeProvider::new("k".into(), &format!("http://127.0.0.1:{port}"))
                .complete(req(json!({ "type": "object" })))
                .await
                .unwrap_err();
            assert!(e.message.starts_with("Claude API request failed: "), "{}", e.message);

            // A server that never answers: the abort ends the call.
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let r = req(json!({ "type": "object" }));
            let abort = r.abort.clone();
            tokio::task::spawn_local(async move {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                abort.notify_one();
            });
            let p = ClaudeProvider::new("k".into(), &url);
            let e = p.complete(r).await.unwrap_err();
            assert_eq!(e.message, "Claude API call was stopped (with.timeout)");
            drop(listener);
        });
    }
}
