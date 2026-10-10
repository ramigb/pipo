// `via: watch` (docs/spec.md §3.3, §7.4, §14.3). Port of watch-input.ts. The runner watches a glob and turns each
// create, change or delete into a packet. File events (notify) only wake the scanner up; the scanner compares the
// folder with its last snapshot (and runs on a slow timer too, for drives where events are lost, such as WSL /mnt),
// so rapid duplicate events collapse into one and nothing depends on event order. The snapshot is persisted in the
// journal: each path's entry is written in the same transaction that journals its packet, so an event the runner
// couldn't take yet is retried on the next scan, and a crash can neither lose nor repeat one. On restart the first
// scan diffs the folder against the saved snapshot, replaying what changed while the runner was down; the very first
// start (or a changed glob) only records a baseline.

use super::{Commit, InputAdapter, InputRuntime, Intake, IntakeResult, LocalBoxFuture, Log, Origin, Stopper, resolve_path};
use crate::journal::Journal;
use crate::time::iso;
use serde_json::{Map, Value, json};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use tokio::task::JoinHandle;

/// Largest file read into `data.content`; bigger files are sent without content (`truncated: true`).
pub const MAX_CONTENT_BYTES: u64 = 1024 * 1024;

const GLOB_CHARS: &[char] = &['*', '?', '[', ']', '{', '}', '!'];

/// Split a glob into the literal folder to watch and the pattern below it.
pub fn split_glob(pattern: &str, dir: &Path) -> (PathBuf, String) {
    let full = resolve_path(dir, pattern).display().to_string();
    let full = if pattern.ends_with('/') && pattern.len() > 1 { full.trim_end_matches('/').to_string() } else { full };
    let parts: Vec<&str> = full.split('/').collect();
    match parts.iter().position(|p| p.contains(GLOB_CHARS)) {
        None => {
            let p = PathBuf::from(&full);
            // A plain folder means every file below it.
            if p.is_dir() {
                return (p, "**/*".into());
            }
            let base = p.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("/"));
            (base, parts.last().unwrap_or(&"").to_string())
        }
        Some(i) => {
            let base = parts[..i].join("/");
            (PathBuf::from(if base.is_empty() { "/".to_string() } else { base }), parts[i..].join("/"))
        }
    }
}

// ── glob matching (Bun.Glob with `dot: true`: `*`, `?`, `[...]`, `{a,b}`, `**`) ─────────────────────────────────

/// `a{b,c}d` → `abd`, `acd` (nested braces too).
fn expand_braces(p: &str) -> Vec<String> {
    let chars: Vec<char> = p.chars().collect();
    let mut depth = 0;
    let mut open = None;
    let mut commas = vec![];
    for (i, c) in chars.iter().enumerate() {
        match c {
            '\\' => continue,
            '{' => {
                if depth == 0 {
                    open = Some(i);
                    commas.clear();
                }
                depth += 1;
            }
            ',' if depth == 1 => commas.push(i),
            '}' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    let start = open.unwrap_or(0);
                    if commas.is_empty() {
                        continue;
                    }
                    let pre: String = chars[..start].iter().collect();
                    let post: String = chars[i + 1..].iter().collect();
                    let mut bounds = vec![start];
                    bounds.extend(&commas);
                    bounds.push(i);
                    let mut out = vec![];
                    for w in bounds.windows(2) {
                        let alt: String = chars[w[0] + 1..w[1]].iter().collect();
                        out.extend(expand_braces(&format!("{pre}{alt}{post}")));
                    }
                    return out;
                }
            }
            _ => {}
        }
    }
    vec![p.to_string()]
}

fn match_class(pat: &[char], c: char) -> Option<(bool, usize)> {
    // pat starts after '['; returns (matched, chars consumed including ']').
    let mut i = 0;
    let negate = matches!(pat.first(), Some('!') | Some('^'));
    if negate {
        i += 1;
    }
    let mut matched = false;
    let mut first = true;
    while i < pat.len() {
        if pat[i] == ']' && !first {
            return Some((matched != negate, i + 1));
        }
        first = false;
        let lo = pat[i];
        if i + 2 < pat.len() && pat[i + 1] == '-' && pat[i + 2] != ']' {
            if lo <= c && c <= pat[i + 2] {
                matched = true;
            }
            i += 3;
        } else {
            if lo == c {
                matched = true;
            }
            i += 1;
        }
    }
    None
}

