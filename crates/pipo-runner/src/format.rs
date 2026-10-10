// Diagnostics as text (docs/spec.md §5). Port of @pipo/spec format.ts `formatDiagnostic`, for start errors.

use serde_json::Value;

/// `file:line:col  severity  code  message` plus an indented hint.
pub fn format_diagnostic(d: &Value) -> String {
    let s = |k: &str| d.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let n = |k: &str| d.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
    let file = d.get("file").and_then(|v| v.as_str()).unwrap_or("<input>");
    let head = format!("{file}:{}:{}  {:<7}  {}  {}", n("line"), n("col"), s("severity"), s("code"), s("message"));
    match d.get("hint").and_then(|v| v.as_str()) {
        Some(h) if !h.is_empty() => format!("{head}\n  {h}"),
        _ => head,
    }
}
