// Version reads for `pipo history` and `pipo diff` (docs/spec.md §6, §9.3, D38). Port of control/versions.ts: the
// journal's versions with who made each and why, one version's source, and a unified diff of two. Answered by the
// runner over its control socket, or from the journal read-only when no runner runs (D34).

use super::ControlError;
use crate::journal::PENDING;
use rusqlite::{Connection, OptionalExtension, params_from_iter};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

/// A version number: `3`, `"3"` or `"v3"`.
pub fn version_arg(raw: Option<&Value>, key: &str) -> Result<i64, ControlError> {
    let bad = || {
        ControlError::new(
            "bad_request",
            format!("`{key}` must be a version number, got {}", crate::expr::js_json(raw.unwrap_or(&Value::Null))),
            "use 3 or v3; pipo history <name> lists the versions",
        )
    };
    let n = match raw {
        Some(Value::String(s)) => {
            let digits = s.strip_prefix(['v', 'V']).unwrap_or(s);
            if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
                return Err(bad());
            }
            digits.parse::<i64>().map_err(|_| bad())?
        }
        Some(Value::Number(n)) => match (n.as_i64(), n.as_f64()) {
            (Some(i), _) => i,
            (None, Some(f)) if f.fract() == 0.0 && f.abs() < 9e15 => f as i64,
            _ => return Err(bad()),
        },
        _ => return Err(bad()),
    };
    if n < 1 { Err(bad()) } else { Ok(n) }
}

fn internal(e: impl ToString) -> ControlError {
    ControlError::new("internal", e.to_string(), "see the runner log")
}

fn marks(n: usize) -> String {
    vec!["?"; n].join(", ")
}

/// The summary columns, with NULL for those a journal read read-only doesn't have yet (`reason` before D38, the audit
/// columns before D49, `files` before D60), since a read without the runner never migrates (D34).
fn summary_columns(db: &Connection) -> Result<String, ControlError> {
    let mut stmt = db.prepare("PRAGMA table_info(versions)").map_err(internal)?;
    let cols: HashSet<String> = stmt
        .query_map([], |r| r.get::<_, String>("name"))
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;
    let opt = |c: &str| if cols.contains(c) { c.to_string() } else { format!("NULL AS {c}") };
    Ok(format!(
        "version, hash, author, {}, {}, {}, {}, created_at",
        opt("reason"),
        opt("author_kind"),
        opt("proposal"),
        opt("files")
    ))
}

/// A summary row in TS key order, `files` (JSON text) as an object.
fn summary_row(r: &rusqlite::Row) -> rusqlite::Result<Map<String, Value>> {
    let files: Option<String> = r.get("files")?;
    let mut m = Map::new();
    m.insert("version".into(), json!(r.get::<_, i64>("version")?));
    m.insert("hash".into(), json!(r.get::<_, String>("hash")?));
    m.insert("author".into(), json!(r.get::<_, String>("author")?));
    m.insert("reason".into(), json!(r.get::<_, Option<String>>("reason")?));
    m.insert("author_kind".into(), json!(r.get::<_, Option<String>>("author_kind")?));
    m.insert("proposal".into(), json!(r.get::<_, Option<String>>("proposal")?));
    m.insert("files".into(), files.and_then(|f| serde_json::from_str(&f).ok()).unwrap_or(Value::Null));
    m.insert("created_at".into(), json!(r.get::<_, i64>("created_at")?));
    Ok(m)
}

