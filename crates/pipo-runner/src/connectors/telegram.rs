// Telegram (docs/spec.md §3.13, D69): `via: telegram`, `tap: telegram`, `to: telegram`, over the Bot API. Port of
// telegram.ts. The input long-polls getUpdates only while its runner runs. Its offset is saved in the packet's own
// transaction, so an update is journaled once: after a crash it is fetched again only if its packet was not
// committed. Sends are at-least-once: Telegram has no idempotency key, so a crash between a send and its commit
// sends it again.

use super::{
    InputAdapter, InputRuntime, Intake, IntakeResult, LocalBoxFuture, Log, Origin, OutputAdapter, Stopper, WriteItem,
    as_i64, http_client, http_error, resolve_path, string_of,
};
use crate::bots::{Bot, Bots, bot_id, pick_bot};
use crate::duration::{format_duration, parse_duration};
use crate::journal::Journal;
use serde_json::{Map, Value, json};
use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;
use tokio::task::JoinHandle;

const DEFAULT_POLL: &str = "25s";
const RETRY_WAIT_MS: u64 = 5_000;
const SEND_TRIES: u32 = 3;
const MAX_RETRY_AFTER_S: u64 = 60;
const TEXT_LIMIT: usize = 4096;
const CAPTION_LIMIT: usize = 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct TelegramError {
    pub message: String,
    /// The HTTP status; 0 when the request failed.
    pub code: u16,
    pub retry_after: Option<u64>,
}

/// A Bot API call's parameters: JSON, or a multipart form (a file upload).
pub enum Params {
    Json(Value),
    Form(Vec<(String, FormValue)>),
}

pub enum FormValue {
    Text(String),
    File { name: String, bytes: Vec<u8> },
}

fn multipart(fields: &[(String, FormValue)]) -> (String, Vec<u8>) {
    let boundary = format!("----pipo{}", crate::ids::ulid().to_lowercase());
    let mut body = vec![];
    for (name, v) in fields {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        match v {
            FormValue::Text(t) => {
                body.extend_from_slice(format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes());
                body.extend_from_slice(t.as_bytes());
            }
            FormValue::File { name: file, bytes } => {
                let file = file.replace(['"', '\r', '\n'], "_");
                body.extend_from_slice(
                    format!("Content-Disposition: form-data; name=\"{name}\"; filename=\"{file}\"\r\nContent-Type: application/octet-stream\r\n\r\n")
                        .as_bytes(),
                );
                body.extend_from_slice(bytes);
            }
        }
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

/// One Bot API call. The URL holds the token, so errors name the method, never the URL.
pub async fn telegram_call(
    bot: &Bot,
    method: &str,
    params: &Params,
    timeout: Duration,
) -> Result<Value, TelegramError> {
    let url = format!("{}/bot{}/{method}", bot.api, bot.token);
    let req = http_client().post(url).timeout(timeout);
    let req = match params {
        Params::Json(v) => req.header("content-type", "application/json").body(crate::expr::js_json(v)),
        Params::Form(fields) => {
            let (ct, body) = multipart(fields);
            req.header("content-type", ct).body(body)
        }
    };
    let res = req.send().await.map_err(|e| TelegramError {
        message: format!("telegram {method} failed: {}; check the network", http_error(e)),
        code: 0,
        retry_after: None,
    })?;
    let status = res.status().as_u16();
    let body: Option<Value> = res.json().await.ok();
    if let Some(b) = &body
        && b.get("ok").and_then(|o| o.as_bool()) == Some(true)
    {
        return Ok(b.get("result").cloned().unwrap_or(Value::Null));
    }
    let why = body
        .as_ref()
        .and_then(|b| b.get("description"))
        .and_then(|d| d.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("HTTP {status}"));
    let hint = match status {
        401 | 404 => {
            "the bot token is wrong or revoked; get a new one from @BotFather and update the bot in the dashboard (Bots)"
        }
        409 => {
            "another program reads this bot's updates (another pipeline, or a webhook); stop it, or call deleteWebhook"
        }
        403 => "the user blocked the bot, or never pressed Start in its chat",
        429 => "Telegram is rate limiting this bot",
        _ => "see the Telegram Bot API docs for this error",
    };
    let retry_after =
        body.as_ref().and_then(|b| b.get("parameters")).and_then(|p| p.get("retry_after")).and_then(|r| r.as_u64());
    Err(TelegramError {
        message: format!("telegram {method} answered {status}: {why}; {hint}"),
        code: status,
        retry_after,
    })
}

// ── input ─────────────────────────────────────────────────────────────────────

const FILE_KINDS: &[&str] = &["document", "photo", "audio", "voice", "video", "animation"];

pub struct TelegramInputOptions {
    pub bot: Bot,
    /// `with.allow` replaces the bot's list.
    pub allow: Option<Vec<i64>>,
    pub poll_every: Option<String>,
    /// Download attached files into `files_dir` (default true).
    pub download: Option<bool>,
    pub files_dir: PathBuf,
    pub log: Option<Log>,
}

struct Inner {
    bot: Bot,
    allow: HashSet<i64>,
    poll_s: u64,
    download: bool,
    files_dir: PathBuf,
    log: Option<Log>,
    stop: Stopper,
    offset: Cell<i64>,
    scope: String,
    journal: RefCell<Option<Rc<RefCell<Journal>>>>,
}

pub struct TelegramInput {
    inner: Rc<Inner>,
    task: RefCell<Option<JoinHandle<()>>>,
}

impl TelegramInput {
    pub fn new(o: TelegramInputOptions) -> Result<TelegramInput, String> {
        let every = o.poll_every.or_else(|| o.bot.poll_every.clone()).unwrap_or_else(|| DEFAULT_POLL.into());
        let ms = parse_duration(&every)?;
        if ms < 1000 {
            return Err("telegram poll_every must be at least 1s".into());
        }
        let allow = o.allow.unwrap_or_else(|| o.bot.allow.clone()).into_iter().collect();
        let scope = format!("telegram:{}", bot_id(&o.bot.token));
        let inner = Inner {
            bot: o.bot,
            allow,
            poll_s: (ms as f64 / 1000.0).round() as u64,
            download: o.download != Some(false),
            files_dir: o.files_dir,
            log: o.log,
            stop: Stopper::default(),
            offset: Cell::new(0),
            scope,
            journal: RefCell::new(None),
        };
        Ok(TelegramInput { inner: Rc::new(inner), task: RefCell::new(None) })
    }
}

/// `basename` of a path given by Telegram or a user (either separator).
fn basename(p: &str) -> String {
    p.rsplit('/').next().unwrap_or(p).to_string()
}

/// `name.replace(/[^\w.-]+/g, "_")`.
fn safe_name(name: &str) -> String {
    let mut out = String::new();
    let mut in_bad = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' {
            out.push(c);
            in_bad = false;
        } else if !in_bad {
            out.push('_');
            in_bad = true;
        }
    }
    out
}

