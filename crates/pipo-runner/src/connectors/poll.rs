// `via: poll` (docs/spec.md §3.3.2, D87): fetch a URL on a timer, split the answer into elements and hand over the ones
// that are new or changed. What it has seen is input state: each element's `seen:<key>` entry (`{h, at}`, a content
// hash and when it was last seen) commits with its packet, so after a crash an element is sent again only if its packet
// wasn't journaled. The cursor, the refreshed keys and `last` (the last fetch's start) are saved once the fetch's
// packets are in.

use super::schedule::When;
use super::web::{self, Answer, Request, content_hash, feed, html};
use super::{InputAdapter, InputRuntime, Intake, IntakeResult, LocalBoxFuture, Log, Origin, Stopper, string_of};
use crate::expr::{JsValue, evaluate, js_json, render, to_text};
use crate::journal::Journal;
use crate::time::{iso, now_ms};
use serde_json::{Map, Value, json};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use tokio::task::JoinHandle;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_REMEMBER: u64 = 10_000;
const DEFAULT_MAX_PAGES: u32 = 10;
/// The longest single wait (as schedule's); longer waits are re-armed.
const MAX_WAIT: i64 = (1 << 31) - 1;
const SEEN: &str = "seen:";
const FULL_RETRY_MS: i64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Parse {
    Auto,
    Json,
    Text,
    Feed,
    Html,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Emit {
    New,
    Changed,
    All,
}

pub struct PollOptions {
    /// `url`, `headers` and `body` are templates, rendered for each request with `vars` and `cursor`.
    pub url: String,
    pub method: String,
    pub headers: Option<Value>,
    pub body: Option<Value>,
    /// `{env, secrets}`.
    pub vars: Value,
    pub timeout_ms: u64,
    pub success: Option<Value>,
    pub when: When,
    pub parse: Parse,
    pub select: Option<String>,
    pub items: Option<String>,
    pub key: Option<String>,
    pub emit: Option<Emit>,
    pub backfill: bool,
    pub remember: u64,
    pub cursor: Option<String>,
    pub next: Option<String>,
    pub max_pages: u32,
    pub log: Option<Log>,
}

impl PollOptions {
    /// From a `with:` block whose `url`, `headers` and `body` are still templates.
    pub fn from_with(w: &Map<String, Value>, vars: Value, log: Option<Log>) -> Result<PollOptions, String> {
        let text = |k: &str| w.get(k).filter(|v| !v.is_null()).map(string_of);
        let url = text("url").unwrap_or_default();
        if url.is_empty() {
            return Err("poll needs a `url`".into());
        }
        let parse = match text("parse").as_deref() {
            None | Some("auto") => Parse::Auto,
            Some("json") => Parse::Json,
            Some("text") => Parse::Text,
            Some("feed") => Parse::Feed,
            Some("html") => Parse::Html,
            Some(other) => return Err(format!("poll parse '{other}' is not one of auto, json, text, feed, html")),
        };
        let emit = match text("emit").as_deref() {
            None => None,
            Some("new") => Some(Emit::New),
            Some("changed") => Some(Emit::Changed),
            Some("all") => Some(Emit::All),
            Some(other) => return Err(format!("poll emit '{other}' is not one of new, changed, all")),
        };
        let timeout_ms = match text("timeout") {
            Some(t) => crate::duration::parse_duration(&t)? as u64,
            None => DEFAULT_TIMEOUT_MS,
        };
        let positive = |k: &str, default: u64| w.get(k).and_then(|v| v.as_u64()).filter(|n| *n > 0).unwrap_or(default);
        let o = PollOptions {
            url,
            method: text("method").unwrap_or_else(|| "GET".into()).to_uppercase(),
            headers: w.get("headers").cloned(),
            body: w.get("body").cloned(),
            vars,
            timeout_ms,
            success: w.get("success").cloned(),
            when: When::parse(text("cron"), text("every"), "poll")?,
            parse,
            select: text("select"),
            items: text("items"),
            key: text("key"),
            emit,
            backfill: w.get("backfill").and_then(|b| b.as_bool()) != Some(false),
            remember: positive("remember", DEFAULT_REMEMBER),
            cursor: text("cursor"),
            next: text("next"),
            max_pages: positive("max_pages", DEFAULT_MAX_PAGES as u64) as u32,
            log,
        };
        for (k, e) in [("items", &o.items), ("key", &o.key), ("cursor", &o.cursor), ("next", &o.next)] {
            if let Some(e) = e {
                crate::expr::parse(e).map_err(|err| format!("poll {k} '{e}' is not an expression: {err}"))?;
            }
        }
        let _ = super::http_out::status_matcher(o.success.as_ref())?;
        if let Some(s) = &o.select {
            html::selector(s)?;
        }
        Ok(o)
    }
}

struct Inner {
    o: PollOptions,
    select: Option<scraper::Selector>,
    stop: Stopper,
    scope: String,
    journal: RefCell<Option<Rc<RefCell<Journal>>>>,
    /// key → content hash.
    seen: RefCell<HashMap<String, String>>,
    cursor: RefCell<Value>,
    last: Cell<Option<i64>>,
    primed: Cell<bool>,
    /// `ETag` and `Last-Modified` of the first page's last answer.
    validators: RefCell<(Option<String>, Option<String>)>,
    /// No fetch before this (a `Retry-After`).
    hold_until: Cell<i64>,
    next_at: Cell<Option<i64>>,
}

pub struct PollInput {
    inner: Rc<Inner>,
    task: RefCell<Option<JoinHandle<()>>>,
}

impl PollInput {
    /// `scope` is where the input keeps its state (`<input>|poll:<url template>`).
    pub fn new(o: PollOptions, scope_prefix: &str) -> Result<PollInput, String> {
        let select = o.select.as_deref().map(html::selector).transpose()?;
        let scope = format!("{scope_prefix}poll:{}", o.url);
        let inner = Inner {
            o,
            select,
            stop: Stopper::default(),
            scope,
            journal: RefCell::new(None),
            seen: RefCell::default(),
            cursor: RefCell::new(Value::Null),
            last: Cell::new(None),
            primed: Cell::new(false),
            validators: RefCell::default(),
            hold_until: Cell::new(0),
            next_at: Cell::new(None),
        };
        Ok(PollInput { inner: Rc::new(inner), task: RefCell::new(None) })
    }
}

/// How one fetch ended.
enum Fetch {
    Done,
    /// The runner couldn't take a packet; the rest waits for the next fetch.
    Full,
    Failed,
}

impl Inner {
    fn log(&self, level: &str, message: &str) {
        if let Some(l) = &self.o.log {
            l(level, message);
        }
    }

    fn vars(&self) -> Value {
        let mut v = self.o.vars.clone();
        if !v.is_object() {
            v = json!({});
        }
        v["cursor"] = self.cursor.borrow().clone();
        v
    }

    fn env(&self) -> Value {
        self.o.vars.get("env").cloned().unwrap_or_else(|| json!({}))
    }

    fn eval(&self, what: &str, expr: &str, ctx: &Value) -> Result<JsValue, String> {
        evaluate(expr, ctx).map_err(|e| format!("poll {what} '{expr}' failed: {e}"))
    }

    async fn run(self: Rc<Self>, intake: Intake) {
        let mut prev_tick = 0;
        loop {
            let now = now_ms();
            let Some(next) = self.o.when.next_run(self.last.get(), now.max(prev_tick)) else {
                self.log("error", "poll has no next fetch within 10 years; stopped");
                return;
            };
            let next = next.max(self.hold_until.get());
            self.next_at.set(Some(next));
            loop {
                let wait = next - now_ms();
                if wait <= 0 {
                    break;
                }
                if !self.stop.sleep(wait.min(MAX_WAIT) as u64).await {
                    return;
                }
            }
            if self.stop.stopped() {
                return;
            }
            prev_tick = next + 1;
            let started = now_ms();
            let r = tokio::select! {
                r = self.fetch(&intake) => r,
                _ = self.stop.wait() => return,
            };
            match r {
                // The rest is fetched again soon, once the runner has made room.
                Fetch::Full => self.hold_until.set(now_ms() + FULL_RETRY_MS),
                Fetch::Done | Fetch::Failed => {
                    self.last.set(Some(started));
                    self.save(&[("last".into(), Some(json!(started)))]);
                }
            }
        }
    }

    fn save(&self, entries: &[(String, Option<Value>)]) {
        let Some(j) = self.journal.borrow().clone() else { return };
        if let Err(e) = j.borrow_mut().input_put_many(&self.scope, entries) {
            self.log("error", &format!("poll {}: could not save its state: {e}", self.o.url));
        }
    }

    fn request(&self, url: &str, first: bool) -> Result<Request, String> {
        let vars = self.vars();
        let mut headers: Vec<(String, String)> = vec![];
        if let Some(h) = &self.o.headers {
            let rendered = render(h, &vars).map_err(|e| format!("poll headers: {e}"))?;
            for (k, v) in rendered.as_object().cloned().unwrap_or_default() {
                headers.push((k, string_of(&v)));
            }
        }
        if first {
            let (etag, modified) = self.validators.borrow().clone();
            if let Some(e) = etag {
                headers.push(("If-None-Match".into(), e));
            }
            if let Some(m) = modified {
                headers.push(("If-Modified-Since".into(), m));
            }
        }
        let mut body = None;
        if self.o.method != "GET"
            && self.o.method != "DELETE"
            && let Some(b) = &self.o.body
        {
            let rendered = render(b, &vars).map_err(|e| format!("poll body: {e}"))?;
            let (text, ct) = match rendered {
                Value::String(s) => (s, "text/plain"),
                other => (js_json(&other), "application/json"),
            };
            if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
                headers.push(("Content-Type".into(), ct.into()));
            }
            body = Some(text);
        }
        Ok(Request {
            method: self.o.method.clone(),
            url: url.to_string(),
            headers,
            body,
            timeout_ms: self.o.timeout_ms,
        })
    }

    /// `data` for an answer, and the elements it splits into by default.
    fn read(&self, a: &Answer) -> Result<(Value, Option<Vec<Value>>), String> {
        let ct = a.content_type.to_ascii_lowercase();
        let parse = match self.o.parse {
            Parse::Auto if feed::looks_like_feed(&ct, &a.body) => Parse::Feed,
            Parse::Auto if ct.contains("json") => Parse::Json,
            Parse::Auto if ct.contains("html") => Parse::Html,
            Parse::Auto => Parse::Text,
            p => p,
        };
        Ok(match parse {
            Parse::Json => (
                serde_json::from_str(&a.body)
                    .map_err(|e| format!("the body is not JSON ({e}); set parse: text to take it as text"))?,
                None,
            ),
            Parse::Feed => {
                let entries = feed::entries(&a.body)?;
                let head = entries.first().and_then(|e| e.get("feed")).cloned().unwrap_or(json!({}));
                let data = json!({
                    "title": head.get("title").cloned().unwrap_or(Value::Null),
                    "link": head.get("link").cloned().unwrap_or(Value::Null),
                    "entries": entries,
                });
                (data, Some(entries))
            }
            Parse::Html => (html::page(&a.body, &a.url, self.select.as_ref()).to_json(a.url.as_str(), a.status), None),
            Parse::Text | Parse::Auto => (Value::String(a.body.clone()), None),
        })
    }

    async fn fetch(self: &Rc<Self>, intake: &Intake) -> Fetch {
        let first_fetch = !self.primed.get();
        let quiet = !self.o.backfill && first_fetch;
        let mut url = match render(&json!(self.o.url), &self.vars()) {
            Ok(u) => to_text(&u),
            Err(e) => {
                self.log("error", &format!("poll url '{}': {e}", self.o.url));
                return Fetch::Failed;
            }
        };
        let ok = match super::http_out::status_matcher(self.o.success.as_ref()) {
            Ok(m) => m,
            Err(e) => {
                self.log("error", &e);
                return Fetch::Failed;
            }
        };
        let mut fetched: HashSet<String> = HashSet::new();
        let mut touched: Vec<(String, String)> = vec![];
        let mut cursor: Option<Value> = None;
        let mut sent = 0usize;
        // Kept only once the fetch is done: a `304` must never hide elements a cut-short fetch didn't hand over.
        let mut validators = self.validators.borrow().clone();
        for page in 0..self.o.max_pages {
            fetched.insert(url.clone());
            let req = match self.request(&url, page == 0) {
                Ok(r) => r,
                Err(e) => {
                    self.log("error", &e);
                    return Fetch::Failed;
                }
            };
            let a = match web::fetch(req).await {
                Ok(a) => a,
                Err(e) => {
                    self.log("error", &format!("{e}; the next fetch tries again"));
                    return Fetch::Failed;
                }
            };
            if a.status == 304 {
                break;
            }
            if a.status == 429 || a.status == 503 {
                let wait = a.retry_after_ms(now_ms());
                if let Some(ms) = wait {
                    self.hold_until.set(now_ms() + ms as i64);
                }
                let when = wait.map(|ms| format!("; waiting {}s as Retry-After asks", ms / 1000)).unwrap_or_default();
                self.log("warn", &format!("{} {url} answered {}{when}", self.o.method, a.status));
                return Fetch::Failed;
            }
            if !ok(a.status) {
                let snippet: String = a.body.chars().take(200).collect();
                let snippet = if snippet.is_empty() { String::new() } else { format!(": {snippet}") };
                self.log(
                    "error",
                    &format!(
                        "{} {url} answered {}, not in the success list{snippet} (set with.success to accept it)",
                        self.o.method, a.status
                    ),
                );
                return Fetch::Failed;
            }
            if page == 0 {
                validators = (a.header("etag").map(str::to_owned), a.header("last-modified").map(str::to_owned));
            }
            let (data, default_items) = match self.read(&a) {
                Ok(d) => d,
                Err(e) => {
                    self.log("error", &format!("poll {url}: {e}"));
                    return Fetch::Failed;
                }
            };
            let response = a.response();
            let env = self.env();
            let whole = self.o.items.is_none() && default_items.is_none();
            let items: Vec<Value> = match &self.o.items {
                Some(expr) => {
                    let ctx = json!({ "data": data, "response": response, "cursor": self.cursor.borrow().clone(), "env": env });
                    match self.eval("items", expr, &ctx) {
                        Ok(JsValue::Undefined | JsValue::Null) => vec![],
                        Ok(v) => match v.to_json() {
                            Value::Array(a) => a,
                            other => vec![other],
                        },
                        Err(e) => {
                            self.log("error", &e);
                            return Fetch::Failed;
                        }
                    }
                }
                None => default_items.clone().unwrap_or_else(|| vec![data.clone()]),
            };
            let page_items = Value::Array(items.clone());
            for item in items {
                let key = match &self.o.key {
                    Some(expr) => {
                        let ctx = json!({ "item": item, "data": data, "env": env });
                        match self.eval("key", expr, &ctx) {
                            Ok(JsValue::Undefined | JsValue::Null) => content_hash(&item),
                            Ok(v) => to_text(&v.to_json()),
                            Err(e) => {
                                self.log("error", &e);
                                return Fetch::Failed;
                            }
                        }
                    }
                    // The template, not the rendered URL: a secret or the cursor in it must never become the key.
                    None if whole && page == 0 => self.o.url.clone(),
                    None if whole => url.clone(),
                    None if default_items.is_some() => {
                        item.get("id").map(to_text).unwrap_or_else(|| content_hash(&item))
                    }
                    None => content_hash(&item),
                };
                let hash = content_hash(&item);
                let emit = self.o.emit.unwrap_or(if whole { Emit::Changed } else { Emit::New });
                let send = !quiet
                    && match emit {
                        Emit::All => true,
                        Emit::New => !self.seen.borrow().contains_key(&key),
                        Emit::Changed => self.seen.borrow().get(&key) != Some(&hash),
                    };
                touched.push((key.clone(), hash.clone()));
                if !send {
                    continue;
                }
                let scope = self.scope.clone();
                let entry = (format!("{SEEN}{key}"), json!({ "h": hash, "at": now_ms() }));
                let commit: super::Commit =
                    Box::new(move |j: &mut Journal| j.input_put(&scope, &entry.0, Some(&entry.1)));
                match intake(item, Origin { trigger: "poll".into(), source: key.clone() }, Some(commit)).await {
                    IntakeResult::Unavailable { reason } => {
                        self.log("warn", &format!("poll {url}: stopped this fetch after {sent} packet(s): {reason}"));
                        return Fetch::Full;
                    }
                    _ => {
                        sent += 1;
                        self.seen.borrow_mut().insert(key, hash);
                    }
                }
            }
            if let Some(expr) = &self.o.cursor {
                let ctx = json!({
                    "data": data, "items": page_items, "response": response,
                    "cursor": self.cursor.borrow().clone(), "env": env,
                });
                match self.eval("cursor", expr, &ctx) {
                    Ok(JsValue::Undefined | JsValue::Null) => {}
                    Ok(v) => cursor = Some(v.to_json()),
                    Err(e) => self.log("warn", &e),
                }
            }
            let Some(expr) = &self.o.next else { break };
            let ctx = json!({ "data": data, "response": response, "env": env });
            let next = match self.eval("next", expr, &ctx) {
                Ok(JsValue::Undefined | JsValue::Null) => break,
                Ok(v) => to_text(&v.to_json()),
                Err(e) => {
                    self.log("warn", &e);
                    break;
                }
            };
            if next.is_empty() {
                break;
            }
            let Some(next) = a.url.join(&next).ok().map(|u| u.to_string()) else {
                self.log("warn", &format!("poll next '{next}' is not a URL; stopped paging"));
                break;
            };
            if fetched.contains(&next) {
                break;
            }
            if page + 1 == self.o.max_pages {
                self.log("warn", &format!("poll {}: stopped after max_pages ({}) pages", self.o.url, self.o.max_pages));
                break;
            }
            url = next;
        }
        *self.validators.borrow_mut() = validators;
        self.finish(touched, cursor, first_fetch);
        Fetch::Done
    }

    /// After a whole fetch: the cursor, the keys it saw (refreshed, and in `seen` when it emitted nothing for them),
    /// `primed`, then the oldest keys past `remember` forgotten.
    fn finish(&self, touched: Vec<(String, String)>, cursor: Option<Value>, first: bool) {
        let at = now_ms();
        let mut entries: Vec<(String, Option<Value>)> = vec![];
        if let Some(c) = cursor {
            *self.cursor.borrow_mut() = c.clone();
            entries.push(("cursor".into(), Some(c)));
        }
        let all = self.o.emit == Some(Emit::All);
        if !all {
            // What wasn't sent was unchanged, or is what `backfill: false` takes as already there.
            let mut seen = self.seen.borrow_mut();
            for (key, hash) in &touched {
                seen.insert(key.clone(), hash.clone());
                entries.push((format!("{SEEN}{key}"), Some(json!({ "h": hash, "at": at }))));
            }
        }
        if first {
            self.primed.set(true);
            entries.push(("primed".into(), Some(json!(true))));
        }
        self.save(&entries);
        if all {
            return;
        }
        let Some(j) = self.journal.borrow().clone() else { return };
        let pruned = j.borrow().input_prune(&self.scope, SEEN, self.o.remember);
        match pruned {
            Ok(0) => {}
            Ok(_) => {
                let mut kept: HashSet<String> = HashSet::new();
                if let Ok(Some(state)) = j.borrow().input_load(&self.scope) {
                    kept = state.keys().filter_map(|k| k.strip_prefix(SEEN)).map(str::to_owned).collect();
                }
                self.seen.borrow_mut().retain(|k, _| kept.contains(k));
                if touched.len() as u64 > self.o.remember {
                    self.log(
                        "warn",
                        &format!(
                            "poll {}: one fetch saw {} elements, more than remember ({}); raise remember, or some come back as new",
                            self.o.url,
                            touched.len(),
                            self.o.remember
                        ),
                    );
                }
            }
            Err(e) => self.log("error", &format!("poll {}: could not forget old keys: {e}", self.o.url)),
        }
    }
}