/// Newest first, each with its packets pinned to it and not finished yet; `current` is the version a running runner
/// gives new packets (null from the journal), `latest` the newest one.
pub fn list_versions(db: &Connection, current: Option<i64>) -> Result<Value, ControlError> {
    let sql = format!(
        "SELECT version, COUNT(*) AS n FROM packets WHERE branch = '' AND state IN ({}) GROUP BY version",
        marks(PENDING.len())
    );
    let mut stmt = db.prepare(&sql).map_err(internal)?;
    let pending: HashMap<i64, i64> = stmt
        .query_map(params_from_iter(PENDING.iter()), |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;
    let sql = format!("SELECT {} FROM versions ORDER BY version DESC", summary_columns(db)?);
    let mut stmt = db.prepare(&sql).map_err(internal)?;
    let rows: Vec<Map<String, Value>> =
        stmt.query_map([], summary_row).map_err(internal)?.collect::<Result<_, _>>().map_err(internal)?;
    let latest = rows.first().and_then(|r| r["version"].as_i64());
    let versions: Vec<Value> = rows
        .into_iter()
        .map(|mut r| {
            let v = r["version"].as_i64().unwrap_or(0);
            r.insert("pending".into(), json!(pending.get(&v).copied().unwrap_or(0)));
            Value::Object(r)
        })
        .collect();
    Ok(json!({ "versions": versions, "current": current, "latest": latest }))
}

/// One version with its definition (the .pipo text; not `source`, which the engine and CLI use for where an answer
/// came from) and, for its audit (§9.3 step 5, D49), the unified `diff` from the version before it (null for v1).
pub fn get_version(db: &Connection, version: i64, pipeline: &str) -> Result<Value, ControlError> {
    let mut row = definition_of(db, version, pipeline)?;
    let before: Option<String> = if version > 1 {
        db.query_row("SELECT source FROM versions WHERE version = ?", [version - 1], |r| r.get(0))
            .optional()
            .map_err(internal)?
    } else {
        None
    };
    let diff = before.map(|b| {
        let definition = row["definition"].as_str().unwrap_or_default();
        unified_diff(&b, definition, &format!("{pipeline} v{}", version - 1), &format!("{pipeline} v{version}"), 3).diff
    });
    row.insert("diff".into(), json!(diff));
    Ok(Value::Object(row))
}

fn definition_of(db: &Connection, version: i64, pipeline: &str) -> Result<Map<String, Value>, ControlError> {
    let sql = format!("SELECT {}, source FROM versions WHERE version = ?", summary_columns(db)?);
    let row = db
        .query_row(&sql, [version], |r| Ok((summary_row(r)?, r.get::<_, String>("source")?)))
        .optional()
        .map_err(internal)?;
    let Some((mut summary, source)) = row else {
        let latest: Option<i64> =
            db.query_row("SELECT MAX(version) FROM versions", [], |r| r.get(0)).map_err(internal)?;
        return Err(ControlError::new(
            "not_found",
            format!(
                "{pipeline} has no version {version}{}",
                latest.filter(|l| *l != 0).map(|l| format!(" (versions are v1 to v{l})")).unwrap_or_default()
            ),
            format!("list them with pipo history {pipeline}"),
        ));
    };
    let sql = format!(
        "SELECT COUNT(*) FROM packets WHERE branch = '' AND version = ? AND state IN ({})",
        marks(PENDING.len())
    );
    let mut values: Vec<rusqlite::types::Value> = vec![version.into()];
    values.extend(PENDING.iter().map(|s| rusqlite::types::Value::from(s.to_string())));
    let pending: i64 = db.query_row(&sql, params_from_iter(values), |r| r.get(0)).map_err(internal)?;
    summary.insert("pending".into(), json!(pending));
    summary.insert("definition".into(), json!(source));
    Ok(summary)
}

/// `{from, to, identical, diff, added, removed}` between two versions.
pub fn diff_versions(db: &Connection, from: i64, to: i64, pipeline: &str) -> Result<Value, ControlError> {
    let a = definition_of(db, from, pipeline)?;
    let b = definition_of(db, to, pipeline)?;
    let (a, b) = (a["definition"].as_str().unwrap_or_default(), b["definition"].as_str().unwrap_or_default());
    let d = unified_diff(a, b, &format!("{pipeline} v{from}"), &format!("{pipeline} v{to}"), 3);
    Ok(json!({ "from": from, "to": to, "identical": a == b, "diff": d.diff, "added": d.added, "removed": d.removed }))
}

// ── unified diff (line-based LCS, no dependency) ─────────────────────────────

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Same,
    Removed,
    Added,
}

#[derive(Clone, Copy)]
struct Op<'a> {
    kind: Kind,
    text: &'a str,
    a: usize,
    b: usize,
}

