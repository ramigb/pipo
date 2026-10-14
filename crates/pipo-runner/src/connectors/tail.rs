// `via: tail` (docs/spec.md §3.3.2, D87): follow one file and hand over each complete line. The position (`pos`:
// device, inode and the byte offset after the last line handed over) commits with each line's packet, so a line is
// journaled once: after a crash, reading resumes after the last committed line. A rename (rotation) is read to its
// end before the new file is opened; a file that shrinks below the offset (truncation) is read again from the start.

use super::{InputAdapter, InputRuntime, Intake, IntakeResult, LocalBoxFuture, Log, Origin, Stopper, resolve_path};
use crate::journal::Journal;
use serde_json::{Map, Value, json};
use std::cell::{Cell, RefCell};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::rc::Rc;
use tokio::task::JoinHandle;

const POLL_MS: u64 = 250;
const RETRY_MS: u64 = 1_000;
/// Longer lines are cut here and sent with `truncated: true`.
pub const MAX_LINE: usize = 1024 * 1024;
const CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LineParse {
    Text,
    Json,
}

impl LineParse {
    pub fn from_with(v: Option<&Value>, what: &str) -> Result<LineParse, String> {
        match v.and_then(|p| p.as_str()) {
            None | Some("text") => Ok(LineParse::Text),
            Some("json") => Ok(LineParse::Json),
            Some(other) => Err(format!("{what} parse '{other}' is not one of text, json")),
        }
    }
}

/// One line as a packet's data: `{line, path?}` (and `truncated: true` when cut) for text, the parsed line for json.
pub fn line_data(bytes: &[u8], truncated: bool, parse: LineParse, path: Option<&str>) -> Result<Value, String> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_suffix('\r').unwrap_or(&text);
    match parse {
        LineParse::Json if !truncated => {
            serde_json::from_str(text).map_err(|e| format!("a line is not JSON ({e}); skipped it"))
        }
        LineParse::Json => {
            Err(format!("a line longer than {} MiB can't be parsed as JSON; skipped it", MAX_LINE >> 20))
        }
        LineParse::Text => {
            let mut m = Map::new();
            m.insert("line".into(), json!(text));
            if let Some(p) = path {
                m.insert("path".into(), json!(p));
            }
            if truncated {
                m.insert("truncated".into(), json!(true));
            }
            Ok(Value::Object(m))
        }
    }
}

pub struct TailOptions {
    pub path: String,
    /// The pipeline's folder; a relative `path` resolves against it.
    pub dir: PathBuf,
    pub parse: LineParse,
    /// A first start reads the whole file instead of only what is written from now on.
    pub from_start: bool,
    pub poll_ms: Option<u64>,
    pub log: Option<Log>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Pos {
    dev: u64,
    ino: u64,
    offset: u64,
}

impl Pos {
    fn json(&self) -> Value {
        json!({ "dev": self.dev, "ino": self.ino, "offset": self.offset })
    }
    fn parse(v: &Value) -> Option<Pos> {
        Some(Pos { dev: v.get("dev")?.as_u64()?, ino: v.get("ino")?.as_u64()?, offset: v.get("offset")?.as_u64()? })
    }
}

struct Open {
    file: File,
    pos: Pos,
    /// Bytes after `pos.offset` read but not yet ending in a newline.
    partial: Vec<u8>,
    /// The rest of a line cut at MAX_LINE is being dropped, up to its newline.
    skipping: bool,
}

struct Inner {
    path: PathBuf,
    shown: String,
    parse: LineParse,
    from_start: bool,
    poll_ms: u64,
    log: Option<Log>,
    stop: Stopper,
    scope: String,
    journal: RefCell<Option<Rc<RefCell<Journal>>>>,
    /// The last committed position (None on a first start).
    saved: RefCell<Option<Pos>>,
    first_start: Cell<bool>,
}

pub struct TailInput {
    inner: Rc<Inner>,
    task: RefCell<Option<JoinHandle<()>>>,
}

impl TailInput {
    pub fn new(o: TailOptions, scope_prefix: &str) -> Result<TailInput, String> {
        if o.path.trim().is_empty() {
            return Err("tail needs a `path`".into());
        }
        let path = resolve_path(&o.dir, &o.path);
        let shown = path.display().to_string();
        let inner = Inner {
            scope: format!("{scope_prefix}tail:{}", o.path),
            path,
            shown,
            parse: o.parse,
            from_start: o.from_start,
            poll_ms: o.poll_ms.unwrap_or(POLL_MS),
            log: o.log,
            stop: Stopper::default(),
            journal: RefCell::new(None),
            saved: RefCell::new(None),
            first_start: Cell::new(false),
        };
        Ok(TailInput { inner: Rc::new(inner), task: RefCell::new(None) })
    }
}

fn identity(m: &std::fs::Metadata) -> (u64, u64) {
    (m.dev(), m.ino())
}

impl Inner {
    fn log(&self, level: &str, message: &str) {
        if let Some(l) = &self.log {
            l(level, message);
        }
    }

