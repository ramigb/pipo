// Chat bot accounts (docs/spec.md §3.13, D69). Port of bots.ts, the runner's side: reading `<home>/bots.json`,
// resolving the tokens a pipeline needs at start, and picking a connector's bot. A token is the raw token or a
// secret reference (op://…, env:…), redacted like a secret. The CLI and engine keep the TS copy that writes the file.

use crate::connectors::{as_i64, string_of};
use crate::pipeline::Pipeline;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const TELEGRAM_API: &str = "https://api.telegram.org";
const BOT_KEYS: &[&str] = &["token", "allow", "poll_every", "api"];

/// A bot ready to use: its token resolved.
#[derive(Debug, Clone, PartialEq)]
pub struct Bot {
    pub name: String,
    pub token: String,
    pub api: String,
    pub allow: Vec<i64>,
    pub poll_every: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Bots {
    pub telegram: HashMap<String, Bot>,
    pub default: Option<String>,
}

impl Bots {
    /// Every resolved token, to redact like a secret.
    pub fn tokens(&self) -> Vec<String> {
        self.telegram.values().map(|b| b.token.clone()).collect()
    }
}

/// One bot's settings as `bots.json` holds them.
#[derive(Debug, Clone, PartialEq)]
pub struct BotConfig {
    pub token: String,
    pub allow: Option<Vec<i64>>,
    pub poll_every: Option<String>,
    pub api: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BotsFile {
    pub default: Option<String>,
    /// In file order.
    pub bots: Vec<(String, BotConfig)>,
}

pub fn bots_path(home: &Path) -> PathBuf {
    home.join("bots.json")
}

pub fn is_reference(token: &str) -> bool {
    token.starts_with("op://") || token.starts_with("env:")
}

/// The bot's numeric id: the part of a token before `:`. Public, so it can name the bot in the registry and the UI.
pub fn bot_id(token: &str) -> String {
    token.split(':').next().unwrap_or("").to_string()
}

fn valid_bot_name(name: &str) -> bool {
    let b = name.as_bytes();
    let ok = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    !b.is_empty() && b.len() <= 64 && ok(&b[0]) && b[1..].iter().all(|c| ok(c) || *c == b'_' || *c == b'-')
}

/// Problems with a bot's settings, in words a user can act on. Never echoes the token.
pub fn bot_problems(name: &str, b: &Map<String, Value>) -> Vec<String> {
    let mut out = vec![];
    let at = format!("telegram bot '{name}'");
    if !valid_bot_name(name) {
        out.push(format!("bot name '{name}' must be lowercase letters, digits, '-' or '_'"));
    }
    for k in b.keys() {
        if !BOT_KEYS.contains(&k.as_str()) {
            out.push(format!("{at}: unknown key '{k}' (known: {})", BOT_KEYS.join(", ")));
        }
    }
    if b.get("token").and_then(|t| t.as_str()).is_none_or(|t| t.trim().is_empty()) {
        out.push(format!("{at}: token is missing; paste it from @BotFather"));
    }
    if let Some(allow) = b.get("allow")
        && !allow.as_array().is_some_and(|a| a.iter().all(|x| as_i64(x).is_some()))
    {
        out.push(format!("{at}: allow must be a list of chat or user ids (whole numbers)"));
    }
    if let Some(p) = b.get("poll_every")
        && crate::duration::parse_duration(&string_of(p)).unwrap_or(0) < 1000
    {
        out.push(format!("{at}: poll_every must be a duration of at least 1s, such as 10s or 1m"));
    }
    if let Some(api) = b.get("api")
        && !api.as_str().is_some_and(|a| a.starts_with("http://") || a.starts_with("https://"))
    {
        out.push(format!("{at}: api must be an http(s) URL"));
    }
    out
}

/// `<home>/bots.json`, validated; empty when there is no file.
pub fn read_bots(home: &Path) -> Result<BotsFile, String> {
    let path = bots_path(home);
    let p = path.display();
    let Ok(text) = std::fs::read(&path) else { return Ok(BotsFile::default()) };
    let raw: Value = serde_json::from_slice(&text)
        .map_err(|e| format!("{p} is not valid JSON ({e}); fix it, or delete it and add bots again"))?;
    let tg = raw.get("telegram");
    let empty = Value::Object(Map::new());
    let bots = match tg.and_then(|t| t.get("bots")) {
        None | Some(Value::Null) => &empty,
        Some(b) => b,
    };
    let Some(bots) = bots.as_object() else {
        return Err(format!("{p}: telegram.bots must be a map of bot name to settings"));
    };
    let mut problems: Vec<String> = vec![];
    for (n, b) in bots {
        match b.as_object() {
            Some(b) => problems.extend(bot_problems(n, b)),
            None => problems.push(format!("telegram bot '{n}' must be a map")),
        }
    }
    let def = tg.and_then(|t| t.get("default")).filter(|d| !d.is_null());
    if let Some(d) = def
        && !d.as_str().is_some_and(|d| bots.contains_key(d))
    {
        problems.push(format!("telegram.default names '{}', which is not one of the bots", string_of(d)));
    }
    if !problems.is_empty() {
        let list: Vec<String> = problems.iter().map(|x| format!("  {x}")).collect();
        return Err(format!("{p} has {} problem(s):\n{}", problems.len(), list.join("\n")));
    }
    let bots = bots
        .iter()
        .map(|(n, b)| {
            let config = BotConfig {
                token: b.get("token").and_then(|t| t.as_str()).unwrap_or_default().to_string(),
                allow: b.get("allow").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(as_i64).collect()),
                poll_every: b.get("poll_every").map(string_of),
                api: b.get("api").and_then(|a| a.as_str()).map(str::to_owned),
            };
            (n.clone(), config)
        })
        .collect();
    Ok(BotsFile { default: def.and_then(|d| d.as_str()).map(str::to_owned), bots })
}

/// Every telegram `with:` block of a pipeline (input, taps, output), with where it is.
pub fn telegram_uses(p: &Pipeline) -> Vec<(String, Map<String, Value>)> {
    let mut out = vec![];
    for (name, i) in p.inputs() {
        if i.via == "telegram" {
            out.push((p.input_path(name), i.with.clone().unwrap_or_default()));
        }
    }
    for (id, n) in p.nodes.iter() {
        if n.tap.as_deref() == Some("telegram") {
            out.push((format!("nodes.{id}"), n.with.clone().unwrap_or_default()));
        }
    }
    if p.output.to == "telegram" {
        out.push(("output".to_string(), p.output.with.clone().unwrap_or_default()));
    }
    out
}

/// The bots a pipeline uses, tokens resolved. Errs when one is missing or its token can't be resolved. Blocks
/// with an inline `with.token` need no bot from the file.
pub async fn load_bots(home: &Path, p: &Pipeline) -> Result<Bots, String> {
    let file = read_bots(home)?;
    let mut bots = Bots { telegram: HashMap::new(), default: file.default.clone() };
    for (at, w) in telegram_uses(p) {
        if w.contains_key("token") {
            continue;
        }
        let name = match w.get("bot").and_then(|b| b.as_str()).map(str::to_owned).or_else(|| file.default.clone()) {
            Some(n) => n,
            None => {
                return Err(format!(
                    "{at} uses telegram but no bot is set up; add one in the dashboard (Bots), or set {at}.with.token to ${{secrets.<name>}}"
                ));
            }
        };
        if bots.telegram.contains_key(&name) {
            continue;
        }
        let Some((_, b)) = file.bots.iter().find(|(n, _)| *n == name) else {
            let known: Vec<&str> = file.bots.iter().map(|(n, _)| n.as_str()).collect();
            let known = if known.is_empty() { "none".to_string() } else { known.join(", ") };
            return Err(format!(
                "{at}.with.bot names '{name}', but {} has no such telegram bot (known: {known}); add it in the dashboard (Bots)",
                bots_path(home).display()
            ));
        };
        let mut token = b.token.clone();
        if is_reference(&token) {
            token = crate::secrets::resolve_ref(&token).await.map_err(|e| format!("telegram bot '{name}': {e}"))?;
        }
        let api = b.api.as_deref().unwrap_or(TELEGRAM_API).trim_end_matches('/').to_string();
        let bot = Bot {
            name: name.clone(),
            token,
            api,
            allow: b.allow.clone().unwrap_or_default(),
            poll_every: b.poll_every.clone(),
        };
        bots.telegram.insert(name, bot);
    }
    Ok(bots)
}

/// The bot a rendered `with:` block uses: an inline token, the named bot, or the default.
pub fn pick_bot(bots: Option<&Bots>, w: &Map<String, Value>, owner: &str) -> Result<Bot, String> {
    if let Some(t) = w.get("token") {
        let token = string_of(t);
        if token.is_empty() {
            return Err(format!("{owner}.with.token is empty after rendering; check the secret"));
        }
        return Ok(Bot {
            name: format!("bot {}", bot_id(&token)),
            token,
            api: TELEGRAM_API.into(),
            allow: vec![],
            poll_every: None,
        });
    }
    let name =
        w.get("bot").and_then(|b| b.as_str()).map(str::to_owned).or_else(|| bots.and_then(|b| b.default.clone()));
    match name.as_ref().and_then(|n| bots.and_then(|b| b.telegram.get(n))) {
        Some(bot) => Ok(bot.clone()),
        None => {
            Err(format!("{owner}: telegram bot '{}' was not loaded at start", name.as_deref().unwrap_or("(default)")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::test_util::{TempDir, local};
    use serde_json::json;

    fn pipeline(v: Value) -> Pipeline {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn reads_and_validates_bots_json() {
        let b = TempDir::new();
        assert_eq!(read_bots(b.path()).unwrap(), BotsFile::default());
        std::fs::write(
            b.join("bots.json"),
            r#"{"telegram":{"default":"main","bots":{"main":{"token":"111:a","allow":[1, 2.0]}}}}"#,
        )
        .unwrap();
        let f = read_bots(b.path()).unwrap();
        assert_eq!(f.default.as_deref(), Some("main"));
        assert_eq!(f.bots[0].1.allow, Some(vec![1, 2]));
        std::fs::write(
            b.join("bots.json"),
            r#"{"telegram":{"default":"x","bots":{"main":{"token":"","poll_every":"10ms"}}}}"#,
        )
        .unwrap();
        let e = read_bots(b.path()).unwrap_err();
        assert!(e.contains("has 3 problem(s):\n  telegram bot 'main': token is missing"), "{e}");
        assert!(e.contains("poll_every must be a duration of at least 1s") && e.contains("telegram.default names 'x'"));
        std::fs::write(
            b.join("bots.json"),
            r#"{"telegram":{"bots":{"Bad":{"token":"t","api":"ftp://x","allow":[1.5],"extra":1}}}}"#,
        )
        .unwrap();
        let e = read_bots(b.path()).unwrap_err();
        assert!(
            e.contains("has 4 problem(s)") && e.contains("unknown key 'extra' (known: token, allow, poll_every, api)"),
            "{e}"
        );
        std::fs::write(b.join("bots.json"), "{").unwrap();
        assert!(read_bots(b.path()).unwrap_err().contains("is not valid JSON"));
        std::fs::write(b.join("bots.json"), r#"{"telegram":{"bots":[]}}"#).unwrap();
        assert!(read_bots(b.path()).unwrap_err().contains("telegram.bots must be a map"));
    }

    #[test]
    fn loads_only_the_bots_a_pipeline_uses() {
        local(async {
            let b = TempDir::new();
            // SAFETY: test-only; no other test reads or writes this variable.
            unsafe { std::env::set_var("PIPO_TEST_BOT_TOKEN", "333:from-env") };
            std::fs::write(
                b.join("bots.json"),
                r#"{"telegram":{"default":"main","bots":{"main":{"token":"111:a","api":"http://x/"},"alerts":{"token":"env:PIPO_TEST_BOT_TOKEN","poll_every":"5s"},"unused":{"token":"999:z"}}}}"#,
            )
            .unwrap();
            let p = pipeline(json!({
                "pipo": 1, "name": "t", "input": {"via": "telegram"},
                "nodes": {"n": {"from": "input", "tap": "telegram", "with": {"bot": "alerts"}}, "m": {"from": "n", "tap": "telegram", "with": {"token": "${secrets.t}"}}},
                "output": {"from": "m", "to": "stdout"}
            }));
            let bots = load_bots(b.path(), &p).await.unwrap();
            assert_eq!(bots.telegram.len(), 2);
            assert_eq!(bots.telegram["main"].api, "http://x");
            assert_eq!(bots.telegram["alerts"].token, "333:from-env");
            assert_eq!(bots.telegram["alerts"].poll_every.as_deref(), Some("5s"));
            let mut tokens = bots.tokens();
            tokens.sort();
            assert_eq!(tokens, vec!["111:a", "333:from-env"]);

            let picked = pick_bot(Some(&bots), &Map::new(), "input").unwrap();
            assert_eq!(picked.name, "main");
            let w = json!({"token": "444:inline"});
            assert_eq!(pick_bot(Some(&bots), w.as_object().unwrap(), "output").unwrap().name, "bot 444");
            let w = json!({"token": ""});
            assert!(
                pick_bot(None, w.as_object().unwrap(), "output").unwrap_err().contains("output.with.token is empty")
            );
            let w = json!({"bot": "unused"});
            let e = pick_bot(Some(&bots), w.as_object().unwrap(), "nodes.n").unwrap_err();
            assert_eq!(e, "nodes.n: telegram bot 'unused' was not loaded at start");
            assert!(pick_bot(None, &Map::new(), "input").unwrap_err().contains("'(default)'"));

            let p = pipeline(
                json!({"pipo": 1, "name": "t", "input": {"via": "telegram", "with": {"bot": "nope"}}, "output": {"from": "input", "to": "stdout"}}),
            );
            let e = load_bots(b.path(), &p).await.unwrap_err();
            assert!(
                e.contains("input.with.bot names 'nope', but") && e.contains("(known: main, alerts, unused)"),
                "{e}"
            );
            std::fs::write(b.join("bots.json"), r#"{"telegram":{"default":null,"bots":{}}}"#).unwrap();
            let p = pipeline(
                json!({"pipo": 1, "name": "t", "input": {"via": "telegram"}, "output": {"from": "input", "to": "stdout"}}),
            );
            assert!(load_bots(b.path(), &p).await.unwrap_err().contains("input uses telegram but no bot is set up"));
            std::fs::write(
                b.join("bots.json"),
                r#"{"telegram":{"default":"m","bots":{"m":{"token":"env:PIPO_TEST_NO_SUCH_VAR"}}}}"#,
            )
            .unwrap();
            let e = load_bots(b.path(), &p).await.unwrap_err();
            assert_eq!(e, "telegram bot 'm': environment variable PIPO_TEST_NO_SUCH_VAR is not set");
        });
    }
}