fn match_segment(pat: &[char], s: &[char]) -> bool {
    match pat.first() {
        None => s.is_empty(),
        Some('*') => (0..=s.len()).any(|k| match_segment(&pat[1..], &s[k..])),
        Some('?') => !s.is_empty() && match_segment(&pat[1..], &s[1..]),
        Some('[') => match (s.first(), match_class(&pat[1..], *s.first().unwrap_or(&'\0'))) {
            (Some(_), Some((ok, used))) => ok && match_segment(&pat[1 + used..], &s[1..]),
            (_, None) => s.first() == Some(&'[') && match_segment(&pat[1..], &s[1..]),
            (None, _) => false,
        },
        Some('\\') if pat.len() > 1 => s.first() == Some(&pat[1]) && match_segment(&pat[2..], &s[1..]),
        Some(c) => s.first() == Some(c) && match_segment(&pat[1..], &s[1..]),
    }
}

fn match_parts(pat: &[Vec<char>], path: &[Vec<char>]) -> bool {
    match pat.first() {
        None => path.is_empty(),
        Some(p) if p.len() == 2 && p[0] == '*' && p[1] == '*' => (0..=path.len()).any(|k| match_parts(&pat[1..], &path[k..])),
        Some(p) => !path.is_empty() && match_segment(p, &path[0]) && match_parts(&pat[1..], &path[1..]),
    }
}

pub struct Glob {
    patterns: Vec<Vec<Vec<char>>>,
    /// How deep below the base a match can be; None with `**`.
    max_depth: Option<usize>,
}

impl Glob {
    pub fn new(pattern: &str) -> Glob {
        let patterns: Vec<Vec<Vec<char>>> =
            expand_braces(pattern).iter().map(|p| p.split('/').filter(|s| !s.is_empty()).map(|s| s.chars().collect()).collect()).collect();
        let deep = patterns.iter().any(|p| p.iter().any(|s| s.len() == 2 && s[0] == '*' && s[1] == '*'));
        let max_depth = if deep { None } else { patterns.iter().map(|p| p.len()).max() };
        Glob { patterns, max_depth }
    }

    /// Whether a path relative to the base (with `/`) matches.
    pub fn matches(&self, rel: &str) -> bool {
        let parts: Vec<Vec<char>> = rel.split('/').map(|s| s.chars().collect()).collect();
        self.patterns.iter().any(|p| match_parts(p, &parts))
    }

    /// Every file below `base` that matches, relative to it (symlinked folders are not followed).
    pub fn scan(&self, base: &Path) -> Vec<String> {
        let mut out = vec![];
        self.walk(base, "", 1, &mut out);
        out
    }

    fn walk(&self, dir: &Path, prefix: &str, depth: usize, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() {
                if self.max_depth.is_none_or(|m| depth < m) {
                    self.walk(&e.path(), &rel, depth + 1, out);
                }
            } else if t.is_file() && self.matches(&rel) {
                out.push(rel);
            }
        }
    }
}

// ── the input ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
struct Stamp {
    mtime_ms: f64,
    size: u64,
}

impl Stamp {
    fn to_json(self) -> Value {
        json!({ "mtimeMs": self.mtime_ms, "size": self.size })
    }
    fn from_json(v: &Value) -> Option<Stamp> {
        Some(Stamp { mtime_ms: v.get("mtimeMs")?.as_f64()?, size: v.get("size")?.as_f64()? as u64 })
    }
    fn of(path: &str) -> Option<Stamp> {
        use std::os::unix::fs::MetadataExt;
        let m = std::fs::metadata(path).ok()?;
        // Node's `mtimeMs`, computed the same way so a journal from either runner compares equal.
        Some(Stamp { mtime_ms: m.mtime() as f64 * 1000.0 + m.mtime_nsec() as f64 / 1e6, size: m.size() })
    }
}

pub struct WatchOptions {
    /// Glob; relative paths resolve against `dir`.
    pub path: String,
    pub dir: PathBuf,
    pub events: Option<Vec<String>>,
    pub read: Option<String>,
    /// Wait after the last file event before scanning (collapses bursts). Default 50 ms.
    pub debounce_ms: Option<u64>,
    /// Safety-net scan interval for platforms where file events are unreliable. Default 1 s.
    pub poll_ms: Option<u64>,
    pub log: Option<Log>,
}

