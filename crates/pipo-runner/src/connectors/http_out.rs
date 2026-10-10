// `to: http` (docs/spec.md §3.5, §3.10). Port of http-output.ts. Sends `Idempotency-Key: <packet_id>` so a retried
// or recovered write is safe for receivers that honour it. A status outside `success` is an error, which flows into
// the output's error policy (retry, then dead-letter, …). Also `http_call`, shared with the http tap and transform.

use super::{LocalBoxFuture, OutputAdapter, WriteItem, http_client, http_error, string_of};
use crate::expr::{js_json, to_text};
use serde_json::{Map, Value, json};
use std::time::Duration;

const TIMEOUT_MS: u64 = 30_000;
const FOLLOW_UP_TIMEOUT_MS: u64 = 5_000;

/// Accepts 204, "204", "2xx" and "200-299"; the default is 200-299.
pub fn status_matcher(spec: Option<&Value>) -> Result<impl Fn(u16) -> bool + use<>, String> {
    let default = vec![json!("200-299")];
    let list = match spec.and_then(|s| s.as_array()) {
        Some(a) if !a.is_empty() => a.clone(),
        _ => default,
    };
    let mut ranges: Vec<(u16, u16)> = vec![];
    for s in &list {
        let text = string_of(s).trim().to_lowercase();
        let digits = |t: &str| t.len() == 3 && t.bytes().all(|b| b.is_ascii_digit());
        let bytes = text.as_bytes();
        if digits(&text) {
            let n: u16 = text.parse().unwrap_or(0);
            ranges.push((n, n));
        } else if text.len() == 3 && (b'1'..=b'5').contains(&bytes[0]) && &text[1..] == "xx" {
            let c = (bytes[0] - b'0') as u16;
            ranges.push((c * 100, c * 100 + 99));
        } else if let Some((a, b)) =
            text.split_once('-').map(|(a, b)| (a.trim(), b.trim())).filter(|(a, b)| digits(a) && digits(b))
        {
            ranges.push((a.parse().unwrap_or(0), b.parse().unwrap_or(0)));
        } else {
            return Err(format!("invalid success status '{}'; use 204, \"2xx\" or \"200-299\"", string_of(s)));
        }
    }
    Ok(move |n: u16| ranges.iter().any(|(lo, hi)| n >= *lo && n <= *hi))
}

/// JS `want === got` for JSON values: numbers compare by value.
fn same(want: &Value, got: &Value) -> bool {
    match (want, got) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        _ => want == got,
    }
}

fn subset(want: &Value, got: &Value) -> bool {
    match want {
        Value::Array(w) => got.as_array().is_some_and(|g| w.iter().all(|x| g.iter().any(|y| subset(x, y)))),
        Value::Object(w) => {
            got.as_object().is_some_and(|g| w.iter().all(|(k, v)| g.get(k).is_some_and(|x| subset(v, x))))
        }
        _ => same(want, got),
    }
}

/// JS `String(v)`: arrays join their items with commas, objects are "[object Object]".
fn js_string(v: &Value) -> String {
    match v {
        Value::Array(a) => {
            a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(",")
        }
        Value::Object(_) => "[object Object]".into(),
        other => string_of(other),
    }
}

/// `match` is text the body must contain, or (object/number/bool) a JSON subset the parsed body must include.
fn body_matches(body: &str, m: &Value) -> bool {
    if let Value::String(s) = m {
        return body.contains(s.as_str());
    }
    match serde_json::from_str::<Value>(body) {
        Ok(parsed) => subset(m, &parsed),
        Err(_) => body.contains(&js_string(m)),
    }
}

pub struct HttpResult {
    pub status: u16,
    pub text: String,
    pub content_type: String,
}

/// One request from an http `with:` block (output, tap or transform). Errs unless the status is in `success`.
pub async fn http_call(
    w: &Map<String, Value>,
    data: &Value,
    idempotency_key: &str,
    owner: &str,
) -> Result<HttpResult, String> {
    let method = w.get("method").map(string_of).unwrap_or_else(|| "POST".into());
    let url = w.get("url").map(to_text).unwrap_or_default();
    if url.is_empty() {
        return Err(format!("{owner}.with.url is empty after rendering; check the template"));
    }
    let fail = |e: String| format!("{method} {url} failed: {e}");
    let m = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| fail(format!("'{method}' is not an HTTP method")))?;
    let mut headers: Vec<(String, String)> = vec![("Idempotency-Key".into(), idempotency_key.into())];
    if let Some(h) = w.get("headers").and_then(|h| h.as_object()) {
        for (k, v) in h {
            headers.retain(|(name, _)| !name.eq_ignore_ascii_case(k));
            headers.push((k.clone(), string_of(v)));
        }
    }
    let mut body: Option<String> = None;
    if method != "GET" && method != "DELETE" {
        let payload = w.get("body").unwrap_or(data);
        let (text, ct) = match payload {
            Value::String(s) => (s.clone(), "text/plain"),
            other => (js_json(other), "application/json"),
        };
        if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
            headers.push(("Content-Type".into(), ct.into()));
        }
        body = Some(text);
    }
    let ok = status_matcher(w.get("success"))?;
    let mut req = http_client().request(m, &url).timeout(Duration::from_millis(TIMEOUT_MS));
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let res = req.send().await.map_err(|e| fail(http_error(e)))?;
    let status = res.status().as_u16();
    let content_type = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let text = res.text().await.unwrap_or_default();
    if !ok(status) {
        let snippet =
            if text.is_empty() { String::new() } else { format!(": {}", text.chars().take(200).collect::<String>()) };
        return Err(format!(
            "{method} {url} answered {status}, not in the success list{snippet} (set {owner}.with.success to accept it)"
        ));
    }
    Ok(HttpResult { status, text, content_type })
}

