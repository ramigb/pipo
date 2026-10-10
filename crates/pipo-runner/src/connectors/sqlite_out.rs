// `to: sqlite` (docs/spec.md §3.5, §3.10). Port of sqlite-output.ts. Writes are idempotent on the key column, so a
// packet re-written after a crash never creates a duplicate row. One transaction per database file (§3.5.1).

use super::{LocalBoxFuture, OutputAdapter, WriteItem, resolve_path};
use crate::expr::{js_json, to_text};
use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn q(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn sql_value(v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(*b as i64),
        Value::String(s) => Sql::Text(s.clone()),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Sql::Integer(i),
            None => Sql::Real(n.as_f64().unwrap_or(0.0)),
        },
        other => Sql::Text(js_json(other)),
    }
}

/// JS `Boolean(v)` for a value read back from SQLite.
fn truthy(v: &Sql) -> bool {
    match v {
        Sql::Null => false,
        Sql::Integer(i) => *i != 0,
        Sql::Real(f) => *f != 0.0 && !f.is_nan(),
        Sql::Text(s) => !s.is_empty(),
        Sql::Blob(_) => true,
    }
}

fn err(e: rusqlite::Error) -> String {
    match e {
        rusqlite::Error::SqliteFailure(_, Some(m)) => m,
        other => other.to_string(),
    }
}

/// The row a packet becomes: rendered `columns`, or the top-level fields of data plus the key.
pub fn row(item: &WriteItem) -> Result<(String, String, Map<String, Value>), String> {
    let w = &item.with;
    let key = w.get("key").and_then(|k| k.as_str()).unwrap_or("packet_id").to_string();
    let values = match w.get("columns").and_then(|c| c.as_object()) {
        Some(c) => c.clone(),
        None => {
            let Value::Object(data) = &item.data else {
                return Err("data must be an object to map onto columns; set output.with.columns".into());
            };
            let mut v = data.clone();
            v.insert(key.clone(), Value::String(item.packet_id.clone()));
            v
        }
    };
    if let Some(bad) = values.keys().find(|n| !valid_name(n)) {
        return Err(format!("'{bad}' is not a valid column name"));
    }
    Ok((w.get("table").map(to_text).unwrap_or_default(), key, values))
}

pub struct SqliteOutput {
    base: PathBuf,
    dbs: RefCell<HashMap<PathBuf, Connection>>,
    readers: RefCell<HashMap<PathBuf, Connection>>,
}

impl SqliteOutput {
    pub fn new(base: &Path) -> SqliteOutput {
        SqliteOutput { base: base.to_path_buf(), dbs: RefCell::default(), readers: RefCell::default() }
    }

    fn path_of(&self, w: &Map<String, Value>) -> PathBuf {
        resolve_path(&self.base, &w.get("path").map(to_text).unwrap_or_default())
    }