enum Emitted {
    /// The intake journaled (or rejected) the packet, which also committed the snapshot entry.
    Taken,
    /// Retry this path on the next scan.
    Skip,
    /// The runner takes nothing right now.
    Full,
}

struct Inner {
    base: PathBuf,
    base_text: String,
    pattern: String,
    glob: Glob,
    events: Vec<String>,
    read_content: bool,
    debounce_ms: u64,
    poll_ms: u64,
    log: Option<Log>,
    stop: Stopper,
    known: RefCell<BTreeMap<String, Stamp>>,
    running: Cell<bool>,
    again: Cell<bool>,
    debounce: RefCell<Option<JoinHandle<()>>>,
    scanning: RefCell<Option<JoinHandle<()>>>,
    intake: RefCell<Option<Intake>>,
    journal: RefCell<Option<Rc<RefCell<Journal>>>>,
}

pub struct WatchInput {
    inner: Rc<Inner>,
    tasks: RefCell<Vec<JoinHandle<()>>>,
    watcher: RefCell<Option<notify::RecommendedWatcher>>,
}

impl WatchInput {
    pub fn new(o: WatchOptions) -> WatchInput {
        let (base, rest) = split_glob(&o.path, &o.dir);
        let events = o.events.filter(|e| !e.is_empty()).unwrap_or_else(|| vec!["create".into(), "change".into()]);
        let mut unique: Vec<String> = vec![];
        for e in events {
            if !unique.contains(&e) {
                unique.push(e);
            }
        }
        let inner = Inner {
            base_text: base.display().to_string(),
            pattern: base.join(&rest).display().to_string(),
            glob: Glob::new(&rest),
            base,
            events: unique,
            read_content: o.read.as_deref() == Some("content"),
            debounce_ms: o.debounce_ms.unwrap_or(50),
            poll_ms: o.poll_ms.unwrap_or(1000),
            log: o.log,
            stop: Stopper::default(),
            known: RefCell::default(),
            running: Cell::new(false),
            again: Cell::new(false),
            debounce: RefCell::new(None),
            scanning: RefCell::new(None),
            intake: RefCell::new(None),
            journal: RefCell::new(None),
        };
        WatchInput { inner: Rc::new(inner), tasks: RefCell::default(), watcher: RefCell::new(None) }
    }
}

impl Inner {
    fn log(&self, level: &str, message: &str) {
        if let Some(l) = &self.log {
            l(level, message);
        }
    }

    fn scope(&self) -> String {
        format!("watch:{}", self.pattern)
    }

    fn wake(self: &Rc<Self>, delay: u64) {
        if self.stop.stopped() {
            return;
        }
        if let Some(d) = self.debounce.borrow_mut().take() {
            d.abort();
        }
        let me = self.clone();
        let task = tokio::task::spawn_local(async move {
            if !me.stop.sleep(delay).await {
                return;
            }
            if me.running.get() {
                me.again.set(true);
                return;
            }
            me.running.set(true);
            let scan = tokio::task::spawn_local(me.clone().scan());
            *me.scanning.borrow_mut() = Some(scan);
        });
        *self.debounce.borrow_mut() = Some(task);
    }

    fn snapshot(&self) -> BTreeMap<String, Stamp> {
        let mut out = BTreeMap::new();
        for name in self.glob.scan(&self.base) {
            let path = self.base.join(&name).display().to_string();
            if let Some(s) = Stamp::of(&path) {
                out.insert(path, s);
            }
        }
        out
    }

    async fn scan(self: Rc<Self>) {
        loop {
            self.again.set(false);
            self.diff().await;
            if !self.again.get() || self.stop.stopped() {
                break;
            }
        }
        self.running.set(false);
    }

    fn put(&self, path: &str, stamp: Option<Stamp>) -> Result<(), String> {
        match self.journal.borrow().as_ref() {
            Some(j) => j.borrow().input_put(&self.scope(), path, stamp.map(Stamp::to_json).as_ref()).map_err(|e| e.to_string()),
            None => Ok(()),
        }
    }

