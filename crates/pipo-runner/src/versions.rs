// Pipeline versions (docs/spec.md §7.3, §9.3, D38, D60). Port of versions.ts: which definition a start runs, what a
// live apply may change, and the files each version runs with. A version stores its compiled form (pipeline, fn
// bundle, schemas), so a version runs the code it was compiled with; files on disk matter only to a new compile.

use crate::journal::FileHashes;
use crate::pipeline::Pipeline;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

pub fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// sha256 of a file's bytes, or None when it can't be read.
pub fn hash_file(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|b| sha256(&b))
}

#[derive(Debug, Clone, PartialEq)]
pub struct FromJournal {
    pub version: i64,
    pub author: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Append {
    pub hash: String,
    pub source: String,
    pub reason: String,
}

/// What a start runs and what it will record (`Journal::commit_start`).
#[derive(Debug, Clone, PartialEq)]
pub struct StartPlan {
    pub source: String,
    pub hash: String,
    /// The file's content hash, so the next start can tell whether the file changed (D38).
    pub file_hash: String,
    /// Set when the source is the journal's latest version rather than the file (the file is unchanged).
    pub from_journal: Option<FromJournal>,
    /// The journal's latest version when the plan was made (None for a new journal).
    pub latest: Option<i64>,
    /// A new version to append (the file), or None to run `latest` as it is.
    pub append: Option<Append>,
}

struct Latest {
    version: i64,
    hash: String,
    source: String,
    author: String,
    reason: Option<String>,
}

/// Read what a start needs from an existing journal, read-only, so nothing is written before the start lock.
fn peek(path: &Path) -> Result<(Option<Latest>, Option<String>), String> {
    if !path.exists() {
        return Ok((None, None));
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("can't open the journal {}: {e}", path.display()))?;
    db.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
    let read = || -> rusqlite::Result<(Option<Latest>, Option<String>)> {
        let tables: Vec<String> = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        if !tables.iter().any(|t| t == "versions") {
            return Ok((None, None));
        }
        let has_reason = db
            .prepare("PRAGMA table_info(versions)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .any(|c| c.map(|c| c == "reason").unwrap_or(false));
        let sql = format!(
            "SELECT version, hash, source, author, {} FROM versions ORDER BY version DESC LIMIT 1",
            if has_reason { "reason" } else { "NULL AS reason" }
        );
        let latest = db
            .query_row(&sql, [], |r| {
                Ok(Latest { version: r.get(0)?, hash: r.get(1)?, source: r.get(2)?, author: r.get(3)?, reason: r.get(4)? })
            })
            .optional()?;
        let file_hash = if tables.iter().any(|t| t == "meta") {
            db.query_row("SELECT value FROM meta WHERE key = 'file_hash'", [], |r| r.get(0)).optional()?
        } else {
            None
        };
        Ok((latest, file_hash))
    };
    read().map_err(|e| format!("can't read the journal {}: {e}", path.display()))
}

/// Decide what a start runs (D38): the file when it is new to the journal or changed since the last start; otherwise
/// the latest version stays (the file's own, unless a rollback was applied since).
pub fn plan_start(home: &Path, name: &str, file_source: &str) -> Result<StartPlan, String> {
    let hash = sha256(file_source.as_bytes());
    let fresh = |reason: &str, latest: Option<i64>| StartPlan {
        source: file_source.to_string(),
        hash: hash.clone(),
        file_hash: hash.clone(),
        from_journal: None,
        latest,
        append: Some(Append { hash: hash.clone(), source: file_source.to_string(), reason: reason.to_string() }),
    };
    let (latest, last_file_hash) = peek(&home.join("pipelines").join(name).join("journal.db"))?;
    let Some(latest) = latest else { return Ok(fresh("first start", None)) };
    if latest.hash == hash {
        return Ok(StartPlan {
            source: file_source.to_string(),
            hash: hash.clone(),
            file_hash: hash,
            from_journal: None,
            latest: Some(latest.version),
            append: None,
        });
    }
    if last_file_hash.as_deref() == Some(hash.as_str()) {
        return Ok(StartPlan {
            source: latest.source,
            hash: latest.hash,
            file_hash: hash,
            from_journal: Some(FromJournal { version: latest.version, author: latest.author, reason: latest.reason }),
            latest: Some(latest.version),
            append: None,
        });
    }
    Ok(fresh("file changed", Some(latest.version)))
}

/// JSON with sorted keys, so two definitions compare by content, not key order.
pub fn canon(v: &Value) -> String {
    match v {
        Value::Array(a) => format!("[{}]", a.iter().map(canon).collect::<Vec<_>>().join(",")),
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            let parts: Vec<String> =
                keys.iter().map(|k| format!("{}:{}", serde_json::to_string(k).unwrap_or_default(), canon(&o[*k]))).collect();
            format!("{{{}}}", parts.join(","))
        }
        other => crate::expr::js_json(other),
    }
}

/// The parts of `next` that differ from `current` but are bound when the runner starts, so a live apply can't
/// change them: the input connector (all but `schema`, `validate`, `on_invalid`), the output connector, secrets,
/// worker count, lifetime timers and stall detection.
pub fn bound_changes(current: &Pipeline, next: &Pipeline) -> Vec<String> {
    let mut out = vec![];
    let differ = |a: &Value, b: &Value| canon(a) != canon(b);
    if current.name != next.name {
        out.push("name".to_string());
    }
    let input = |p: &Pipeline| -> Map<String, Value> {
        let mut m = serde_json::to_value(&p.input).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
        for k in ["schema", "validate", "on_invalid"] {
            m.remove(k);
        }
        m
    };
    let (a, b) = (input(current), input(next));
    let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
    keys.sort();
    keys.dedup();
    for k in keys {
        if differ(a.get(k).unwrap_or(&Value::Null), b.get(k).unwrap_or(&Value::Null)) {
            out.push(format!("input.{k}"));
        }
    }
    if current.output.to != next.output.to {
        out.push("output.to".to_string());
    }
    let obj = |m: &Option<Map<String, Value>>| Value::Object(m.clone().unwrap_or_default());
    if differ(&obj(&current.secrets), &obj(&next.secrets)) {
        out.push("secrets".to_string());
    }
    if current.concurrency() != next.concurrency() {
        out.push("concurrency".to_string());
    }
    let json = |v: Value| if v.is_null() { Value::Object(Map::new()) } else { v };
    let lifetime = |p: &Pipeline| json(serde_json::to_value(&p.lifetime).unwrap_or(Value::Null));
    if differ(&lifetime(current), &lifetime(next)) {
        out.push("lifetime".to_string());
    }
    let stall = |p: &Pipeline| serde_json::to_value(p.delivered.as_ref().and_then(|d| d.stall.as_ref())).unwrap_or(Value::Null);
    if differ(&stall(current), &stall(next)) {
        out.push("delivered.stall".to_string());
    }
    out
}

/// A warning about the files a version runs with (D60): not a refusal, the version runs.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct VersionWarning {
    /// `file_changed` or `module_not_reloaded`.
    pub code: String,
    pub file: String,
    pub version: i64,
    pub recorded: String,
    pub current: Option<String>,
    pub message: String,
    pub hint: String,
}

