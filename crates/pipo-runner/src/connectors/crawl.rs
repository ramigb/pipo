// `via: crawl` (docs/spec.md §3.3.2, D87): crawl a site on a timer, breadth first within `within`, and hand over each
// HTML page that is new or changed. A page's `seen:<url>` entry (`{h, at}`: a hash of its title, text and links) commits
// with its packet, so a crawl cut short by a crash or a stop starts over at the next start and skips what it already
// sent. `last` (when the last whole crawl ended) times the next one.

use super::schedule::When;
use super::web::{self, Request, content_hash, html, robots::Robots};
use super::{InputAdapter, InputRuntime, Intake, IntakeResult, LocalBoxFuture, Log, Origin, Stopper, string_of};
use crate::journal::Journal;
use crate::time::{iso, now_ms};
use regex::Regex;
use reqwest::Url;
use serde_json::{Map, Value, json};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;
use tokio::task::JoinHandle;

const DEFAULT_DEPTH: u32 = 3;
const DEFAULT_MAX_PAGES: u32 = 500;
const DEFAULT_DELAY_MS: u64 = 1_000;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_REMEMBER: u64 = 10_000;
const MAX_RETRY_AFTER_MS: u64 = 5 * 60_000;
const FULL_RETRY_MS: i64 = 60_000;
const MAX_WAIT: i64 = (1 << 31) - 1;
const SEEN: &str = "seen:";
const AGENT: &str = "pipo";

pub struct CrawlOptions {
    pub start: Vec<Url>,
    pub when: When,
    /// URL prefixes a followed link must start with.
    pub within: Vec<String>,
    pub exclude: Vec<Regex>,
    pub depth: u32,
    pub max_pages: u32,
    pub delay_ms: u64,
    pub select: Option<String>,
    pub headers: Vec<(String, String)>,
    pub timeout_ms: u64,
    pub emit_all: bool,
    pub remember: u64,
    pub robots: bool,
    pub log: Option<Log>,
}

/// One URL or a list of them, from a `with:` value.
fn url_list(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a.iter().map(string_of).collect(),
        Some(Value::Null) | None => vec![],
        Some(v) => vec![string_of(v)],
    }
}

impl CrawlOptions {
    pub fn from_with(w: &Map<String, Value>, log: Option<Log>) -> Result<CrawlOptions, String> {
        let text = |k: &str| w.get(k).filter(|v| !v.is_null()).map(string_of);
        let start: Vec<Url> = url_list(w.get("start"))
            .iter()
            .map(|u| match Url::parse(u) {
                Ok(p) if p.scheme() == "http" || p.scheme() == "https" => Ok(p),
                _ => Err(format!("crawl start '{u}' is not an http or https URL")),
            })
            .collect::<Result<_, _>>()?;
        if start.is_empty() {
            return Err("crawl needs a `start` URL".into());
        }
        let mut within = url_list(w.get("within"));
        if within.is_empty() {
            within = start.iter().map(|u| format!("{}/", u.origin().ascii_serialization())).collect();
        }
        let exclude = url_list(w.get("exclude"))
            .iter()
            .map(|p| Regex::new(p).map_err(|e| format!("crawl exclude '{p}' is not a regular expression: {e}")))
            .collect::<Result<_, _>>()?;
        let ms = |k: &str, default: u64| -> Result<u64, String> {
            Ok(match text(k) {
                Some(t) => crate::duration::parse_duration(&t)? as u64,
                None => default,
            })
        };
        let num = |k: &str| w.get(k).and_then(|v| v.as_u64());
        let select = text("select");
        if let Some(s) = &select {
            html::selector(s)?;
        }
        let headers = w
            .get("headers")
            .and_then(|h| h.as_object())
            .map(|h| h.iter().map(|(k, v)| (k.clone(), string_of(v))).collect())
            .unwrap_or_default();
        Ok(CrawlOptions {
            start,
            when: When::parse(text("cron"), text("every"), "crawl")?,
            within,
            exclude,
            depth: num("depth").unwrap_or(DEFAULT_DEPTH as u64) as u32,
            max_pages: num("max_pages").filter(|n| *n > 0).unwrap_or(DEFAULT_MAX_PAGES as u64) as u32,
            delay_ms: ms("delay", DEFAULT_DELAY_MS)?,
            select,
            headers,
            timeout_ms: ms("timeout", DEFAULT_TIMEOUT_MS)?,
            emit_all: text("emit").as_deref() == Some("all"),
            remember: num("remember").filter(|n| *n > 0).unwrap_or(DEFAULT_REMEMBER),
            robots: w.get("robots").and_then(|r| r.as_bool()) != Some(false),
            log,
        })
    }
}

