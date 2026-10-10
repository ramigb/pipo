// JavaScript values for the expression evaluator (docs/spec.md §3.2): `undefined` vs `null`, f64 numbers,
// `String(n)` and `JSON.stringify` number formatting, own-key order, and conversion to and from serde_json.

use indexmap::IndexMap;
use serde_json::{Map, Number, Value};

/// A value as the TS evaluator sees it. Objects keep JavaScript's key order: array-index keys first, ascending,
/// then the rest in insertion order. `PartialEq` is structural (so `NaN != NaN`), not the language's `==`.
#[derive(Clone, Debug, PartialEq)]
pub enum JsValue {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Array(Vec<JsValue>),
    Object(IndexMap<String, JsValue>),
}

pub(crate) static UNDEFINED: JsValue = JsValue::Undefined;

impl JsValue {
    /// JSON.stringify semantics: `undefined` is `null` at the top and in arrays and is dropped from objects;
    /// NaN and ±Infinity are `null`.
    pub fn to_json(&self) -> Value {
        self.to_json_opt().unwrap_or(Value::Null)
    }

    fn to_json_opt(&self) -> Option<Value> {
        Some(match self {
            JsValue::Undefined => return None,
            JsValue::Null => Value::Null,
            JsValue::Bool(b) => Value::Bool(*b),
            JsValue::Num(n) => js_number(*n),
            JsValue::Str(s) => Value::String(s.clone()),
            JsValue::Array(items) => Value::Array(items.iter().map(JsValue::to_json).collect()),
            JsValue::Object(m) => Value::Object(
                m.iter()
                    .filter_map(|(k, v)| v.to_json_opt().map(|v| (k.clone(), v)))
                    .collect(),
            ),
        })
    }

    pub fn from_json(v: &Value) -> JsValue {
        match v {
            Value::Null => JsValue::Null,
            Value::Bool(b) => JsValue::Bool(*b),
            Value::Number(n) => JsValue::Num(json_f64(n)),
            Value::String(s) => JsValue::Str(s.clone()),
            Value::Array(items) => JsValue::Array(items.iter().map(JsValue::from_json).collect()),
            Value::Object(m) => {
                let mut out = IndexMap::with_capacity(m.len());
                for k in ordered_keys(m.keys()) {
                    out.insert(k.clone(), JsValue::from_json(&m[k]));
                }
                JsValue::Object(out)
            }
        }
    }
}

pub(crate) fn json_f64(n: &Number) -> f64 {
    n.as_f64().unwrap_or(f64::NAN)
}

/// A number as a serde_json value: an integer when it is integral and within ±2^53, else a float. NaN and
/// ±Infinity become `null`, as in JSON.stringify.
pub fn js_number(f: f64) -> Value {
    const MAX_SAFE: f64 = 9_007_199_254_740_992.0;
    if !f.is_finite() {
        return Value::Null;
    }
    if f.fract() == 0.0 && f.abs() <= MAX_SAFE {
        return Value::Number(Number::from(f as i64));
    }
    Number::from_f64(f).map_or(Value::Null, Value::Number)
}

/// `String(n)` in JavaScript (Number::toString): shortest round-trip digits, exponent form outside 1e-7..1e21.
pub fn number_to_text(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f == 0.0 {
        return "0".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if f < 0.0 {
        return format!("-{}", number_to_text(-f));
    }
    let sci = format!("{f:e}");
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e >= 0 { '+' } else { '-' };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    }
}

/// JSON.stringify of a serde_json value, with JavaScript number formatting and key order.
pub fn js_json(v: &Value) -> String {
    let mut out = String::new();
    stringify(R::Json(v), &mut out);
    out
}

/// `toText` of template.ts: null → "", strings as they are, objects and arrays as JSON, numbers as `String(n)`.
pub fn to_text(v: &Value) -> String {
    text_of(R::Json(v))
}

pub(crate) fn text_of(r: R) -> String {
    match r.kind() {
        K::Undef | K::Null => String::new(),
        K::Str(s) => s.to_string(),
        K::Arr(_) | K::Obj(_) => {
            let mut out = String::new();
            stringify(r, &mut out);
            out
        }
        _ => to_js_string(r),
    }
}

