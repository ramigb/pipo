// TEMPORARY stand-in until the expr port merges: no expressions, templates pass through unrendered.
#![allow(unused)]
use serde_json::Value;
#[derive(Debug, Clone)]
pub struct ExprError(pub String);
impl std::fmt::Display for ExprError { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.0) } }
#[derive(Debug, Clone, PartialEq)]
pub enum JsValue { Undefined, Json(Value) }
impl JsValue {
    pub fn to_json(&self) -> Value { match self { JsValue::Undefined => Value::Null, JsValue::Json(v) => v.clone() } }
    pub fn from_json(v: &Value) -> JsValue { JsValue::Json(v.clone()) }
}
pub fn evaluate(source: &str, ctx: &Value) -> Result<JsValue, ExprError> { Err(ExprError("expressions are not merged yet".into())) }
pub fn truthy(v: &JsValue) -> bool { !matches!(v, JsValue::Undefined | JsValue::Json(Value::Null) | JsValue::Json(Value::Bool(false))) }
pub fn render(value: &Value, ctx: &Value) -> Result<Value, ExprError> { Ok(value.clone()) }
pub fn render_string(input: &str, ctx: &Value) -> Result<JsValue, ExprError> { Ok(JsValue::Json(Value::String(input.into()))) }
pub fn to_text(v: &Value) -> String { match v { Value::Null => String::new(), Value::String(s) => s.clone(), other => other.to_string() } }
pub fn js_number(f: f64) -> Value { if f.fract() == 0.0 && f.abs() < 9e15 { Value::from(f as i64) } else { Value::from(f) } }
pub fn js_json(v: &Value) -> String { v.to_string() }