    fn with_db<T>(&self, abs: &Path, f: impl FnOnce(&mut Connection) -> Result<T, String>) -> Result<T, String> {
        let mut dbs = self.dbs.borrow_mut();
        if !dbs.contains_key(abs) {
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
            }
            let db = Connection::open(abs).map_err(err)?;
            db.busy_timeout(Duration::from_millis(5000)).map_err(err)?;
            dbs.insert(abs.to_path_buf(), db);
        }
        f(dbs.get_mut(abs).expect("opened above"))
    }

    /// Read-only handle, so a check query can never change data. Values go in `with.params`, not in the SQL text.
    fn with_reader<T>(&self, abs: &Path, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        let mut readers = self.readers.borrow_mut();
        if !readers.contains_key(abs) {
            if !abs.exists() {
                return Err(format!("database {} does not exist yet; check output.with.path", abs.display()));
            }
            let db = Connection::open_with_flags(abs, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
            db.busy_timeout(Duration::from_millis(5000)).map_err(err)?;
            readers.insert(abs.to_path_buf(), db);
        }
        f(&readers[abs])
    }

    pub fn write_now(&self, items: &[WriteItem]) -> Result<Vec<Value>, String> {
        let mut results = vec![Value::Null; items.len()];
        let mut by_path: Vec<(PathBuf, Vec<usize>)> = vec![];
        for (i, item) in items.iter().enumerate() {
            let path = self.path_of(&item.with);
            match by_path.iter_mut().find(|(p, _)| *p == path) {
                Some((_, idx)) => idx.push(i),
                None => by_path.push((path, vec![i])),
            }
        }
        for (path, idx) in by_path {
            let written = self.with_db(&path, |db| {
                let tx = db.transaction().map_err(err)?;
                let mut out = vec![];
                for i in &idx {
                    out.push(write_row(&tx, &items[*i])?);
                }
                tx.commit().map_err(err)?;
                Ok(out)
            })?;
            for (j, i) in idx.iter().enumerate() {
                results[*i] = written[j].clone();
            }
        }
        Ok(results)
    }

    pub fn verify_now(&self, check: &str, check_with: &Map<String, Value>, item: &WriteItem) -> Result<bool, String> {
        let w = &item.with;
        let table = w.get("table").map(to_text).unwrap_or_default();
        let path = self.path_of(w);
        if check == "record_exists" {
            let wher = check_with.get("where").and_then(|v| v.as_object()).filter(|o| !o.is_empty());
            let Some(wher) = wher else {
                return Err("delivered.with.where is empty; give the column values the record must have".into());
            };
            if let Some(bad) = wher.keys().find(|c| !valid_name(c)) {
                return Err(format!("'{bad}' is not a valid column name"));
            }
            let cond: Vec<String> = wher.keys().map(|c| format!("{} = ?", q(c))).collect();
            let sql = format!("SELECT 1 FROM {} WHERE {} LIMIT 1", q(&table), cond.join(" AND "));
            let params: Vec<Sql> = wher.values().map(sql_value).collect();
            return self.with_db(&path, |db| {
                let mut stmt = db.prepare(&sql).map_err(err)?;
                let mut rows = stmt.query(rusqlite::params_from_iter(params)).map_err(err)?;
                Ok(rows.next().map_err(err)?.is_some())
            });
        }
        if check == "row_count" || check == "query" {
            let sql = if check == "row_count" { check_with.get("query") } else { check_with.get("sql").filter(|s| !s.is_null()).or(check_with.get("query")) };
            let sql = match sql {
                Some(Value::String(s)) if !s.trim().is_empty() => s.clone(),
                _ => {
                    let key = if check == "row_count" { "query" } else { "sql" };
                    return Err(format!("delivered.with.{key} is empty; give a SELECT statement"));
                }
            };
            let params: Vec<Sql> = check_with.get("params").and_then(|p| p.as_array()).map(|a| a.iter().map(sql_value).collect()).unwrap_or_default();
            let min = check_with.get("min").and_then(|m| m.as_f64()).unwrap_or(1.0);
            return self.with_reader(&path, |db| {
                let mut stmt = db.prepare(&sql).map_err(err)?;
                let mut rows = stmt.query(rusqlite::params_from_iter(params)).map_err(err)?;
                if check == "query" {
                    return Ok(match rows.next().map_err(err)? {
                        Some(r) => truthy(&r.get::<_, Sql>(0).map_err(err)?),
                        None => false,
                    });
                }
                let mut n = 0.0;
                while rows.next().map_err(err)?.is_some() {
                    n += 1.0;
                }
                Ok(n >= min)
            });
        }
        Err(format!("sqlite does not support delivery check '{check}'"))
    }
}

fn write_row(db: &Connection, item: &WriteItem) -> Result<Value, String> {
    let w = &item.with;
    let (table, key, values) = row(item)?;
    let cols: Vec<&String> = values.keys().collect();
    if w.get("create").is_some_and(crate::connectors::truthy) {
        let defs: Vec<String> = cols.iter().map(|c| if **c == key { format!("{} PRIMARY KEY", q(c)) } else { q(c) }).collect();
        db.execute_batch(&format!("CREATE TABLE IF NOT EXISTS {} ({})", q(&table), defs.join(", "))).map_err(err)?;
    }
    let others: Vec<&&String> = cols.iter().filter(|c| ***c != key).collect();
    let on_conflict = if w.get("mode").and_then(|m| m.as_str()) == Some("upsert") && !others.is_empty() {
        format!("DO UPDATE SET {}", others.iter().map(|c| format!("{} = excluded.{}", q(c), q(c))).collect::<Vec<_>>().join(", "))
    } else {
        "DO NOTHING".into()
    };
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT({}) {on_conflict}",
        q(&table),
        cols.iter().map(|c| q(c)).collect::<Vec<_>>().join(", "),
        cols.iter().map(|_| "?").collect::<Vec<_>>().join(", "),
        q(&key)
    );
    let params: Vec<Sql> = values.values().map(sql_value).collect();
    let run = || -> rusqlite::Result<usize> { db.prepare(&sql)?.execute(rusqlite::params_from_iter(params)) };
    match run() {
        Ok(changes) => Ok(json!({ "rowid": db.last_insert_rowid(), "changes": changes })),
        Err(e) => {
            let msg = err(e);
            if msg.contains("no such table") {
                return Err(format!("{msg} (set output.with.create: true to create it)"));
            }
            if msg.contains("ON CONFLICT clause does not match") {
                return Err(format!("table '{table}' needs a PRIMARY KEY or UNIQUE constraint on '{key}' for idempotent writes"));
            }
            Err(msg)
        }
    }
}