/// JavaScript's WhiteSpace and LineTerminator characters (what `trim()` and `\s` use).
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// The integer value of a canonical array-index key ("0", "17"; not "01" or "-0"), below 2^32 - 1.
pub(crate) fn array_index(k: &str) -> Option<u32> {
    let b = k.as_bytes();
    if b.is_empty() || b.len() > 10 || !b.iter().all(u8::is_ascii_digit) || (b.len() > 1 && b[0] == b'0') {
        return None;
    }
    k.parse::<u64>().ok().filter(|n| *n < u32::MAX as u64).map(|n| n as u32)
}

/// Keys in JavaScript's own-property order: array indices ascending, then the rest as given.
pub(crate) fn ordered_keys<'m>(keys: impl Iterator<Item = &'m String>) -> Vec<&'m String> {
    let keys: Vec<&String> = keys.collect();
    if !keys.iter().any(|k| array_index(k).is_some()) {
        return keys;
    }
    let mut indices: Vec<(u32, &String)> = keys.iter().filter_map(|k| array_index(k).map(|i| (i, *k))).collect();
    indices.sort_by_key(|(i, _)| *i);
    let mut out: Vec<&String> = indices.into_iter().map(|(_, k)| k).collect();
    out.extend(keys.into_iter().filter(|k| array_index(k).is_none()));
    out
}

/// Set a key the way assignment to a JavaScript object does: an existing key keeps its place.
pub(crate) fn js_insert(m: &mut IndexMap<String, JsValue>, k: String, v: JsValue) {
    if let Some(slot) = m.get_mut(&k) {
        *slot = v;
        return;
    }
    match array_index(&k) {
        Some(i) => {
            let at = m.keys().take_while(|x| array_index(x).is_some_and(|j| j < i)).count();
            m.shift_insert(at, k, v);
        }
        None => {
            m.insert(k, v);
        }
    }
}

