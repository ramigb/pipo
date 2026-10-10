// What this runner implements (docs/spec.md §5, CLAUDE.md "Runtime gaps are explicit"). Port of support.ts:
// `pipo check` validates the whole spec, and the runner refuses to start a pipeline that uses something it can't do
// yet, rather than silently misbehaving. Removing entries here (with tests) is how the runtime grows.

use crate::connectors::{INPUTS, OUTPUTS, TAPS, TRANSFORMS};
use crate::pipeline::{Pipeline, fn_ref};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Gap {
    pub path: String,
    pub feature: String,
    /// `refuse` blocks start; `warn` starts anyway because data still flows correctly.
    pub level: &'static str,
}

const HTTP_FORMATS: &[&str] = &["json", "text", "form", "csv", "bytes"];
const CHECKS: &[&str] = &[
    "ack",
    "none",
    "record_exists",
    "row_count",
    "query",
    "file_exists",
    "file_nonempty",
    "line_contains",
    "checksum",
    "status",
    "follow_up",
    "external",
];
const THEN: &[&str] = &["dead_letter", "drop", "continue", "pause", "halt", "agent"];

pub fn gaps(p: &Pipeline) -> Vec<Gap> {
    let mut out = vec![];
    let mut refuse = |path: String, feature: String| out.push(Gap { path, feature, level: "refuse" });
    if !INPUTS.contains(&p.input.via.as_str()) {
        refuse("input.via".into(), format!("input '{}' (spec §3.3)", p.input.via));
    }
    if p.input.via == "http" {
        let format = p.input.format.as_deref().unwrap_or("json");
        if !HTTP_FORMATS.contains(&format) {
            refuse("input.format".into(), format!("http format '{format}'"));
        }
    }
    for (id, n) in p.nodes.iter() {
        if let Some(tap) = &n.tap
            && fn_ref(tap).is_none()
            && tap != "log"
            && !TAPS.contains(&tap.as_str())
        {
            refuse(format!("nodes.{id}.tap"), format!("tap '{tap}'"));
        }
        if let Some(t) = &n.transform
            && fn_ref(t).is_none()
            && t != "map"
            && !TRANSFORMS.contains(&t.as_str())
        {
            refuse(format!("nodes.{id}.transform"), format!("transform '{t}'"));
        }
    }
    if !OUTPUTS.contains(&p.output.to.as_str()) {
        refuse("output.to".into(), format!("output '{}' (spec §3.5)", p.output.to));
    }
    let check = p.delivered.as_ref().and_then(|d| d.check.as_deref()).unwrap_or("ack");
    if !CHECKS.contains(&check) {
        refuse("delivered.check".into(), format!("delivery check '{check}' (spec §3.10)"));
    }
    let mut thens: Vec<Option<&String>> = vec![
        p.errors.as_ref().and_then(|e| e.then.as_ref()),
        p.output.on_error.as_ref().and_then(|e| e.then.as_ref()),
        p.output.on_invalid.as_ref().and_then(|e| e.then.as_ref()),
        p.delivered.as_ref().and_then(|d| d.on_fail.as_ref()).and_then(|e| e.then.as_ref()),
    ];
    for (_, n) in p.nodes.iter() {
        thens.push(n.on_error.as_ref().and_then(|e| e.then.as_ref()));
        thens.push(n.loop_.as_ref().and_then(|l| l.then.as_ref()));
    }
    for then in thens.into_iter().flatten() {
        if !THEN.contains(&then.as_str()) {
            refuse("then".into(), format!("then: {then} (spec §3.9)"));
        }
    }
    out
}
