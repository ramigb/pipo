// Pipo's expression language (docs/spec.md §3.2): a port of @pipo/spec's expr (jsep subset, evaluator, helpers,
// templates). packages/spec/test/fixtures/expr-cases.json is the conformance suite both implementations run.
//
// The context is a JSON object whose top-level keys are the variables (`data`, `meta`, `env`, …). Results are
// `JsValue`s, which keep `undefined` apart from `null`; `JsValue::to_json` converts as JSON.stringify does.
// `now()` and `iso()` read the clock in `EvalOptions` (the `*_with` functions); the others use the system clock.

mod eval;
mod helpers;
mod parse;
mod template;
mod value;

pub use eval::{evaluate, evaluate_compiled, evaluate_with, truthy};
pub use helpers::{Clock, EvalOptions};
pub use parse::{
    Ast, BLOCKED_KEYS, Compiled, ExprError, LIMIT_DEPTH, LIMIT_NODES, LIMIT_SOURCE_LENGTH, Lit, Prop, parse,
};
pub use template::{Segment, render, render_string, render_string_with, render_with, segments, template_expressions};
pub use value::{JsValue, js_json, js_number, number_to_text, to_text};

#[cfg(test)]
pub(crate) use helpers::iso_string;
pub(crate) use value::{is_js_space, js_trim};

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_fixed_clock_holds_on_other_threads() {
        let opts = EvalOptions {
            clock: Clock::Fixed(1_767_225_600_000.0),
        };
        let iso = std::thread::spawn(move || evaluate_with("iso()", &json!({}), &opts))
            .join()
            .unwrap();
        assert_eq!(iso, Ok(JsValue::Str("2026-01-01T00:00:00.000Z".into())));
        assert_eq!(
            evaluate_with("now()", &json!({}), &opts),
            Ok(JsValue::Num(1_767_225_600_000.0))
        );
        let JsValue::Num(now) = evaluate("now()", &json!({})).unwrap() else {
            panic!()
        };
        assert!(now > 1.7e12);
    }

    #[test]
    fn render_follows_json_stringify() {
        let ctx = json!({ "data": { "age": 36 } });
        let with = json!({ "a": "${data.x}", "b": ["${data.x}", "${data.age}"], "c": "${0.5 + 1}", "d": "n=${1e21}" });
        let out = render(&with, &ctx).unwrap();
        assert_eq!(js_json(&out), r#"{"b":[null,36],"c":1.5,"d":"n=1e+21"}"#);
        assert_eq!(render(&json!("${data.x}"), &ctx).unwrap(), serde_json::Value::Null);
        assert_eq!(render_string("${data.age}", &ctx).unwrap(), JsValue::Num(36.0));
    }

    #[test]
    fn text_and_json_use_javascript_forms() {
        assert_eq!(to_text(&json!(null)), "");
        assert_eq!(to_text(&json!("s")), "s");
        assert_eq!(to_text(&json!(36)), "36");
        assert_eq!(to_text(&json!(1e21)), "1e+21");
        assert_eq!(
            to_text(&json!({ "b": [1, "x"], "1": true })),
            r#"{"1":true,"b":[1,"x"]}"#
        );
        assert_eq!(js_json(&json!("a\"\n\u{1}")), r#""a\"\n\u0001""#);
        assert_eq!(js_number(2.0), json!(2));
    }

    #[test]
    fn values_convert_both_ways() {
        let v = json!({ "a": [1, 2.5, null, "x"], "b": { "c": false } });
        assert_eq!(JsValue::from_json(&v).to_json(), v);
        assert!(truthy(&JsValue::Str(" ".into())));
        assert!(!truthy(&JsValue::Num(f64::NAN)));
        assert!(!truthy(&JsValue::Undefined));
    }

    #[test]
    fn errors_display_their_message() {
        let e = evaluate("data.a = 1", &json!({ "data": {} })).unwrap_err();
        assert_eq!(e.to_string(), "Unexpected \"=\"");
        assert_eq!(e.index, Some(7));
        assert_eq!(segments("a ${b").unwrap_err().index, Some(2));
    }
}