fn short(h: Option<&str>) -> String {
    h.map(|h| h.chars().take(12).collect()).unwrap_or_else(|| "missing".to_string())
}

/// Compare the files `recorded` with version `of` against those it `runs` with now (D60). `as_` names the version
/// that runs them when it isn't `of` itself (a rollback runs v<of>'s source as a new version).
pub fn file_changes(
    recorded: Option<&FileHashes>,
    runs: &FileHashes,
    of: i64,
    pipeline: &str,
    as_: Option<(i64, &str)>,
) -> Vec<VersionWarning> {
    let Some(recorded) = recorded else { return vec![] };
    let mut out = vec![];
    for (file, was) in recorded {
        let was = was.as_str();
        let now = runs.get(file).map(String::as_str);
        if now == Some(was) {
            continue;
        }
        let who = match as_ {
            Some((v, what)) => format!("v{v} ({what})"),
            None => format!("v{of}"),
        };
        out.push(VersionWarning {
            code: "file_changed".into(),
            file: file.clone(),
            version: of,
            recorded: was.to_string(),
            current: now.map(str::to_owned),
            message: format!(
                "{file} has changed since v{of} was recorded (sha256 {}, now {}), so {who} runs the file as it is now, not v{of}'s",
                short(Some(was)),
                short(now)
            ),
            hint: format!(
                "if v{of}'s {file} is what you want, restore it (e.g. from version control) and restart (pipo restart {pipeline}); if the new file is intended, nothing to do: a changed .pipo file records the files it runs with as a new version"
            ),
        });
    }
    out
}

/// The fn module a version was compiled with, when the file on disk has changed since (D60): the version keeps
/// running the code it was compiled with until a restart or apply compiles the file again.
pub fn stale_module(fn_path: Option<&str>, compiled_hash: Option<&str>, dir: &Path, version: i64, name: &str) -> Vec<VersionWarning> {
    let (Some(file), Some(loaded)) = (fn_path, compiled_hash) else { return vec![] };
    let disk = hash_file(&dir.join(file));
    if disk.as_deref() == Some(loaded) {
        return vec![];
    }
    vec![VersionWarning {
        code: "module_not_reloaded".into(),
        file: file.to_string(),
        version,
        recorded: loaded.to_string(),
        current: disk.clone(),
        message: format!(
            "{file} has changed on disk since v{version} was compiled (sha256 {}, now {}); v{version} runs the code it was compiled with",
            short(Some(loaded)),
            short(disk.as_deref())
        ),
        hint: format!("restart to compile the file as it is now (pipo restart {name})"),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pipeline(v: Value) -> Pipeline {
        Pipeline::from_value(v).unwrap()
    }

    #[test]
    fn bound_changes_lists_what_needs_a_restart() {
        let base = json!({"pipo": 1, "name": "p", "input": {"via": "http", "with": {"listen": 1}, "validate": ["true"]}, "output": {"from": "input", "to": "stdout"}});
        let mut next = base.clone();
        next["input"]["validate"] = json!(["false"]);
        assert!(bound_changes(&pipeline(base.clone()), &pipeline(next.clone())).is_empty());
        next["input"]["with"] = json!({"listen": 2});
        next["concurrency"] = json!(8);
        next["output"]["to"] = json!("file");
        assert_eq!(bound_changes(&pipeline(base), &pipeline(next)), vec!["input.with", "output.to", "concurrency"]);
    }

    #[test]
    fn canon_sorts_keys() {
        assert_eq!(canon(&json!({"b": 1, "a": [true, null, "x"]})), r#"{"a":[true,null,"x"],"b":1}"#);
    }
}

/// D60 file hashes as `pipo compile` gives them (a JSON map) in the journal's form.
pub fn file_hashes(files: &Map<String, Value>) -> FileHashes {
    files.iter().filter_map(|(k, v)| v.as_str().map(|h| (k.clone(), h.to_string()))).collect()
}
