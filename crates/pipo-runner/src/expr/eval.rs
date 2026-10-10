// Allow-list evaluator for parsed expressions (docs/spec.md §3.2). Ports packages/spec/src/expr/evaluate.ts:
// JavaScript operator semantics (coercion for `+ - * / % < >`), deep strict `==`, and member access that only
// sees own properties. Context values are read in place and cloned only when they are returned.

use serde_json::{Map, Value};

use super::helpers::{self, EvalOptions};
use super::parse::{Ast, BLOCKED_KEYS, Compiled, ExprError, Lit, Prop, parse};
use super::value::{
    JsValue, K, Prim, R, UNDEFINED, array_index, js_insert, number_to_text, prim_number, prim_string, to_js_string,
    to_number, to_primitive, truthy_r, utf16_len,
};

/// An intermediate value: borrowed from the context or the AST, or computed.
pub(crate) enum V<'a> {
    Ref(R<'a>),
    Own(JsValue),
}

impl V<'_> {
    pub(crate) fn r(&self) -> R<'_> {
        match self {
            V::Ref(r) => *r,
            V::Own(v) => R::Js(v),
        }
    }

    fn into_js(self) -> JsValue {
        match self {
            V::Ref(r) => r.to_owned_js(),
            V::Own(v) => v,
        }
    }
}

/// Parse (cached) and evaluate an expression against the context variables (the top-level keys of `ctx`),
/// reading the system clock.
pub fn evaluate(source: &str, ctx: &Value) -> Result<JsValue, ExprError> {
    evaluate_with(source, ctx, &EvalOptions::default())
}

pub fn evaluate_with(source: &str, ctx: &Value, opts: &EvalOptions) -> Result<JsValue, ExprError> {
    let compiled = parse(source)?;
    evaluate_compiled(&compiled, ctx, opts)
}

/// Evaluate an expression that is already parsed.
pub fn evaluate_compiled(c: &Compiled, ctx: &Value, opts: &EvalOptions) -> Result<JsValue, ExprError> {
    let env = Env {
        vars: ctx.as_object(),
        opts,
    };
    Ok(eval(&c.ast, &env)?.into_js())
}

/// JavaScript truthiness: `undefined`, `null`, `false`, `0`, `NaN` and `""` are false.
pub fn truthy(v: &JsValue) -> bool {
    truthy_r(R::Js(v))
}

struct Env<'a, 'o> {
    vars: Option<&'a Map<String, Value>>,
    opts: &'o EvalOptions,
}

fn undefined<'a>() -> V<'a> {
    V::Ref(R::Js(&UNDEFINED))
}

