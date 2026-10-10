// `to: file` (docs/spec.md §3.5, §3.5.1, §3.10). Port of file-output.ts. A repeated write of the same packet_id is
// skipped, also after a crash between writing the file and committing the journal:
//  - jsonl / json (append): the file is its own index, every record carries its packet_id.
//  - csv / text (append): a sidecar `<file>.pipo-keys` logs "begin key(s) offset length" before the append and
//    "done key(s)" after it; on open an unfinished begin is resolved by file size (complete: counts as written,
//    partial: truncated and rewritten). A failed append is cut back and logged as "abort".
//  - mode write: the file is replaced atomically (temp + rename), so a repeat is harmless.
// A batch is one append per file: one write call for jsonl/csv/text, one replace for json and mode write (where the
// last packet's content wins, as with one write per packet).

use super::{LocalBoxFuture, OutputAdapter, WriteItem, resolve_path};
use crate::expr::{js_json, to_text};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

fn csv_cell(v: &Value) -> String {
    let s = match v {
        Value::Null => String::new(),
        Value::Object(_) | Value::Array(_) => js_json(v),
        other => to_text(other),
    };
    if s.contains(['"', ',', '\r', '\n']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s }
}

fn csv_columns(data: &Value) -> Vec<String> {
    match data {
        Value::Object(o) => o.keys().cloned().collect(),
        _ => vec!["value".into()],
    }
}

fn csv_row(data: &Value, columns: &[String]) -> String {
    let cells: Vec<String> = match data {
        Value::Object(o) => columns.iter().map(|c| csv_cell(o.get(c).unwrap_or(&Value::Null))).collect(),
        other => columns.iter().map(|c| if c == "value" { csv_cell(other) } else { String::new() }).collect(),
    };
    format!("{}\n", cells.join(","))
}

fn split_csv_line(line: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if quoted {
            if ch == '"' && chars.peek() == Some(&'"') {
                cur.push('"');
                chars.next();
            } else if ch == '"' {
                quoted = false;
            } else {
                cur.push(ch);
            }
        } else if ch == '"' {
            quoted = true;
        } else if ch == ',' {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(ch);
        }
    }
    out.push(cur);
    out
}

fn io(path: &Path) -> impl Fn(std::io::Error) -> String + '_ {
    move |e| format!("{}: {e}", path.display())
}

fn file_size(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn append(path: &Path, text: &str) -> Result<(), String> {
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(io(path))?;
    f.write_all(text.as_bytes()).map_err(io(path))
}

/// Append in one call; if it fails part-way, cut the file back so no torn record is left behind.
fn append_or_cut_back(path: &Path, size: u64, chunk: &str) -> Result<(), String> {
    append(path, chunk).inspect_err(|_| {
        if file_size(path) > size
            && let Ok(f) = std::fs::OpenOptions::new().write(true).open(path)
        {
            let _ = f.set_len(size);
        }
    })
}

fn last_byte(path: &Path, size: u64) -> Option<u8> {
    let mut f = std::fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(size.checked_sub(1)?)).ok()?;
    let mut b = [0u8; 1];
    f.read_exact(&mut b).ok()?;
    Some(b[0])
}

fn replace(path: &Path, content: &str) -> Result<(), String> {
    let tmp = PathBuf::from(format!("{}.tmp", path.display()));
    std::fs::write(&tmp, content).map_err(io(&tmp))?;
    std::fs::rename(&tmp, path).map_err(io(path))
}

fn read_text(path: &Path) -> Result<String, String> {
    std::fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).map_err(io(path))
}

/// `JSON.stringify(v, null, 2)`.
fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

fn record(item: &WriteItem) -> String {
    js_json(&json!({ "packet_id": item.packet_id, "data": item.data }))
}

struct Group {
    path: PathBuf,
    format: String,
    mode: String,
    idx: Vec<usize>,
}

pub struct FileOutput {
    base: PathBuf,
    /// Keys already written, per file (read from the file or its sidecar once).
    seen: RefCell<HashMap<PathBuf, HashSet<String>>>,
}

impl FileOutput {
    pub fn new(base: &Path) -> FileOutput {
        FileOutput { base: base.to_path_buf(), seen: RefCell::default() }
    }