struct Inner {
    o: CrawlOptions,
    select: Option<scraper::Selector>,
    stop: Stopper,
    scope: String,
    journal: RefCell<Option<Rc<RefCell<Journal>>>>,
    seen: RefCell<HashMap<String, String>>,
    last: Cell<Option<i64>>,
    hold_until: Cell<i64>,
    next_at: Cell<Option<i64>>,
}

pub struct CrawlInput {
    inner: Rc<Inner>,
    task: RefCell<Option<JoinHandle<()>>>,
}

impl CrawlInput {
    pub fn new(o: CrawlOptions, scope_prefix: &str) -> Result<CrawlInput, String> {
        let select = o.select.as_deref().map(html::selector).transpose()?;
        let starts: Vec<&str> = o.start.iter().map(Url::as_str).collect();
        let scope = format!("{scope_prefix}crawl:{}", starts.join(" "));
        let inner = Inner {
            o,
            select,
            stop: Stopper::default(),
            scope,
            journal: RefCell::new(None),
            seen: RefCell::default(),
            last: Cell::new(None),
            hold_until: Cell::new(0),
            next_at: Cell::new(None),
        };
        Ok(CrawlInput { inner: Rc::new(inner), task: RefCell::new(None) })
    }
}

enum Crawl {
    Done,
    Full,
}

impl Inner {
    fn log(&self, level: &str, message: &str) {
        if let Some(l) = &self.o.log {
            l(level, message);
        }
    }

    fn name(&self) -> &str {
        self.o.start[0].as_str()
    }

    fn in_scope(&self, url: &str) -> bool {
        self.o.within.iter().any(|w| url.starts_with(w.as_str())) && !self.o.exclude.iter().any(|r| r.is_match(url))
    }

