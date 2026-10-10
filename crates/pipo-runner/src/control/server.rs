// The runner side of the control socket (docs/spec.md §7.2, D24). Port of control/server.ts: owns
// `<home>/run/<name>.sock`, removes a stale socket left by a killed runner, refuses one a live runner still answers
// on, and unlinks it on close. Replies go out in request order on each connection.

use super::ops;
use super::protocol::{ControlError, MAX_LINE, OPS, socket_path_problem};
use crate::runner::Runner;
use serde_json::{Value, json};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::task::JoinHandle;

const EXAMPLE: &str = r#"one JSON object per line, e.g. {"id":1,"op":"status","args":{}}"#;

/// True if something accepts connections on the unix socket at `path`.
pub async fn probe(path: &Path) -> bool {
    matches!(tokio::time::timeout(Duration::from_secs(1), UnixStream::connect(path)).await, Ok(Ok(_)))
}

pub struct ControlServer {
    path: PathBuf,
    accept: JoinHandle<()>,
    conns: Rc<std::cell::RefCell<Vec<JoinHandle<()>>>>,
}

impl ControlServer {
    /// Listen on `path`. Errs (with a hint) when the path is unusable or a live runner owns it.
    pub async fn listen(path: &Path, runner: Rc<Runner>) -> Result<ControlServer, ControlError> {
        if let Some((message, hint)) = socket_path_problem(path) {
            return Err(ControlError::new("unavailable", message, hint));
        }
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
        if let Ok(meta) = std::fs::symlink_metadata(path) {
            if !meta.file_type().is_socket() {
                return Err(ControlError::new(
                    "unavailable",
                    format!("{} exists and is not a socket", path.display()),
                    "move or delete that file; Pipo keeps runner sockets under <home>/run/",
                ));
            }
            if probe(path).await {
                return Err(ControlError::new(
                    "unavailable",
                    format!("another runner is listening on {}", path.display()),
                    "stop it first (`pipo stop <name>`), or use a different --home",
                ));
            }
            // Left behind by a runner that was killed: nothing answers on it.
            let _ = std::fs::remove_file(path);
            runner.log("info", &format!("removed stale control socket {}", path.display()));
        }
        let listener = UnixListener::bind(path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AddrInUse {
                ControlError::new(
                    "unavailable",
                    format!("another runner is listening on {}", path.display()),
                    "stop it first (`pipo stop <name>`), or use a different --home",
                )
            } else {
                ControlError::new(
                    "unavailable",
                    format!("could not listen on control socket {}: {e}", path.display()),
                    "use a Pipo home on a local Linux or macOS filesystem (--home or PIPO_HOME)",
                )
            }
        })?;
        // Only this user may drive the runner.
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        let conns: Rc<std::cell::RefCell<Vec<JoinHandle<()>>>> = Rc::default();
        let weak = Rc::downgrade(&runner);
        drop(runner);
        let conns2 = conns.clone();
        let accept = tokio::task::spawn_local(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { continue };
                let Some(r) = weak.upgrade() else { return };
                let handle = tokio::task::spawn_local(serve(stream, Rc::downgrade(&r)));
                let mut list = conns2.borrow_mut();
                list.retain(|h| !h.is_finished());
                list.push(handle);
            }
        });
        Ok(ControlServer { path: path.to_path_buf(), accept, conns })
    }

    /// Stop listening, drop every connection and remove the socket file.
    pub async fn close(self) {
        self.accept.abort();
        for c in self.conns.borrow_mut().drain(..) {
            c.abort();
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

async fn serve(stream: UnixStream, runner: std::rc::Weak<Runner>) {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        let n = match (&mut reader).take((MAX_LINE + 1) as u64).read_until(b'\n', &mut buf).await {
            Ok(n) => n,
            Err(_) => return,
        };
        if n == 0 {
            return;
        }
        if buf.len() > MAX_LINE && !buf.ends_with(b"\n") {
            let e = ControlError::new(
                "bad_request",
                format!("request line is over {MAX_LINE} bytes"),
                "send one packet per push; large files belong in a watch input",
            );
            let line = format!("{}\n", json!({ "id": null, "ok": false, "error": e.body() }));
            let _ = write.write_all(line.as_bytes()).await;
            let _ = write.shutdown().await;
            return;
        }
        let line = String::from_utf8_lossy(&buf).trim().to_string();
        if line.is_empty() {
            continue;
        }
        let Some(r) = runner.upgrade() else { return };
        let (response, after) = answer(&r, &line).await;
        let text = format!("{}\n", response);
        let wrote = write.write_all(text.as_bytes()).await.is_ok();
        let _ = write.flush().await;
        if let Some(after) = after {
            after(r.clone());
        }
        drop(r);
        if !wrote {
            return;
        }
    }
}

pub type After = Box<dyn FnOnce(Rc<Runner>)>;

async fn answer(r: &Rc<Runner>, line: &str) -> (Value, Option<After>) {
    let error = |id: Value, e: ControlError| -> (Value, Option<After>) {
        (json!({ "id": id, "ok": false, "error": r.secrets.redact_value(&e.body()) }), None)
    };
    let req: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return error(Value::Null, ControlError::new("bad_request", format!("bad JSON: {e}"), EXAMPLE)),
    };
    let Some(obj) = req.as_object() else {
        return error(Value::Null, ControlError::new("bad_request", "a request must be a JSON object", EXAMPLE));
    };
    let id = match obj.get("id") {
        Some(v @ Value::String(_)) | Some(v @ Value::Number(_)) => v.clone(),
        _ => Value::Null,
    };
    let Some(op) = obj.get("op").and_then(|o| o.as_str()) else {
        return error(id, ControlError::new("bad_request", "missing `op`", EXAMPLE));
    };
    if !OPS.contains(&op) {
        return error(id, ControlError::new("unknown_op", format!("unknown op '{op}'"), format!("ops: {}", OPS.join(", "))));
    }
    let args = match obj.get("args") {
        None | Some(Value::Null) => serde_json::Map::new(),
        Some(Value::Object(a)) => a.clone(),
        Some(_) => return error(id, ControlError::new("bad_request", "`args` must be an object", EXAMPLE)),
    };
    match ops::handle(r, op, &args).await {
        Ok((result, after)) => (json!({ "id": id, "ok": true, "result": r.secrets.redact_value(&result) }), after),
        Err(e) => error(id, e),
    }
}