impl Inner {
    fn log(&self, level: &str, message: &str) {
        if let Some(l) = &self.log {
            l(level, message);
        }
    }

    /// Saves the offset outside a packet (an ignored or non-message update advances it on its own).
    fn save_offset(&self, next: i64) -> Result<(), String> {
        if let Some(j) = self.journal.borrow().as_ref() {
            j.borrow().input_put(&self.scope, "offset", Some(&json!(next))).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    async fn run(self: Rc<Self>, intake: Intake) {
        while !self.stop.stopped() {
            let params = Params::Json(
                json!({ "offset": self.offset.get(), "timeout": self.poll_s, "allowed_updates": ["message"] }),
            );
            let wait = Duration::from_secs(self.poll_s + 15);
            let fetched = tokio::select! {
                r = telegram_call(&self.bot, "getUpdates", &params, wait) => r,
                _ = self.stop.wait() => return,
            };
            let updates = match fetched {
                Ok(Value::Array(u)) => u,
                Ok(_) => vec![],
                Err(e) => {
                    self.log("error", &format!("{}; retrying in {}s", e.message, RETRY_WAIT_MS / 1000));
                    self.stop.sleep(RETRY_WAIT_MS).await;
                    continue;
                }
            };
            for u in &updates {
                if self.stop.stopped() {
                    return;
                }
                if !self.take(u, &intake).await {
                    self.stop.sleep(1000).await;
                    break; // fetched again from the same offset
                }
            }
        }
    }

    /// False when the runner can't take the packet now (buffer full, draining): the update is fetched again later.
    async fn take(self: &Rc<Self>, u: &Value, intake: &Intake) -> bool {
        let next = u.get("update_id").and_then(as_i64).unwrap_or(self.offset.get()) + 1;
        let skip = || match self.save_offset(next) {
            Ok(()) => {
                self.offset.set(next);
                true
            }
            Err(e) => {
                self.log("error", &format!("telegram {}: could not save the update offset: {e}", self.bot.name));
                false
            }
        };
        let Some(m) = u.get("message").filter(|m| m.is_object()) else { return skip() };
        let chat = m.get("chat").and_then(|c| c.get("id")).and_then(as_i64);
        let from = m.get("from").and_then(|c| c.get("id")).and_then(as_i64);
        let allowed = |id: Option<i64>| id.is_some_and(|i| self.allow.contains(&i));
        if !allowed(chat) && !allowed(from) {
            let f = m.get("from");
            let who = match f.and_then(|f| f.get("username")).and_then(|u| u.as_str()) {
                Some(u) => format!("@{u}"),
                None => f.and_then(|f| f.get("first_name")).and_then(|n| n.as_str()).unwrap_or("someone").to_string(),
            };
            let id = |v: Option<i64>| v.map(|i| i.to_string()).unwrap_or_else(|| "NaN".into());
            self.log(
                "warn",
                &format!(
                    "telegram {}: ignored a message from {who} (user id {}, chat id {}): not in the allow list; add {} to the bot's allow list in the dashboard (Bots) to accept it",
                    self.bot.name,
                    id(from),
                    id(chat),
                    id(chat)
                ),
            );
            return skip();
        }
        let payload = self.packet(m).await;
        let scope = self.scope.clone();
        let commit: super::Commit = Box::new(move |j: &mut Journal| j.input_put(&scope, "offset", Some(&json!(next))));
        let source = chat.map(|c| c.to_string()).unwrap_or_else(|| "NaN".into());
        match intake(payload, Origin { trigger: "telegram".into(), source }, Some(commit)).await {
            IntakeResult::Unavailable { .. } => false,
            _ => {
                self.offset.set(next);
                true
            }
        }
    }

    async fn packet(&self, m: &Value) -> Value {
        let kind = FILE_KINDS.iter().find(|k| m.get(**k).is_some_and(|v| !v.is_null())).copied();
        // A photo comes in several sizes, smallest first.
        let f = match kind {
            Some("photo") => m.get("photo").and_then(|p| p.as_array()).and_then(|p| p.last()).cloned(),
            Some(k) => m.get(k).cloned(),
            None => None,
        };
        let from = m.get("from");
        let field = |v: Option<&Value>, k: &str| v.and_then(|v| v.get(k)).cloned();
        let name: Vec<String> = ["first_name", "last_name"]
            .iter()
            .filter_map(|k| field(from, k))
            .filter(super::truthy)
            .map(|v| string_of(&v))
            .collect();
        let mut out = Map::new();
        let mut put = |k: &str, v: Option<Value>| {
            if let Some(v) = v {
                out.insert(k.into(), v);
            }
        };
        put("message_id", m.get("message_id").cloned());
        let date = m.get("date").and_then(|d| d.as_f64()).unwrap_or(0.0);
        put("date", Some(json!(crate::time::iso((date * 1000.0) as i64))));
        put("chat_id", field(m.get("chat"), "id"));
        put("chat_type", field(m.get("chat"), "type"));
        let mut who = Map::new();
        if let Some(id) = field(from, "id") {
            who.insert("id".into(), id);
        }
        who.insert("username".into(), field(from, "username").unwrap_or(Value::Null));
        who.insert("name".into(), json!(name.join(" ")));
        put("from", Some(Value::Object(who)));
        let text = m
            .get("text")
            .filter(|t| !t.is_null())
            .or(m.get("caption").filter(|t| !t.is_null()))
            .cloned()
            .unwrap_or(json!(""));
        put("text", Some(text));
        let file = match (kind, f) {
            (Some(k), Some(f)) => self.file(k, &f).await,
            _ => Value::Null,
        };
        put("file", Some(file));
        Value::Object(out)
    }

    async fn file(&self, kind: &str, f: &Value) -> Value {
        let get = |k: &str| f.get(k).cloned().filter(|v| !v.is_null());
        let mut out = json!({
            "kind": kind,
            "file_id": get("file_id").unwrap_or(Value::Null),
            "name": get("file_name").unwrap_or(Value::Null),
            "mime_type": get("mime_type").unwrap_or(Value::Null),
            "size": get("file_size").unwrap_or(Value::Null),
            "path": Value::Null,
        });
        if !self.download {
            return out;
        }
        match self.download(kind, f).await {
            Ok(path) => out["path"] = json!(path.display().to_string()),
            // Telegram bots can't download files over 20 MB; the packet still carries the file's id and name.
            Err(e) => self.log("warn", &format!("telegram {}: could not download a {kind}: {e}", self.bot.name)),
        }
        out
    }

    async fn download(&self, kind: &str, f: &Value) -> Result<PathBuf, String> {
        let file_id = f.get("file_id").map(string_of).unwrap_or_default();
        let info =
            telegram_call(&self.bot, "getFile", &Params::Json(json!({ "file_id": file_id })), Duration::from_secs(30))
                .await
                .map_err(|e| e.message)?;
        let Some(file_path) = info.get("file_path").and_then(|p| p.as_str()).filter(|p| !p.is_empty()) else {
            return Err("Telegram gave no file path".into());
        };
        let name = match f.get("file_name").and_then(|n| n.as_str()) {
            Some(n) => basename(n),
            None => {
                let ext =
                    Path::new(file_path).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
                format!("{kind}{ext}")
            }
        };
        let unique = f.get("file_unique_id").map(string_of).unwrap_or_default();
        let path = self.files_dir.join(format!("{unique}-{}", safe_name(&name)));
        if !path.exists() {
            let url = format!("{}/file/bot{}/{file_path}", self.bot.api, self.bot.token);
            let res = http_client().get(url).timeout(Duration::from_secs(120)).send().await.map_err(http_error)?;
            if !res.status().is_success() {
                return Err(format!("download answered {}", res.status().as_u16()));
            }
            let bytes = res.bytes().await.map_err(http_error)?;
            std::fs::create_dir_all(&self.files_dir).map_err(|e| e.to_string())?;
            let part = PathBuf::from(format!("{}.part", path.display()));
            std::fs::write(&part, &bytes).map_err(|e| e.to_string())?;
            std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
        }
        Ok(path)
    }
}

impl InputAdapter for TelegramInput {
    fn start(&self, intake: Intake, runtime: InputRuntime) -> LocalBoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let inner = &self.inner;
            let saved = runtime.journal.borrow().input_load(&inner.scope).map_err(|e| e.to_string())?;
            if saved.is_none() {
                runtime.journal.borrow_mut().input_baseline(&inner.scope, &Map::new()).map_err(|e| e.to_string())?;
            }
            inner.offset.set(saved.as_ref().and_then(|s| s.get("offset")).and_then(as_i64).unwrap_or(0));
            *inner.journal.borrow_mut() = Some(runtime.journal.clone());
            if inner.allow.is_empty() {
                inner.log(
                    "warn",
                    &format!("telegram {} has no allow list: every message is ignored; the log names each sender's id to add", inner.bot.name),
                );
            }
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
        format!("telegram {}, long polling ({})", self.inner.bot.name, format_duration(self.inner.poll_s * 1000))
    }

    fn polls_bot(&self) -> Option<String> {
        Some(bot_id(&self.inner.bot.token))
    }
}

// ── sending (tap and output) ───────────────────────────────────────────────────

/// The first `limit` UTF-16 units of `s` (Telegram counts text in UTF-16), without splitting a character.
fn utf16_prefix(s: &str, limit: usize) -> String {
    let mut n = 0;
    s.chars()
        .take_while(|c| {
            n += c.len_utf16();
            n <= limit
        })
        .collect()
}

/// Send one message from a rendered `with:` block. Answers `{chat_id, message_id}`.
pub async fn telegram_send(
    bots: Option<&Bots>,
    dir: &Path,
    w: &Map<String, Value>,
    data: &Value,
    origin: Option<&Origin>,
    owner: &str,
) -> Result<Value, String> {
    let bot = pick_bot(bots, w, owner)?;
    let chat = match w.get("chat_id").filter(|c| !c.is_null()) {
        Some(c) => Some(c.clone()),
        None => origin.filter(|o| o.trigger == "telegram").map(|o| Value::String(o.source.clone())),
    };
    let Some(chat) = chat.filter(|c| c.as_str() != Some("")) else {
        return Err(format!(
            "{owner}.with.chat_id is not set and the packet did not come from a telegram input; set {owner}.with.chat_id"
        ));
    };
    let text = match w.get("text") {
        Some(t) => string_of(t),
        None => match data {
            Value::String(s) => s.clone(),
            other => serde_json::to_string_pretty(other).unwrap_or_default(),
        },
    };
    let media = if w.contains_key("photo") {
        Some("photo")
    } else if w.contains_key("document") {
        Some("document")
    } else {
        None
    };
    let mut common = Map::new();
    common.insert("chat_id".into(), chat.clone());
    if let Some(pm) = w.get("parse_mode").filter(|p| super::truthy(p)) {
        common.insert("parse_mode".into(), pm.clone());
    }
    let mut method = "sendMessage";
    let mut params = {
        let mut p = common.clone();
        p.insert("text".into(), json!(utf16_prefix(&text, TEXT_LIMIT)));
        Params::Json(Value::Object(p))
    };
    if let Some(media) = media {
        method = if media == "photo" { "sendPhoto" } else { "sendDocument" };
        let reference = string_of(&w[media]);
        let caption = utf16_prefix(&text, CAPTION_LIMIT);
        if reference.starts_with("http://") || reference.starts_with("https://") {
            let mut p = common.clone();
            p.insert(media.into(), json!(reference));
            if !caption.is_empty() {
                p.insert("caption".into(), json!(caption));
            }
            params = Params::Json(Value::Object(p));
        } else {
            let path = resolve_path(dir, &reference);
            let Ok(bytes) = std::fs::read(&path) else {
                return Err(format!(
                    "{owner}.with.{media}: no file at {}; give a path or an http(s) URL",
                    path.display()
                ));
            };
            let mut form: Vec<(String, FormValue)> =
                common.iter().map(|(k, v)| (k.clone(), FormValue::Text(string_of(v)))).collect();
            if !caption.is_empty() {
                form.push(("caption".into(), FormValue::Text(caption)));
            }
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            form.push((media.into(), FormValue::File { name, bytes }));
            params = Params::Form(form);
        }
    }
    let mut attempt = 1;
    loop {
        match telegram_call(&bot, method, &params, Duration::from_secs(30)).await {
            Ok(msg) => {
                let chat_id =
                    msg.get("chat").and_then(|c| c.get("id")).cloned().filter(|c| !c.is_null()).unwrap_or(chat);
                return Ok(
                    json!({ "chat_id": chat_id, "message_id": msg.get("message_id").cloned().unwrap_or(Value::Null) }),
                );
            }
            // Rate limited: wait as Telegram asks, a few times, before the step's own on_error takes over.
            Err(e) if e.code == 429 && attempt < SEND_TRIES => {
                let wait = e.retry_after.unwrap_or(1).min(MAX_RETRY_AFTER_S);
                tokio::time::sleep(Duration::from_secs(wait)).await;
                attempt += 1;
            }
            Err(e) => return Err(e.message),
        }
    }
}

pub struct TelegramOutput {
    pub bots: Option<Rc<Bots>>,
    pub dir: PathBuf,
}

impl OutputAdapter for TelegramOutput {
    fn write(&self, items: Vec<WriteItem>) -> LocalBoxFuture<'_, Result<Vec<Value>, String>> {
        Box::pin(async move {
            let mut out = vec![];
            for i in items {
                out.push(
                    telegram_send(self.bots.as_deref(), &self.dir, &i.with, &i.data, i.origin.as_ref(), "output")
                        .await?,
                );
            }
            Ok(out)
        })
    }