impl OutputAdapter for SqliteOutput {
    fn write(&self, items: Vec<WriteItem>) -> LocalBoxFuture<'_, Result<Vec<Value>, String>> {
        Box::pin(async move { self.write_now(&items) })
    }

    fn verify<'a>(
        &'a self,
        check: &'a str,
        check_with: &'a Map<String, Value>,
        item: &'a WriteItem,
        _result: &'a Value,
    ) -> LocalBoxFuture<'a, Result<bool, String>> {
        Box::pin(async move { self.verify_now(check, check_with, item) })
    }

    fn close(&self) {
        self.dbs.borrow_mut().clear();
        self.readers.borrow_mut().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::test_util::TempDir;

    fn item(id: &str, data: Value, w: Value) -> WriteItem {
        WriteItem { packet_id: id.into(), data, with: w.as_object().cloned().unwrap(), origin: None }
    }

    fn setup(b: &TempDir) -> (SqliteOutput, WriteItem) {
        let out = SqliteOutput::new(b.path());
        let it = item("p1", json!({"name": "Ada"}), json!({"path": "o.db", "table": "people", "create": true, "key": "id", "columns": {"id": "p1", "name": "Ada"}}));
        out.write_now(std::slice::from_ref(&it)).unwrap();
        (out, it)
    }

    fn rows(path: PathBuf, sql: &str) -> Vec<Vec<String>> {
        let db = Connection::open(path).unwrap();
        let mut stmt = db.prepare(sql).unwrap();
        let n = stmt.column_count();
        stmt.query_map([], |r| Ok((0..n).map(|i| match r.get::<_, Sql>(i).unwrap() {
            Sql::Null => "null".to_string(),
            Sql::Integer(i) => i.to_string(),
            Sql::Real(f) => f.to_string(),
            Sql::Text(s) => s,
            Sql::Blob(_) => "blob".into(),
        }).collect())).unwrap().map(|r| r.unwrap()).collect()
    }

    #[test]
    fn writes_are_idempotent_on_the_key() {
        let b = TempDir::new();
        let out = SqliteOutput::new(b.path());
        let w = json!({"path": "sub/o.db", "table": "t", "create": true});
        let r = out.write_now(&[item("p1", json!({"a": 1}), w.clone()), item("p2", json!({"a": 2.5, "b": {"x": 1}}), w.clone())]);
        assert_eq!(r.unwrap_err(), "table t has no column named b");
        let w = json!({"path": "sub/o.db", "table": "u", "create": true});
        let r = out.write_now(&[item("p1", json!({"a": 1, "b": true}), w.clone()), item("p1", json!({"a": 9, "b": false}), w.clone())]).unwrap();
        assert_eq!(r, vec![json!({"rowid": 1, "changes": 1}), json!({"rowid": 1, "changes": 0})]);
        assert_eq!(rows(b.join("sub/o.db"), "SELECT a, b, packet_id FROM u"), vec![vec!["1", "1", "p1"]]);
        // A fresh adapter (after a crash) still writes nothing twice; upsert updates the other columns.
        let up = json!({"path": "sub/o.db", "table": "u", "mode": "upsert"});
        SqliteOutput::new(b.path()).write_now(&[item("p1", json!({"a": 3, "b": null}), up)]).unwrap();
        assert_eq!(rows(b.join("sub/o.db"), "SELECT a, b, packet_id FROM u"), vec![vec!["3", "null", "p1"]]);
        // The batch's transaction rolled back the failed first write: no table t.
        assert!(rows(b.join("sub/o.db"), "SELECT name FROM sqlite_master WHERE name = 't'").is_empty());
    }

    #[test]
    fn write_errors_say_what_to_do() {
        let b = TempDir::new();
        let out = SqliteOutput::new(b.path());
        let e = out.write_now(&[item("p", json!({"a": 1}), json!({"path": "o.db", "table": "missing"}))]).unwrap_err();
        assert_eq!(e, "no such table: missing (set output.with.create: true to create it)");
        Connection::open(b.join("o.db")).unwrap().execute_batch("CREATE TABLE plain (packet_id, a)").unwrap();
        let e = out.write_now(&[item("p", json!({"a": 1}), json!({"path": "o.db", "table": "plain"}))]).unwrap_err();
        assert_eq!(e, "table 'plain' needs a PRIMARY KEY or UNIQUE constraint on 'packet_id' for idempotent writes");
        let e = out.write_now(&[item("p", json!([1]), json!({"path": "o.db", "table": "plain"}))]).unwrap_err();
        assert!(e.contains("data must be an object"));
        let e = out.write_now(&[item("p", json!({"bad name": 1}), json!({"path": "o.db", "table": "plain"}))]).unwrap_err();
        assert_eq!(e, "'bad name' is not a valid column name");
    }

    #[test]
    fn record_exists() {
        let b = TempDir::new();
        let (out, it) = setup(&b);
        assert!(out.verify_now("record_exists", json!({"where": {"id": "p1"}}).as_object().unwrap(), &it).unwrap());
        assert!(!out.verify_now("record_exists", json!({"where": {"id": "nope"}}).as_object().unwrap(), &it).unwrap());
        assert!(out.verify_now("record_exists", json!({"where": {}}).as_object().unwrap(), &it).unwrap_err().contains("where"));
    }

    #[test]
    fn row_count() {
        let b = TempDir::new();
        let (out, it) = setup(&b);
        let w = json!({"query": "SELECT * FROM people WHERE name = ?", "params": ["Ada"]});
        assert!(out.verify_now("row_count", w.as_object().unwrap(), &it).unwrap());
        let mut two = w.as_object().cloned().unwrap();
        two.insert("min".into(), json!(2));
        assert!(!out.verify_now("row_count", &two, &it).unwrap());
        let x = json!({"query": "SELECT * FROM people WHERE name = ?", "params": ["x"]});
        assert!(!out.verify_now("row_count", x.as_object().unwrap(), &it).unwrap());
    }

    #[test]
    fn query() {
        let b = TempDir::new();
        let (out, it) = setup(&b);
        let q = |sql: Value| out.verify_now("query", json!({"sql": sql, "params": ["zz"]}).as_object().unwrap(), &it);
        assert!(out.verify_now("query", json!({"sql": "SELECT count(*) = 1 FROM people"}).as_object().unwrap(), &it).unwrap());
        assert!(!out.verify_now("query", json!({"sql": "SELECT count(*) > 5 FROM people"}).as_object().unwrap(), &it).unwrap());
        assert!(!q(json!("SELECT 1 FROM people WHERE id = ?")).unwrap());
        // Read-only, and bad SQL errs.
        assert!(out.verify_now("query", json!({"sql": "DELETE FROM people"}).as_object().unwrap(), &it).is_err());
        assert!(out.verify_now("record_exists", json!({"where": {"id": "p1"}}).as_object().unwrap(), &it).unwrap());
        assert!(out.verify_now("query", json!({"sql": "SELEC nonsense"}).as_object().unwrap(), &it).is_err());
        assert!(out.verify_now("query", json!({"sql": ""}).as_object().unwrap(), &it).unwrap_err().contains("empty"));
        assert!(out.verify_now("file_exists", &Map::new(), &it).unwrap_err().contains("does not support"));
        let other = item("p1", json!({}), json!({"path": "none.db", "table": "t"}));
        let e = out.verify_now("query", json!({"sql": "SELECT 1"}).as_object().unwrap(), &other).unwrap_err();
        assert!(e.contains("does not exist yet"));
    }
}