    fn save(&self, pos: Pos) {
        let Some(j) = self.journal.borrow().clone() else { return };
        if let Err(e) = j.borrow().input_put(&self.scope, "pos", Some(&pos.json())) {
            self.log("error", &format!("tail {}: could not save its position: {e}", self.shown));
        }
        *self.saved.borrow_mut() = Some(pos);
    }

    /// Open the file at the path: where the saved position says, or (a file never read) at its start or end.
    fn open(&self) -> Option<Open> {
        let mut file = File::open(&self.path).ok()?;
        let meta = file.metadata().ok()?;
        let (dev, ino) = identity(&meta);
        let saved = *self.saved.borrow();
        let offset = match saved {
            Some(p) if p.dev == dev && p.ino == ino && meta.len() >= p.offset => p.offset,
            Some(p) if p.dev == dev && p.ino == ino => {
                self.log(
                    "warn",
                    &format!(
                        "tail {}: the file is shorter than where reading stopped; reading it again from the start",
                        self.shown
                    ),
                );
                0
            }
            Some(_) => 0,
            None if self.first_start.get() && !self.from_start => meta.len(),
            None => 0,
        };
        self.first_start.set(false);
        file.seek(SeekFrom::Start(offset)).ok()?;
        let pos = Pos { dev, ino, offset };
        if saved != Some(pos) {
            self.save(pos);
        }
        Some(Open { file, pos, partial: vec![], skipping: false })
    }

    async fn run(self: Rc<Self>, intake: Intake) {
        let mut open: Option<Open> = None;
        let mut said_missing = false;
        loop {
            if self.stop.stopped() {
                return;
            }
            if open.is_none() {
                open = self.open();
                match &open {
                    None if !said_missing => {
                        self.log("warn", &format!("tail {}: the file doesn't exist yet; waiting for it", self.shown));
                        said_missing = true;
                        // A file that appears later is all new.
                        self.first_start.set(false);
                    }
                    Some(_) => said_missing = false,
                    None => {}
                }
            }
            if let Some(o) = open.as_mut() {
                if !self.drain(o, &intake, false).await {
                    if !self.stop.sleep(RETRY_MS).await {
                        return;
                    }
                    continue;
                }
                match std::fs::metadata(&self.path) {
                    Ok(m) if identity(&m) == (o.pos.dev, o.pos.ino) => {
                        if m.len() < o.pos.offset + o.partial.len() as u64 {
                            self.log(
                                "warn",
                                &format!(
                                    "tail {}: the file was truncated; reading it again from the start",
                                    self.shown
                                ),
                            );
                            let _ = o.file.seek(SeekFrom::Start(0));
                            o.pos.offset = 0;
                            o.partial.clear();
                            self.save(o.pos);
                        }
                    }
                    // Rotated (or removed): what the old file still holds was read above; its last line, if it has
                    // no newline, goes now.
                    _ => {
                        if !self.drain(o, &intake, true).await {
                            continue;
                        }
                        self.log("info", &format!("tail {}: the file was replaced; following the new one", self.shown));
                        *self.saved.borrow_mut() = Some(Pos { dev: 0, ino: 0, offset: 0 });
                        open = None;
                        continue;
                    }
                }
            }
            if !self.stop.sleep(self.poll_ms).await {
                return;
            }
        }
    }

