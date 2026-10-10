// Runs the expression conformance suite (packages/spec/test/fixtures/expr-cases.json, docs/spec.md §3.2) against
// the Rust port. The case format is described in packages/spec/test/expr.test.ts, which runs the same file on TS.

use pipo_runner::expr::{
    Clock, EvalOptions, ExprError, JsValue, Segment, evaluate_with, render_string_with, render_with, segments,
};
use serde_json::{Value, json};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/spec/test/fixtures/expr-cases.json"
);

/// The expected value, with `{"$undefined": true}` and `{"$number": "NaN"}` (etc.) decoded.
fn decode(v: &Value) -> JsValue {
    match v {
        Value::Array(items) => JsValue::Array(items.iter().map(decode).collect()),
        Value::Object(m) if m.len() == 1 && m.contains_key("$undefined") => JsValue::Undefined,
        Value::Object(m) if m.len() == 1 && m.contains_key("$number") => JsValue::Num(match m["$number"].as_str() {
            Some("NaN") => f64::NAN,
            Some("Infinity") => f64::INFINITY,
            Some("-Infinity") => f64::NEG_INFINITY,
            Some("-0") => -0.0,
            other => panic!("bad $number {other:?}"),
        }),
        Value::Object(m) => JsValue::Object(m.iter().map(|(k, v)| (k.clone(), decode(v))).collect()),
        other => JsValue::from_json(other),
    }
}

/// `toStrictEqual`: NaN equals NaN, -0 differs from 0, and object key order does not matter.
fn same(a: &JsValue, b: &JsValue) -> bool {
    match (a, b) {
        (JsValue::Num(x), JsValue::Num(y)) => {
            (x.is_nan() && y.is_nan()) || (x == y && x.is_sign_negative() == y.is_sign_negative())
        }
        (JsValue::Array(x), JsValue::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (JsValue::Object(x), JsValue::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

fn segment_json(s: &Segment) -> Value {
    match s {
        Segment::Text(text) => json!({ "text": text }),
        Segment::Expr { expr, offset } => json!({ "expr": expr, "offset": offset }),
    }
}

fn run(case: &Value, opts: &EvalOptions) -> Result<JsValue, ExprError> {
    let ctx = case.get("ctx").cloned().unwrap_or_else(|| json!({}));
    if let Some(src) = case.get("expr").and_then(Value::as_str) {
        return evaluate_with(src, &ctx, opts);
    }
    if let Some(src) = case.get("template").and_then(Value::as_str) {
        return render_string_with(src, &ctx, opts);
    }
    if let Some(src) = case.get("segments").and_then(Value::as_str) {
        let parts = segments(src)?;
        return Ok(JsValue::from_json(&Value::Array(
            parts.iter().map(segment_json).collect(),
        )));
    }
    let value = case.get("render").expect("case has expr, template, render or segments");
    Ok(JsValue::from_json(&render_with(value, &ctx, opts)?))
}

#[test]
fn conformance() {
    let text = std::fs::read_to_string(FIXTURE).expect("read the fixture");
    let cases: Vec<Value> = serde_json::from_str(&text).expect("parse the fixture");
    assert!(cases.len() > 500, "the fixture has {} cases", cases.len());
    let mut failures = vec![];
    for case in &cases {
        let name = case["name"].as_str().unwrap_or("?");
        let clock = case
            .get("now")
            .and_then(Value::as_f64)
            .map_or(Clock::System, Clock::Fixed);
        let got = run(case, &EvalOptions { clock });
        let problem = match (case.get("error").and_then(Value::as_str), &got) {
            (None, Ok(v)) => {
                let want = decode(&case["expect"]);
                (!same(v, &want)).then(|| format!("got {v:?}, want {want:?}"))
            }
            (None, Err(e)) => Some(format!("failed: {e}")),
            (Some(want), Ok(v)) => Some(format!("got {v:?}, want an error containing {want:?}")),
            (Some(want), Err(e)) => {
                let index = case.get("index").and_then(Value::as_u64).map(|i| i as usize);
                if !e.message.contains(want) {
                    Some(format!("error {:?}, want one containing {want:?}", e.message))
                } else if index.is_some() && e.index != index {
                    Some(format!("error at {:?}, want {index:?}", e.index))
                } else {
                    None
                }
            }
        };
        if let Some(p) = problem {
            failures.push(format!("{name}: {p}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases fail:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}