    /// The synchronous body of `write`.
    pub fn write_now(&self, items: &[WriteItem]) -> Result<Vec<Value>, String> {
        let mut groups: Vec<Group> = vec![];
        for (i, item) in items.iter().enumerate() {
            let w = &item.with;
            let path = w.get("path").map(to_text).unwrap_or_default();
            if path.is_empty() {
                return Err("output.with.path is empty after rendering; check the template".into());
            }
            let path = resolve_path(&self.base, &path);
            let format = w.get("format").and_then(|f| f.as_str()).unwrap_or("jsonl").to_string();
            let mode = w.get("mode").and_then(|f| f.as_str()).unwrap_or("append").to_string();
            match groups.iter_mut().find(|g| g.path == path && g.format == format && g.mode == mode) {
                Some(g) => g.idx.push(i),
                None => groups.push(Group { path, format, mode, idx: vec![i] }),
            }
        }
        let mut results = vec![Value::Null; items.len()];
        for g in groups {
            let group: Vec<&WriteItem> = g.idx.iter().map(|i| &items[*i]).collect();
            if let Some(parent) = g.path.parent() {
                std::fs::create_dir_all(parent).map_err(io(parent))?;
            }
            let p = g.path.display().to_string();
            let out = if g.mode == "write" {
                replace(&g.path, &whole(&g.format, group[group.len() - 1]))?;
                group.iter().map(|_| json!({ "path": p, "written": true })).collect()
            } else if g.format == "json" {
                self.append_json(&g.path, &group)?
            } else if g.format == "jsonl" {
                self.append_jsonl(&g.path, &group)?
            } else {
                self.append_logged(&g.path, &g.format, &group)?
            };
            for (j, i) in g.idx.iter().enumerate() {
                results[*i] = out[j].clone();
            }
        }
        Ok(results)
    }

