// What `poll` and `crawl` share (docs/spec.md §3.3.2): one request with a body cap, reading an answer as JSON, text,
// a feed or a page, content hashes for change detection, and URL normalization.

pub mod feed;
pub mod html;
pub mod robots;

use super::{http_client, http_error};
use reqwest::Url;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

/// Bodies above this are refused (§3.3.2).
pub const MAX_BODY: usize = 10 * 1024 * 1024;

pub fn user_agent() -> String {
    format!("pipo/{}", env!("CARGO_PKG_VERSION"))
}

/// A short, stable hash of a JSON value (its JS JSON text), for `seen` entries and default keys.
pub fn content_hash(v: &Value) -> String {
    let digest = Sha256::digest(crate::expr::js_json(v).as_bytes());
    hex::encode(&digest[..12])
}

/// A URL with its fragment removed (the scheme and host are already lower-cased by parsing).
pub fn normalize(u: &Url) -> String {
    let mut u = u.clone();
    u.set_fragment(None);
    u.to_string()
}

pub struct Request {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout_ms: u64,
}

pub struct Answer {
    pub status: u16,
    /// After redirects.
    pub url: Url,
    /// Lower-cased names; a repeated header keeps its last value.
    pub headers: Map<String, Value>,
    pub content_type: String,
    pub body: String,
}

impl Answer {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.as_str())
    }

    /// `Retry-After` in milliseconds (seconds, or an HTTP date), when the answer carries one.
    pub fn retry_after_ms(&self, now_ms: i64) -> Option<u64> {
        let v = self.header("retry-after")?.trim();
        if let Ok(s) = v.parse::<u64>() {
            return Some(s * 1000);
        }
        let at = jiff::fmt::rfc2822::parse(v).ok()?.timestamp().as_millisecond();
        Some((at - now_ms).max(0) as u64)
    }

    /// `{status, url, headers}`, the `response` variable of a poll's expressions.
    pub fn response(&self) -> Value {
        serde_json::json!({ "status": self.status, "url": self.url.as_str(), "headers": self.headers })
    }
}

/// One request; errs (with the method and URL, never a header) when it can't be sent or the body is too big.
pub async fn fetch(r: Request) -> Result<Answer, String> {
    let fail = |e: String| format!("{} {} failed: {e}", r.method, r.url);
    let m = reqwest::Method::from_bytes(r.method.as_bytes())
        .map_err(|_| fail(format!("'{}' is not an HTTP method", r.method)))?;
    let mut req = http_client().request(m, &r.url).timeout(Duration::from_millis(r.timeout_ms));
    if !r.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("user-agent")) {
        req = req.header("User-Agent", user_agent());
    }
    for (k, v) in &r.headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(b) = r.body {
        req = req.body(b);
    }
    let mut res = req.send().await.map_err(|e| fail(http_error(e)))?;
    let status = res.status().as_u16();
    let url = res.url().clone();
    let mut headers = Map::new();
    for (k, v) in res.headers() {
        if let Ok(v) = v.to_str() {
            headers.insert(k.as_str().to_ascii_lowercase(), Value::String(v.to_string()));
        }
    }
    let content_type = headers.get("content-type").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if res.content_length().is_some_and(|n| n as usize > MAX_BODY) {
        return Err(fail(format!("the body is larger than {} MiB", MAX_BODY >> 20)));
    }
    let mut body: Vec<u8> = vec![];
    while let Some(chunk) = res.chunk().await.map_err(|e| fail(http_error(e)))? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BODY {
            return Err(fail(format!("the body is larger than {} MiB", MAX_BODY >> 20)));
        }
    }
    Ok(Answer { status, url, headers, content_type, body: String::from_utf8_lossy(&body).into_owned() })
}
