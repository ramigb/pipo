// `via: http` (docs/spec.md §3.3, D17, D30). Port of http-input.ts. Served at /in/<pipeline><path> on the runner's
// own port (hyper, one local task per connection). Formats json, text, form, csv (one packet per record) and bytes;
// header-token and HMAC auth; `respond: delivered` waits for the packet to settle, up to `timeout`.

use super::{
    AwaitTerminal, ConnectorContext, ConnectorError, InputAdapter, InputRuntime, Intake, IntakeResult, LocalBoxFuture,
    Origin, Stopper, string_of,
};
use crate::duration::parse_duration;
use base64::Engine;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::{Request, Response};
use serde_json::{Map, Value, json};
use std::cell::{Cell, RefCell};
use std::net::SocketAddr;
use std::rc::Rc;
use std::time::Duration;
use tokio::task::JoinHandle;

/// Idle keep-alive connections are closed after this long without a new request (Bun's default in the TS runner).
const IDLE: Duration = Duration::from_secs(10);
/// Bun's default body limit.
const MAX_BODY: usize = 128 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Hmac {
    pub header: String,
    pub secret: String,
    /// `sha256` or `sha1`.
    pub algorithm: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HttpOptions {
    pub pipeline: String,
    pub path: String,
    pub method: String,
    pub port: u16,
    pub hostname: String,
    pub format: String,
    /// The header that must hold the token, and the token.
    pub auth: Option<(String, String)>,
    pub hmac: Option<Hmac>,
    pub respond: Option<String>,
    /// How long `respond: delivered` waits for a terminal state.
    pub timeout_ms: u64,
    /// How long an idle keep-alive connection is kept; tests lower it.
    pub idle: Duration,
}

struct BadBody {
    message: String,
    hint: String,
}

fn bad(message: impl Into<String>, hint: impl Into<String>) -> BadBody {
    BadBody { message: message.into(), hint: hint.into() }
}

/// RFC 4180 records: quoted fields, doubled quotes, newlines inside quotes.
fn parse_csv(text: &str) -> Result<Vec<Vec<String>>, BadBody> {
    let mut rows: Vec<Vec<String>> = vec![];
    let mut row: Vec<String> = vec![];
    let mut field = String::new();
    let (mut quoted, mut started) = (false, false);
    let mut end_row = |row: &mut Vec<String>, field: &mut String, started: &mut bool| {
        row.push(std::mem::take(field));
        if row.len() > 1 || !row[0].is_empty() {
            rows.push(std::mem::take(row));
        } else {
            row.clear();
        }
        *started = false;
    };
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if quoted {
            if c == '"' && chars.get(i + 1) == Some(&'"') {
                field.push('"');
                i += 1;
            } else if c == '"' {
                quoted = false;
            } else {
                field.push(c);
            }
        } else if c == '"' && !started {
            quoted = true;
            started = true;
        } else if c == '"' {
            return Err(bad("stray quote in csv field", "quote the whole field and double any inner quotes"));
        } else if c == ',' {
            row.push(std::mem::take(&mut field));
            started = false;
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.get(i + 1) == Some(&'\n') {
                i += 1;
            }
            end_row(&mut row, &mut field, &mut started);
        } else {
            field.push(c);
            started = true;
        }
        i += 1;
    }
    if quoted {
        return Err(bad("csv has an unterminated quote", "close every quoted field"));
    }
    if !field.is_empty() || !row.is_empty() {
        end_row(&mut row, &mut field, &mut started);
    }
    Ok(rows)
}

fn csv_records(text: &str) -> Result<Vec<Value>, BadBody> {
    let rows = parse_csv(text.strip_prefix('\u{feff}').unwrap_or(text))?;
    if rows.len() < 2 {
        return Err(bad(
            "csv needs a header row and at least one record",
            "send the header line first, then one line per record",
        ));
    }
    let header = &rows[0];
    let unique: std::collections::HashSet<&String> = header.iter().collect();
    if unique.len() != header.len() || header.iter().any(|h| h.is_empty()) {
        return Err(bad("csv header has empty or repeated column names", "give every column a unique name"));
    }
    rows[1..]
        .iter()
        .enumerate()
        .map(|(i, r)| {
            if r.len() != header.len() {
                return Err(bad(
                    format!("csv record {} has {} field(s), the header has {}", i + 1, r.len(), header.len()),
                    "every record needs one value per header column",
                ));
            }
            Ok(Value::Object(header.iter().cloned().zip(r.iter().map(|v| Value::String(v.clone()))).collect()))
        })
        .collect()
}

/// One part of a multipart/form-data body.
#[derive(Debug, Clone, PartialEq)]
pub struct Part {
    pub name: String,
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub data: Vec<u8>,
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from > hay.len() {
        return None;
    }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|p| p + from)
}

/// A parameter of a header value, e.g. `boundary` of a content type or `name` of a content disposition.
fn header_param(value: &str, key: &str) -> Option<String> {
    value.split(';').skip(1).find_map(|p| {
        let (k, v) = p.split_once('=')?;
        if !k.trim().eq_ignore_ascii_case(key) {
            return None;
        }
        let v = v.trim();
        Some(v.strip_prefix('"').and_then(|v| v.strip_suffix('"')).unwrap_or(v).to_string())
    })
}