    /// Items not written yet, each once; the rest are reported as skipped.
    fn fresh<'a>(path: &Path, group: &[&'a WriteItem], keys: &HashSet<String>) -> (Vec<&'a WriteItem>, Vec<Value>) {
        let p = path.display().to_string();
        let mut seen = HashSet::new();
        let mut todo = vec![];
        let out = group
            .iter()
            .map(|item| {
                if keys.contains(&item.packet_id) || seen.contains(&item.packet_id) {
                    return json!({ "path": p, "skipped": true });
                }
                seen.insert(item.packet_id.clone());
                todo.push(*item);
                json!({ "path": p, "written": true })
            })
            .collect();
        (todo, out)
    }

    fn append_jsonl(&self, path: &Path, group: &[&WriteItem]) -> Result<Vec<Value>, String> {
        let mut seen = self.seen.borrow_mut();
        let keys = seen.entry(path.to_path_buf()).or_insert_with(|| jsonl_keys(path));
        let (todo, out) = Self::fresh(path, group, keys);
        if todo.is_empty() {
            return Ok(out);
        }
        let size = file_size(path);
        let prefix = if size > 0 && last_byte(path, size) != Some(b'\n') { "\n" } else { "" };
        let chunk: String = todo.iter().map(|i| format!("{}\n", record(i))).collect();
        append_or_cut_back(path, size, &format!("{prefix}{chunk}"))?;
        for item in todo {
            keys.insert(item.packet_id.clone());
        }
        Ok(out)
    }

    fn append_json(&self, path: &Path, group: &[&WriteItem]) -> Result<Vec<Value>, String> {
        let mut records: Vec<Value> = vec![];
        if file_size(path) > 0 {
            let bad = || {
                format!(
                    "{} is not a JSON array written by Pipo; use mode: write, or another path or format",
                    path.display()
                )
            };
            match serde_json::from_str::<Value>(&read_text(path)?) {
                Ok(Value::Array(a)) => records = a,
                _ => return Err(bad()),
            }
        }
        let keys: HashSet<String> =
            records.iter().filter_map(|r| r.get("packet_id").and_then(|k| k.as_str()).map(str::to_owned)).collect();
        let (todo, out) = Self::fresh(path, group, &keys);
        if todo.is_empty() {
            return Ok(out);
        }
        for item in todo {
            records.push(json!({ "packet_id": item.packet_id, "data": item.data }));
        }
        replace(path, &format!("{}\n", pretty(&Value::Array(records))))?;
        Ok(out)
    }

    fn append_logged(&self, path: &Path, format: &str, group: &[&WriteItem]) -> Result<Vec<Value>, String> {
        let mut seen = self.seen.borrow_mut();
        let keys = match seen.entry(path.to_path_buf()) {
            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
            std::collections::hash_map::Entry::Vacant(e) => e.insert(logged_keys(path)?),
        };
        let (todo, out) = Self::fresh(path, group, keys);
        if todo.is_empty() {
            return Ok(out);
        }
        let size = file_size(path);
        let chunk = if format == "csv" {
            let cols = if size > 0 {
                split_csv_line(read_text(path)?.split('\n').next().unwrap_or(""))
            } else {
                csv_columns(&todo[0].data)
            };
            let header = if size > 0 {
                String::new()
            } else {
                format!("{}\n", cols.iter().map(|c| csv_cell(&json!(c))).collect::<Vec<_>>().join(","))
            };
            header + &todo.iter().map(|i| csv_row(&i.data, &cols)).collect::<String>()
        } else {
            todo.iter().map(|i| format!("{}\n", to_text(&i.data))).collect()
        };
        let ids = if todo.len() == 1 {
            json!(todo[0].packet_id)
        } else {
            json!(todo.iter().map(|i| &i.packet_id).collect::<Vec<_>>())
        };
        let log = PathBuf::from(format!("{}.pipo-keys", path.display()));
        append(&log, &format!("{}\n", js_json(&json!(["begin", ids, size, chunk.len()]))))?;
        if let Err(e) = append_or_cut_back(path, size, &chunk) {
            let _ = append(&log, &format!("{}\n", js_json(&json!(["abort", ids]))));
            return Err(e);
        }
        append(&log, &format!("{}\n", js_json(&json!(["done", ids]))))?;
        for item in todo {
            keys.insert(item.packet_id.clone());
        }
        Ok(out)
    }

    fn verify_now(&self, check: &str, check_with: &Map<String, Value>, item: &WriteItem) -> Result<bool, String> {
        if !["file_exists", "file_nonempty", "line_contains", "checksum"].contains(&check) {
            return Err(format!("file output does not support delivery check '{check}'"));
        }
        let target = check_with
            .get("path")
            .filter(|v| !v.is_null())
            .or_else(|| item.with.get("path"))
            .map(to_text)
            .unwrap_or_default();
        if target.is_empty() {
            return Err("delivered.with.path is empty after rendering; set it or output.with.path".into());
        }
        let path = resolve_path(&self.base, &target);
        if !path.exists() {
            return Ok(false);
        }
        let run = || -> Result<bool, String> {
            let stat = std::fs::metadata(&path).map_err(|e| e.to_string())?;
            if !stat.is_file() {
                return Err(format!("{} is not a file", path.display()));
            }
            match check {
                "file_exists" => Ok(true),
                "file_nonempty" => Ok(stat.len() > 0),
                "line_contains" => {
                    let value = match check_with.get("value") {
                        Some(Value::String(v)) if !v.is_empty() => v,
                        _ => return Err("delivered.with.value is empty; give the text to look for".into()),
                    };
                    let text = std::fs::read(&path).map_err(|e| e.to_string())?;
                    Ok(String::from_utf8_lossy(&text)
                        .split('\n')
                        .any(|l| l.strip_suffix('\r').unwrap_or(l).contains(value.as_str())))
                }
                _ => {
                    let want = match check_with.get("sha256") {
                        Some(Value::String(v))
                            if v.trim().len() == 64 && v.trim().bytes().all(|b| b.is_ascii_hexdigit()) =>
                        {
                            v.trim().to_lowercase()
                        }
                        _ => return Err("delivered.with.sha256 must be 64 hex characters".into()),
                    };
                    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
                    Ok(hex::encode(Sha256::digest(&bytes)) == want)
                }
            }
        };
        run().map_err(|e| {
            format!("cannot read {} for check '{check}': {e}; check the path and permissions", path.display())
        })
    }
}

fn whole(format: &str, item: &WriteItem) -> String {
    match format {
        "jsonl" => format!("{}\n", record(item)),
        "json" => format!("{}\n", pretty(&item.data)),
        "csv" => {
            let cols = csv_columns(&item.data);
            format!(
                "{}\n{}",
                cols.iter().map(|c| csv_cell(&json!(c))).collect::<Vec<_>>().join(","),
                csv_row(&item.data, &cols)
            )
        }
        _ => format!("{}\n", to_text(&item.data)),
    }
}

