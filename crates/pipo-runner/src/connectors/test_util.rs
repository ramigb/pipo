// Test helpers for the connector tests: a LocalSet runner, temp folders under /tmp, and a local HTTP server.

use super::{InputRuntime, Intake, IntakeResult, LocalBoxFuture, Origin};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Request, Response};
use serde_json::Value;
use std::cell::RefCell;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

/// Runs `f` on a current-thread runtime inside a LocalSet, as the runner does.
pub fn local<F: Future>(f: F) -> F::Output {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    tokio::task::LocalSet::new().block_on(&rt, f)
}

/// A temp folder under /tmp, removed on drop.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new() -> TempDir {
        let p = PathBuf::from("/tmp").join(format!("pipo-conn-{}", crate::ids::ulid().to_lowercase()));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
    pub fn join(&self, p: &str) -> PathBuf {
        self.0.join(p)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Polls `f` until it is true, or panics after `ms`.
pub async fn wait_for(mut f: impl FnMut() -> bool, ms: u64, what: &str) {
    let end = std::time::Instant::now() + Duration::from_millis(ms);
    while !f() {
        if std::time::Instant::now() > end {
            panic!("timed out waiting for {what}");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[derive(Debug, Clone)]
pub struct Call {
    pub method: String,
    pub path: String,
    pub headers: hyper::HeaderMap,
    pub body: Vec<u8>,
}

impl Call {
    pub fn header(&self, name: &str) -> Option<String> {
        self.headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_owned)
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

pub struct Reply {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn text(status: u16, body: &str) -> Reply {
        Reply { status, content_type: "text/plain", body: body.as_bytes().to_vec() }
    }
    pub fn json(status: u16, body: &Value) -> Reply {
        Reply { status, content_type: "application/json", body: body.to_string().into_bytes() }
    }
}

pub type Handler = Rc<dyn Fn(Call) -> LocalBoxFuture<'static, Reply>>;

pub struct Server {
    pub base: String,
    pub calls: Rc<RefCell<Vec<Call>>>,
}

/// A local HTTP server on 127.0.0.1:0 that records each request and answers with `handler`. It lives as long as
/// the LocalSet.
pub async fn server(handler: Handler) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let calls: Rc<RefCell<Vec<Call>>> = Rc::default();
    let recorded = calls.clone();
    tokio::task::spawn_local(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { return };
            let handler = handler.clone();
            let calls = recorded.clone();
            tokio::task::spawn_local(async move {
                let svc = hyper::service::service_fn(move |req: Request<Incoming>| {
                    let handler = handler.clone();
                    let calls = calls.clone();
                    async move {
                        let (parts, body) = req.into_parts();
                        let body = body.collect().await.map(|b| b.to_bytes().to_vec()).unwrap_or_default();
                        let call = Call {
                            method: parts.method.to_string(),
                            path: parts.uri.path().to_string(),
                            headers: parts.headers,
                            body,
                        };
                        calls.borrow_mut().push(call.clone());
                        let r = handler(call).await;
                        Ok::<_, std::convert::Infallible>(
                            Response::builder()
                                .status(r.status)
                                .header("content-type", r.content_type)
                                .body(Full::new(Bytes::from(r.body)))
                                .unwrap(),
                        )
                    }
                });
                let io = hyper_util::rt::TokioIo::new(stream);
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(io, svc).await;
            });
        }
    });
    Server { base, calls }
}

/// A server whose every answer is the same.
pub async fn fixed(status: u16, body: &'static str) -> Server {
    server(Rc::new(move |_| Box::pin(async move { Reply::text(status, body) }))).await
}

/// The payloads an intake was handed.
pub type Got = Rc<RefCell<Vec<(Value, Origin)>>>;

/// An intake that records each payload and answers with `answer`.
pub fn recording_intake(answer: impl Fn(usize) -> IntakeResult + 'static) -> (Intake, Got) {
    let got: Got = Rc::default();
    let g = got.clone();
    let answer = Rc::new(answer);
    let intake: Intake = Rc::new(move |payload, origin, _commit| {
        g.borrow_mut().push((payload, origin));
        let n = g.borrow().len();
        let r = answer(n);
        Box::pin(async move { r })
    });
    (intake, got)
}

pub fn accepted(n: usize) -> IntakeResult {
    IntakeResult::Accepted { packet_id: format!("p{n}") }
}

/// An input runtime over a journal in `dir`, whose packets never settle.
pub fn runtime(dir: &TempDir) -> InputRuntime {
    let j = crate::journal::Journal::open(dir.join("journal.db")).unwrap();
    InputRuntime { journal: Rc::new(RefCell::new(j)), await_terminal: Rc::new(|_, _| Box::pin(async { None })) }
}