/// A borrowed view of a value from either the context (serde_json) or the evaluator (JsValue).
#[derive(Clone, Copy, Debug)]
pub(crate) enum R<'a> {
    Js(&'a JsValue),
    Json(&'a Value),
}

pub(crate) enum K<'a> {
    Undef,
    Null,
    Bool(bool),
    Num(f64),
    Str(&'a str),
    Arr(Arr<'a>),
    Obj(Obj<'a>),
}

#[derive(Clone, Copy)]
pub(crate) enum Arr<'a> {
    Js(&'a [JsValue]),
    Json(&'a [Value]),
}

#[derive(Clone, Copy)]
pub(crate) enum Obj<'a> {
    Js(&'a IndexMap<String, JsValue>),
    Json(&'a Map<String, Value>),
}

impl<'a> R<'a> {
    pub(crate) fn kind(self) -> K<'a> {
        match self {
            R::Js(v) => match v {
                JsValue::Undefined => K::Undef,
                JsValue::Null => K::Null,
                JsValue::Bool(b) => K::Bool(*b),
                JsValue::Num(n) => K::Num(*n),
                JsValue::Str(s) => K::Str(s),
                JsValue::Array(a) => K::Arr(Arr::Js(a)),
                JsValue::Object(o) => K::Obj(Obj::Js(o)),
            },
            R::Json(v) => match v {
                Value::Null => K::Null,
                Value::Bool(b) => K::Bool(*b),
                Value::Number(n) => K::Num(json_f64(n)),
                Value::String(s) => K::Str(s),
                Value::Array(a) => K::Arr(Arr::Json(a)),
                Value::Object(o) => K::Obj(Obj::Json(o)),
            },
        }
    }

    pub(crate) fn is_nullish(self) -> bool {
        matches!(self.kind(), K::Undef | K::Null)
    }

    pub(crate) fn to_owned_js(self) -> JsValue {
        match self {
            R::Js(v) => v.clone(),
            R::Json(v) => JsValue::from_json(v),
        }
    }
}

impl<'a> Arr<'a> {
    pub(crate) fn len(self) -> usize {
        match self {
            Arr::Js(a) => a.len(),
            Arr::Json(a) => a.len(),
        }
    }

    pub(crate) fn get(self, i: usize) -> Option<R<'a>> {
        match self {
            Arr::Js(a) => a.get(i).map(R::Js),
            Arr::Json(a) => a.get(i).map(R::Json),
        }
    }

    pub(crate) fn iter(self) -> impl Iterator<Item = R<'a>> {
        (0..self.len()).filter_map(move |i| self.get(i))
    }
}

impl<'a> Obj<'a> {
    pub(crate) fn len(self) -> usize {
        match self {
            Obj::Js(m) => m.len(),
            Obj::Json(m) => m.len(),
        }
    }

    pub(crate) fn get(self, k: &str) -> Option<R<'a>> {
        match self {
            Obj::Js(m) => m.get(k).map(R::Js),
            Obj::Json(m) => m.get(k).map(R::Json),
        }
    }

    /// Entries in JavaScript key order.
    pub(crate) fn entries(self) -> Vec<(&'a String, R<'a>)> {
        match self {
            Obj::Js(m) => m.iter().map(|(k, v)| (k, R::Js(v))).collect(),
            Obj::Json(m) => ordered_keys(m.keys())
                .into_iter()
                .map(|k| (k, R::Json(&m[k])))
                .collect(),
        }
    }
}

pub(crate) fn truthy_r(r: R) -> bool {
    match r.kind() {
        K::Undef | K::Null => false,
        K::Bool(b) => b,
        K::Num(n) => !(n == 0.0 || n.is_nan()),
        K::Str(s) => !s.is_empty(),
        K::Arr(_) | K::Obj(_) => true,
    }
}

/// `String(v)`. Arrays join their items with "," (null and undefined as ""), objects are "[object Object]".
pub(crate) fn to_js_string(r: R) -> String {
    match r.kind() {
        K::Undef => "undefined".into(),
        K::Null => "null".into(),
        K::Bool(b) => b.to_string(),
        K::Num(n) => number_to_text(n),
        K::Str(s) => s.to_string(),
        K::Arr(a) => {
            let parts: Vec<String> = a
                .iter()
                .map(|x| if x.is_nullish() { String::new() } else { to_js_string(x) })
                .collect();
            parts.join(",")
        }
        K::Obj(_) => "[object Object]".into(),
    }
}

/// ToPrimitive: arrays and objects become their string form; everything else is already primitive.
pub(crate) enum Prim {
    Undef,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
}

pub(crate) fn to_primitive(r: R) -> Prim {
    match r.kind() {
        K::Undef => Prim::Undef,
        K::Null => Prim::Null,
        K::Bool(b) => Prim::Bool(b),
        K::Num(n) => Prim::Num(n),
        K::Str(s) => Prim::Str(s.to_string()),
        K::Arr(_) | K::Obj(_) => Prim::Str(to_js_string(r)),
    }
}

pub(crate) fn prim_number(p: &Prim) -> f64 {
    match p {
        Prim::Undef => f64::NAN,
        Prim::Null => 0.0,
        Prim::Bool(b) => f64::from(u8::from(*b)),
        Prim::Num(n) => *n,
        Prim::Str(s) => string_to_number(s),
    }
}

pub(crate) fn prim_string(p: &Prim) -> String {
    match p {
        Prim::Undef => "undefined".into(),
        Prim::Null => "null".into(),
        Prim::Bool(b) => b.to_string(),
        Prim::Num(n) => number_to_text(*n),
        Prim::Str(s) => s.clone(),
    }
}

pub(crate) fn to_number(r: R) -> f64 {
    prim_number(&to_primitive(r))
}

/// StringToNumber: trimmed decimal literal, 0x/0o/0b integers, ±Infinity; "" is 0; anything else is NaN.
pub(crate) fn string_to_number(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let b = t.as_bytes();
    if b.len() > 2 && b[0] == b'0' {
        let radix = match b[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix != 0 {
            return radix_number(&t[2..], radix);
        }
    }
    if decimal_literal(b) {
        t.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

fn radix_number(digits: &str, radix: u32) -> f64 {
    if let Ok(n) = u128::from_str_radix(digits, radix) {
        return n as f64;
    }
    let mut acc = 0.0f64;
    for c in digits.chars() {
        match c.to_digit(radix) {
            Some(d) => acc = acc * f64::from(radix) + f64::from(d),
            None => return f64::NAN,
        }
    }
    acc
}

/// `[+-]? (digits ('.' digits*)? | '.' digits) ([eE] [+-]? digits)?`
fn decimal_literal(b: &[u8]) -> bool {
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut digits = i - int_start;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        digits += i - frac_start;
    }
    if digits == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let exp_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return false;
        }
    }
    i == b.len()
}

/// JSON.stringify. Returns false (and writes nothing) for `undefined`.
pub(crate) fn stringify(r: R, out: &mut String) -> bool {
    match r.kind() {
        K::Undef => return false,
        K::Null => out.push_str("null"),
        K::Bool(b) => out.push_str(if b { "true" } else { "false" }),
        K::Num(n) => {
            if n.is_finite() {
                out.push_str(&number_to_text(n));
            } else {
                out.push_str("null");
            }
        }
        K::Str(s) => quote(s, out),
        K::Arr(a) => {
            out.push('[');
            for (i, item) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if !stringify(item, out) {
                    out.push_str("null");
                }
            }
            out.push(']');
        }
        K::Obj(o) => {
            out.push('{');
            let mut first = true;
            for (k, v) in o.entries() {
                if matches!(v.kind(), K::Undef) {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                quote(k, out);
                out.push(':');
                stringify(v, out);
            }
            out.push('}');
        }
    }
    true
}

fn quote(s: &str, out: &mut String) {
    // serde_json escapes exactly what JSON.stringify does: quote, backslash and control characters.
    out.push_str(&serde_json::to_string(s).unwrap_or_default());
}

/// `typeOf` of helpers.ts: "null" and "array" are their own types.
pub(crate) fn type_of(r: R) -> &'static str {
    match r.kind() {
        K::Undef => "undefined",
        K::Null => "null",
        K::Bool(_) => "boolean",
        K::Num(_) => "number",
        K::Str(_) => "string",
        K::Arr(_) => "array",
        K::Obj(_) => "object",
    }
}