fn split_lines(s: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = s.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

/// Above this many cells the middle is shown as removed then added, rather than aligned line by line.
const MAX_CELLS: usize = 25_000_000;

fn line_ops<'a>(a: &[&'a str], b: &[&'a str]) -> Vec<Op<'a>> {
    let mut pre = 0;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < a.len() - pre && suf < b.len() - pre && a[a.len() - 1 - suf] == b[b.len() - 1 - suf] {
        suf += 1;
    }
    let mut ops: Vec<Op> = (0..pre).map(|i| Op { kind: Kind::Same, text: a[i], a: i, b: i }).collect();
    let am = &a[pre..a.len() - suf];
    let bm = &b[pre..b.len() - suf];
    let (n, m) = (am.len(), bm.len());
    if n.saturating_mul(m) > MAX_CELLS {
        ops.extend(am.iter().enumerate().map(|(i, t)| Op { kind: Kind::Removed, text: t, a: pre + i, b: pre }));
        ops.extend(bm.iter().enumerate().map(|(j, t)| Op { kind: Kind::Added, text: t, a: pre + n, b: pre + j }));
    } else {
        // lcs[i * (m + 1) + j]: longest common subsequence of am[i..] and bm[j..].
        let w = m + 1;
        let mut lcs = vec![0i32; (n + 1) * w];
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                lcs[i * w + j] = if am[i] == bm[j] {
                    lcs[(i + 1) * w + j + 1] + 1
                } else {
                    lcs[(i + 1) * w + j].max(lcs[i * w + j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < n || j < m {
            if i < n && j < m && am[i] == bm[j] {
                ops.push(Op { kind: Kind::Same, text: am[i], a: pre + i, b: pre + j });
                i += 1;
                j += 1;
            } else if j < m && (i == n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j]) {
                ops.push(Op { kind: Kind::Added, text: bm[j], a: pre + i, b: pre + j });
                j += 1;
            } else {
                ops.push(Op { kind: Kind::Removed, text: am[i], a: pre + i, b: pre + j });
                i += 1;
            }
        }
    }
    for k in 0..suf {
        ops.push(Op { kind: Kind::Same, text: a[a.len() - suf + k], a: a.len() - suf + k, b: b.len() - suf + k });
    }
    // Removals before additions within each changed run, as diff(1) prints them.
    let mut out = Vec::with_capacity(ops.len());
    let mut k = 0;
    while k < ops.len() {
        if ops[k].kind == Kind::Same {
            out.push(ops[k]);
            k += 1;
            continue;
        }
        let start = k;
        while k < ops.len() && ops[k].kind != Kind::Same {
            k += 1;
        }
        let run = &ops[start..k];
        out.extend(run.iter().filter(|o| o.kind == Kind::Removed));
        out.extend(run.iter().filter(|o| o.kind == Kind::Added));
    }
    out
}

/// A unified diff, with how many lines it adds and removes.
#[derive(Debug, Clone, PartialEq)]
pub struct UnifiedDiff {
    pub diff: String,
    pub added: usize,
    pub removed: usize,
}

/// A unified diff of two texts, line by line, with `context` unchanged lines around each change.
pub fn unified_diff(before: &str, after: &str, from_label: &str, to_label: &str, context: usize) -> UnifiedDiff {
    let a = split_lines(before);
    let b = split_lines(after);
    let ops = line_ops(&a, &b);
    let changed: Vec<usize> = ops.iter().enumerate().filter(|(_, o)| o.kind != Kind::Same).map(|(i, _)| i).collect();
    let added = ops.iter().filter(|o| o.kind == Kind::Added).count();
    let removed = ops.iter().filter(|o| o.kind == Kind::Removed).count();
    if changed.is_empty() {
        let diff = if before == after {
            String::new()
        } else {
            format!("--- {from_label}\n+++ {to_label}\n(only the newline at the end of the file differs)")
        };
        return UnifiedDiff { diff, added, removed };
    }
    let mut lines = vec![format!("--- {from_label}"), format!("+++ {to_label}")];
    let mut k = 0;
    while k < changed.len() {
        let start = changed[k].saturating_sub(context);
        let mut end = changed[k] + context;
        while k + 1 < changed.len() && changed[k + 1] <= end + 1 + context {
            k += 1;
            end = changed[k] + context;
        }
        end = end.min(ops.len() - 1);
        let hunk = &ops[start..=end];
        let a_len = hunk.iter().filter(|o| o.kind != Kind::Added).count();
        let b_len = hunk.iter().filter(|o| o.kind != Kind::Removed).count();
        // A line's own index is exact on its side only (a `+` line's `a` is where it would go), so each side starts at
        // its first line in the hunk.
        let a_start = hunk.iter().find(|o| o.kind != Kind::Added).map_or(hunk[0].a, |o| o.a + 1);
        let b_start = hunk.iter().find(|o| o.kind != Kind::Removed).map_or(hunk[0].b, |o| o.b + 1);
        lines.push(format!("@@ -{a_start},{a_len} +{b_start},{b_len} @@"));
        for o in hunk {
            let mark = match o.kind {
                Kind::Same => ' ',
                Kind::Removed => '-',
                Kind::Added => '+',
            };
            lines.push(format!("{mark}{}", o.text));
        }
        k += 1;
    }
    UnifiedDiff { diff: lines.join("\n"), added, removed }
}