fn jsonl_keys(path: &Path) -> HashSet<String> {
    let mut keys = HashSet::new();
    if let Ok(text) = read_text(path) {
        for line in text.split('\n') {
            if let Ok(v) = serde_json::from_str::<Value>(line)
                && let Some(id) = v.get("packet_id").and_then(|i| i.as_str())
            {
                keys.insert(id.to_string());
            }
        }
    }
    keys
}

/// Keys from the sidecar log; an unfinished append is resolved by the file's size.
fn logged_keys(path: &Path) -> Result<HashSet<String>, String> {
    let mut keys = HashSet::new();
    let log = PathBuf::from(format!("{}.pipo-keys", path.display()));
    let Ok(text) = read_text(&log) else { return Ok(keys) };
    let mut pending: Vec<(String, (u64, u64))> = vec![];
    for line in text.split('\n') {
        let Ok(Value::Array(entry)) = serde_json::from_str::<Value>(line) else { continue };
        let kind = entry.first().and_then(|k| k.as_str()).unwrap_or("");
        let ids: Vec<String> = match entry.get(1) {
            Some(Value::Array(a)) => a.iter().map(to_text).collect(),
            Some(v) => vec![to_text(v)],
            None => vec![],
        };
        let num = |i: usize| entry.get(i).and_then(|n| n.as_u64()).unwrap_or(0);
        for k in ids {
            match kind {
                "begin" => match pending.iter_mut().find(|(p, _)| *p == k) {
                    Some(p) => p.1 = (num(2), num(3)),
                    None => pending.push((k, (num(2), num(3)))),
                },
                "abort" => pending.retain(|(p, _)| *p != k),
                "done" => {
                    pending.retain(|(p, _)| *p != k);
                    keys.insert(k);
                }
                _ => {}
            }
        }
    }
    for (key, (offset, length)) in pending {
        let size = file_size(path);
        if size >= offset + length {
            append(&log, &format!("{}\n", js_json(&json!(["done", key]))))?;
            keys.insert(key);
        } else if size > offset {
            let f = std::fs::OpenOptions::new().write(true).open(path).map_err(io(path))?;
            f.set_len(offset).map_err(io(path))?;
        }
    }
    Ok(keys)
}

impl OutputAdapter for FileOutput {
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
        self.seen.borrow_mut().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::test_util::TempDir;

    fn item(id: &str, data: Value, w: Value) -> WriteItem {
        WriteItem { packet_id: id.into(), data, with: w.as_object().cloned().unwrap(), origin: None, chain_depth: 0 }
    }
    fn read(p: PathBuf) -> String {
        std::fs::read_to_string(p).unwrap()
    }