    async fn diff(&self) {
        let now = self.snapshot();
        let mut todo: Vec<(&str, String, Stamp)> = vec![];
        {
            let known = self.known.borrow();
            for (path, stamp) in &now {
                match known.get(path) {
                    None => todo.push(("create", path.clone(), *stamp)),
                    Some(old) if old != stamp => todo.push(("change", path.clone(), *stamp)),
                    _ => {}
                }
            }
            for (path, stamp) in known.iter() {
                if !now.contains_key(path) {
                    todo.push(("delete", path.clone(), *stamp));
                }
            }
        }
        todo.sort_by(|a, b| a.1.cmp(&b.1));
        for (event, path, stamp) in todo {
            if self.stop.stopped() {
                return;
            }
            let saved = if event == "delete" { None } else { Some(stamp) };
            if self.events.iter().any(|e| e == event) {
                match self.emit(event, &path, stamp, saved).await {
                    Emitted::Full => return, // the next poll resumes from here
                    Emitted::Skip => continue,
                    Emitted::Taken => {}
                }
            } else if let Err(e) = self.put(&path, saved) {
                // Not subscribed: nothing to journal, only the snapshot moves.
                self.log("error", &format!("watch: could not save the snapshot of {path}: {e}"));
                return;
            }
            let mut known = self.known.borrow_mut();
            match saved {
                None => known.remove(&path),
                Some(s) => known.insert(path, s),
            };
        }
    }

    async fn emit(&self, event: &str, path: &str, stamp: Stamp, saved: Option<Stamp>) -> Emitted {
        let name = path.strip_prefix(&self.base_text).unwrap_or(path).trim_start_matches('/');
        let mut data = Map::new();
        data.insert("event".into(), json!(event));
        data.insert("path".into(), json!(path));
        data.insert("name".into(), json!(name));
        data.insert("size".into(), json!(stamp.size));
        if event != "delete" {
            data.insert("mtime".into(), json!(iso(stamp.mtime_ms.trunc() as i64)));
            if self.read_content {
                if stamp.size > MAX_CONTENT_BYTES {
                    data.insert("content".into(), Value::Null);
                    data.insert("truncated".into(), json!(true));
                    self.log("warn", &format!("watch: {path} is over {MAX_CONTENT_BYTES} bytes; sent without content"));
                } else {
                    match std::fs::read(path) {
                        Ok(b) => data.insert("content".into(), json!(String::from_utf8_lossy(&b))),
                        Err(_) => return Emitted::Skip, // vanished or locked mid-write: the next scan sees its final state
                    };
                }
            }
        }
        let source = format!("{path}#{event}@{}", stamp.mtime_ms.round() as i64);
        let (scope, key) = (self.scope(), path.to_string());
        let commit: Commit = Box::new(move |j: &mut Journal| j.input_put(&scope, &key, saved.map(Stamp::to_json).as_ref()));
        let Some(intake) = self.intake.borrow().clone() else { return Emitted::Full };
        match intake(Value::Object(data), Origin { trigger: "watch".into(), source }, Some(commit)).await {
            IntakeResult::Unavailable { reason } => {
                self.log("warn", &format!("watch {event} {path} not accepted yet: {reason}"));
                Emitted::Full
            }
            IntakeResult::Rejected { message, .. } => {
                self.log("warn", &format!("watch {event} {path} was rejected: {message}"));
                Emitted::Taken
            }
            IntakeResult::Accepted { .. } => Emitted::Taken,
        }
    }
}