    /// Read to the end of the file and hand over each complete line (with `flush`, the rest too). False when the
    /// runner can't take a line now; that line is read again later.
    async fn drain(&self, o: &mut Open, intake: &Intake, flush: bool) -> bool {
        let mut buf = vec![0u8; CHUNK];
        loop {
            let n = match o.file.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    self.log("error", &format!("tail {}: could not read: {e}", self.shown));
                    return true;
                }
            };
            o.partial.extend_from_slice(&buf[..n]);
            if !self.lines(o, intake).await {
                return false;
            }
        }
        if !self.lines(o, intake).await {
            return false;
        }
        if flush && !o.partial.is_empty() {
            let rest = std::mem::take(&mut o.partial);
            let len = rest.len() as u64;
            if !self.send(o, &rest, false, len, intake).await {
                o.partial = rest;
                return false;
            }
        }
        true
    }

    /// Hand over the complete lines in `o.partial`.
    async fn lines(&self, o: &mut Open, intake: &Intake) -> bool {
        loop {
            if o.skipping {
                let dropped = match o.partial.iter().position(|b| *b == b'\n') {
                    Some(i) => {
                        o.skipping = false;
                        i + 1
                    }
                    None => o.partial.len(),
                };
                o.partial.drain(..dropped);
                o.pos.offset += dropped as u64;
                if dropped > 0 {
                    self.save(o.pos);
                }
                if o.skipping {
                    return true;
                }
            }
            let end = o.partial.iter().position(|b| *b == b'\n');
            let (line_len, used, truncated) = match end {
                Some(i) if i <= MAX_LINE => (i, i + 1, false),
                Some(_) => (MAX_LINE, MAX_LINE, true),
                None if o.partial.len() > MAX_LINE => (MAX_LINE, MAX_LINE, true),
                None => return true,
            };
            let line = o.partial[..line_len].to_vec();
            if !self.send(o, &line, truncated, used as u64, intake).await {
                return false;
            }
            o.partial.drain(..used);
            o.skipping = truncated;
        }
    }

    /// One line, whose bytes up to the next line take `used` bytes of the file.
    async fn send(&self, o: &mut Open, line: &[u8], truncated: bool, used: u64, intake: &Intake) -> bool {
        let start = o.pos.offset;
        let next = Pos { offset: start + used, ..o.pos };
        let data = match line_data(line, truncated, self.parse, Some(&self.shown)) {
            Ok(d) => d,
            Err(e) => {
                self.log("warn", &format!("tail {} at byte {start}: {e}", self.shown));
                o.pos = next;
                self.save(next);
                return true;
            }
        };
        let scope = self.scope.clone();
        let commit: super::Commit = Box::new(move |j: &mut Journal| j.input_put(&scope, "pos", Some(&next.json())));
        let origin = Origin { trigger: "tail".into(), source: format!("{}:{start}", self.shown) };
        match intake(data, origin, Some(commit)).await {
            IntakeResult::Unavailable { .. } => false,
            _ => {
                o.pos = next;
                *self.saved.borrow_mut() = Some(next);
                true
            }
        }
    }
}