fn eval<'a>(node: &Ast, env: &Env<'a, '_>) -> Result<V<'a>, ExprError> {
    Ok(match node {
        Ast::Literal(lit) => V::Own(match lit {
            Lit::Null => JsValue::Null,
            Lit::Bool(b) => JsValue::Bool(*b),
            Lit::Num(n) => JsValue::Num(*n),
            Lit::Str(s) => JsValue::Str(s.clone()),
        }),
        Ast::Identifier(name) => match env.vars.and_then(|m| m.get(name)) {
            Some(v) => V::Ref(R::Json(v)),
            None => return Err(ExprError::new(format!("'{name}' is not available here"))),
        },
        Ast::Member {
            object,
            property,
            computed,
            ..
        } => {
            let target = eval(object, env)?;
            if *computed {
                let key = eval(property, env)?;
                match property_key(key.r()) {
                    Some(k) => get_member(target, &k),
                    None => undefined(),
                }
            } else {
                match property.as_ref() {
                    Ast::Identifier(name) => get_member(target, name),
                    _ => undefined(),
                }
            }
        }
        Ast::Call { callee, arguments, .. } => {
            let Ast::Identifier(name) = callee.as_ref() else {
                return Err(ExprError::new(
                    "only helper functions can be called, e.g. len(x) rather than x.length()",
                ));
            };
            let args = arguments.iter().map(|a| eval(a, env)).collect::<Result<Vec<_>, _>>()?;
            helpers::call(name, args, env.opts).map_err(ExprError::new)?
        }
        Ast::Unary { operator, argument } => {
            let v = eval(argument, env)?;
            V::Own(match operator.as_str() {
                "!" => JsValue::Bool(!truthy_r(v.r())),
                "-" => JsValue::Num(-to_number(v.r())),
                _ => JsValue::Num(to_number(v.r())),
            })
        }
        Ast::Binary { operator, left, right } => {
            let op = operator.as_str();
            let l = eval(left, env)?;
            match op {
                "&&" => return if truthy_r(l.r()) { eval(right, env) } else { Ok(l) },
                "||" => return if truthy_r(l.r()) { Ok(l) } else { eval(right, env) },
                "??" => return if l.r().is_nullish() { eval(right, env) } else { Ok(l) },
                _ => {}
            }
            let r = eval(right, env)?;
            V::Own(binary(op, l.r(), r.r())?)
        }
        Ast::Conditional {
            test,
            consequent,
            alternate,
        } => {
            if truthy_r(eval(test, env)?.r()) {
                eval(consequent, env)?
            } else {
                eval(alternate, env)?
            }
        }
        Ast::Array(elements) => {
            let mut out = Vec::with_capacity(elements.len());
            for el in elements {
                out.push(match el {
                    Some(el) => eval(el, env)?.into_js(),
                    None => JsValue::Undefined,
                });
            }
            V::Own(JsValue::Array(out))
        }
        Ast::Object(props) => {
            let mut out = indexmap::IndexMap::new();
            for p in props {
                let Prop::Property { key, value, .. } = p else {
                    return Err(ExprError::new(super::parse::OBJECT_ENTRY));
                };
                let key = match key.as_deref() {
                    Some(Ast::Identifier(name)) => name.clone(),
                    Some(Ast::Literal(lit)) => match lit {
                        Lit::Null => "null".into(),
                        Lit::Bool(b) => b.to_string(),
                        Lit::Num(n) => number_to_text(*n),
                        Lit::Str(s) => s.clone(),
                    },
                    _ => "undefined".into(),
                };
                if BLOCKED_KEYS.contains(&key.as_str()) {
                    return Err(ExprError::new(format!("key '{key}' is not allowed")));
                }
                let v = eval(value, env)?.into_js();
                js_insert(&mut out, key, v);
            }
            V::Own(JsValue::Object(out))
        }
        Ast::Compound(_) => return Err(ExprError::new("only a single expression is allowed (found ',' or ';')")),
        Ast::This => return Err(ExprError::new("'ThisExpression' is not allowed in expressions")),
        Ast::Sequence(_) => return Err(ExprError::new("'SequenceExpression' is not allowed in expressions")),
    })
}

/// The property key of a computed access; `None` for a blocked key. Numbers are never blocked.
fn property_key(key: R) -> Option<String> {
    match key.kind() {
        K::Num(n) => Some(number_to_text(n)),
        _ => Some(to_js_string(key)).filter(|k| !BLOCKED_KEYS.contains(&k.as_str())),
    }
}

/// `getMember`: own properties only. Strings and arrays have `length` and their indices; numbers and
/// booleans have none; a missing or null-ish target gives `undefined`.
fn get_member<'a>(target: V<'a>, k: &str) -> V<'a> {
    match target {
        V::Ref(r) => match r.kind() {
            K::Str(s) => string_member(s, k),
            K::Arr(a) => {
                if k == "length" {
                    V::Own(JsValue::Num(a.len() as f64))
                } else {
                    array_index(k)
                        .and_then(|i| a.get(i as usize))
                        .map_or_else(undefined, V::Ref)
                }
            }
            K::Obj(o) => o.get(k).map_or_else(undefined, V::Ref),
            _ => undefined(),
        },
        V::Own(v) => match v {
            JsValue::Str(s) => string_member(&s, k),
            JsValue::Array(mut a) => {
                if k == "length" {
                    return V::Own(JsValue::Num(a.len() as f64));
                }
                match array_index(k).map(|i| i as usize) {
                    Some(i) if i < a.len() => V::Own(a.swap_remove(i)),
                    _ => undefined(),
                }
            }
            JsValue::Object(mut m) => m.swap_remove(k).map_or_else(undefined, V::Own),
            _ => undefined(),
        },
    }
}

