// Runner control protocol (docs/spec.md §7.2, D24). Port of control/protocol.ts: newline-delimited JSON over
// `<home>/run/<name>.sock`. One request per line, `{id, op, args}`; one response per line with the same id,
// `{id, ok: true, result}` or `{id, ok: false, error: {code, message, hint}}`.

use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

pub const PROTOCOL: u32 = 1;

pub const OPS: &[&str] = &[
    "hello",
    "status",
    "pause",
    "resume",
    "drain",
    "stop",
    "push",
    "ack",
    "events",
    "packets",
    "packet",
    "dlq",
    "replay",
    "purge",
    "versions",
    "version",
    "diff",
    "apply",
    "rollback",
    "propose",
    "proposals",
    "proposal",
    "apply_proposal",
    "reject_proposal",
    "resolve",
];

/// A request line larger than this closes the connection (a push carries one packet, not a file).
pub const MAX_LINE: usize = 16 * 1024 * 1024;

/// sun_path is 108 bytes on Linux and 104 on macOS/BSD, including the trailing NUL.
pub const MAX_SOCKET_PATH: usize = if cfg!(target_os = "linux") { 107 } else { 103 };

/// An op's failure: code, message and what to do. `code` is one of bad_request, unknown_op, unavailable, rejected,
/// not_found, invalid_state, invalid_pipeline, internal.
#[derive(Debug, Clone, PartialEq)]
pub struct ControlError {
    pub code: &'static str,
    pub message: String,
    pub hint: Option<String>,
    pub packet_id: Option<String>,
    /// `invalid_pipeline`: the `pipo check` diagnostics of the definition (D60).
    pub diagnostics: Vec<Value>,
}

impl ControlError {
    pub fn new(code: &'static str, message: impl Into<String>, hint: impl Into<String>) -> ControlError {
        let hint = hint.into();
        ControlError {
            code,
            message: message.into(),
            hint: if hint.is_empty() { None } else { Some(hint) },
            packet_id: None,
            diagnostics: vec![],
        }
    }

    pub fn body(&self) -> Value {
        let mut b = Map::new();
        b.insert("code".into(), json!(self.code));
        b.insert("message".into(), json!(self.message));
        if let Some(h) = &self.hint {
            b.insert("hint".into(), json!(h));
        }
        if let Some(p) = &self.packet_id {
            b.insert("packet_id".into(), json!(p));
        }
        if !self.diagnostics.is_empty() {
            b.insert("diagnostics".into(), Value::Array(self.diagnostics.clone()));
        }
        Value::Object(b)
    }
}

impl std::fmt::Display for ControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Every string in `value` (values and keys) passed through `redact` (redactDeep in control/protocol.ts).
pub fn redact_deep(value: &Value, redact: &dyn Fn(&str) -> String) -> Value {
    match value {
        Value::String(s) => Value::String(redact(s)),
        Value::Array(a) => Value::Array(a.iter().map(|v| redact_deep(v, redact)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (redact(k), redact_deep(v, redact))).collect()),
        other => other.clone(),
    }
}

pub fn socket_path(home: &Path, pipeline: &str) -> PathBuf {
    home.join("run").join(format!("{pipeline}.sock"))
}

/// Why a socket can't live at `path`, with what to do about it; None when it can.
pub fn socket_path_problem(path: &Path) -> Option<(String, String)> {
    let text = path.to_string_lossy();
    let bytes = text.len();
    if bytes > MAX_SOCKET_PATH {
        return Some((
            format!(
                "control socket path is {bytes} bytes, over the {MAX_SOCKET_PATH}-byte limit for unix sockets: {text}"
            ),
            "use a shorter Pipo home (--home or PIPO_HOME, e.g. ~/.pipo) or a shorter pipeline name".into(),
        ));
    }
    let b = text.as_bytes();
    if cfg!(target_os = "linux")
        && b.len() >= 7
        && text.starts_with("/mnt/")
        && b[5].is_ascii_alphabetic()
        && b[6] == b'/'
    {
        return Some((
            format!("control socket {text} is on a Windows drive; unix sockets do not work there under WSL"),
            "use a Pipo home on the Linux filesystem (the default ~/.pipo, or --home / PIPO_HOME under /home or /tmp)"
                .into(),
        ));
    }
    None
}