impl InputAdapter for WatchInput {
    fn start(&self, intake: Intake, runtime: InputRuntime) -> LocalBoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let inner = &self.inner;
            *inner.intake.borrow_mut() = Some(intake);
            inner.stop.reset();
            let scope = inner.scope();
            let saved = runtime.journal.borrow().input_load(&scope).map_err(|e| e.to_string())?;
            let replay = saved.is_some();
            match saved {
                Some(saved) => {
                    // Replay: the first scan diffs the folder against what the last run had journaled.
                    *inner.known.borrow_mut() = saved.iter().filter_map(|(k, v)| Some((k.clone(), Stamp::from_json(v)?))).collect();
                    inner.log("info", &format!("watch: checking {} for changes since the last run", inner.base_text));
                }
                None => {
                    // First start: files already there are the baseline; only later changes produce packets.
                    let now = inner.snapshot();
                    let entries: Map<String, Value> = now.iter().map(|(k, v)| (k.clone(), v.to_json())).collect();
                    runtime.journal.borrow_mut().input_baseline(&scope, &entries).map_err(|e| e.to_string())?;
                    *inner.known.borrow_mut() = now;
                }
            }
            *inner.journal.borrow_mut() = Some(runtime.journal.clone());

            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Result<(), String>>();
            let watched = notify::recommended_watcher(move |r: notify::Result<notify::Event>| {
                let _ = tx.send(r.map(|_| ()).map_err(|e| e.to_string()));
            })
            .and_then(|mut w| {
                notify::Watcher::watch(&mut w, &inner.base, notify::RecursiveMode::Recursive)?;
                Ok(w)
            });
            let mut tasks = self.tasks.borrow_mut();
            match watched {
                Ok(w) => {
                    *self.watcher.borrow_mut() = Some(w);
                    let me = inner.clone();
                    tasks.push(tokio::task::spawn_local(async move {
                        let mut warned = false;
                        while let Some(r) = rx.recv().await {
                            match r {
                                Ok(()) => me.wake(me.debounce_ms),
                                Err(e) if !warned => {
                                    warned = true;
                                    me.log("warn", &format!("watch: file events stopped ({e}); polling only"));
                                }
                                Err(_) => {}
                            }
                        }
                    }));
                }
                Err(e) => inner.log("warn", &format!("watch: file events unavailable on {} ({e}); polling only", inner.base_text)),
            }
            let me = inner.clone();
            tasks.push(tokio::task::spawn_local(async move {
                while me.stop.sleep(me.poll_ms).await {
                    me.wake(0);
                }
            }));
            // Runs once the runner is active (a task, not inline); an unavailable intake is retried by the poll.
            if replay {
                inner.wake(0);
            }
            Ok(())
        })
    }

    fn stop(&self) -> LocalBoxFuture<'_, ()> {
        Box::pin(async move {
            let inner = &self.inner;
            inner.stop.stop();
            self.watcher.borrow_mut().take();
            for t in self.tasks.borrow_mut().drain(..) {
                t.abort();
            }
            if let Some(d) = inner.debounce.borrow_mut().take() {
                d.abort();
            }
            let scanning = inner.scanning.borrow_mut().take();
            if let Some(s) = scanning {
                let _ = s.await;
            }
        })
    }

    fn describe(&self) -> String {
        format!("watch {} ({})", self.inner.pattern, self.inner.events.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::test_util::*;
    use std::time::Duration;

    #[test]
    fn splits_globs_into_folder_and_pattern() {
        assert_eq!(split_glob("./in/**/*.txt", Path::new("/a")), (PathBuf::from("/a/in"), "**/*.txt".into()));
        assert_eq!(split_glob("/x/y.txt", Path::new("/a")), (PathBuf::from("/x"), "y.txt".into()));
        assert_eq!(split_glob("../b/{x,y}/*.md", Path::new("/a/c")), (PathBuf::from("/a/b"), "{x,y}/*.md".into()));
        let b = TempDir::new();
        std::fs::create_dir(b.join("inbox")).unwrap();
        assert_eq!(split_glob("./inbox", b.path()), (b.join("inbox"), "**/*".into()));
        assert_eq!(split_glob("./inbox/", b.path()), (b.join("inbox"), "**/*".into()));
    }

    #[test]
    fn glob_matching() {
        let g = |p: &str, s: &str| Glob::new(p).matches(s);
        assert!(g("*.txt", "a.txt") && g("*.txt", ".hidden.txt") && !g("*.txt", "sub/a.txt") && !g("*.txt", "a.json"));
        assert!(g("**/*.json", "top.json") && g("**/*.json", "sub/deep/x.json") && !g("**/*.json", "skip.txt"));
        assert!(g("**/*", "a") && g("**/*", "a/b/c"));
        assert!(g("a?c", "abc") && !g("a?c", "ac"));
        assert!(g("[ab]*.log", "b1.log") && !g("[ab]*.log", "c1.log") && g("[!ab]*", "c") && g("[a-c]x", "bx"));
        assert!(g("*.{jpg,png}", "x.png") && g("{a,b/c}/*.md", "b/c/r.md") && !g("*.{jpg,png}", "x.gif"));
        assert!(g("data/**/out.csv", "data/out.csv") && g("data/**/out.csv", "data/x/y/out.csv"));
        assert_eq!(Glob::new("*.txt").max_depth, Some(1));
        assert_eq!(Glob::new("{a,b/c}/*").max_depth, Some(3));
        assert_eq!(Glob::new("**/*").max_depth, None);
    }

    struct Setup {
        _box: TempDir,
        dir: PathBuf,
        rt: InputRuntime,
    }

    fn setup() -> Setup {
        let b = TempDir::new();
        let dir = b.join("in");
        std::fs::create_dir(&dir).unwrap();
        let rt = runtime(&b);
        Setup { _box: b, dir, rt }
    }

    fn watch(s: &Setup, path: &str, events: &[&str], read: &str) -> WatchInput {
        WatchInput::new(WatchOptions {
            path: path.into(),
            dir: s.dir.clone(),
            events: Some(events.iter().map(|e| e.to_string()).collect()),
            read: Some(read.into()),
            debounce_ms: Some(10),
            poll_ms: Some(50),
            log: None,
        })
    }

    /// An intake that journals like the runner: the commit runs in its own transaction when the packet is taken.
    fn journaling(rt: &InputRuntime, open: Rc<Cell<bool>>) -> (Intake, Got) {
        let got: Got = Rc::default();
        let g = got.clone();
        let journal = rt.journal.clone();
        let intake: Intake = Rc::new(move |payload, origin, commit: Option<Commit>| {
            let open = open.get();
            g.borrow_mut().push((payload, origin));
            if open
                && let Some(c) = commit {
                    journal.borrow_mut().atomically(|j| c(j)).unwrap();
                }
            let n = g.borrow().len();
            Box::pin(async move { if open { accepted(n) } else { IntakeResult::Unavailable { reason: "paused".into() } } })
        });
        (intake, got)
    }

    fn sleep(ms: u64) -> tokio::time::Sleep {
        tokio::time::sleep(Duration::from_millis(ms))
    }

    #[test]
    fn create_change_and_delete_produce_packets_with_content_and_existing_files_are_baseline() {
        local(async {
            let s = setup();
            std::fs::write(s.dir.join("old.txt"), "old").unwrap();
            let input = watch(&s, "*.txt", &["create", "change", "delete"], "content");
            let (intake, got) = journaling(&s.rt, Rc::new(Cell::new(true)));
            input.start(intake, s.rt.clone()).await.unwrap();
            assert_eq!(input.describe(), format!("watch {}/*.txt (create, change, delete)", s.dir.display()));
            let f = s.dir.join("a.txt");
            let fp = f.display().to_string();
            std::fs::write(&f, "one").unwrap();
            wait_for(|| !got.borrow().is_empty(), 5000, "create").await;
            let (d, o) = got.borrow()[0].clone();
            assert_eq!((d["event"].clone(), d["path"].clone(), d["name"].clone(), d["content"].clone(), d["size"].clone()), (json!("create"), json!(fp), json!("a.txt"), json!("one"), json!(3)));
            assert!(d["mtime"].as_str().unwrap().ends_with('Z'));
            assert_eq!(o.trigger, "watch");
            assert!(o.source.starts_with(&format!("{fp}#create@")));
            std::fs::write(&f, "two!").unwrap();
            wait_for(|| got.borrow().len() >= 2, 5000, "change").await;
            assert_eq!((got.borrow()[1].0["event"].clone(), got.borrow()[1].0["content"].clone()), (json!("change"), json!("two!")));
            std::fs::remove_file(&f).unwrap();
            wait_for(|| got.borrow().len() >= 3, 5000, "delete").await;
            let d = got.borrow()[2].0.clone();
            assert_eq!((d["event"].clone(), d["path"].clone()), (json!("delete"), json!(fp)));
            assert!(d.get("content").is_none() && d.get("mtime").is_none());
            assert!(!got.borrow().iter().any(|g| g.0["name"] == "old.txt"));
            input.stop().await;
            input.stop().await;
        });
    }

    #[test]
    fn read_path_sends_metadata_only_and_events_filters() {
        local(async {
            let s = setup();
            let input = watch(&s, "*.txt", &["create"], "path");
            let (intake, got) = journaling(&s.rt, Rc::new(Cell::new(true)));
            input.start(intake, s.rt.clone()).await.unwrap();
            let f = s.dir.join("a.txt");
            std::fs::write(&f, "one").unwrap();
            wait_for(|| !got.borrow().is_empty(), 5000, "create").await;
            assert!(got.borrow()[0].0.get("content").is_none());
            assert!(got.borrow()[0].0["mtime"].is_string());
            std::fs::write(&f, "changed").unwrap();
            sleep(300).await;
            assert_eq!(got.borrow().len(), 1);
            input.stop().await;
        });
    }

    #[test]
    fn glob_filtering_including_subfolders() {
        local(async {
            let s = setup();
            let input = watch(&s, "**/*.json", &["create"], "path");
            let (intake, got) = journaling(&s.rt, Rc::new(Cell::new(true)));
            input.start(intake, s.rt.clone()).await.unwrap();
            std::fs::create_dir(s.dir.join("sub")).unwrap();
            std::fs::write(s.dir.join("skip.txt"), "x").unwrap();
            std::fs::write(s.dir.join("sub/deep.json"), "{}").unwrap();
            std::fs::write(s.dir.join("top.json"), "{}").unwrap();
            wait_for(|| got.borrow().len() >= 2, 5000, "two json files").await;
            sleep(200).await;
            let mut names: Vec<String> = got.borrow().iter().map(|g| g.0["name"].as_str().unwrap().to_string()).collect();
            names.sort();
            assert_eq!(names, vec!["sub/deep.json", "top.json"]);
            input.stop().await;
        });
    }

    #[test]
    fn a_burst_of_writes_to_one_file_collapses_into_one_event() {
        local(async {
            let s = setup();
            let input = WatchInput::new(WatchOptions {
                path: "*.txt".into(),
                dir: s.dir.clone(),
                events: None,
                read: None,
                debounce_ms: Some(100),
                poll_ms: Some(60_000),
                log: None,
            });
            let (intake, got) = journaling(&s.rt, Rc::new(Cell::new(true)));
            input.start(intake, s.rt.clone()).await.unwrap();
            let f = s.dir.join("a.txt");
            for i in 0..5 {
                std::fs::write(&f, format!("v{i}")).unwrap();
                sleep(5).await;
            }
            sleep(500).await;
            assert_eq!(got.borrow().len(), 1);
            input.stop().await;
        });
    }

    #[test]
    fn an_event_the_runner_could_not_take_is_retried() {
        local(async {
            let s = setup();
            let input = watch(&s, "*.txt", &["create"], "path");
            let open = Rc::new(Cell::new(false));
            let (intake, got) = journaling(&s.rt, open.clone());
            input.start(intake, s.rt.clone()).await.unwrap();
            std::fs::write(s.dir.join("a.txt"), "x").unwrap();
            wait_for(|| !got.borrow().is_empty(), 5000, "first try").await;
            let tried = got.borrow().len();
            open.set(true);
            wait_for(|| got.borrow().len() > tried, 5000, "retry").await;
            let taken = got.borrow().len();
            sleep(200).await;
            assert_eq!(got.borrow().len(), taken, "taken once, then never again");
            input.stop().await;
        });
    }

    #[test]
    fn oversized_files_are_sent_without_content() {
        local(async {
            let s = setup();
            let input = watch(&s, "*.bin", &["create"], "content");
            let (intake, got) = journaling(&s.rt, Rc::new(Cell::new(true)));
            input.start(intake, s.rt.clone()).await.unwrap();
            std::fs::write(s.dir.join("big.bin"), vec![0u8; MAX_CONTENT_BYTES as usize + 1]).unwrap();
            wait_for(|| !got.borrow().is_empty(), 5000, "big file").await;
            assert_eq!((got.borrow()[0].0["content"].clone(), got.borrow()[0].0["truncated"].clone()), (Value::Null, json!(true)));
            input.stop().await;
        });
    }

    /// Start, let the replay scan run, then stop; returns the events seen in this run.
    async fn cycle(s: &Setup, path: &str, events: &[&str], expect: usize) -> Vec<(String, String, u64)> {
        let input = watch(s, path, events, "content");
        let (intake, got) = journaling(&s.rt, Rc::new(Cell::new(true)));
        input.start(intake, s.rt.clone()).await.unwrap();
        wait_for(|| got.borrow().len() >= expect, 5000, &format!("{expect} packets")).await;
        sleep(300).await; // nothing extra arrives
        input.stop().await;
        let mut out: Vec<(String, String, u64)> =
            got.borrow().iter().map(|(d, _)| (d["event"].as_str().unwrap().into(), d["name"].as_str().unwrap().into(), d["size"].as_u64().unwrap())).collect();
        out.sort_by(|a, b| (&a.1, &a.0).cmp(&(&b.1, &b.0)));
        out
    }

    fn ev(e: &str, n: &str, size: u64) -> (String, String, u64) {
        (e.into(), n.into(), size)
    }

    #[test]
    fn changes_made_while_the_runner_was_down_are_emitted_exactly_once() {
        local(async {
            let s = setup();
            let all = ["create", "change", "delete"];
            let f = |n: &str| s.dir.join(n);
            std::fs::write(f("keep.txt"), "keep").unwrap();
            std::fs::write(f("mod.txt"), "before").unwrap();
            std::fs::write(f("del.txt"), "doomed").unwrap();
            assert!(cycle(&s, "*.txt", &all, 0).await.is_empty()); // first start: baseline only

            std::fs::write(f("new.txt"), "fresh").unwrap();
            std::fs::write(f("mod.txt"), "after, longer").unwrap();
            std::fs::remove_file(f("del.txt")).unwrap();
            std::fs::write(f("ignored.json"), "{}").unwrap();
            let got = cycle(&s, "*.txt", &all, 3).await;
            assert_eq!(got, vec![ev("delete", "del.txt", 6), ev("change", "mod.txt", 13), ev("create", "new.txt", 5)]);

            assert!(cycle(&s, "*.txt", &all, 0).await.is_empty()); // restart again: nothing re-emitted
        });
    }

    #[test]
    fn live_events_are_persisted_so_a_restart_does_not_repeat_them_and_an_empty_folder_is_a_baseline() {
        local(async {
            let s = setup();
            let all = ["create", "change", "delete"];
            assert!(cycle(&s, "*.txt", &all, 0).await.is_empty());
            std::fs::write(s.dir.join("a.txt"), "a").unwrap();
            assert_eq!(cycle(&s, "*.txt", &all, 1).await, vec![ev("create", "a.txt", 1)]);

            let input = watch(&s, "*.txt", &all, "content");
            let (intake, got) = journaling(&s.rt, Rc::new(Cell::new(true)));
            input.start(intake, s.rt.clone()).await.unwrap();
            std::fs::write(s.dir.join("live.txt"), "live").unwrap();
            wait_for(|| got.borrow().len() == 1, 5000, "live create").await;
            input.stop().await;
            assert!(cycle(&s, "*.txt", &all, 0).await.is_empty());
        });
    }

    #[test]
    fn unsubscribed_events_still_move_the_snapshot_and_a_changed_glob_starts_a_new_baseline() {
        local(async {
            let s = setup();
            std::fs::write(s.dir.join("m.txt"), "1").unwrap();
            assert!(cycle(&s, "*.txt", &["create"], 0).await.is_empty());
            std::fs::write(s.dir.join("m.txt"), "22").unwrap();
            std::fs::write(s.dir.join("n.txt"), "n").unwrap();
            assert_eq!(cycle(&s, "*.txt", &["create"], 1).await, vec![ev("create", "n.txt", 1)]);
            // Same glob, more events: the change was already seen.
            assert!(cycle(&s, "*.txt", &["create", "change", "delete"], 0).await.is_empty());
            // A different glob: a fresh baseline, no replay.
            std::fs::write(s.dir.join("late.txt"), "late").unwrap();
            assert!(cycle(&s, "*", &["create", "change", "delete"], 0).await.is_empty());
            let saved = s.rt.journal.borrow().input_load(&format!("watch:{}/*.txt", s.dir.display())).unwrap();
            assert!(saved.is_none(), "a new scope replaces the old one");
        });
    }

    #[test]
    fn the_snapshot_entry_is_written_with_the_packet_only() {
        local(async {
            let s = setup();
            let input = watch(&s, "*.txt", &["create", "delete"], "path");
            let open = Rc::new(Cell::new(false));
            let (intake, got) = journaling(&s.rt, open.clone());
            input.start(intake, s.rt.clone()).await.unwrap();
            std::fs::write(s.dir.join("a.txt"), "x").unwrap();
            wait_for(|| !got.borrow().is_empty(), 5000, "an attempt").await;
            let scope = format!("watch:{}/*.txt", s.dir.display());
            let saved = s.rt.journal.borrow().input_load(&scope).unwrap().unwrap();
            assert!(saved.is_empty(), "not taken, not saved");
            open.set(true);
            wait_for(|| s.rt.journal.borrow().input_load(&scope).unwrap().unwrap().len() == 1, 5000, "the saved entry").await;
            let saved = s.rt.journal.borrow().input_load(&scope).unwrap().unwrap();
            let entry = &saved[&s.dir.join("a.txt").display().to_string()];
            assert_eq!(entry["size"], json!(1));
            assert!(entry["mtimeMs"].as_f64().unwrap() > 1.0e12);
            input.stop().await;
        });
    }
}