/// A string's own properties: `length` and single UTF-16 code units by index (a lone surrogate half becomes
/// U+FFFD, since Rust strings cannot hold one).
fn string_member<'a>(s: &str, k: &str) -> V<'a> {
    if k == "length" {
        return V::Own(JsValue::Num(utf16_len(s) as f64));
    }
    match array_index(k).and_then(|i| s.encode_utf16().nth(i as usize)) {
        Some(unit) => V::Own(JsValue::Str(String::from_utf16_lossy(&[unit]))),
        None => undefined(),
    }
}

/// `deepEqual`: strict for primitives (`NaN` is not equal to itself), structural for arrays and objects.
pub(crate) fn deep_equal(a: R, b: R) -> bool {
    match (a.kind(), b.kind()) {
        (K::Undef, K::Undef) | (K::Null, K::Null) => true,
        (K::Bool(x), K::Bool(y)) => x == y,
        (K::Num(x), K::Num(y)) => x == y,
        (K::Str(x), K::Str(y)) => x == y,
        (K::Arr(x), K::Arr(y)) => x.len() == y.len() && x.iter().zip(y.iter()).all(|(p, q)| deep_equal(p, q)),
        (K::Obj(x), K::Obj(y)) => {
            x.len() == y.len()
                && x.entries()
                    .into_iter()
                    .all(|(k, v)| deep_equal(v, y.get(k).unwrap_or(R::Js(&UNDEFINED))))
        }
        _ => false,
    }
}

/// `x in y`: an array holding `x`, a string containing the substring `x`, or an object with the own key `x`.
fn contains(collection: R, item: R) -> bool {
    match collection.kind() {
        K::Arr(a) => a.iter().any(|x| deep_equal(x, item)),
        K::Str(s) => matches!(item.kind(), K::Str(i) if s.contains(i)),
        K::Obj(o) => o.get(&to_js_string(item)).is_some(),
        _ => false,
    }
}

/// The abstract relational comparison `a < b`: `None` when either side is NaN.
fn less_than(a: &Prim, b: &Prim) -> Option<bool> {
    if let (Prim::Str(x), Prim::Str(y)) = (a, b) {
        return Some(x.encode_utf16().lt(y.encode_utf16()));
    }
    let (x, y) = (prim_number(a), prim_number(b));
    if x.is_nan() || y.is_nan() { None } else { Some(x < y) }
}

fn binary(op: &str, l: R, r: R) -> Result<JsValue, ExprError> {
    Ok(match op {
        "==" | "===" => JsValue::Bool(deep_equal(l, r)),
        "!=" | "!==" => JsValue::Bool(!deep_equal(l, r)),
        "<" | ">" | "<=" | ">=" => {
            let (a, b) = (to_primitive(l), to_primitive(r));
            JsValue::Bool(match op {
                "<" => less_than(&a, &b) == Some(true),
                ">" => less_than(&b, &a) == Some(true),
                "<=" => less_than(&b, &a) == Some(false),
                _ => less_than(&a, &b) == Some(false),
            })
        }
        "+" => {
            let (a, b) = (to_primitive(l), to_primitive(r));
            if matches!(a, Prim::Str(_)) || matches!(b, Prim::Str(_)) {
                JsValue::Str(prim_string(&a) + &prim_string(&b))
            } else {
                JsValue::Num(prim_number(&a) + prim_number(&b))
            }
        }
        "-" => JsValue::Num(to_number(l) - to_number(r)),
        "*" => JsValue::Num(to_number(l) * to_number(r)),
        "/" => JsValue::Num(to_number(l) / to_number(r)),
        "%" => JsValue::Num(to_number(l) % to_number(r)),
        "in" => JsValue::Bool(contains(r, l)),
        _ => return Err(ExprError::new(format!("operator '{op}' is not allowed"))),
    })
}