pub(crate) fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_like_javascript() {
        let cases: [(f64, &str); 14] = [
            (1.0, "1"),
            (-0.0, "0"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123e-20, "1.23e-18"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (-1.5e-7, "-1.5e-7"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (123456789.125, "123456789.125"),
            (f64::NAN, "NaN"),
            (f64::NEG_INFINITY, "-Infinity"),
        ];
        for (f, s) in cases {
            assert_eq!(number_to_text(f), s, "{f:?}");
        }
    }

    #[test]
    fn numbers_become_json_integers_when_integral() {
        assert_eq!(js_number(36.0).to_string(), "36");
        assert_eq!(js_number(-0.0).to_string(), "0");
        assert_eq!(js_number(1.5).to_string(), "1.5");
        assert_eq!(js_number(f64::NAN), Value::Null);
        assert_eq!(js_json(&js_number(1e21)), "1e+21");
        assert!(js_number(9_007_199_254_740_992.0).is_i64());
        assert!(js_number(18_014_398_509_481_984.0).is_f64());
    }

    #[test]
    fn strings_convert_like_number() {
        let cases: [(&str, f64); 12] = [
            (" 12 ", 12.0),
            ("", 0.0),
            ("0x10", 16.0),
            ("0b101", 5.0),
            ("0o17", 15.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("+5", 5.0),
            ("1e3", 1000.0),
            ("-Infinity", f64::NEG_INFINITY),
            ("\u{FEFF}7\u{A0}", 7.0),
            ("1_0", f64::NAN),
        ];
        for (s, n) in cases {
            let got = string_to_number(s);
            assert!(got == n || (got.is_nan() && n.is_nan()), "{s:?} -> {got}");
        }
        for s in ["inf", "-0x10", "1e", "nan", "0x", "."] {
            assert!(string_to_number(s).is_nan(), "{s:?}");
        }
    }

    #[test]
    fn objects_order_index_keys_first() {
        let v: Value = serde_json::from_str(r#"{"b":1,"2":2,"a":3,"1":4,"01":5}"#).unwrap();
        assert_eq!(js_json(&v), r#"{"1":4,"2":2,"b":1,"a":3,"01":5}"#);
        let mut m = IndexMap::new();
        for (k, v) in [("b", 1.0), ("2", 2.0), ("1", 3.0), ("b", 4.0)] {
            js_insert(&mut m, k.into(), JsValue::Num(v));
        }
        assert_eq!(m.keys().map(String::as_str).collect::<Vec<_>>(), ["1", "2", "b"]);
        assert_eq!(m["b"], JsValue::Num(4.0));
    }

    #[test]
    fn to_json_follows_json_stringify() {
        let mut m = IndexMap::new();
        m.insert("a".to_string(), JsValue::Undefined);
        m.insert(
            "b".to_string(),
            JsValue::Array(vec![JsValue::Undefined, JsValue::Num(f64::INFINITY)]),
        );
        assert_eq!(JsValue::Object(m).to_json().to_string(), r#"{"b":[null,null]}"#);
        assert_eq!(JsValue::Undefined.to_json(), Value::Null);
    }
}