    async fn run(self: Rc<Self>, intake: Intake) {
        let mut prev_tick = 0;
        loop {
            let now = now_ms();
            let Some(next) = self.o.when.next_run(self.last.get(), now.max(prev_tick)) else {
                self.log("error", "crawl has no next run within 10 years; stopped");
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
            prev_tick = next + 1;
            let Some(r) = self.crawl(&intake).await else { return };
            match r {
                Crawl::Full => self.hold_until.set(now_ms() + FULL_RETRY_MS),
                Crawl::Done => {
                    let end = now_ms();
                    self.last.set(Some(end));
                    self.save(&[("last".into(), Some(json!(end)))]);
                }
            }
        }
    }

    fn save(&self, entries: &[(String, Option<Value>)]) {
        let Some(j) = self.journal.borrow().clone() else { return };
        if let Err(e) = j.borrow_mut().input_put_many(&self.scope, entries) {
            self.log("error", &format!("crawl {}: could not save its state: {e}", self.name()));
        }
    }

    async fn get(&self, url: &str) -> Result<web::Answer, String> {
        let req = Request {
            method: "GET".into(),
            url: url.to_string(),
            headers: self.o.headers.clone(),
            body: None,
            timeout_ms: self.o.timeout_ms,
        };
        tokio::select! {
            r = web::fetch(req) => r,
            _ = self.stop.wait() => Err("stopped".into()),
        }
    }

    async fn robots_for(&self, url: &Url, cache: &mut HashMap<String, Robots>) -> Robots {
        let origin = url.origin().ascii_serialization();
        if let Some(r) = cache.get(&origin) {
            return r.clone();
        }
        let r = match self.get(&format!("{origin}/robots.txt")).await {
            Ok(a) if (200..300).contains(&a.status) => Robots::parse(&a.body, AGENT),
            Ok(_) => Robots::default(),
            Err(e) => {
                self.log(
                    "warn",
                    &format!("crawl: could not read {origin}/robots.txt ({e}); crawling as if it allowed everything"),
                );
                Robots::default()
            }
        };
        cache.insert(origin, r.clone());
        r
    }

    /// One crawl; None when stopped.
    async fn crawl(&self, intake: &Intake) -> Option<Crawl> {
        let mut queue: VecDeque<(String, u32)> = self.o.start.iter().map(|u| (web::normalize(u), 0)).collect();
        let mut visited: HashSet<String> = HashSet::new();
        let mut robots: HashMap<String, Robots> = HashMap::new();
        let mut touched: Vec<(String, String)> = vec![];
        let (mut pages, mut sent, mut failed) = (0u32, 0u32, 0u32);
        let mut fetched_before = false;
        while let Some((url, depth)) = queue.pop_front() {
            if self.stop.stopped() {
                return None;
            }
            if !visited.insert(url.clone()) {
                continue;
            }
            if pages >= self.o.max_pages {
                self.log("info", &format!("crawl {}: stopped at max_pages ({})", self.name(), self.o.max_pages));
                break;
            }
            let Ok(parsed) = Url::parse(&url) else { continue };
            let mut delay = self.o.delay_ms;
            if self.o.robots {
                let r = self.robots_for(&parsed, &mut robots).await;
                let path = match parsed.query() {
                    Some(q) => format!("{}?{q}", parsed.path()),
                    None => parsed.path().to_string(),
                };
                if !r.allowed(&path) {
                    continue;
                }
                delay = delay.max(r.crawl_delay_ms.unwrap_or(0));
            }
            if fetched_before && !self.stop.sleep(delay).await {
                return None;
            }
            fetched_before = true;
            let mut answer = self.get(&url).await;
            if let Ok(a) = &answer
                && (a.status == 429 || a.status == 503)
            {
                let wait = a.retry_after_ms(now_ms()).unwrap_or(delay.max(1000)).min(MAX_RETRY_AFTER_MS);
                if !self.stop.sleep(wait).await {
                    return None;
                }
                answer = self.get(&url).await;
            }
            if self.stop.stopped() {
                return None;
            }
            let a = match answer {
                Ok(a) if (200..300).contains(&a.status) => a,
                Ok(a) => {
                    failed += 1;
                    if failed <= 3 {
                        self.log("warn", &format!("crawl: GET {url} answered {}; skipped it", a.status));
                    }
                    continue;
                }
                Err(e) => {
                    failed += 1;
                    if failed <= 3 {
                        self.log("warn", &format!("crawl: {e}; skipped it"));
                    }
                    continue;
                }
            };
            let final_url = web::normalize(&a.url);
            visited.insert(final_url.clone());
            // A link that redirected out of scope is not this site's page (a start URL always is).
            if !a.content_type.to_ascii_lowercase().contains("html") || (depth > 0 && !self.in_scope(&final_url)) {
                continue;
            }
            pages += 1;
            let page = html::page(&a.body, &a.url, self.select.as_ref());
            let hash = content_hash(&json!({ "title": page.title, "text": page.text, "links": page.links }));
            if depth < self.o.depth {
                for link in &page.links {
                    if !visited.contains(link) && self.in_scope(link) {
                        queue.push_back((link.clone(), depth + 1));
                    }
                }
            }
            touched.push((final_url.clone(), hash.clone()));
            if !self.o.emit_all && self.seen.borrow().get(&final_url) == Some(&hash) {
                continue;
            }
            let mut data = page.to_json(&final_url, a.status);
            data["depth"] = json!(depth);
            let scope = self.scope.clone();
            let entry = (format!("{SEEN}{final_url}"), json!({ "h": hash, "at": now_ms() }));
            let commit: super::Commit = Box::new(move |j: &mut Journal| j.input_put(&scope, &entry.0, Some(&entry.1)));
            match intake(data, Origin { trigger: "crawl".into(), source: final_url.clone() }, Some(commit)).await {
                IntakeResult::Unavailable { reason } => {
                    self.log(
                        "warn",
                        &format!(
                            "crawl {}: stopped after {sent} page(s): {reason}; crawling again in a minute",
                            self.name()
                        ),
                    );
                    return Some(Crawl::Full);
                }
                _ => {
                    sent += 1;
                    self.seen.borrow_mut().insert(final_url, hash);
                }
            }
        }
        if failed > 3 {
            self.log("warn", &format!("crawl {}: {failed} page(s) failed in all", self.name()));
        }
        self.finish(touched);
        self.log("info", &format!("crawl {}: {pages} page(s), {sent} new or changed", self.name()));
        Some(Crawl::Done)
    }

    fn finish(&self, touched: Vec<(String, String)>) {
        let at = now_ms();
        let entries: Vec<(String, Option<Value>)> = {
            let mut seen = self.seen.borrow_mut();
            touched
                .into_iter()
                .map(|(url, h)| {
                    seen.insert(url.clone(), h.clone());
                    (format!("{SEEN}{url}"), Some(json!({ "h": h, "at": at })))
                })
                .collect()
        };
        self.save(&entries);
        let Some(j) = self.journal.borrow().clone() else { return };
        let pruned = j.borrow().input_prune(&self.scope, SEEN, self.o.remember);
        match pruned {
            Ok(0) => {}
            Ok(_) => {
                if let Ok(Some(state)) = j.borrow().input_load(&self.scope) {
                    let kept: HashSet<&str> = state.keys().filter_map(|k| k.strip_prefix(SEEN)).collect();
                    self.seen.borrow_mut().retain(|k, _| kept.contains(k.as_str()));
                }
            }
            Err(e) => self.log("error", &format!("crawl {}: could not forget old pages: {e}", self.name())),
        }
    }
}

impl InputAdapter for CrawlInput {
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
                        if let Some(url) = k.strip_prefix(SEEN) {
                            seen.insert(url.to_string(), v.get("h").map(string_of).unwrap_or_default());
                        }
                    }
                    inner.last.set(state.get("last").and_then(|l| l.as_i64()));
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
        format!("crawl {} {}{next}", self.inner.name(), self.inner.o.when.describe())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::test_util::*;
    use std::time::Duration;