pub fn parse_multipart(body: &[u8], content_type: &str) -> Result<Vec<Part>, String> {
    let boundary = header_param(content_type, "boundary").filter(|b| !b.is_empty()).ok_or("no boundary")?;
    let delim = format!("--{boundary}").into_bytes();
    let mut at = find(body, &delim, 0).ok_or("no first boundary")? + delim.len();
    let mut parts = vec![];
    loop {
        if body[at..].starts_with(b"--") {
            return Ok(parts);
        }
        at = find(body, b"\r\n", at).ok_or("bad boundary line")? + 2;
        let head_end = find(body, b"\r\n\r\n", at).ok_or("no part headers")?;
        let head = String::from_utf8_lossy(&body[at..head_end]).into_owned();
        let mut end_delim = b"\r\n".to_vec();
        end_delim.extend_from_slice(&delim);
        let data_end = find(body, &end_delim, head_end + 4).ok_or("unterminated part")?;
        let (mut name, mut filename, mut ctype) = (None, None, None);
        for line in head.split("\r\n") {
            let Some((k, v)) = line.split_once(':') else { continue };
            if k.trim().eq_ignore_ascii_case("content-disposition") {
                name = header_param(v, "name");
                filename = header_param(v, "filename");
            } else if k.trim().eq_ignore_ascii_case("content-type") {
                ctype = Some(v.trim().to_string());
            }
        }
        parts.push(Part {
            name: name.ok_or("part without a name")?,
            filename,
            content_type: ctype,
            data: body[head_end + 4..data_end].to_vec(),
        });
        at = data_end + end_delim.len();
    }
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Same length and same bytes, compared in constant time.
fn same_secret(given: &[u8], expected: &[u8]) -> bool {
    given.len() == expected.len() && given.iter().zip(expected).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

fn hmac_hex(algorithm: &str, secret: &str, body: &[u8]) -> String {
    use hmac::{KeyInit, Mac};
    if algorithm == "sha1" {
        let mut m = hmac::Hmac::<sha1::Sha1>::new_from_slice(secret.as_bytes()).expect("any key length");
        m.update(body);
        hex::encode(m.finalize().into_bytes())
    } else {
        let mut m = hmac::Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).expect("any key length");
        m.update(body);
        hex::encode(m.finalize().into_bytes())
    }
}

type Reply = Response<Full<Bytes>>;

fn reply(status: u16, body: &Value, headers: &[(&str, &str)]) -> Reply {
    let mut r = Response::builder().status(status).header("content-type", "application/json;charset=utf-8");
    for (k, v) in headers {
        r = r.header(*k, *v);
    }
    r.body(Full::new(Bytes::from(crate::expr::js_json(body)))).expect("valid response")
}

struct Inner {
    opts: HttpOptions,
    route: String,
    bound: Cell<Option<u16>>,
    stop: Stopper,
    conns: RefCell<Vec<JoinHandle<()>>>,
    intake: RefCell<Option<Intake>>,
    await_terminal: RefCell<Option<AwaitTerminal>>,
    /// The pipeline's other http inputs, served on this one's listener (D76).
    siblings: RefCell<Vec<Rc<Inner>>>,
    /// For a sibling: the input whose listener serves it.
    host: RefCell<Option<std::rc::Weak<Inner>>>,
}

pub struct HttpInput {
    inner: Rc<Inner>,
    accept: RefCell<Option<JoinHandle<()>>>,
}

impl HttpInput {
    pub fn new(opts: HttpOptions) -> HttpInput {
        let route = format!("/in/{}{}", opts.pipeline, if opts.path == "/" { "" } else { opts.path.as_str() });
        let inner = Inner {
            opts,
            route,
            bound: Cell::new(None),
            stop: Stopper::default(),
            conns: RefCell::default(),
            intake: RefCell::new(None),
            await_terminal: RefCell::new(None),
            siblings: RefCell::default(),
            host: RefCell::new(None),
        };
        HttpInput { inner: Rc::new(inner), accept: RefCell::new(None) }
    }

    /// Serve `other` on this input's listener: requests are matched to an input on path, then method (D76).
    pub fn add_sibling(&self, other: &HttpInput) {
        *other.inner.host.borrow_mut() = Some(Rc::downgrade(&self.inner));
        self.inner.siblings.borrow_mut().push(other.inner.clone());
    }

    fn host(&self) -> Option<Rc<Inner>> {
        self.inner.host.borrow().as_ref().and_then(|h| h.upgrade())
    }

    pub fn from_context(ctx: &ConnectorContext) -> Result<HttpInput, ConnectorError> {
        let w = &ctx.with;
        let port = match ctx.listen.or_else(|| w.get("listen").and_then(|l| l.as_u64()).map(|p| p as u16)) {
            Some(p) => p,
            None => {
                return Err(ConnectorError(
                    "http input needs a port: set input.with.listen or pass --listen, or start it through the engine with engine.listen set (its gateway then serves /in/<pipeline>/… and gives the runner a free loopback port)".into(),
                ));
            }
        };
        let auth = w.get("auth").and_then(|a| a.as_object());
        let timeout = w.get("timeout").filter(|t| !t.is_null()).map(string_of).unwrap_or_else(|| "30s".into());
        let timeout_ms = parse_duration(&timeout).map_err(|e| ConnectorError(format!("http input: {e}")))?;
        Ok(HttpInput::new(HttpOptions {
            pipeline: ctx.pipeline.name.clone(),
            path: w.get("path").and_then(|p| p.as_str()).unwrap_or("/").to_string(),
            method: w.get("method").and_then(|p| p.as_str()).unwrap_or("POST").to_string(),
            port,
            hostname: ctx.hostname.clone().unwrap_or_else(|| "127.0.0.1".into()),
            format: ctx.input.as_ref().and_then(|(_, i)| i.format.clone()).unwrap_or_else(|| "json".into()),
            auth: auth.and_then(|a| a.get("header")).filter(|h| super::truthy(h)).map(|h| {
                let equals =
                    auth.and_then(|a| a.get("equals")).filter(|e| !e.is_null()).map(string_of).unwrap_or_default();
                (string_of(h), equals)
            }),
            hmac: auth.and_then(|a| a.get("hmac")).and_then(|h| h.as_object()).map(|h| Hmac {
                header: h.get("header").map(string_of).unwrap_or_default(),
                secret: h.get("secret").map(string_of).unwrap_or_default(),
                algorithm: h.get("algorithm").and_then(|a| a.as_str()).unwrap_or("sha256").to_string(),
            }),
            respond: w.get("respond").and_then(|r| r.as_str()).map(str::to_owned),
            timeout_ms,
            idle: IDLE,
        }))
    }
}

impl Inner {
    fn signed(&self, header: Option<&[u8]>, body: &[u8]) -> bool {
        let (Some(h), Some(header)) = (&self.opts.hmac, header) else { return false };
        let text = String::from_utf8_lossy(header);
        let text = text.trim();
        let lower = text.to_lowercase();
        let given =
            ["sha256=", "sha1="].iter().find(|p| lower.starts_with(**p)).map(|p| &lower[p.len()..]).unwrap_or(&lower);
        same_secret(given.as_bytes(), hmac_hex(&h.algorithm, &h.secret, body).as_bytes())
    }

    fn parse(&self, content_type: Option<&str>, raw: &[u8]) -> Result<Vec<Value>, Option<BadBody>> {
        let text = || String::from_utf8_lossy(raw).into_owned();
        match self.opts.format.as_str() {
            "text" => Ok(vec![Value::String(text())]),
            "csv" => csv_records(&text()).map_err(Some),
            "bytes" => Ok(vec![json!({
                "base64": b64(raw),
                "content_type": content_type.unwrap_or("application/octet-stream"),
                "size": raw.len(),
            })]),
            "form" => {
                let ct = content_type.unwrap_or("");
                let essence = ct.split(';').next().unwrap_or("").trim().to_lowercase();
                let mut out = Map::new();
                if essence == "application/x-www-form-urlencoded" {
                    for (k, v) in form_urlencoded::parse(raw) {
                        out.insert(k.into_owned(), Value::String(v.into_owned()));
                    }
                } else if essence == "multipart/form-data" {
                    for p in parse_multipart(raw, ct).map_err(|_| None)? {
                        let v = match &p.filename {
                            None => Value::String(String::from_utf8_lossy(&p.data).into_owned()),
                            Some(f) => json!({
                                "filename": f,
                                "content_type": p.content_type.as_deref().unwrap_or("application/octet-stream"),
                                "size": p.data.len(),
                                "base64": b64(&p.data),
                            }),
                        };
                        out.insert(p.name, v);
                    }
                } else {
                    return Err(None);
                }
                Ok(vec![Value::Object(out)])
            }
            _ => serde_json::from_str::<Value>(&text()).map(|v| vec![v]).map_err(|_| None),
        }
    }

    /// Route a request to this input or a sibling: by path, then by method.
    async fn handle(self: Rc<Self>, req: Request<Incoming>, peer: SocketAddr) -> Reply {
        let raw_path = req.uri().path();
        let trimmed = raw_path.trim_end_matches('/');
        let path = if trimmed.is_empty() { "/" } else { trimmed };
        let all: Vec<Rc<Inner>> = std::iter::once(self.clone()).chain(self.siblings.borrow().iter().cloned()).collect();
        let here: Vec<&Rc<Inner>> = all.iter().filter(|i| i.route == path).collect();
        if here.is_empty() {
            let mut body = json!({ "error": format!("no input at {path}") });
            if all.len() > 1 {
                let routes: Vec<String> = all.iter().map(|i| format!("{} {}", i.opts.method, i.route)).collect();
                body["hint"] = json!(format!("inputs here: {}", routes.join(", ")));
            }
            return reply(404, &body, &[]);
        }
        let method = req.method().as_str();
        let Some(input) = here.iter().find(|i| i.opts.method == method).map(|i| (*i).clone()) else {
            let allow = here.iter().map(|i| i.opts.method.clone()).collect::<Vec<_>>().join(", ");
            return reply(405, &json!({ "error": format!("use {allow}") }), &[("Allow", &allow)]);
        };
        input.handle_here(req, peer).await
    }

    async fn handle_here(self: Rc<Self>, req: Request<Incoming>, peer: SocketAddr) -> Reply {
        let o = &self.opts;
        if let Some((header, equals)) = &o.auth {
            let given = req.headers().get(header.as_str()).map(|v| v.as_bytes()).unwrap_or(b"");
            if !same_secret(given, equals.as_bytes()) {
                return reply(
                    401,
                    &json!({ "error": "unauthorized", "hint": format!("send the token in the {header} header") }),
                    &[],
                );
            }
        }
        let content_type =
            req.headers().get("content-type").map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned());
        let signature =
            o.hmac.as_ref().and_then(|h| req.headers().get(h.header.as_str())).map(|v| v.as_bytes().to_vec());
        let raw = match Limited::new(req.into_body(), MAX_BODY).collect().await {
            Ok(b) => b.to_bytes(),
            Err(e) if e.is::<http_body_util::LengthLimitError>() => {
                return reply(413, &json!({ "error": "body is over 128 MB", "hint": "send a smaller body" }), &[]);
            }
            Err(_) => {
                return reply(400, &json!({ "error": "could not read the body", "hint": "send the whole body" }), &[]);
            }
        };
        if let Some(h) = &o.hmac
            && !self.signed(signature.as_deref(), &raw)
        {
            let hint = format!("send the hex {} HMAC of the raw body in the {} header", h.algorithm, h.header);
            return reply(401, &json!({ "error": "invalid or missing signature", "hint": hint }), &[]);
        }
        let payloads = match self.parse(content_type.as_deref(), &raw) {
            Ok(p) => p,
            Err(Some(b)) => return reply(400, &json!({ "error": b.message, "hint": b.hint }), &[]),
            Err(None) => {
                let f = &o.format;
                return reply(
                    400,
                    &json!({ "error": format!("body is not valid {f}"), "hint": format!("send a {f} body") }),
                    &[],
                );
            }
        };
        let Some(intake) = self.intake.borrow().clone() else {
            return reply(503, &json!({ "error": "pipeline is not running" }), &[("Retry-After", "5")]);
        };
        let source = peer.ip().to_string();
        let mut results = vec![];
        for payload in payloads {
            let r = intake(payload, Origin { trigger: "http".into(), source: source.clone() }, None).await;
            let stop = matches!(r, IntakeResult::Unavailable { .. });
            results.push(r);
            if stop {
                break;
            }
        }
        self.answer(results, o.format == "csv").await
    }

    async fn answer(&self, results: Vec<IntakeResult>, many: bool) -> Reply {
        let unavailable = results.iter().find_map(|r| match r {
            IntakeResult::Unavailable { reason } => Some(reason.clone()),
            _ => None,
        });
        let accepted = results.iter().filter(|r| matches!(r, IntakeResult::Accepted { .. })).count();
        if let (Some(reason), 0) = (&unavailable, accepted) {
            return reply(503, &json!({ "error": reason }), &[("Retry-After", "5")]);
        }
        let rejected = results.iter().find_map(|r| match r {
            IntakeResult::Rejected { respond, .. } => Some(respond.unwrap_or(422)),
            _ => None,
        });
        let wait =
            if self.opts.respond.as_deref() == Some("delivered") { self.await_terminal.borrow().clone() } else { None };
        let ms = self.opts.timeout_ms;
        let mut waits = vec![];
        for r in &results {
            waits.push(match (r, &wait) {
                (IntakeResult::Accepted { packet_id }, Some(w)) => {
                    Some(tokio::task::spawn_local(w(packet_id.clone(), ms)))
                }
                _ => None,
            });
        }
        let mut packets = vec![];
        for (r, w) in results.iter().zip(waits) {
            packets.push(match r {
                IntakeResult::Rejected { packet_id, rule, message, .. } => {
                    let mut p = json!({ "packet_id": packet_id, "state": "rejected", "error": message });
                    if let Some(rule) = rule {
                        p["rule"] = json!(rule);
                    }
                    p
                }
                IntakeResult::Unavailable { reason } => json!({ "state": "unavailable", "error": reason }),
                IntakeResult::Accepted { packet_id } => match w {
                    None => json!({ "packet_id": packet_id, "state": "accepted" }),
                    Some(h) => match h.await.ok().flatten() {
                        None => json!({ "packet_id": packet_id, "state": "accepted" }),
                        Some(done) => {
                            let mut p = json!({ "packet_id": packet_id, "state": done.state });
                            let message = match done.error {
                                Some(Value::Object(e)) => e.get("message").cloned(),
                                Some(Value::String(s)) => Some(Value::String(s)),
                                _ => None,
                            };
                            if let Some(m) = message {
                                p["error"] = m;
                            }
                            p
                        }
                    },
                },
            });
        }
        let state = |s: &str| packets.iter().any(|p| p["state"] == s);
        let (dead, waiting) = (state("dead_lettered"), state("accepted") || state("escalated"));
        let body = if many { json!({ "packets": packets }) } else { packets[0].clone() };
        if let (Some(code), 0) = (rejected, accepted) {
            return reply(code, &body, &[]);
        }
        if let Some(reason) = unavailable {
            return reply(503, &json!({ "packets": packets, "error": reason }), &[("Retry-After", "5")]);
        }
        if let Some(code) = rejected {
            return reply(code, &body, &[]);
        }
        if dead {
            return reply(502, &body, &[]);
        }
        // Waiting for an agent (D50) is not a result yet: accepted, with its state and error.
        if waiting {
            return reply(202, &body, &[]);
        }
        reply(if wait.is_some() { 200 } else { 202 }, &body, &[])
    }

    async fn serve(self: Rc<Self>, listener: tokio::net::TcpListener) {
        loop {
            let (stream, peer) = tokio::select! {
                r = listener.accept() => match r {
                    Ok(c) => c,
                    Err(_) => {
                        // Out of file descriptors and the like: back off instead of spinning.
                        if !self.stop.sleep(100).await { return }
                        continue;
                    }
                },
                _ = self.stop.wait() => return,
            };
            let me = self.clone();
            let conn = tokio::task::spawn_local(async move {
                let handler = me.clone();
                let svc = hyper::service::service_fn(move |req| {
                    let h = handler.clone();
                    async move { Ok::<_, std::convert::Infallible>(h.handle(req, peer).await) }
                });
                let conn = hyper::server::conn::http1::Builder::new()
                    .timer(hyper_util::rt::TokioTimer::new())
                    .header_read_timeout(me.opts.idle)
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), svc);
                tokio::pin!(conn);
                tokio::select! {
                    _ = conn.as_mut() => {}
                    _ = me.stop.wait() => {
                        // Let the request in flight finish; idle keep-alive connections close now.
                        conn.as_mut().graceful_shutdown();
                        let _ = conn.await;
                    }
                }
            });
            let mut conns = self.conns.borrow_mut();
            conns.retain(|c| !c.is_finished());
            conns.push(conn);
        }
    }
}

