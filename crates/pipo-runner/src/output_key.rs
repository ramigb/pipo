// The output key (docs/spec.md §3.2 `meta.key`, §3.5, D22, D44). Port of output-key.ts: what the output writes a
// packet under, so a delivery check can look it up. The write and `meta.key` both use it.

use crate::expr::{render, to_text};
use crate::pipeline::Output;
use serde_json::{Map, Value};

/// The key of a write: the unit id, unless the output sets one explicitly: the sqlite key column in `columns`, or
/// an `Idempotency-Key` header on http.
pub fn output_key(to: &str, w: &Map<String, Value>, unit_id: &str) -> String {
    if to == "sqlite" {
        let key = w.get("key").and_then(|k| k.as_str()).unwrap_or("packet_id");
        if let Some(v) = w.get("columns").and_then(|c| c.get(key)).filter(|v| !v.is_null()) {
            return to_text(v);
        }
    } else if to == "http"
        && let Some(headers) = w.get("headers").and_then(|h| h.as_object())
    {
        for (h, v) in headers {
            if h.eq_ignore_ascii_case("idempotency-key") {
                return to_text(v);
            }
        }
    }
    unit_id.to_string()
}

/// `meta.key` for a unit: the output's key rendered with `meta.key` set to the unit id; the unit id when the
/// output's `with:` can't be rendered yet.
pub fn resolve_key(out: &Output, unit_id: &str, ctx: &Value) -> String {
    let Some(w) = &out.with else { return unit_id.to_string() };
    if out.to != "sqlite" && out.to != "http" {
        return unit_id.to_string();
    }
    let mut c = ctx.clone();
    if let Some(meta) = c.get_mut("meta").and_then(|m| m.as_object_mut()) {
        meta.insert("key".into(), Value::String(unit_id.to_string()));
    }
    match render(&Value::Object(w.clone()), &c) {
        Ok(Value::Object(rendered)) => output_key(&out.to, &rendered, unit_id),
        _ => unit_id.to_string(),
    }
}