impl InputAdapter for TailInput {
    fn start(&self, intake: Intake, runtime: InputRuntime) -> LocalBoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let inner = &self.inner;
            let saved = runtime.journal.borrow().input_load(&inner.scope).map_err(|e| e.to_string())?;
            match &saved {
                None => {
                    runtime
                        .journal
                        .borrow_mut()
                        .input_baseline(&inner.scope, &Map::new())
                        .map_err(|e| e.to_string())?;
                    inner.first_start.set(true);
                }
                Some(state) => {
                    *inner.saved.borrow_mut() = state.get("pos").and_then(Pos::parse);
                    // Started before but never found the file: whatever is there now is new.
                    inner.first_start.set(false);
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
        format!("tail {}", self.inner.shown)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::test_util::*;
    use std::io::Write;
    use std::time::Duration;

    fn tail(dir: &TempDir, parse: LineParse, from_start: bool) -> TailInput {
        let o = TailOptions {
            path: "app.log".into(),
            dir: dir.path().to_path_buf(),
            parse,
            from_start,
            poll_ms: Some(20),
            log: None,
        };
        TailInput::new(o, "input|").unwrap()
    }

    fn append(dir: &TempDir, text: &str) {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("app.log")).unwrap();
        f.write_all(text.as_bytes()).unwrap();
    }

    fn lines(got: &Got) -> Vec<String> {
        got.borrow().iter().map(|(d, _)| d["line"].as_str().unwrap_or_default().to_string()).collect()
    }

    async fn sleep(ms: u64) {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }

    #[test]
    fn lines_written_after_a_first_start_are_sent_once_across_restarts() {
        local(async {
            let dir = TempDir::new();
            append(&dir, "old\n");
            let input = tail(&dir, LineParse::Text, false);
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(true)));
            input.start(intake, rt).await.unwrap();
            sleep(60).await;
            append(&dir, "one\ntwo\r\nthr");
            wait_for(|| got.borrow().len() == 2, 5000, "two lines").await;
            sleep(60).await;
            assert_eq!(lines(&got), vec!["one", "two"], "a line without its newline waits");
            append(&dir, "ee\n");
            wait_for(|| got.borrow().len() == 3, 5000, "the third line").await;
            input.stop().await;
            assert_eq!(
                got.borrow()[2].0,
                json!({ "line": "three", "path": dir.join("app.log").display().to_string() })
            );
            assert_eq!(got.borrow()[0].1.source, format!("{}:4", dir.join("app.log").display()));
            assert_eq!(got.borrow()[0].1.trigger, "tail");
            append(&dir, "four\n");
            let input = tail(&dir, LineParse::Text, false);
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(true)));
            input.start(intake, rt).await.unwrap();
            wait_for(|| !got.borrow().is_empty(), 5000, "the line written while stopped").await;
            sleep(60).await;
            input.stop().await;
            assert_eq!(lines(&got), vec!["four"]);
        });
    }

    #[test]
    fn from_start_rotation_and_truncation() {
        local(async {
            let dir = TempDir::new();
            append(&dir, "a\nb\n");
            let input = tail(&dir, LineParse::Text, true);
            let rt = runtime(&dir);
            let (intake, got) = journaling_intake(&rt, Rc::new(Cell::new(true)));
            input.start(intake, rt).await.unwrap();
            wait_for(|| got.borrow().len() == 2, 5000, "the whole file").await;
            // Rotation: the old file's last lines (even one without a newline) come before the new file's.
            append(&dir, "c\nd");
            std::fs::rename(dir.join("app.log"), dir.join("app.log.1")).unwrap();
            append(&dir, "e\n");
            wait_for(|| got.borrow().len() == 5, 5000, "c, d, e").await;
            assert_eq!(lines(&got), vec!["a", "b", "c", "d", "e"]);
            // Truncation: read again from the start.
            std::fs::write(dir.join("app.log"), "").unwrap();
            sleep(60).await;
            append(&dir, "f\n");
            wait_for(|| got.borrow().len() == 6, 5000, "f").await;
            input.stop().await;
            assert_eq!(lines(&got)[5], "f");
        });
    }

    #[test]
    fn json_lines_a_missing_file_and_a_full_buffer() {
        local(async {
            let dir = TempDir::new();
            let input = tail(&dir, LineParse::Json, false);
            let rt = runtime(&dir);
            let open = Rc::new(Cell::new(false));
            let (intake, got) = journaling_intake(&rt, open.clone());
            input.start(intake, rt).await.unwrap();
            sleep(60).await;
            append(&dir, "{\"n\":1}\nnot json\n{\"n\":2}\n");
            sleep(100).await;
            assert!(got.borrow().is_empty(), "the buffer is full");
            open.set(true);
            wait_for(|| got.borrow().len() == 2, 5000, "both JSON lines").await;
            input.stop().await;
            let data: Vec<Value> = got.borrow().iter().map(|(d, _)| d.clone()).collect();
            assert_eq!(data, vec![json!({ "n": 1 }), json!({ "n": 2 })]);
        });
    }

    #[test]
    fn long_lines_are_cut() {
        let long = vec![b'x'; MAX_LINE + 10];
        assert_eq!(line_data(&long[..MAX_LINE], true, LineParse::Text, None).unwrap()["truncated"], json!(true));
        assert!(line_data(b"{", false, LineParse::Json, None).unwrap_err().starts_with("a line is not JSON"));
        assert_eq!(line_data(b"x\r", false, LineParse::Text, None).unwrap(), json!({ "line": "x" }));
    }
}