impl InputAdapter for HttpInput {
    fn start(&self, intake: Intake, runtime: InputRuntime) -> LocalBoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let inner = &self.inner;
            if self.host().is_some() {
                // A sibling: the host's listener serves it once its intake is set.
                *inner.intake.borrow_mut() = Some(intake);
                *inner.await_terminal.borrow_mut() = Some(runtime.await_terminal);
                return Ok(());
            }
            let o = &inner.opts;
            let listener = tokio::net::TcpListener::bind((o.hostname.as_str(), o.port)).await.map_err(|e| {
                format!(
                    "http input can't listen on {}:{} ({e}); stop what holds the port, or pass another --listen",
                    o.hostname, o.port
                )
            })?;
            inner.bound.set(listener.local_addr().ok().map(|a| a.port()));
            *inner.intake.borrow_mut() = Some(intake);
            *inner.await_terminal.borrow_mut() = Some(runtime.await_terminal);
            inner.stop.reset();
            *self.accept.borrow_mut() = Some(tokio::task::spawn_local(inner.clone().serve(listener)));
            Ok(())
        })
    }

    fn stop(&self) -> LocalBoxFuture<'_, ()> {
        Box::pin(async move {
            if self.host().is_some() {
                *self.inner.intake.borrow_mut() = None;
                return;
            }
            let Some(accept) = self.accept.borrow_mut().take() else { return };
            self.inner.stop.stop();
            let _ = accept.await;
            let conns: Vec<JoinHandle<()>> = std::mem::take(&mut *self.inner.conns.borrow_mut());
            let aborts: Vec<_> = conns.iter().map(|c| c.abort_handle()).collect();
            // Let in-flight requests finish, but not forever.
            let all = async {
                for c in conns {
                    let _ = c.await;
                }
            };
            if tokio::time::timeout(Duration::from_secs(2), all).await.is_err() {
                for a in aborts {
                    a.abort();
                }
            }
        })
    }

    fn describe(&self) -> String {
        let o = &self.inner.opts;
        let bound = self.host().and_then(|h| h.bound.get()).or(self.inner.bound.get());
        format!("{} http://{}:{}{}", o.method, o.hostname, bound.unwrap_or(o.port), self.inner.route)
    }

    fn port(&self) -> Option<u16> {
        if self.host().is_some() { None } else { self.inner.bound.get() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::Settled;
    use crate::connectors::test_util::*;

    fn opts(format: &str) -> HttpOptions {
        HttpOptions {
            pipeline: "hin".into(),
            path: "/".into(),
            method: "POST".into(),
            port: 0,
            hostname: "127.0.0.1".into(),
            format: format.into(),
            auth: None,
            hmac: None,
            respond: None,
            timeout_ms: 30_000,
            idle: IDLE,
        }
    }

    fn runtime_with(
        dir: &TempDir,
        settle: impl Fn(String, u64) -> LocalBoxFuture<'static, Option<Settled>> + 'static,
    ) -> InputRuntime {
        InputRuntime { await_terminal: Rc::new(settle), ..runtime(dir) }
    }

    async fn started(o: HttpOptions, intake: Intake, rt: InputRuntime) -> (HttpInput, String) {
        let input = HttpInput::new(o);
        input.start(intake, rt).await.unwrap();
        let url = format!("http://127.0.0.1:{}/in/hin", input.port().unwrap());
        (input, url)
    }

    async fn post(
        url: &str,
        body: impl Into<reqwest::Body>,
        headers: &[(&str, &str)],
    ) -> (u16, Value, reqwest::header::HeaderMap) {
        let mut req = reqwest::Client::new().post(url).body(body);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let res = req.send().await.unwrap();
        let status = res.status().as_u16();
        let headers = res.headers().clone();
        (status, res.json().await.unwrap_or(Value::Null), headers)
    }

    #[test]
    fn csv_parsing() {
        let r = csv_records("\u{feff}name,note\nAda,hi\nBob,\"a, \"\"b\"\"\"\r\n\nCy,\n").ok().unwrap();
        assert_eq!(
            r,
            vec![
                json!({"name": "Ada", "note": "hi"}),
                json!({"name": "Bob", "note": "a, \"b\""}),
                json!({"name": "Cy", "note": ""})
            ]
        );
        assert_eq!(csv_records("a\n\"x\ny\"").ok().unwrap(), vec![json!({"a": "x\ny"})]);
        let err = |t: &str| csv_records(t).err().map(|b| b.message).unwrap();
        assert_eq!(err("a,b\n1,2,3\n"), "csv record 1 has 3 field(s), the header has 2");
        assert_eq!(err("a,b\n"), "csv needs a header row and at least one record");
        assert_eq!(err("a,b\n\"1,2\n"), "csv has an unterminated quote");
        assert_eq!(err(""), "csv needs a header row and at least one record");
        assert_eq!(err("a,a\n1,2"), "csv header has empty or repeated column names");
        assert_eq!(err("a,b\n1\"x\",2"), "stray quote in csv field");
    }

    #[test]
    fn multipart_parsing() {
        let body = b"--XYZ\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\n1\r\n--XYZ\r\nContent-Disposition: form-data; name=\"f\"; filename=\"x.bin\"\r\nContent-Type: image/png\r\n\r\n\x00\x01\r\n--XYZ--\r\n";
        let parts = parse_multipart(body, "multipart/form-data; boundary=XYZ").unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!((parts[0].name.as_str(), parts[0].data.as_slice()), ("a", b"1".as_slice()));
        assert_eq!(parts[1].filename.as_deref(), Some("x.bin"));
        assert_eq!(parts[1].content_type.as_deref(), Some("image/png"));
        assert_eq!(parts[1].data, vec![0, 1]);
        assert!(parse_multipart(body, "multipart/form-data").is_err());
    }

    #[test]
    fn json_routes_methods_and_answers() {
        local(async {
            let dir = TempDir::new();
            let (intake, got) = recording_intake(accepted);
            let (input, url) = started(opts("json"), intake, runtime(&dir)).await;
            let (status, body, _) = post(&format!("{url}/"), r#"{"a":1}"#, &[]).await;
            assert_eq!((status, body), (202, json!({"packet_id": "p1", "state": "accepted"})));
            assert_eq!(got.borrow()[0].0, json!({"a": 1}));
            assert_eq!(got.borrow()[0].1, Origin { trigger: "http".into(), source: "127.0.0.1".into() });
            let res = reqwest::Client::new().post(&url).body("{").send().await.unwrap();
            assert_eq!(res.headers()["content-type"], "application/json;charset=utf-8");
            assert_eq!(
                (res.status().as_u16(), res.json::<Value>().await.unwrap()),
                (400, json!({"error": "body is not valid json", "hint": "send a json body"}))
            );
            let (status, body, _) = post(&format!("{url}/other"), "{}", &[]).await;
            assert_eq!((status, body), (404, json!({"error": "no input at /in/hin/other"})));
            let res = reqwest::Client::new().get(&url).send().await.unwrap();
            assert_eq!(res.status().as_u16(), 405);
            assert_eq!(res.headers()["allow"], "POST");
            assert_eq!(res.json::<Value>().await.unwrap(), json!({"error": "use POST"}));
            assert!(input.describe().starts_with("POST http://127.0.0.1:") && input.describe().ends_with("/in/hin"));
            input.stop().await;
            input.stop().await;
            assert!(
                reqwest::Client::new().post(&url).body("{}").send().await.is_err(),
                "the port is closed after stop"
            );
        });
    }

    #[test]
    fn http_inputs_share_the_first_ones_listener() {
        local(async {
            let dir = TempDir::new();
            let (first_intake, first) = recording_intake(accepted);
            let (other_intake, other) = recording_intake(accepted);
            let host = HttpInput::new(HttpOptions { path: "/people".into(), ..opts("json") });
            let text = HttpInput::new(HttpOptions { path: "/notes".into(), ..opts("text") });
            let get = HttpInput::new(HttpOptions { path: "/people".into(), method: "GET".into(), ..opts("text") });
            host.add_sibling(&text);
            host.add_sibling(&get);
            host.start(first_intake, runtime(&dir)).await.unwrap();
            let base = format!("http://127.0.0.1:{}/in/hin", host.port().unwrap());
            // Not started yet: the route is there, but nothing takes its packets.
            let (status, _, _) = post(&format!("{base}/notes"), "hi", &[]).await;
            assert_eq!(status, 503);
            text.start(other_intake.clone(), runtime(&dir)).await.unwrap();
            get.start(other_intake, runtime(&dir)).await.unwrap();
            assert_eq!((text.port(), get.port()), (None, None), "only the host reports the port");
            assert!(text.describe().ends_with(&format!(":{}/in/hin/notes", host.port().unwrap())));
            let (status, _, _) = post(&format!("{base}/people"), r#"{"a":1}"#, &[]).await;
            assert_eq!(status, 202);
            let (status, _, _) = post(&format!("{base}/notes"), "hi", &[]).await;
            assert_eq!(status, 202);
            assert_eq!(first.borrow().len(), 1);
            assert_eq!(other.borrow()[0].0, json!("hi"));
            let res = reqwest::Client::new().get(format!("{base}/people")).send().await.unwrap();
            assert_eq!(res.status().as_u16(), 202, "same path, other method: the GET input");
            let res = reqwest::Client::new().put(format!("{base}/people")).send().await.unwrap();
            assert_eq!(res.status().as_u16(), 405);
            assert_eq!(res.headers()["allow"], "POST, GET");
            let (status, body, _) = post(&format!("{base}/nope"), "{}", &[]).await;
            assert_eq!(status, 404);
            assert_eq!(body["hint"], "inputs here: POST /in/hin/people, POST /in/hin/notes, GET /in/hin/people");
            for i in [&get, &text, &host] {
                i.stop().await;
            }
        });
    }

    #[test]
    fn intake_results_map_to_status_codes() {
        local(async {
            let dir = TempDir::new();
            let (intake, _) = recording_intake(|n| match n {
                1 => IntakeResult::Rejected {
                    packet_id: "r1".into(),
                    rule: Some("data.a > 1".into()),
                    message: "too small".into(),
                    respond: None,
                },
                2 => IntakeResult::Rejected {
                    packet_id: "r2".into(),
                    rule: None,
                    message: "nope".into(),
                    respond: Some(409),
                },
                _ => IntakeResult::Unavailable { reason: "buffer full (2 packets pending)".into() },
            });
            let (input, url) = started(opts("json"), intake, runtime(&dir)).await;
            let (status, body, _) = post(&url, "{}", &[]).await;
            assert_eq!(
                (status, body),
                (422, json!({"packet_id": "r1", "state": "rejected", "error": "too small", "rule": "data.a > 1"}))
            );
            let (status, body, _) = post(&url, "{}", &[]).await;
            assert_eq!((status, body), (409, json!({"packet_id": "r2", "state": "rejected", "error": "nope"})));
            let (status, body, headers) = post(&url, "{}", &[]).await;
            assert_eq!((status, body), (503, json!({"error": "buffer full (2 packets pending)"})));
            assert_eq!(headers["retry-after"], "5");
            input.stop().await;
        });
    }

    #[test]
    fn csv_records_become_packets_and_a_partial_intake_is_503() {
        local(async {
            let dir = TempDir::new();
            let (intake, got) = recording_intake(|n| {
                if n < 3 { accepted(n) } else { IntakeResult::Unavailable { reason: "draining".into() } }
            });
            let (input, url) = started(opts("csv"), intake, runtime(&dir)).await;
            let (status, body, _) = post(&url, "name\nAda\n", &[]).await;
            assert_eq!((status, body), (202, json!({"packets": [{"packet_id": "p1", "state": "accepted"}]})));
            let (status, body, _) = post(&url, "name\nBo\nCy\nDi\n", &[]).await;
            assert_eq!(status, 503);
            assert_eq!(
                body,
                json!({"packets": [{"packet_id": "p2", "state": "accepted"}, {"state": "unavailable", "error": "draining"}], "error": "draining"})
            );
            assert_eq!(got.borrow().len(), 3, "intake stops at the first unavailable");
            for body in ["a,b\n1,2,3\n", "a,b\n", "a,b\n\"1,2\n", ""] {
                let (status, j, _) = post(&url, body, &[]).await;
                assert_eq!(status, 400);
                assert!(
                    j["error"].as_str().is_some_and(|e| !e.is_empty())
                        && j["hint"].as_str().is_some_and(|h| !h.is_empty())
                );
            }
            assert_eq!(got.borrow().len(), 3);
            input.stop().await;
        });
    }

    #[test]
    fn text_bytes_and_form_bodies() {
        local(async {
            let dir = TempDir::new();
            for (format, body, ct, want) in [
                ("text", b"hello \xff".to_vec(), None, json!("hello \u{fffd}")),
                ("bytes", vec![0, 1, 2, 250, 255], Some("image/png"), json!({"base64": "AAEC+v8=", "content_type": "image/png", "size": 5})),
                ("bytes", vec![1], None, json!({"base64": "AQ==", "content_type": "application/octet-stream", "size": 1})),
                ("form", b"a=1&b=x+y%21&a=2".to_vec(), Some("application/x-www-form-urlencoded"), json!({"a": "2", "b": "x y!"})),
                (
                    "form",
                    b"--B\r\nContent-Disposition: form-data; name=\"n\"\r\n\r\nv\r\n--B\r\nContent-Disposition: form-data; name=\"f\"; filename=\"a.txt\"\r\n\r\nhi\r\n--B--\r\n".to_vec(),
                    Some("multipart/form-data; boundary=B"),
                    json!({"n": "v", "f": {"filename": "a.txt", "content_type": "application/octet-stream", "size": 2, "base64": "aGk="}}),
                ),
            ] {
                let (intake, got) = recording_intake(accepted);
                let (input, url) = started(opts(format), intake, runtime(&dir)).await;
                let headers: Vec<(&str, &str)> = ct.map(|c| vec![("content-type", c)]).unwrap_or_default();
                let (status, _, _) = post(&url, body, &headers).await;
                assert_eq!(status, 202, "{format}");
                assert_eq!(got.borrow()[0].0, want, "{format}");
                input.stop().await;
            }
            let (intake, _) = recording_intake(accepted);
            let (input, url) = started(opts("form"), intake, runtime(&dir)).await;
            let (status, body, _) = post(&url, "a=1", &[("content-type", "text/plain")]).await;
            assert_eq!((status, body), (400, json!({"error": "body is not valid form", "hint": "send a form body"})));
            input.stop().await;
        });
    }

    #[test]
    fn header_auth_and_hmac() {
        local(async {
            let dir = TempDir::new();
            let (intake, got) = recording_intake(accepted);
            let mut o = opts("json");
            o.auth = Some(("X-Token".into(), "tok".into()));
            let (input, url) = started(o, intake.clone(), runtime(&dir)).await;
            let (status, body, _) = post(&url, "{}", &[("X-Token", "nope")]).await;
            assert_eq!(
                (status, body),
                (401, json!({"error": "unauthorized", "hint": "send the token in the X-Token header"}))
            );
            assert_eq!(post(&url, "{}", &[]).await.0, 401);
            assert_eq!(post(&url, "{}", &[("x-token", "tok")]).await.0, 202);
            input.stop().await;

            let mut o = opts("json");
            o.hmac = Some(Hmac { header: "X-Signature".into(), secret: "shh-test".into(), algorithm: "sha256".into() });
            let (input, url) = started(o, intake.clone(), runtime(&dir)).await;
            let body = r#"{"a":1}"#;
            let sign = |b: &str| hmac_hex("sha256", "shh-test", b.as_bytes());
            assert_eq!(post(&url, body, &[("X-Signature", &format!("sha256={}", sign(body)))]).await.0, 202);
            assert_eq!(
                post(&url, body, &[("X-Signature", &format!(" SHA256={} ", sign(body).to_uppercase()))]).await.0,
                202
            );
            assert_eq!(post(&url, body, &[("X-Signature", &sign(body))]).await.0, 202);
            let (status, j, _) = post(&url, body, &[("X-Signature", &sign("other"))]).await;
            assert_eq!(status, 401);
            assert_eq!(
                j,
                json!({"error": "invalid or missing signature", "hint": "send the hex sha256 HMAC of the raw body in the X-Signature header"})
            );
            assert_eq!(post(&url, body, &[]).await.0, 401);
            assert_eq!(post(&url, body, &[("X-Signature", "zz")]).await.0, 401);
            input.stop().await;
            assert_eq!(got.borrow().len(), 4);

            let mut o = opts("text");
            o.hmac = Some(Hmac { header: "X-Hub-Signature".into(), secret: "k".into(), algorithm: "sha1".into() });
            let (input, url) = started(o, intake, runtime(&dir)).await;
            // HMAC-SHA1("k", "hi") per RFC 2104.
            let sig = hmac_hex("sha1", "k", b"hi");
            assert_eq!(sig.len(), 40);
            assert_eq!(post(&url, "hi", &[("X-Hub-Signature", &format!("sha1={sig}"))]).await.0, 202);
            assert_eq!(post(&url, "hi", &[("X-Hub-Signature", &hmac_hex("sha256", "k", b"hi"))]).await.0, 401);
            input.stop().await;
        });
    }

    #[test]
    fn hmac_matches_known_vectors() {
        // RFC 4231 test case 2 and its SHA-1 counterpart (RFC 2202 test case 2).
        let data = b"what do ya want for nothing?";
        assert_eq!(
            hmac_hex("sha256", "Jefe", data),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_eq!(hmac_hex("sha1", "Jefe", data), "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
    }

    #[test]
    fn respond_delivered_waits_for_the_packet() {
        local(async {
            let dir = TempDir::new();
            let settle = |id: String, ms: u64| -> LocalBoxFuture<'static, Option<Settled>> {
                Box::pin(async move {
                    match id.as_str() {
                        "p1" => Some(Settled { state: "delivered".into(), error: None }),
                        "p2" => Some(Settled {
                            state: "dead_lettered".into(),
                            error: Some(json!({"code": "node.error", "message": "boom"})),
                        }),
                        "p3" => {
                            Some(Settled { state: "escalated".into(), error: Some(json!({"message": "needs a look"})) })
                        }
                        _ => {
                            tokio::time::sleep(Duration::from_millis(ms)).await;
                            None
                        }
                    }
                })
            };
            let (intake, _) = recording_intake(accepted);
            let mut o = opts("json");
            o.respond = Some("delivered".into());
            o.timeout_ms = 100;
            let (input, url) = started(o, intake, runtime_with(&dir, settle)).await;
            assert_eq!(post(&url, "{}", &[]).await.0, 200);
            let (status, body, _) = post(&url, "{}", &[]).await;
            assert_eq!((status, body), (502, json!({"packet_id": "p2", "state": "dead_lettered", "error": "boom"})));
            let (status, body, _) = post(&url, "{}", &[]).await;
            assert_eq!(
                (status, body),
                (202, json!({"packet_id": "p3", "state": "escalated", "error": "needs a look"}))
            );
            let t0 = std::time::Instant::now();
            let (status, body, _) = post(&url, "{}", &[]).await;
            assert!(t0.elapsed().as_millis() < 700);
            assert_eq!((status, body), (202, json!({"packet_id": "p4", "state": "accepted"})));
            input.stop().await;
        });
    }

    #[test]
    fn a_long_delivered_wait_still_gets_its_answer() {
        // A GET hook (no body) whose wait outlasts the idle timeout of keep-alive connections.
        local(async {
            let dir = TempDir::new();
            let settle = |_: String, _: u64| -> LocalBoxFuture<'static, Option<Settled>> {
                Box::pin(async {
                    tokio::time::sleep(Duration::from_millis(2500)).await;
                    Some(Settled { state: "delivered".into(), error: None })
                })
            };
            let (intake, _) = recording_intake(|_| IntakeResult::Accepted { packet_id: "p_1".into() });
            let mut o = opts("text");
            o.method = "GET".into();
            o.respond = Some("delivered".into());
            o.pipeline = "idle".into();
            o.idle = Duration::from_millis(500);
            let input = HttpInput::new(o);
            input.start(intake, runtime_with(&dir, settle)).await.unwrap();
            let res = reqwest::Client::new()
                .get(format!("http://127.0.0.1:{}/in/idle", input.port().unwrap()))
                .send()
                .await
                .unwrap();
            assert_eq!(res.status().as_u16(), 200);
            assert_eq!(res.json::<Value>().await.unwrap(), json!({"packet_id": "p_1", "state": "delivered"}));
            input.stop().await;
        });
    }

    #[test]
    fn idle_keep_alive_connections_are_closed() {
        local(async {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let dir = TempDir::new();
            let (intake, _) = recording_intake(accepted);
            let mut o = opts("json");
            o.idle = Duration::from_millis(300);
            let (input, _) = started(o, intake, runtime(&dir)).await;
            let mut s = tokio::net::TcpStream::connect(("127.0.0.1", input.port().unwrap())).await.unwrap();
            s.write_all(b"POST /in/hin HTTP/1.1\r\nhost: x\r\ncontent-length: 2\r\n\r\n{}").await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).await.unwrap();
            assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 202"));
            let closed =
                tokio::time::timeout(Duration::from_secs(3), s.read(&mut buf)).await.expect("closed within 3 s");
            assert_eq!(closed.unwrap_or(0), 0);
            input.stop().await;
        });
    }

    #[test]
    fn stop_lets_a_request_in_flight_finish() {
        local(async {
            let dir = TempDir::new();
            let arrived = Rc::new(std::cell::Cell::new(false));
            let seen = arrived.clone();
            let intake: Intake = Rc::new(move |_, _, _| {
                seen.set(true);
                Box::pin(async {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    accepted(1)
                })
            });
            let (input, url) = started(opts("json"), intake, runtime(&dir)).await;
            let req = tokio::task::spawn_local(async move { post(&url, "{}", &[]).await.0 });
            // Stop only once the request is in flight (a fixed sleep raced the connection under load).
            while !arrived.get() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            input.stop().await;
            assert_eq!(req.await.unwrap(), 202);
        });
    }

    #[test]
    fn a_taken_port_is_a_clear_start_error() {
        local(async {
            let dir = TempDir::new();
            let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let mut o = opts("json");
            o.port = held.local_addr().unwrap().port();
            let (intake, _) = recording_intake(accepted);
            let e = HttpInput::new(o).start(intake, runtime(&dir)).await.unwrap_err();
            assert!(
                e.starts_with("http input can't listen on 127.0.0.1:") && e.contains("pass another --listen"),
                "{e}"
            );
        });
    }
}