    fn page(title: &str, links: &[&str]) -> Reply {
        let a: String = links.iter().map(|l| format!("<a href=\"{l}\">{l}</a>")).collect();
        let html = format!("<html><head><title>{title}</title></head><body><p>{title} body</p>{a}</body></html>");
        Reply { status: 200, content_type: "text/html; charset=utf-8", body: html.into_bytes(), headers: vec![] }
    }

    /// A small site: / → /a, /b, /private/x, an outside link and a PDF; /a → /a/deep → /a/deeper.
    async fn site(version: Rc<Cell<u32>>) -> Server {
        server(Rc::new(move |c: Call| {
            let v = version.get();
            Box::pin(async move {
                match c.path.as_str() {
                    "/robots.txt" => Reply::text(200, "User-agent: *\nDisallow: /private/\n"),
                    "/" => page(
                        "Home",
                        &["/a", "/b#frag", "/private/x", "https://elsewhere.example/", "/doc.pdf", "/tag/x"],
                    ),
                    "/a" => page("A", &["/a/deep", "/"]),
                    "/a/deep" => page("Deep", &["/a/deeper"]),
                    "/a/deeper" => page("Deeper", &[]),
                    "/b" => page(if v == 0 { "B" } else { "B2" }, &[]),
                    "/tag/x" => page("Tag", &[]),
                    "/a/moved" => Reply { headers: vec![("location", "/b".into())], ..Reply::text(302, "") },
                    "/a/home" => page("A home", &["/a/moved"]),
                    "/doc.pdf" => {
                        Reply { status: 200, content_type: "application/pdf", body: b"%PDF".to_vec(), headers: vec![] }
                    }
                    _ => Reply::text(404, "no"),
                }
            })
        }))
        .await
    }

    fn opts(base: &str, extra: Value) -> CrawlOptions {
        let mut w =
            json!({ "start": format!("{base}/"), "every": "1h", "delay": "0ms", "depth": 2, "exclude": ["/tag/"] });
        for (k, v) in extra.as_object().cloned().unwrap_or_default() {
            w[k] = v;
        }
        CrawlOptions::from_with(w.as_object().unwrap(), None).unwrap()
    }

    fn paths(got: &Got, base: &str) -> Vec<String> {
        let mut p: Vec<String> = got.borrow().iter().map(|(_, o)| o.source.replace(base, "")).collect();
        p.sort();
        p
    }