    fn verify<'a>(
        &'a self,
        check: &'a str,
        _: &'a Map<String, Value>,
        _: &'a WriteItem,
        _: &'a Value,
    ) -> LocalBoxFuture<'a, Result<bool, String>> {
        Box::pin(async move { Err(format!("telegram output does not support delivery check '{check}'")) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::http_input::parse_multipart;
    use crate::connectors::test_util::*;

    const MAIN: &str = "111:main-secret-token";
    const ALERTS: &str = "222:alerts-secret-token";

    #[derive(Clone)]
    struct Sent {
        token: String,
        method: String,
        body: Value,
    }

    /// A fake Bot API: queued updates, recorded calls, one downloadable file.
    #[derive(Clone, Default)]
    struct Fake {
        api: String,
        updates: Rc<RefCell<Vec<Value>>>,
        calls: Rc<RefCell<Vec<Sent>>>,
        offsets: Rc<RefCell<Vec<i64>>>,
        fail_sends: Rc<Cell<u32>>,
        next: Rc<Cell<i64>>,
    }

    impl Fake {
        async fn start() -> Fake {
            let mut fake = Fake::default();
            fake.next.set(1);
            let f = fake.clone();
            let s = server(Rc::new(move |c: Call| {
                let f = f.clone();
                Box::pin(async move { f.answer(c).await })
            }))
            .await;
            fake.api = s.base;
            fake
        }

        async fn answer(&self, c: Call) -> Reply {
            if c.path.starts_with("/file/") {
                return Reply::text(200, "file-bytes");
            }
            let mut parts = c.path.split('/').skip(1);
            let token = parts.next().unwrap_or("").trim_start_matches("bot").to_string();
            let method = parts.next().unwrap_or("").to_string();
            let ct = c.header("content-type").unwrap_or_default();
            let body = if ct.starts_with("multipart/") {
                let mut o = Map::new();
                for p in parse_multipart(&c.body, &ct).unwrap() {
                    let v = match &p.filename {
                        Some(f) => json!({ "filename": f, "content": String::from_utf8_lossy(&p.data) }),
                        None => json!(String::from_utf8_lossy(&p.data)),
                    };
                    o.insert(p.name, v);
                }
                Value::Object(o)
            } else {
                c.json()
            };
            if method == "getUpdates" {
                let offset = body["offset"].as_i64().unwrap();
                self.offsets.borrow_mut().push(offset);
                let due: Vec<Value> = self
                    .updates
                    .borrow()
                    .iter()
                    .filter(|u| u["update_id"].as_i64().unwrap() >= offset)
                    .cloned()
                    .collect();
                if due.is_empty() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                return Reply::json(200, &json!({ "ok": true, "result": due }));
            }
            self.calls.borrow_mut().push(Sent { token, method: method.clone(), body: body.clone() });
            if method == "getFile" {
                return Reply::json(200, &json!({ "ok": true, "result": { "file_path": "documents/file_1.txt" } }));
            }
            if self.fail_sends.get() > 0 {
                self.fail_sends.set(self.fail_sends.get() - 1);
                return Reply::json(
                    429,
                    &json!({ "ok": false, "error_code": 429, "description": "Too Many Requests", "parameters": { "retry_after": 0 } }),
                );
            }
            let chat = string_of(&body["chat_id"]).parse::<i64>().unwrap_or(0);
            Reply::json(
                200,
                &json!({ "ok": true, "result": { "message_id": self.calls.borrow().len(), "chat": { "id": chat } } }),
            )
        }

        fn message(&self, chat: i64, extra: Value) -> i64 {
            let id = self.next.get();
            self.next.set(id + 1);
            let mut m = json!({ "message_id": id, "date": 1_700_000_000, "chat": { "id": chat, "type": "private" }, "from": { "id": chat, "first_name": "Ann", "username": "ann" } });
            for (k, v) in extra.as_object().unwrap() {
                m[k] = v.clone();
            }
            self.updates.borrow_mut().push(json!({ "update_id": id, "message": m }));
            id
        }

        fn sends(&self) -> Vec<Sent> {
            self.calls.borrow().iter().filter(|c| c.method.starts_with("send")).cloned().collect()
        }

        fn bot(&self, name: &str, token: &str, allow: Vec<i64>) -> Bot {
            Bot { name: name.into(), token: token.into(), api: self.api.clone(), allow, poll_every: Some("1s".into()) }
        }
    }

    fn logger() -> (Log, Rc<RefCell<Vec<String>>>) {
        let lines: Rc<RefCell<Vec<String>>> = Rc::default();
        let l = lines.clone();
        (Rc::new(move |level: &str, m: &str| l.borrow_mut().push(format!("{level}: {m}"))), lines)
    }

    /// An intake that journals like the runner: the commit runs in its own transaction.
    fn journaling(rt: &InputRuntime, open: Rc<Cell<bool>>) -> (Intake, Got) {
        let got: Got = Rc::default();
        let g = got.clone();
        let journal = rt.journal.clone();
        let intake: Intake = Rc::new(move |payload, origin, commit: Option<super::super::Commit>| {
            let open = open.get();
            if open {
                g.borrow_mut().push((payload, origin));
                if let Some(c) = commit {
                    journal.borrow_mut().atomically(|j| c(j)).unwrap();
                }
            }
            let n = g.borrow().len();
            Box::pin(async move {
                if open { accepted(n) } else { IntakeResult::Unavailable { reason: "buffer full".into() } }
            })
        });
        (intake, got)
    }

    fn input(bot: Bot, dir: &TempDir, log: Log) -> TelegramInput {
        TelegramInput::new(TelegramInputOptions {
            bot,
            allow: None,
            poll_every: None,
            download: None,
            files_dir: dir.join("files"),
            log: Some(log),
        })
        .unwrap()
    }

    #[test]
    fn settings() {
        let bot =
            Bot { name: "main".into(), token: MAIN.into(), api: "http://x".into(), allow: vec![1], poll_every: None };
        let o = |poll: Option<&str>| TelegramInputOptions {
            bot: bot.clone(),
            allow: None,
            poll_every: poll.map(str::to_owned),
            download: None,
            files_dir: PathBuf::new(),
            log: None,
        };
        assert_eq!(TelegramInput::new(o(Some("500ms"))).err().unwrap(), "telegram poll_every must be at least 1s");
        let i = TelegramInput::new(o(None)).unwrap();
        assert_eq!(i.describe(), "telegram main, long polling (25s)");
        assert_eq!(i.polls_bot().as_deref(), Some("111"));
    }

    #[test]
    fn takes_allowed_messages_ignores_strangers_and_resumes_after_its_saved_offset() {
        local(async {
            let fake = Fake::start().await;
            let dir = TempDir::new();
            let rt = runtime(&dir);
            let (log, lines) = logger();
            let tg = input(fake.bot("main", MAIN, vec![42]), &dir, log.clone());
            let open = Rc::new(Cell::new(true));
            let (intake, got) = journaling(&rt, open.clone());
            tg.start(intake.clone(), rt.clone()).await.unwrap();
            fake.message(7, json!({"text": "let me in"}));
            fake.message(42, json!({"text": "hi"}));
            wait_for(|| got.borrow().len() == 1, 5000, "the message").await;
            let (data, origin) = got.borrow()[0].clone();
            assert_eq!((origin.trigger.as_str(), origin.source.as_str()), ("telegram", "42"));
            assert_eq!(
                data,
                json!({"message_id": 2, "date": "2023-11-14T22:13:20.000Z", "chat_id": 42, "chat_type": "private",
                       "from": {"id": 42, "username": "ann", "name": "Ann"}, "text": "hi", "file": null})
            );
            assert!(lines.borrow().iter().any(|l| {
                l.contains("ignored a message from @ann (user id 7, chat id 7): not in the allow list; add 7")
            }));
            wait_for(|| fake.offsets.borrow().last() == Some(&3), 5000, "the next poll").await;
            tg.stop().await;
            tg.stop().await;

            // A new start resumes after the saved offset; an update the runner can't take is fetched again.
            fake.offsets.borrow_mut().clear();
            open.set(false);
            fake.message(42, json!({"caption": "again"}));
            let tg = input(fake.bot("main", MAIN, vec![42]), &dir, log);
            tg.start(intake, rt.clone()).await.unwrap();
            wait_for(|| fake.offsets.borrow().len() >= 2, 5000, "two polls").await;
            assert_eq!(fake.offsets.borrow()[..2], [3, 3]);
            open.set(true);
            wait_for(|| got.borrow().len() == 2, 5000, "the retried message").await;
            assert_eq!(got.borrow()[1].0["text"], json!("again"));
            tg.stop().await;
            let saved = rt.journal.borrow().input_load("telegram:111").unwrap().unwrap();
            assert_eq!(saved["offset"], json!(4));
        });
    }

    #[test]
    fn no_allow_list_warns_and_downloads_attached_files() {
        local(async {
            let fake = Fake::start().await;
            let dir = TempDir::new();
            let rt = runtime(&dir);
            let (log, lines) = logger();
            let tg = input(fake.bot("main", MAIN, vec![]), &dir, log.clone());
            let (intake, got) = journaling(&rt, Rc::new(Cell::new(true)));
            tg.start(intake.clone(), rt.clone()).await.unwrap();
            assert!(lines.borrow()[0].contains("telegram main has no allow list"));
            tg.stop().await;

            let tg = TelegramInput::new(TelegramInputOptions {
                bot: fake.bot("main", MAIN, vec![]),
                allow: Some(vec![42]),
                poll_every: None,
                download: None,
                files_dir: dir.join("files"),
                log: Some(log),
            })
            .unwrap();
            tg.start(intake, rt).await.unwrap();
            fake.message(42, json!({"caption": "here", "document": {"file_id": "F1", "file_unique_id": "U1", "file_name": "../notes v1.txt", "file_size": 10}}));
            fake.message(42, json!({"photo": [{"file_id": "S", "file_unique_id": "small"}, {"file_id": "B", "file_unique_id": "big"}]}));
            wait_for(|| got.borrow().len() == 2, 5000, "two messages").await;
            tg.stop().await;
            let doc = got.borrow()[0].0.clone();
            let path = dir.join("files/U1-notes_v1.txt");
            assert_eq!(doc["text"], json!("here"));
            assert_eq!(
                doc["file"],
                json!({"kind": "document", "file_id": "F1", "name": "../notes v1.txt", "mime_type": null, "size": 10, "path": path.display().to_string()})
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "file-bytes");
            let photo = got.borrow()[1].0["file"].clone();
            assert_eq!(
                (photo["file_id"].clone(), photo["path"].clone()),
                (json!("B"), json!(dir.join("files/big-photo.txt").display().to_string()))
            );
        });
    }

    #[test]
    fn sends_reply_to_the_senders_chat_and_retry_429() {
        local(async {
            let fake = Fake::start().await;
            let dir = TempDir::new();
            let mut bots = Bots::default();
            bots.telegram.insert("main".into(), fake.bot("main", MAIN, vec![]));
            bots.telegram.insert("alerts".into(), fake.bot("alerts", ALERTS, vec![]));
            bots.default = Some("main".into());
            let out = TelegramOutput { bots: Some(Rc::new(bots.clone())), dir: dir.path().to_path_buf() };
            let origin = Origin { trigger: "telegram".into(), source: "42".into() };
            let w = json!({"text": "echo: hi"});
            let item = WriteItem {
                packet_id: "p".into(),
                data: json!({"a": 1}),
                with: w.as_object().cloned().unwrap(),
                origin: Some(origin),
            };
            let r = out.write(vec![item]).await.unwrap();
            assert_eq!(r, vec![json!({"chat_id": 42, "message_id": 1})]);
            let s = fake.sends()[0].clone();
            assert_eq!((s.token.as_str(), s.method.as_str()), (MAIN, "sendMessage"));
            assert_eq!(s.body, json!({"chat_id": "42", "text": "echo: hi"}));

            // A tap from another bot; a 429 is retried as Telegram asks; data goes as pretty JSON.
            fake.fail_sends.set(1);
            let w = json!({"bot": "alerts", "chat_id": 99, "parse_mode": "HTML"});
            let tap = crate::connectors::steps::TelegramTap {
                bots: Some(Rc::new(bots.clone())),
                dir: dir.path().to_path_buf(),
            };
            let input = crate::connectors::StepInput {
                packet_id: "p".into(),
                node: "ping".into(),
                data: json!({"a": 1}),
                with: w.as_object().cloned().unwrap(),
                origin: None,
            };
            crate::connectors::StepAdapter::run(&tap, input).await.unwrap();
            let sends = fake.sends();
            assert_eq!(sends.len(), 3);
            assert_eq!(sends[2].token, ALERTS);
            assert_eq!(sends[2].body, json!({"chat_id": 99, "parse_mode": "HTML", "text": "{\n  \"a\": 1\n}"}));

            // Without a chat id, and with a 429 that never ends.
            let none = WriteItem { packet_id: "p".into(), data: json!("x"), with: Map::new(), origin: None };
            let e = out.write(vec![none]).await.unwrap_err();
            assert_eq!(
                e,
                "output.with.chat_id is not set and the packet did not come from a telegram input; set output.with.chat_id"
            );
            fake.fail_sends.set(5);
            let w = json!({"chat_id": 1});
            let e = telegram_send(Some(&bots), dir.path(), w.as_object().unwrap(), &json!("x"), None, "output")
                .await
                .unwrap_err();
            assert!(
                e.starts_with(
                    "telegram sendMessage answered 429: Too Many Requests; Telegram is rate limiting this bot"
                ),
                "{e}"
            );
            assert!(!e.contains(MAIN));
            let e = out
                .verify(
                    "status",
                    &Map::new(),
                    &WriteItem { packet_id: "p".into(), data: Value::Null, with: Map::new(), origin: None },
                    &Value::Null,
                )
                .await
                .unwrap_err();
            assert_eq!(e, "telegram output does not support delivery check 'status'");
        });
    }

    #[test]
    fn sends_a_document_from_a_file_or_a_url() {
        local(async {
            let fake = Fake::start().await;
            let dir = TempDir::new();
            std::fs::write(dir.join("notes.txt"), "file-bytes").unwrap();
            let bots = Bots {
                telegram: [("main".to_string(), fake.bot("main", MAIN, vec![]))].into(),
                default: Some("main".into()),
            };
            let w = json!({"document": "notes.txt", "text": "got notes.txt", "chat_id": "42"});
            telegram_send(Some(&bots), dir.path(), w.as_object().unwrap(), &Value::Null, None, "output").await.unwrap();
            let s = fake.sends()[0].clone();
            assert_eq!(s.method, "sendDocument");
            assert_eq!(
                s.body,
                json!({"chat_id": "42", "caption": "got notes.txt", "document": {"filename": "notes.txt", "content": "file-bytes"}})
            );
            let w = json!({"photo": "https://example.com/a.png", "text": "", "chat_id": 5});
            telegram_send(Some(&bots), dir.path(), w.as_object().unwrap(), &Value::Null, None, "output").await.unwrap();
            assert_eq!(fake.sends()[1].body, json!({"chat_id": 5, "photo": "https://example.com/a.png"}));
            let w = json!({"photo": "missing.png", "chat_id": 5});
            let e = telegram_send(Some(&bots), dir.path(), w.as_object().unwrap(), &Value::Null, None, "nodes.n")
                .await
                .unwrap_err();
            assert_eq!(
                e,
                format!(
                    "nodes.n.with.photo: no file at {}; give a path or an http(s) URL",
                    dir.join("missing.png").display()
                )
            );
        });
    }

    #[test]
    fn bad_tokens_and_unreachable_apis_never_show_the_token() {
        local(async {
            let s = server(Rc::new(|_| {
                Box::pin(async { Reply::json(401, &json!({"ok": false, "description": "Unauthorized"})) })
            }))
            .await;
            let bot =
                Bot { name: "main".into(), token: MAIN.into(), api: s.base.clone(), allow: vec![], poll_every: None };
            let e = telegram_call(&bot, "getMe", &Params::Json(json!({})), Duration::from_secs(5)).await.unwrap_err();
            assert_eq!(e.code, 401);
            assert!(
                e.message.starts_with("telegram getMe answered 401: Unauthorized; the bot token is wrong or revoked")
            );
            let bot = Bot { api: "http://127.0.0.1:1".into(), ..bot };
            let e = telegram_call(&bot, "getMe", &Params::Json(json!({})), Duration::from_secs(5)).await.unwrap_err();
            assert_eq!(e.code, 0);
            assert!(
                e.message.starts_with("telegram getMe failed: ") && e.message.ends_with("; check the network"),
                "{}",
                e.message
            );
            assert!(!e.message.contains("main-secret"));
        });
    }

    #[test]
    fn text_limits_count_utf16_units() {
        assert_eq!(utf16_prefix("abc", 2), "ab");
        assert_eq!(utf16_prefix("a😀b", 2), "a");
        assert_eq!(utf16_prefix("a😀b", 3), "a😀");
        assert_eq!(safe_name("my file (1).txt"), "my_file_1_.txt");
    }
}
