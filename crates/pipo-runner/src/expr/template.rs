// `${expr}` templates (docs/spec.md §3.2). Ports packages/spec/src/expr/template.ts. A value that is exactly one
// `${expr}` keeps the expression's type; anything else renders to a string. `$${` escapes a literal `${`.

use serde_json::Value;

use super::eval::evaluate_with;
use super::helpers::EvalOptions;
use super::parse::ExprError;
use super::value::{JsValue, R, ordered_keys, text_of};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Segment {
    Text(String),
    /// `offset` is where the expression starts in the input (UTF-16 code units, as in JavaScript).
    Expr {
        expr: String,
        offset: usize,
    },
}

const DOLLAR: u16 = b'$' as u16;
const OPEN: u16 = b'{' as u16;
const CLOSE: u16 = b'}' as u16;

/// Split a string into literal text and `${…}` expressions, honouring nested braces and quotes.
pub fn segments(input: &str) -> Result<Vec<Segment>, ExprError> {
    let s: Vec<u16> = input.encode_utf16().collect();
    let mut out = vec![];
    let mut text: Vec<u16> = vec![];
    let mut i = 0;
    while i < s.len() {
        if s[i..].starts_with(&[DOLLAR, DOLLAR, OPEN]) {
            text.extend([DOLLAR, OPEN]);
            i += 3;
            continue;
        }
        if !s[i..].starts_with(&[DOLLAR, OPEN]) {
            text.push(s[i]);
            i += 1;
            continue;
        }
        let start = i + 2;
        let mut depth = 1;
        let mut quote: Option<u16> = None;
        let mut j = start;
        while j < s.len() && depth > 0 {
            let c = s[j];
            match quote {
                Some(q) => {
                    if c == b'\\' as u16 {
                        j += 1;
                    } else if c == q {
                        quote = None;
                    }
                }
                None if c == b'"' as u16 || c == b'\'' as u16 => quote = Some(c),
                None if c == OPEN => depth += 1,
                None if c == CLOSE => depth -= 1,
                None => {}
            }
            j += 1;
        }
        if depth > 0 {
            return Err(ExprError::at("unclosed '${' in template", i));
        }
        if !text.is_empty() {
            out.push(Segment::Text(String::from_utf16_lossy(&text)));
            text.clear();
        }
        out.push(Segment::Expr {
            expr: String::from_utf16_lossy(&s[start..j - 1]),
            offset: start,
        });
        i = j;
    }
    if !text.is_empty() {
        out.push(Segment::Text(String::from_utf16_lossy(&text)));
    }
    Ok(out)
}

/// Every expression inside a template string.
pub fn template_expressions(input: &str) -> Result<Vec<String>, ExprError> {
    Ok(segments(input)?
        .into_iter()
        .filter_map(|s| match s {
            Segment::Expr { expr, .. } => Some(expr),
            Segment::Text(_) => None,
        })
        .collect())
}

pub fn render_string(input: &str, ctx: &Value) -> Result<JsValue, ExprError> {
    render_string_with(input, ctx, &EvalOptions::default())
}

pub fn render_string_with(input: &str, ctx: &Value, opts: &EvalOptions) -> Result<JsValue, ExprError> {
    let parts = segments(input)?;
    if let [Segment::Expr { expr, .. }] = parts.as_slice() {
        return evaluate_with(expr, ctx, opts);
    }
    let mut out = String::new();
    for part in parts {
        match part {
            Segment::Text(t) => out.push_str(&t),
            Segment::Expr { expr, .. } => out.push_str(&text_of(R::Js(&evaluate_with(&expr, ctx, opts)?))),
        }
    }
    Ok(JsValue::Str(out))
}

/// Render templates in every string of a value, recursively (used for `with:` blocks). A string that renders
/// to `undefined` is dropped from its object, and is `null` in an array or at the top, as in JSON.stringify.
pub fn render(value: &Value, ctx: &Value) -> Result<Value, ExprError> {
    render_with(value, ctx, &EvalOptions::default())
}

pub fn render_with(value: &Value, ctx: &Value, opts: &EvalOptions) -> Result<Value, ExprError> {
    Ok(walk(value, ctx, opts)?.unwrap_or(Value::Null))
}

fn walk(value: &Value, ctx: &Value, opts: &EvalOptions) -> Result<Option<Value>, ExprError> {
    Ok(match value {
        Value::String(s) => match render_string_with(s, ctx, opts)? {
            JsValue::Undefined => None,
            v => Some(v.to_json()),
        },
        Value::Array(items) => Some(Value::Array(
            items
                .iter()
                .map(|v| Ok(walk(v, ctx, opts)?.unwrap_or(Value::Null)))
                .collect::<Result<_, ExprError>>()?,
        )),
        Value::Object(m) => {
            let mut out = serde_json::Map::new();
            for k in ordered_keys(m.keys()) {
                if let Some(v) = walk(&m[k], ctx, opts)? {
                    out.insert(k.clone(), v);
                }
            }
            Some(Value::Object(out))
        }
        other => Some(other.clone()),
    })
}