    #[test]
    fn jsonl_append_skips_a_repeated_packet_id_even_with_a_fresh_adapter() {
        let b = TempDir::new();
        let w = json!({ "path": "out/a.jsonl" });
        let out = FileOutput::new(b.path());
        let r = out
            .write_now(&[
                item("p1", json!({"n": 1}), w.clone()),
                item("p2", json!({"n": 2}), w.clone()),
                item("p1", json!({"n": 1}), w.clone()),
            ])
            .unwrap();
        assert_eq!(r[2]["skipped"], json!(true));
        FileOutput::new(b.path())
            .write_now(&[item("p2", json!({"n": 2}), w.clone()), item("p3", json!({"n": 3}), w)])
            .unwrap();
        let lines: Vec<Value> =
            read(b.join("out/a.jsonl")).trim().split('\n').map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(
            lines,
            vec![
                json!({"packet_id": "p1", "data": {"n": 1}}),
                json!({"packet_id": "p2", "data": {"n": 2}}),
                json!({"packet_id": "p3", "data": {"n": 3}})
            ]
        );
        // A file without a final newline gets one before the next record.
        std::fs::write(b.join("t.jsonl"), r#"{"packet_id":"x","data":1}"#).unwrap();
        FileOutput::new(b.path()).write_now(&[item("y", json!(2), json!({"path": "t.jsonl"}))]).unwrap();
        assert_eq!(read(b.join("t.jsonl")), "{\"packet_id\":\"x\",\"data\":1}\n{\"packet_id\":\"y\",\"data\":2}\n");
    }

    #[test]
    fn json_append_keeps_an_array_and_dedupes_and_json_write_replaces() {
        let b = TempDir::new();
        let out = FileOutput::new(b.path());
        let w = json!({ "path": "a.json", "format": "json" });
        out.write_now(&[item("p1", json!(1), w.clone()), item("p1", json!(1), w.clone()), item("p2", json!(2), w)])
            .unwrap();
        let v: Value = serde_json::from_str(&read(b.join("a.json"))).unwrap();
        assert_eq!(v, json!([{"packet_id": "p1", "data": 1}, {"packet_id": "p2", "data": 2}]));
        let ww = json!({ "path": "b.json", "format": "json", "mode": "write" });
        out.write_now(&[item("p1", json!({"a": 1}), ww.clone()), item("p2", json!({"a": 2}), ww)]).unwrap();
        assert_eq!(read(b.join("b.json")), "{\n  \"a\": 2\n}\n");
        std::fs::write(b.join("c.json"), "{}").unwrap();
        let e = out.write_now(&[item("p1", json!(1), json!({"path": "c.json", "format": "json"}))]).unwrap_err();
        assert!(e.contains("is not a JSON array written by Pipo"));
    }

    #[test]
    fn csv_append_writes_one_header_quotes_cells_and_dedupes() {
        let b = TempDir::new();
        let out = FileOutput::new(b.path());
        let w = json!({ "path": "a.csv", "format": "csv" });
        out.write_now(&[
            item("p1", json!({"name": "A \"x\", y", "n": 1}), w.clone()),
            item("p2", json!({"name": "B", "n": 2}), w.clone()),
            item("p1", json!({}), w.clone()),
        ])
        .unwrap();
        assert_eq!(read(b.join("a.csv")), "name,n\n\"A \"\"x\"\", y\",1\nB,2\n");
        out.write_now(&[item("p3", json!({"n": 3, "name": "C"}), w)]).unwrap();
        assert_eq!(read(b.join("a.csv")), "name,n\n\"A \"\"x\"\", y\",1\nB,2\nC,3\n");
        out.write_now(&[item("p4", json!("plain"), json!({"path": "v.csv", "format": "csv", "mode": "write"}))])
            .unwrap();
        assert_eq!(read(b.join("v.csv")), "value\nplain\n");
    }

    #[test]
    fn text_append_and_write() {
        let b = TempDir::new();
        let out = FileOutput::new(b.path());
        out.write_now(&[
            item("p1", json!("hello"), json!({"path": "a.txt", "format": "text"})),
            item("p2", json!("world"), json!({"path": "a.txt", "format": "text"})),
        ])
        .unwrap();
        assert_eq!(read(b.join("a.txt")), "hello\nworld\n");
        out.write_now(&[item("p3", json!("only"), json!({"path": "w.txt", "format": "text", "mode": "write"}))])
            .unwrap();
        out.write_now(&[item("p4", json!("last"), json!({"path": "w.txt", "format": "text", "mode": "write"}))])
            .unwrap();
        assert_eq!(read(b.join("w.txt")), "last\n");
        assert!(!b.join("w.txt.tmp").exists());
    }

    #[test]
    fn text_append_recovers_from_a_crash_between_file_write_and_key_log() {
        let b = TempDir::new();
        let path = b.join("c.txt");
        let keys = b.join("c.txt.pipo-keys");
        let w = json!({ "path": "c.txt", "format": "text" });
        FileOutput::new(b.path()).write_now(&[item("p1", json!("one"), w.clone())]).unwrap();
        // A crash after the data landed, before "done" was logged.
        let first = read(keys.clone()).split('\n').next().unwrap().to_string();
        assert_eq!(first, r#"["begin","p1",0,4]"#);
        std::fs::write(&keys, format!("{first}\n")).unwrap();
        FileOutput::new(b.path()).write_now(&[item("p1", json!("one"), w.clone())]).unwrap();
        assert_eq!(read(path.clone()), "one\n");
        // A crash mid-append: partial data, begin logged.
        append(&keys, "[\"begin\",\"p2\",4,4]\n").unwrap();
        append(&path, "tw").unwrap();
        FileOutput::new(b.path()).write_now(&[item("p2", json!("two"), w)]).unwrap();
        assert_eq!(read(path), "one\ntwo\n");
    }

    #[test]
    fn csv_batch_is_one_sidecar_entry_and_a_torn_batch_append_is_cut_back_and_written_again_once() {
        let b = TempDir::new();
        let w = json!({ "path": "out.csv", "format": "csv" });
        let path = b.join("out.csv");
        let keys = b.join("out.csv.pipo-keys");
        FileOutput::new(b.path())
            .write_now(&[item("a", json!({"n": 1}), w.clone()), item("b", json!({"n": 2}), w.clone())])
            .unwrap();
        assert_eq!(read(keys.clone()), "[\"begin\",[\"a\",\"b\"],0,6]\n[\"done\",[\"a\",\"b\"]]\n");

        // A crash mid-append: the begin record is there, half the rows are not.
        let size = std::fs::metadata(&path).unwrap().len();
        append(&keys, &format!("[\"begin\",[\"c\",\"d\"],{size},4]\n")).unwrap();
        append(&path, "3").unwrap();
        let res = FileOutput::new(b.path())
            .write_now(&[
                item("b", json!({"n": 2}), w.clone()),
                item("c", json!({"n": 3}), w.clone()),
                item("d", json!({"n": 4}), w),
            ])
            .unwrap();
        assert_eq!(res[0]["skipped"], json!(true));
        assert_eq!(res[1]["written"], json!(true));
        assert_eq!(res[2]["written"], json!(true));
        assert_eq!(read(path), "n\n1\n2\n3\n4\n");
    }

    #[test]
    fn empty_path_is_an_error() {
        let b = TempDir::new();
        let e = FileOutput::new(b.path()).write_now(&[item("p", json!(1), json!({"path": ""}))]).unwrap_err();
        assert!(e.contains("path is empty"));
    }

    #[test]
    fn delivery_checks() {
        let b = TempDir::new();
        let out = FileOutput::new(b.path());
        let it = item("p1", json!({}), json!({"path": "out/a.txt"}));
        let check = |c: &str, w: Value| out.verify_now(c, w.as_object().unwrap(), &it);
        assert!(!check("file_exists", json!({})).unwrap());
        assert!(!check("file_nonempty", json!({})).unwrap());
        assert!(!check("line_contains", json!({"value": "x"})).unwrap());
        assert!(!check("checksum", json!({"sha256": "0".repeat(64)})).unwrap());

        out.write_now(&[item("p1", json!("hello world"), json!({"path": "out/a.txt", "format": "text"}))]).unwrap();
        assert!(check("file_exists", json!({})).unwrap());
        assert!(check("file_nonempty", json!({})).unwrap());
        assert!(check("line_contains", json!({"value": "hello"})).unwrap());
        assert!(!check("line_contains", json!({"value": "absent"})).unwrap());
        let sha = hex::encode(Sha256::digest(b"hello world\n"));
        assert!(check("checksum", json!({"sha256": sha.to_uppercase()})).unwrap());
        assert!(!check("checksum", json!({"sha256": "0".repeat(64)})).unwrap());
        assert!(!check("file_exists", json!({"path": "out/other.txt"})).unwrap());
        std::fs::write(b.join("out/empty.txt"), "").unwrap();
        assert!(check("file_exists", json!({"path": "out/empty.txt"})).unwrap());
        assert!(!check("file_nonempty", json!({"path": "out/empty.txt"})).unwrap());

        // Real errors.
        std::fs::write(b.join("f"), "x").unwrap();
        let f = item("p1", json!({}), json!({"path": "f"}));
        assert!(
            out.verify_now("checksum", json!({"sha256": "abc"}).as_object().unwrap(), &f)
                .unwrap_err()
                .contains("64 hex")
        );
        let none = item("p1", json!({}), json!({}));
        assert!(
            out.verify_now("file_exists", json!({"path": ""}).as_object().unwrap(), &none)
                .unwrap_err()
                .contains("path")
        );
        assert!(out.verify_now("record_exists", &Map::new(), &f).unwrap_err().contains("does not support"));
        assert!(
            out.verify_now("file_exists", json!({"path": "out"}).as_object().unwrap(), &f)
                .unwrap_err()
                .contains("is not a file")
        );
    }
}