pub struct HttpOutput;

impl OutputAdapter for HttpOutput {
    fn write(&self, items: Vec<WriteItem>) -> LocalBoxFuture<'_, Result<Vec<Value>, String>> {
        Box::pin(async move {
            let mut out = vec![];
            for item in items {
                let r = http_call(&item.with, &item.data, &item.packet_id, "output").await?;
                out.push(json!({ "status": r.status }));
            }
            Ok(out)
        })
    }

    fn verify<'a>(
        &'a self,
        check: &'a str,
        check_with: &'a Map<String, Value>,
        _item: &'a WriteItem,
        result: &'a Value,
    ) -> LocalBoxFuture<'a, Result<bool, String>> {
        Box::pin(async move {
            if check == "status" {
                let Some(status) = result.get("status").and_then(|s| s.as_f64()) else {
                    return Err("no stored write status to check; the packet was written without one".into());
                };
                return Ok(status.fract() == 0.0 && status_matcher(check_with.get("success"))?(status as u16));
            }
            if check != "follow_up" {
                return Err(format!("http output does not support delivery check '{check}'"));
            }
            let url = match check_with.get("url") {
                Some(Value::String(u)) if !u.is_empty() => u.clone(),
                _ => return Err("delivered.with.url is empty after rendering; check the template".into()),
            };
            let mut req = http_client().get(&url).timeout(Duration::from_millis(FOLLOW_UP_TIMEOUT_MS));
            if let Some(h) = check_with.get("headers").and_then(|h| h.as_object()) {
                for (k, v) in h {
                    req = req.header(k.as_str(), string_of(v));
                }
            }
            let unreachable = |e: String| format!("GET {url} failed: {e}; check that the receiver is reachable");
            let res = req.send().await.map_err(|e| unreachable(http_error(e)))?;
            let status = res.status().as_u16();
            let text = res.text().await.map_err(|e| unreachable(http_error(e)))?;
            if !status_matcher(check_with.get("success"))?(status) {
                return Ok(false);
            }
            Ok(match check_with.get("match") {
                None => true,
                Some(m) => body_matches(&text, m),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::test_util::*;
    use std::rc::Rc;

    fn item(id: &str, data: Value, w: Value) -> WriteItem {
        WriteItem { packet_id: id.into(), data, with: w.as_object().cloned().unwrap(), origin: None, chain_depth: 0 }
    }

    #[test]
    fn status_matcher_forms() {
        assert!(status_matcher(None).unwrap()(204));
        assert!(!status_matcher(None).unwrap()(301));
        let m = status_matcher(Some(&json!([201, "3xx", "400-404"]))).unwrap();
        assert!(m(403) && m(201) && m(399) && !m(405) && !m(200));
        assert!(status_matcher(Some(&json!(["abc"]))).err().unwrap().contains("invalid success status"));
        assert!(status_matcher(Some(&json!([]))).unwrap()(200));
    }

    #[test]
    fn body_matching() {
        assert!(body_matches(r#"{"state":"done","id":7}"#, &json!({ "state": "done" })));
        assert!(body_matches(r#"{"id":7}"#, &json!({ "id": 7.0 })));
        assert!(!body_matches(r#"{"state":"done"}"#, &json!({ "state": "pending" })));
        assert!(body_matches(r#"{"list":[1,{"a":2,"b":3}]}"#, &json!({ "list": [{ "a": 2 }] })));
        assert!(body_matches("all good", &json!("good")));
        assert!(body_matches("count 5 ok", &json!(5)));
        assert!(!body_matches(r#"{"a":1}"#, &json!({ "b": null })));
    }

    #[test]
    fn sends_idempotency_key_headers_and_json() {
        local(async {
            let s = fixed(200, "ok").await;
            let url = format!("{}/hook", s.base);
            HttpOutput
                .write(vec![item("pk1", json!({"a": 1}), json!({"url": url, "headers": {"X-Auth": "t"}}))])
                .await
                .unwrap();
            let c = s.calls.borrow()[0].clone();
            assert_eq!(c.method, "POST");
            assert_eq!(c.header("idempotency-key").as_deref(), Some("pk1"));
            assert_eq!(c.header("x-auth").as_deref(), Some("t"));
            assert_eq!(c.header("content-type").as_deref(), Some("application/json"));
            assert_eq!(c.json(), json!({"a": 1}));
            // A string body goes as text; GET sends none; an explicit key header wins.
            let w = json!({"url": url, "body": "hi", "headers": {"idempotency-key": "mine"}});
            let r = HttpOutput.write(vec![item("pk2", json!(1), w)]).await.unwrap();
            assert_eq!(r, vec![json!({"status": 200})]);
            let c = s.calls.borrow()[1].clone();
            assert_eq!((c.text(), c.header("content-type")), ("hi".into(), Some("text/plain".into())));
            assert_eq!(c.headers.get_all("idempotency-key").iter().count(), 1);
            assert_eq!(c.header("idempotency-key").as_deref(), Some("mine"));
            HttpOutput.write(vec![item("pk3", json!(1), json!({"url": url, "method": "GET"}))]).await.unwrap();
            assert!(s.calls.borrow()[2].body.is_empty());
        });
    }

    #[test]
    fn non_success_errs_and_success_list_is_honoured() {
        local(async {
            let s = fixed(202, "nope").await;
            let url = format!("{}/hook", s.base);
            assert!(HttpOutput.write(vec![item("p", json!(1), json!({"url": url}))]).await.is_ok());
            let e =
                HttpOutput.write(vec![item("p", json!(1), json!({"url": url, "success": [200]}))]).await.unwrap_err();
            assert!(e.contains("answered 202, not in the success list: nope (set output.with.success"), "{e}");
            assert!(HttpOutput.write(vec![item("p", json!(1), json!({"url": url, "success": ["2xx"]}))]).await.is_ok());
            let bad = fixed(500, "bad").await;
            let url = format!("{}/hook", bad.base);
            assert!(
                HttpOutput.write(vec![item("p", json!(1), json!({"url": url}))]).await.unwrap_err().contains("500")
            );
            assert!(HttpOutput.write(vec![item("p", json!(1), json!({"url": url, "success": [500]}))]).await.is_ok());
            let e = HttpOutput.write(vec![item("p", json!(1), json!({"url": ""}))]).await.unwrap_err();
            assert_eq!(e, "output.with.url is empty after rendering; check the template");
        });
    }

    #[test]
    fn status_check() {
        local(async {
            let it = item("p1", json!({}), json!({}));
            let v = |w: Value, r: Value| {
                let it = it.clone();
                async move { HttpOutput.verify("status", w.as_object().unwrap(), &it, &r).await }
            };
            assert!(v(json!({"success": [201, "2xx"]}), json!({"status": 201})).await.unwrap());
            assert!(!v(json!({"success": [204]}), json!({"status": 200})).await.unwrap());
            assert!(v(json!({}), json!({"status": 200})).await.unwrap());
            assert!(v(json!({}), Value::Null).await.unwrap_err().contains("status"));
        });
    }

    #[test]
    fn follow_up_check() {
        local(async {
            let s = server(Rc::new(|c: Call| {
                Box::pin(async move {
                    match c.path.as_str() {
                        "/ok" => Reply::json(200, &json!({"state": "done", "id": 7})),
                        "/text" => Reply::text(200, "all good"),
                        _ => Reply::text(404, "nope"),
                    }
                })
            }))
            .await;
            let it = item("p1", json!({}), json!({}));
            let check = |w: Value| {
                let it = it.clone();
                async move { HttpOutput.verify("follow_up", w.as_object().unwrap(), &it, &Value::Null).await }
            };
            let b = &s.base;
            assert!(check(json!({"url": format!("{b}/ok")})).await.unwrap());
            assert!(!check(json!({"url": format!("{b}/missing")})).await.unwrap());
            assert!(check(json!({"url": format!("{b}/text"), "match": "good"})).await.unwrap());
            assert!(!check(json!({"url": format!("{b}/text"), "match": "bad"})).await.unwrap());
            assert!(check(json!({"url": format!("{b}/ok"), "match": {"state": "done"}})).await.unwrap());
            assert!(!check(json!({"url": format!("{b}/ok"), "match": {"state": "pending"}})).await.unwrap());
            assert!(!check(json!({"url": format!("{b}/missing"), "match": "nope"})).await.unwrap());
            assert!(check(json!({"url": ""})).await.unwrap_err().contains("url"));
            assert!(check(json!({"url": "http://127.0.0.1:1/x"})).await.unwrap_err().contains("reachable"));
            let e = HttpOutput.verify("query", &Map::new(), &it, &Value::Null).await.unwrap_err();
            assert!(e.contains("does not support"));
        });
    }
}