    #[test]
    fn settings_errors() {
        let bad = |w: Value| CrawlOptions::from_with(w.as_object().unwrap(), None).err().unwrap();
        assert_eq!(bad(json!({ "every": "1d" })), "crawl needs a `start` URL");
        assert_eq!(
            bad(json!({ "start": "ftp://x/", "every": "1d" })),
            "crawl start 'ftp://x/' is not an http or https URL"
        );
        assert_eq!(bad(json!({ "start": "http://x/" })), "crawl needs exactly one of `cron` or `every`");
        assert!(
            bad(json!({ "start": "http://x/", "every": "1d", "exclude": ["("] }))
                .starts_with("crawl exclude '(' is not a regular expression")
        );
    }

    #[test]
    fn a_crawl_stays_in_scope_obeys_robots_and_sends_only_changes_the_next_time() {
        local(async {
            let version = Rc::new(Cell::new(0));
            let s = site(version.clone()).await;
            let dir = TempDir::new();
            let input = CrawlInput::new(opts(&s.base, json!({})), "input|").unwrap();
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(true)));
            input.start(intake, rt).await.unwrap();
            wait_for(|| got.borrow().len() >= 4, 5000, "four pages").await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            input.stop().await;
            assert_eq!(
                paths(&got, &s.base),
                vec!["/", "/a", "/a/deep", "/b"],
                "depth 2, no /private, /tag, PDF or outside"
            );
            let home = got.borrow().iter().find(|(_, o)| o.source == format!("{}/", s.base)).unwrap().0.clone();
            assert_eq!(home["title"], json!("Home"));
            assert_eq!(home["depth"], json!(0));
            assert_eq!(home["status"], json!(200));
            assert_eq!(got.borrow()[0].1.trigger, "crawl");
            let robots = s.calls.borrow().iter().filter(|c| c.path == "/robots.txt").count();
            assert_eq!(robots, 1, "robots.txt is read once per crawl");
            assert!(!s.calls.borrow().iter().any(|c| c.path.starts_with("/private")));

            // The next crawl (a restart past `every`, here: `last` cleared) sends only the page that changed.
            version.set(1);
            rt_clear_last(&dir);
            let input = CrawlInput::new(opts(&s.base, json!({})), "input|").unwrap();
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(true)));
            input.start(intake, rt).await.unwrap();
            wait_for(|| !got.borrow().is_empty(), 5000, "the changed page").await;
            tokio::time::sleep(Duration::from_millis(200)).await;
            input.stop().await;
            assert_eq!(paths(&got, &s.base), vec!["/b"]);
            assert_eq!(got.borrow()[0].0["title"], json!("B2"));
        });
    }

    /// Forget when the last crawl ended, as if `every` had passed.
    fn rt_clear_last(dir: &TempDir) {
        let conn = rusqlite::Connection::open(dir.join("journal.db")).unwrap();
        conn.execute("DELETE FROM input_state WHERE key = 'last'", []).unwrap();
    }

    #[test]
    fn a_link_that_redirects_out_of_scope_is_not_sent() {
        local(async {
            let s = site(Rc::new(Cell::new(0))).await;
            let dir = TempDir::new();
            let o = opts(&s.base, json!({ "start": format!("{}/a/home", s.base), "within": format!("{}/a/", s.base) }));
            let input = CrawlInput::new(o, "input|").unwrap();
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(true)));
            input.start(intake, rt).await.unwrap();
            wait_for(|| s.calls.borrow().iter().any(|c| c.path == "/b"), 5000, "the redirect").await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            input.stop().await;
            assert_eq!(paths(&got, &s.base), vec!["/a/home"]);
        });
    }

    #[test]
    fn emit_all_robots_off_and_max_pages() {
        local(async {
            let s = site(Rc::new(Cell::new(0))).await;
            let dir = TempDir::new();
            let o = opts(
                &s.base,
                json!({ "emit": "all", "robots": false, "max_pages": 2, "within": format!("{}/", s.base) }),
            );
            let input = CrawlInput::new(o, "input|").unwrap();
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(true)));
            input.start(intake, rt).await.unwrap();
            wait_for(|| got.borrow().len() >= 2, 5000, "two pages").await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            input.stop().await;
            assert_eq!(got.borrow().len(), 2);
            assert!(!s.calls.borrow().iter().any(|c| c.path == "/robots.txt"));
            assert!(input.describe().contains(" every 1h0m, next at "), "{}", input.describe());
        });
    }
}