impl InputAdapter for PollInput {
    fn start(&self, intake: Intake, runtime: InputRuntime) -> LocalBoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let inner = &self.inner;
            let saved = runtime.journal.borrow().input_load(&inner.scope).map_err(|e| e.to_string())?;
            match &saved {
                None => {
                    runtime.journal.borrow_mut().input_baseline(&inner.scope, &Map::new()).map_err(|e| e.to_string())?
                }
                Some(state) => {
                    let mut seen = inner.seen.borrow_mut();
                    for (k, v) in state {
                        if let Some(key) = k.strip_prefix(SEEN) {
                            seen.insert(key.to_string(), v.get("h").map(to_text).unwrap_or_default());
                        }
                    }
                    *inner.cursor.borrow_mut() = state.get("cursor").cloned().unwrap_or(Value::Null);
                    inner.last.set(state.get("last").and_then(|l| l.as_i64()));
                    inner.primed.set(state.get("primed").and_then(|p| p.as_bool()) == Some(true));
                }
            }
            *inner.journal.borrow_mut() = Some(runtime.journal.clone());
            inner.stop.reset();
            *self.task.borrow_mut() = Some(tokio::task::spawn_local(inner.clone().run(intake)));
            Ok(())
        })
    }

    fn stop(&self) -> LocalBoxFuture<'_, ()> {
        Box::pin(async move {
            self.inner.stop.stop();
            let task = self.task.borrow_mut().take();
            if let Some(t) = task {
                let _ = t.await;
            }
        })
    }

    fn describe(&self) -> String {
        let next = self.inner.next_at.get().map(|t| format!(", next at {}", iso(t))).unwrap_or_default();
        format!("poll {} {}{next}", self.inner.o.url, self.inner.o.when.describe())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::test_util::*;
    use std::time::Duration;

    fn opts(url: String, extra: Value) -> PollOptions {
        let mut w = json!({ "url": url, "every": "40ms" });
        for (k, v) in extra.as_object().cloned().unwrap_or_default() {
            w[k] = v;
        }
        PollOptions::from_with(w.as_object().unwrap(), json!({ "env": {}, "secrets": { "tok": "s3cret" } }), None)
            .unwrap()
    }

    fn logging(o: &mut PollOptions) -> Rc<RefCell<Vec<String>>> {
        let logs: Rc<RefCell<Vec<String>>> = Rc::default();
        let l = logs.clone();
        o.log = Some(Rc::new(move |level: &str, m: &str| l.borrow_mut().push(format!("{level}: {m}"))));
        logs
    }

    /// A server answering the n-th request (from 0) with `answers[n]`, the last one again after that.
    async fn answers(answers: Vec<Value>) -> Server {
        let n = Rc::new(Cell::new(0usize));
        let answers = Rc::new(answers);
        server(Rc::new(move |_| {
            let i = n.get().min(answers.len() - 1);
            n.set(n.get() + 1);
            let a = answers[i].clone();
            Box::pin(async move { Reply::json(200, &a) })
        }))
        .await
    }

    fn sources(got: &Got) -> Vec<String> {
        got.borrow().iter().map(|(_, o)| o.source.clone()).collect()
    }

    async fn sleep(ms: u64) {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }

    #[test]
    fn settings_errors() {
        let bad = |w: Value| PollOptions::from_with(w.as_object().unwrap(), json!({}), None).err().unwrap();
        assert_eq!(bad(json!({ "every": "1m" })), "poll needs a `url`");
        assert_eq!(bad(json!({ "url": "http://x" })), "poll needs exactly one of `cron` or `every`");
        assert!(
            bad(json!({ "url": "http://x", "every": "1m", "items": "data[" }))
                .starts_with("poll items 'data[' is not an expression")
        );
        assert!(
            bad(json!({ "url": "http://x", "every": "1m", "select": "p[" }))
                .starts_with("select 'p[' is not a CSS selector")
        );
        assert!(
            bad(json!({ "url": "http://x", "every": "1m", "success": ["nope"] })).contains("invalid success status")
        );
    }

    #[test]
    fn new_elements_are_sent_once_across_fetches_and_restarts() {
        local(async {
            let s = answers(vec![
                json!({ "items": [{ "id": 1 }, { "id": 2 }] }),
                json!({ "items": [{ "id": 2 }, { "id": 1 }, { "id": 3 }] }),
            ])
            .await;
            let dir = TempDir::new();
            let o = || {
                opts(format!("{}/items?t=${{secrets.tok}}", s.base), json!({ "items": "data.items", "key": "item.id" }))
            };
            let input = PollInput::new(o(), "input|").unwrap();
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(true)));
            input.start(intake, rt).await.unwrap();
            wait_for(|| got.borrow().len() >= 3, 5000, "three elements").await;
            sleep(150).await;
            input.stop().await;
            assert_eq!(sources(&got), vec!["1", "2", "3"]);
            assert_eq!(got.borrow()[2].0, json!({ "id": 3 }));
            assert_eq!(got.borrow()[0].1.trigger, "poll");
            assert_eq!(s.calls.borrow()[0].query, "t=s3cret", "url is a template with secrets");
            assert!(s.calls.borrow()[0].header("user-agent").unwrap().starts_with("pipo/"));
            // A restarted runner remembers what it sent.
            let input = PollInput::new(o(), "input|").unwrap();
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(true)));
            input.start(intake, rt).await.unwrap();
            sleep(200).await;
            input.stop().await;
            assert!(got.borrow().is_empty());
        });
    }

    #[test]
    fn every_waits_out_the_interval_after_a_restart() {
        local(async {
            let s = answers(vec![json!({ "a": 1 })]).await;
            let dir = TempDir::new();
            let o = || opts(format!("{}/x", s.base), json!({ "every": "1h" }));
            let input = PollInput::new(o(), "input|").unwrap();
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(true)));
            input.start(intake, rt).await.unwrap();
            wait_for(|| got.borrow().len() == 1, 5000, "the first fetch").await;
            sleep(100).await; // `last` is saved once the fetch is done
            assert!(input.describe().contains(" every 1h0m"), "{}", input.describe());
            input.stop().await;
            let input = PollInput::new(o(), "input|").unwrap();
            let (intake, _) = journaling_intake(&runtime(&dir), Rc::new(Cell::new(true)));
            input.start(intake, runtime(&dir)).await.unwrap();
            sleep(200).await;
            assert_eq!(s.calls.borrow().len(), 1, "no fetch until an hour after the last one");
            assert!(input.describe().contains(", next at "));
            input.stop().await;
        });
    }

    #[test]
    fn a_whole_answer_is_sent_when_it_changes() {
        local(async {
            let s = answers(vec![json!({ "v": "a" }), json!({ "v": "a" }), json!({ "v": "b" })]).await;
            let input = PollInput::new(opts(format!("{}/page", s.base), json!({})), "input|").unwrap();
            let dir = TempDir::new();
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(true)));
            input.start(intake, rt).await.unwrap();
            wait_for(|| got.borrow().len() >= 2, 5000, "two versions").await;
            sleep(100).await;
            input.stop().await;
            let data: Vec<Value> = got.borrow().iter().map(|(d, _)| d.clone()).collect();
            assert_eq!(data, vec![json!({ "v": "a" }), json!({ "v": "b" })]);
            assert_eq!(sources(&got)[0], format!("{}/page", s.base), "the key of a whole answer is its URL");
        });
    }

    #[test]
    fn backfill_false_takes_the_first_fetch_as_seen_and_emit_all_sends_everything() {
        local(async {
            let s = answers(vec![json!([{ "id": 1 }]), json!([{ "id": 1 }, { "id": 2 }])]).await;
            let input = PollInput::new(
                opts(format!("{}/a", s.base), json!({ "items": "data", "key": "item.id", "backfill": false })),
                "input|",
            )
            .unwrap();
            let dir = TempDir::new();
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(true)));
            input.start(intake, rt).await.unwrap();
            wait_for(|| !got.borrow().is_empty(), 5000, "the new element").await;
            sleep(100).await;
            input.stop().await;
            assert_eq!(sources(&got), vec!["2"]);

            let s = answers(vec![json!([{ "id": 1 }])]).await;
            let input =
                PollInput::new(opts(format!("{}/b", s.base), json!({ "items": "data", "emit": "all" })), "input|")
                    .unwrap();
            let dir = TempDir::new();
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(true)));
            input.start(intake, rt).await.unwrap();
            wait_for(|| got.borrow().len() >= 3, 5000, "the same element three times").await;
            input.stop().await;
        });
    }

    #[test]
    fn pages_follow_next_and_the_cursor_feeds_the_next_fetch() {
        local(async {
            let s = server(Rc::new(|c: Call| {
                Box::pin(async move {
                    match (c.path.as_str(), c.query.as_str()) {
                        ("/list", "since=0") => {
                            Reply::json(200, &json!({ "items": [{ "id": "a", "ts": 1 }], "next": "/list/2" }))
                        }
                        ("/list/2", _) => {
                            Reply::json(200, &json!({ "items": [{ "id": "b", "ts": 2 }], "next": "/list/2" }))
                        }
                        ("/list", q) => Reply::json(200, &json!({ "items": [{ "id": q, "ts": 3 }], "next": null })),
                        _ => Reply::text(404, "no"),
                    }
                })
            }))
            .await;
            let o = opts(
                format!("{}/list?since=${{cursor ?? 0}}", s.base),
                json!({ "items": "data.items", "key": "item.id", "cursor": "items[len(items) - 1].ts", "next": "data.next" }),
            );
            let input = PollInput::new(o, "input|").unwrap();
            let dir = TempDir::new();
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(true)));
            input.start(intake, rt.clone()).await.unwrap();
            wait_for(|| got.borrow().len() >= 3, 5000, "both pages, then the cursor").await;
            input.stop().await;
            assert_eq!(&sources(&got)[..3], ["a", "b", "since=2"]);
            let paths: Vec<String> =
                s.calls.borrow().iter().take(3).map(|c| format!("{}?{}", c.path, c.query)).collect();
            assert_eq!(
                paths,
                vec!["/list?since=0", "/list/2?", "/list?since=2"],
                "a repeated next URL ends the paging"
            );
            let state = rt
                .journal
                .borrow()
                .input_load(&format!("input|poll:{}/list?since=${{cursor ?? 0}}", s.base))
                .unwrap()
                .unwrap();
            assert_eq!(state["cursor"], json!(3));
        });
    }

    #[test]
    fn a_cut_short_fetch_keeps_no_etag() {
        local(async {
            let s = server(Rc::new(|c: Call| {
                Box::pin(async move {
                    if c.header("if-none-match").is_some() {
                        return Reply::text(304, "");
                    }
                    Reply { headers: vec![("etag", "\"v1\"".into())], ..Reply::json(200, &json!([{ "id": 1 }])) }
                })
            }))
            .await;
            let dir = TempDir::new();
            let o = || opts(format!("{}/e", s.base), json!({ "items": "data", "key": "item.id", "every": "1h" }));
            let input = PollInput::new(o(), "input|").unwrap();
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(false)));
            input.start(intake, rt).await.unwrap();
            wait_for(|| !s.calls.borrow().is_empty(), 5000, "the first fetch").await;
            sleep(50).await;
            input.stop().await;
            assert!(got.borrow().is_empty());
            // The fetch stopped at the full buffer, so its ETag wasn't kept: the retry asks for the whole answer.
            assert_eq!(input.inner.validators.borrow().0, None);
        });
    }

    #[test]
    fn a_full_buffer_leaves_the_rest_for_later() {
        local(async {
            let s = answers(vec![json!([{ "id": 1 }, { "id": 2 }])]).await;
            let dir = TempDir::new();
            let o = || opts(format!("{}/a", s.base), json!({ "items": "data", "key": "item.id", "every": "1h" }));
            let input = PollInput::new(o(), "input|").unwrap();
            let mut po = o();
            let logs = logging(&mut po);
            drop(input);
            let input = PollInput::new(po, "input|").unwrap();
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(false)));
            input.start(intake, rt).await.unwrap();
            wait_for(
                || logs.borrow().iter().any(|l| l.contains("stopped this fetch after 0 packet(s): buffer full")),
                5000,
                "the warning",
            )
            .await;
            input.stop().await;
            assert!(got.borrow().is_empty());
            // Nothing was taken, so nothing counts as seen, and the next start fetches at once.
            let input = PollInput::new(o(), "input|").unwrap();
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(true)));
            input.start(intake, rt).await.unwrap();
            wait_for(|| got.borrow().len() == 2, 5000, "both elements").await;
            input.stop().await;
        });
    }

    #[test]
    fn validators_errors_and_retry_after() {
        local(async {
            let n = Rc::new(Cell::new(0));
            let s = server(Rc::new(move |c: Call| {
                n.set(n.get() + 1);
                let i = n.get();
                Box::pin(async move {
                    match i {
                        1 => Reply { headers: vec![("etag", "\"v1\"".into())], ..Reply::json(200, &json!({ "a": 1 })) },
                        2 if c.header("if-none-match").as_deref() == Some("\"v1\"") => Reply::text(304, ""),
                        3 => Reply::text(500, "boom"),
                        _ => Reply { headers: vec![("retry-after", "3600".into())], ..Reply::text(429, "slow down") },
                    }
                })
            }))
            .await;
            let mut o = opts(format!("{}/v", s.base), json!({}));
            let logs = logging(&mut o);
            let input = PollInput::new(o, "input|").unwrap();
            let dir = TempDir::new();
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(true)));
            input.start(intake, rt).await.unwrap();
            wait_for(|| logs.borrow().iter().any(|l| l.contains("answered 429")), 5000, "the 429").await;
            sleep(150).await;
            input.stop().await;
            assert_eq!(got.borrow().len(), 1);
            assert_eq!(s.calls.borrow().len(), 4, "Retry-After holds the next fetch");
            let logs = logs.borrow();
            assert!(
                logs.iter()
                    .any(|l| l.starts_with("error: GET") && l.contains("answered 500, not in the success list: boom"))
            );
            assert!(logs.iter().any(|l| l.contains("waiting 3600s as Retry-After asks")));
        });
    }

    #[test]
    fn feeds_and_page_parts_parse() {
        local(async {
            let rss = r#"<rss version="2.0"><channel><title>B</title><item><guid>g1</guid><title>One</title></item></channel></rss>"#;
            let s = server(Rc::new(move |c: Call| {
                Box::pin(async move {
                    if c.path == "/feed" {
                        Reply { status: 200, content_type: "application/rss+xml", body: rss.as_bytes().to_vec(), headers: vec![] }
                    } else {
                        let html = "<html><head><title>Shop</title></head><body><p id=price>4.50</p><a href=/x>x</a></body></html>";
                        Reply { status: 200, content_type: "text/html", body: html.as_bytes().to_vec(), headers: vec![] }
                    }
                })
            }))
            .await;
            let dir = TempDir::new();
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(true)));
            let feed = PollInput::new(opts(format!("{}/feed", s.base), json!({})), "a|").unwrap();
            let page = PollInput::new(opts(format!("{}/shop", s.base), json!({ "select": "#price" })), "b|").unwrap();
            feed.start(intake.clone(), rt.clone()).await.unwrap();
            page.start(intake, rt).await.unwrap();
            wait_for(|| got.borrow().len() >= 2, 5000, "an entry and a page").await;
            sleep(100).await;
            feed.stop().await;
            page.stop().await;
            assert_eq!(got.borrow().len(), 2);
            let by =
                |src: &str| got.borrow().iter().find(|(_, o)| o.source.contains(src)).map(|(d, _)| d.clone()).unwrap();
            assert_eq!(by("g1")["title"], json!("One"));
            assert_eq!(by("g1")["feed"]["title"], json!("B"));
            let p = by("/shop");
            assert_eq!(p["text"], json!("4.50"));
            assert_eq!(p["title"], json!("Shop"));
            assert_eq!(p["links"], json!([format!("{}/x", s.base)]));
            assert_eq!(p["status"], json!(200));
        });
    }

    #[test]
    fn remember_forgets_the_keys_seen_longest_ago() {
        local(async {
            // Keys seen in the same fetch tie on `at`; the tie goes to the lower key.
            let s = answers(vec![json!([1, 2]), json!([3]), json!([2])]).await;
            let o = opts(format!("{}/r", s.base), json!({ "items": "data", "key": "item", "remember": 2 }));
            let input = PollInput::new(o, "input|").unwrap();
            let dir = TempDir::new();
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(true)));
            input.start(intake, rt).await.unwrap();
            wait_for(|| got.borrow().len() >= 4, 5000, "2 forgotten, then sent again").await;
            input.stop().await;
            assert_eq!(&sources(&got)[..4], ["1", "2", "3", "2"]);
        });
    }
}
