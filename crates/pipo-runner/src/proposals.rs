// Agent change protocol: the proposal store and its validation (docs/spec.md §9.3, D4, D38, D45–D51). Port of
// proposals.ts, except the dry run (`dryRun`, D48), which comes with the dry-run port.
//
// A proposal is a whole proposed `.pipo` source against version N. `propose` compiles it (`pipo compile`), then
// validates it against the journal and stores it, with a pipeline-level `proposal.<state>` event, in one transaction,
// so a proposal is never half-recorded. States: validated → verified (the dry run, when the base sets `agent.verify`
// for an agent's proposal) → applied; validated or verified → rejected. `applied` is committed by `mark_applied_in`
// inside the transaction that stores version N+1 (`Runner::apply_proposal`, D49).
//
// Stored sources are the author's text (secret references, not values), like versions; reasons, diagnostics and
// events go through `redact`, and responses must be redacted by whoever serves them (D24).

use crate::compile::Compiled;
use crate::control::ControlError;
use crate::control::protocol::redact_deep;
use crate::control::versions::{unified_diff, version_arg};
use crate::journal::Journal;
use crate::pipeline::{AgentPolicy, Pipeline};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::cmp::Ordering;
use std::path::PathBuf;
use std::rc::Rc;

pub const PROPOSAL_STATES: &[&str] = &["validated", "verified", "applied", "rejected"];

/// Top-level keys an agent may never change, whatever `agent.edit` lists (§9.3; `agent_budget`, D47).
pub const AGENT_FORBIDDEN: &[&str] = &["output", "delivered", "secrets", "agent", "agent_budget"];

/// Bounds on what a proposal may carry, so an author can't bloat the journal.
pub const MAX_SOURCE_BYTES: usize = 1024 * 1024;
pub const MAX_REASON_CHARS: usize = 2000;
pub const MAX_AUTHOR_CHARS: usize = 200;

/// Why a proposal can't be applied. `code` is one of stale_base, not_allowed, forbidden_path, not_editable,
/// invalid_pipeline, bound_change, unsupported, no_change.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProposalProblem {
    pub code: &'static str,
    /// The changed path it is about (dotted), when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub message: String,
    pub hint: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProposalSummary {
    pub id: String,
    pub pipeline: String,
    pub base_version: i64,
    pub author: String,
    /// `agent` or `human`.
    pub author_kind: String,
    pub reason: String,
    pub state: String,
    /// Dotted paths that differ from the base, by structure (a list is compared whole).
    pub changed_paths: Value,
    pub added: i64,
    pub removed: i64,
    /// `agent.verify` of the base version, when a dry run is required before apply (agents only).
    pub verify: Option<String>,
    pub applied_version: Option<i64>,
    /// Who made the latest decision (verify, apply, reject); None while only validated at propose time.
    pub decided_by: Option<String>,
    pub created_at: i64,
    pub decided_at: Option<i64>,
}

/// A proposal as `get` returns it: the summary's keys, then the rest, in TS key order.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Proposal {
    #[serde(flatten)]
    pub summary: ProposalSummary,
    pub source: String,
    /// Unified diff from version N (3 lines of context), as `pipo diff` prints it.
    pub diff: String,
    pub problems: Value,
    /// `pipo check` output on the proposed source (warnings too).
    pub diagnostics: Value,
    /// Why it was decided later (a reject's reason, a dry run's summary).
    pub decision: Option<String>,
    /// The dry run's report.
    pub verification: Value,
}

impl Proposal {
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("a proposal serializes")
    }
}

impl std::ops::Deref for Proposal {
    type Target = ProposalSummary;
    fn deref(&self) -> &ProposalSummary {
        &self.summary
    }
}

/// What `propose` takes, as the caller sent it: each field is checked, as in TS.
#[derive(Debug, Clone, Default)]
pub struct ProposalInput {
    /// Version N the source was written against: `3` or `"v3"`.
    pub base_version: Value,
    /// The whole proposed `.pipo` source.
    pub source: Value,
    /// Agent id, or the human channel (`cli`, `api`).
    pub author: Value,
    pub author_kind: Value,
    pub reason: Value,
}

// ── changed paths and the edit policy (pure) ─────────────────────────────────

/// `a === b` on parsed JSON, deep for lists and maps (absent is not null).
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::Array(x)), Some(Value::Array(y))) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(Some(x), Some(y)))
        }
        (Some(Value::Object(x)), Some(Value::Object(y))) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.contains_key(k) && same(Some(v), y.get(k)))
        }
        (Some(Value::Array(_) | Value::Object(_)), _) | (_, Some(Value::Array(_) | Value::Object(_))) => false,
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// Primary weight under ICU's root collation for the characters YAML keys use; None for ignorable ones (controls).
fn collation_weight(c: char) -> Option<u32> {
    const ORDER: &str = "\t\n\u{b}\u{c}\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789";
    if let Some(i) = ORDER.find(c) {
        return Some(i as u32);
    }
    if c.is_ascii_alphabetic() {
        return Some(100 + (c.to_ascii_lowercase() as u32 - 'a' as u32));
    }
    if (c as u32) < 0x20 || c == '\u{7f}' {
        return None;
    }
    Some(1000 + c as u32)
}

/// `a.localeCompare(b)` as Bun (ICU, en-US) orders ASCII: punctuation, digits, then letters with lower case first
/// among equals; control characters (the `\0` joining path segments) are ignored. Other characters sort by code
/// point after the letters, an approximation.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let weights = |s: &str| -> Vec<(u32, bool)> {
        s.chars().filter_map(|c| collation_weight(c).map(|w| (w, c.is_ascii_uppercase()))).collect()
    };
    let (wa, wb) = (weights(a), weights(b));
    wa.iter().map(|w| w.0).cmp(wb.iter().map(|w| w.0)).then_with(|| wa.iter().map(|w| w.1).cmp(wb.iter().map(|w| w.1)))
}

/// The deepest paths where two parsed documents differ: a key added, removed or changed. Maps are walked key by key;
/// a list, a scalar or a change of type is one path, so `agent.edit` must cover a list as a whole. Key order and
/// formatting are not changes. Sorted as TS sorts them (`localeCompare` of the segments joined by `\0`).
pub fn changed_paths(before: &Value, after: &Value) -> Vec<Vec<String>> {
    fn walk(a: Option<&Value>, b: Option<&Value>, at: &mut Vec<String>, out: &mut Vec<Vec<String>>) {
        if let (Some(Value::Object(x)), Some(Value::Object(y))) = (a, b) {
            let keys = x.keys().chain(y.keys().filter(|k| !x.contains_key(*k)));
            for k in keys {
                at.push(k.clone());
                walk(x.get(k), y.get(k), at, out);
                at.pop();
            }
        } else if !same(a, b) {
            out.push(at.clone());
        }
    }
    let mut out = vec![];
    walk(Some(before), Some(after), &mut vec![], &mut out);
    out.sort_by(|x, y| locale_compare(&x.join("\0"), &y.join("\0")));
    out
}

/// `pattern` (dotted, `*` = exactly one segment) covers `path` when it matches a prefix of it: a pattern covers its
/// subtree.
pub fn covers(pattern: &str, path: &[String]) -> bool {
    let segs: Vec<&str> = pattern.split('.').collect();
    segs.len() <= path.len() && segs.iter().zip(path).all(|(s, p)| *s == "*" || s == p)
}

pub fn dotted(path: &[String]) -> String {
    if path.is_empty() { "(the whole file)".to_string() } else { path.join(".") }
}

/// What an agent's change may not do under the base version's `agent:` policy (§9.3). Humans skip this (D45).
pub fn agent_policy_problems(base: &Pipeline, changed: &[Vec<String>]) -> Vec<ProposalProblem> {
    policy_problems(&base.name, base.agent.as_ref(), changed)
}

fn policy_problems(name: &str, policy: Option<&AgentPolicy>, changed: &[Vec<String>]) -> Vec<ProposalProblem> {
    let control = policy.and_then(|p| p.control) == Some(true);
    let edit: &[String] = policy.and_then(|p| p.edit.as_deref()).unwrap_or_default();
    if !control || edit.is_empty() {
        return vec![ProposalProblem {
            code: "not_allowed",
            path: None,
            message: format!(
                "{name} takes no change proposals from agents: its current version has {}",
                if control { "no `agent.edit` paths" } else { "no `agent.control: true`" }
            ),
            hint: "a human must add `agent: {control: true, edit: [...]}` to the pipeline file first; agents can't grant themselves edits".into(),
        }];
    }
    let mut out = vec![];
    for path in changed {
        let at = dotted(path);
        let top = path.first().map(String::as_str).unwrap_or("undefined");
        if path.first().is_some_and(|p| AGENT_FORBIDDEN.contains(&p.as_str())) {
            out.push(ProposalProblem {
                code: "forbidden_path",
                path: Some(at.clone()),
                message: format!("agents may never change `{top}` (changed: {at})"),
                hint: format!(
                    "output, delivered, secrets, agent and agent_budget are human-only, even if agent.edit lists them; leave {top} as in the base version"
                ),
            });
        } else if !edit.iter().any(|p| covers(p, path)) {
            out.push(ProposalProblem {
                code: "not_editable",
                path: Some(at.clone()),
                message: format!("{at} is not covered by agent.edit ({})", edit.join(", ")),
                hint: "change only paths agent.edit lists (a pattern covers its subtree; * is one segment), or ask a human to widen agent.edit".into(),
            });
        }
    }
    out
}

// ── validation ───────────────────────────────────────────────────────────────

pub struct Validation {
    pub changed: Vec<Vec<String>>,
    pub problems: Vec<ProposalProblem>,
    pub diagnostics: Vec<Value>,
    pub verify: Option<String>,
}

pub struct ValidateArgs<'a> {
    pub base_version: i64,
    pub base_source: &'a str,
    /// The base's definition as `load()` gives it (its stored compiled form's `pipeline`); `{}` when unknown.
    pub base: &'a Value,
    pub latest: i64,
    pub source: &'a str,
    /// `agent` or `human`.
    pub author_kind: &'a str,
    /// `pipo compile` of `source`, with the pipeline's file anchoring relative paths (D38).
    pub compiled: &'a Compiled,
}

/// Validate a proposed source against its base (§9.3 step 2). Every problem is reported, not just the first, so an
/// agent can fix them in one go. Synchronous: the caller reads `latest` in the transaction that stores the result.
pub fn validate_proposal(a: ValidateArgs) -> Validation {
    let mut problems = vec![];
    if a.base_version != a.latest {
        problems.push(ProposalProblem {
            code: "stale_base",
            path: None,
            message: format!("the proposal is against v{}, but the pipeline is at v{} now", a.base_version, a.latest),
            hint: format!("read v{} (pipo history, the version op) and propose your change against it", a.latest),
        });
    }
    if a.source == a.base_source {
        problems.push(ProposalProblem {
            code: "no_change",
            path: None,
            message: format!("the proposed source is the same as v{}", a.base_version),
            hint: "propose the full .pipo source with your change in it".into(),
        });
    }
    let errors = a.compiled.errors().len();
    let after = if errors == 0 { a.compiled.pipeline.as_ref() } else { None };
    let changed = after.map(|after| changed_paths(a.base, after)).unwrap_or_default();
    let policy: Option<AgentPolicy> = a.base.get("agent").and_then(|p| serde_json::from_value(p.clone()).ok());
    if after.is_some() && a.author_kind == "agent" {
        let name = a.base.get("name").and_then(Value::as_str).unwrap_or("undefined");
        problems.extend(policy_problems(name, policy.as_ref(), &changed));
    }
    if errors > 0 {
        problems.push(ProposalProblem {
            code: "invalid_pipeline",
            path: None,
            message: format!("the proposed source fails pipo check with {errors} error(s)"),
            hint: "fix the errors in `diagnostics` (pipo check on a local copy shows the same) and propose again".into(),
        });
    } else if let Some(after) = after {
        match Pipeline::from_value(after.clone()) {
            Ok(next) => {
                if let Ok(before) = Pipeline::from_value(a.base.clone()) {
                    let bound = crate::versions::bound_changes(&before, &next);
                    if !bound.is_empty() {
                        problems.push(ProposalProblem {
                            code: "bound_change",
                            path: None,
                            message: format!(
                                "it changes {}, which the runner binds when it starts, so it can't be applied live",
                                bound.join(", ")
                            ),
                            hint: "a human must put that change in the pipeline file and restart it (D38)".into(),
                        });
                    }
                }
                let missing: Vec<String> = crate::support::gaps(&next)
                    .into_iter()
                    .filter(|g| g.level == "refuse")
                    .map(|g| format!("{} ({})", g.feature, g.path))
                    .collect();
                if !missing.is_empty() {
                    problems.push(ProposalProblem {
                        code: "unsupported",
                        path: None,
                        message: format!("it uses features this runner does not implement yet: {}", missing.join(", ")),
                        hint: "remove them from the proposal".into(),
                    });
                }
            }
            Err(e) => problems.push(ProposalProblem {
                code: "unsupported",
                path: None,
                message: format!("it uses features this runner does not implement yet: {e}"),
                hint: "remove them from the proposal".into(),
            }),
        }
    }
    let verify = if a.author_kind == "agent" { policy.and_then(|p| p.verify) } else { None };
    Validation { changed, problems, diagnostics: a.compiled.diagnostics.clone(), verify }
}

// ── reads (any journal, also read-only and from before proposals, D34) ───────

const SUMMARY_COLUMNS: &str = "id, pipeline, base_version, author, author_kind, reason, state, changed_paths, added, \
     removed, verify, applied_version, decided_by, created_at, decided_at";

fn parse(text: &str) -> rusqlite::Result<Value> {
    serde_json::from_str(text).map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
}

fn decode_summary(r: &rusqlite::Row) -> rusqlite::Result<ProposalSummary> {
    Ok(ProposalSummary {
        id: r.get("id")?,
        pipeline: r.get("pipeline")?,
        base_version: r.get("base_version")?,
        author: r.get("author")?,
        author_kind: r.get("author_kind")?,
        reason: r.get("reason")?,
        state: r.get("state")?,
        changed_paths: parse(&r.get::<_, String>("changed_paths")?)?,
        added: r.get("added")?,
        removed: r.get("removed")?,
        verify: r.get("verify")?,
        applied_version: r.get("applied_version")?,
        decided_by: r.get("decided_by")?,
        created_at: r.get("created_at")?,
        decided_at: r.get("decided_at")?,
    })
}

fn decode(r: &rusqlite::Row) -> rusqlite::Result<Proposal> {
    let verification: Option<String> = r.get("verification")?;
    Ok(Proposal {
        summary: decode_summary(r)?,
        source: r.get("source")?,
        diff: r.get("diff")?,
        problems: parse(&r.get::<_, String>("problems")?)?,
        diagnostics: parse(&r.get::<_, String>("diagnostics")?)?,
        decision: r.get("decision")?,
        verification: verification.map(|v| parse(&v)).transpose()?.unwrap_or(Value::Null),
    })
}

fn has_table(db: &Connection) -> rusqlite::Result<bool> {
    Ok(db
        .query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'proposals'", [], |_| Ok(()))
        .optional()?
        .is_some())
}

/// Proposals, newest first, optionally in one state; `limit` is clamped to 1–1000 (default 50). An older journal
/// without the table has none.
pub fn read_list(db: &Connection, state: Option<&str>, limit: Option<i64>) -> rusqlite::Result<Vec<ProposalSummary>> {
    if !has_table(db)? {
        return Ok(vec![]);
    }
    let limit = limit.unwrap_or(50).clamp(1, 1000);
    let order = "ORDER BY created_at DESC, id DESC LIMIT ?";
    match state {
        Some(s) => {
            let mut stmt = db.prepare(&format!("SELECT {SUMMARY_COLUMNS} FROM proposals WHERE state = ? {order}"))?;
            stmt.query_map(params![s, limit], decode_summary)?.collect()
        }
        None => {
            let mut stmt = db.prepare(&format!("SELECT {SUMMARY_COLUMNS} FROM proposals {order}"))?;
            stmt.query_map(params![limit], decode_summary)?.collect()
        }
    }
}

/// One proposal, or None (also for a journal without the table).
pub fn read_get(db: &Connection, id: &str) -> rusqlite::Result<Option<Proposal>> {
    if !has_table(db)? {
        return Ok(None);
    }
    db.query_row("SELECT * FROM proposals WHERE id = ?", [id], decode).optional()
}

// ── the store ────────────────────────────────────────────────────────────────

fn internal(e: impl ToString) -> ControlError {
    ControlError::new("internal", e.to_string(), "see the runner log")
}

/// Run `f` as one journal transaction (a savepoint inside another), rolled back when it fails; its ControlError
/// comes back as it is.
pub fn control_tx<T>(j: &mut Journal, f: impl FnOnce(&mut Journal) -> Result<T, ControlError>) -> Result<T, ControlError> {
    let mut refused = None;
    let out = j.atomically(|j| {
        f(j).map_err(|e| {
            let message = e.message.clone();
            refused = Some(e);
            crate::journal::Error::Message(message)
        })
    });
    out.map_err(|e| refused.take().unwrap_or_else(|| internal(e)))
}

/// JS string length (UTF-16 code units).
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn str_arg<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a str, ControlError> {
    let s = v.as_str().filter(|s| !s.trim().is_empty()).ok_or_else(|| {
        ControlError::new("bad_request", format!("`{key}` must be a non-empty string"), format!("pass {key} with the proposal"))
    })?;
    if js_len(s) > max {
        return Err(ControlError::new("bad_request", format!("`{key}` is longer than {max} characters"), format!("shorten {key}")));
    }
    Ok(s)
}

pub struct ProposalStoreOptions {
    pub pipeline: String,
    /// The pipeline's file: `pipo compile` anchors `fn` modules and schemas on its folder (D38).
    pub file: PathBuf,
    /// Pipo home, for trust (P052).
    pub home: PathBuf,
    /// Secret redaction for reasons, diagnostics and events.
    pub redact: Rc<dyn Fn(&str) -> String>,
    pub now: Rc<dyn Fn() -> i64>,
}

/// What a state move writes besides the state: `decision` None leaves it, Some(None) clears it; `verification` None
/// leaves it.
#[derive(Default)]
struct Extra {
    decision: Option<Option<String>>,
    verification: Option<Value>,
    applied_version: Option<i64>,
    event: Option<Map<String, Value>>,
}

/// The store of change proposals in the pipeline's journal.
pub struct Proposals {
    journal: Rc<RefCell<Journal>>,
    opts: ProposalStoreOptions,
}

impl Proposals {
    pub fn new(journal: Rc<RefCell<Journal>>, opts: ProposalStoreOptions) -> Proposals {
        Proposals { journal, opts }
    }

    fn redact(&self, text: &str) -> String {
        (self.opts.redact)(text)
    }

    /// The base version's definition as `load()` gives it: its stored compiled form, else compiled again from its
    /// source (a version an older runner recorded), else `{}`.
    async fn base_definition(&self, version: i64, source: &str) -> Value {
        let stored = self.journal.borrow().version_compiled(version).ok().flatten();
        if let Some(c) = stored.and_then(|t| Compiled::from_json(&t).ok()).and_then(|c| c.pipeline) {
            return c;
        }
        match crate::compile::compile(&self.opts.file, &self.opts.home, Some(source)).await {
            Ok(c) => c.pipeline.unwrap_or_else(|| json!({})),
            Err(_) => json!({}),
        }
    }

    /// Validate and store a proposal (§9.3 steps 1–2). Bad input (a missing field, an unknown base) is a ControlError
    /// and stores nothing; a proposal that fails validation is stored `rejected` with its problems, so the audit trail
    /// keeps every attempt. One transaction writes the row and its `proposal.validated|rejected` event.
    pub async fn propose(&self, input: &ProposalInput) -> Result<Proposal, ControlError> {
        let base = version_arg(Some(&input.base_version), "base_version")?;
        let source = input.source.as_str().filter(|s| !s.trim().is_empty()).ok_or_else(|| {
            ControlError::new("bad_request", "`source` must be the whole proposed .pipo source", "pass source")
        })?;
        if source.len() > MAX_SOURCE_BYTES {
            return Err(ControlError::new(
                "bad_request",
                format!("`source` is larger than {MAX_SOURCE_BYTES} bytes"),
                "a .pipo file that big is not a pipeline definition; move data out of it",
            ));
        }
        // Every caller-supplied text is redacted before it is stored or journaled.
        let author = self.redact(str_arg(&input.author, "author", MAX_AUTHOR_CHARS)?);
        let reason = str_arg(&input.reason, "reason", MAX_REASON_CHARS)?;
        let author_kind = match input.author_kind.as_str() {
            Some(k @ ("agent" | "human")) => k,
            _ => {
                return Err(ControlError::new(
                    "bad_request",
                    format!("`author_kind` must be agent or human, got {}", crate::expr::js_json(&input.author_kind)),
                    "agents propose as agent; the CLI and API as human",
                ));
            }
        };
        let pipeline = self.opts.pipeline.clone();
        let base_source = self.journal.borrow().version_source(base).map_err(|_| {
            let latest = self.journal.borrow().latest_version().ok().flatten().map_or(0, |l| l.version);
            ControlError::new(
                "not_found",
                format!(
                    "{pipeline} has no version {base}{}",
                    if latest > 0 { format!(" (versions are v1 to v{latest})") } else { String::new() }
                ),
                format!("propose against the current version; pipo history {pipeline} lists them"),
            )
        })?;
        let id = format!("pr_{}", crate::ids::ulid_at((self.opts.now)().max(0) as u64));
        let compiled = crate::compile::compile(&self.opts.file, &self.opts.home, Some(source))
            .await
            .map_err(|e| ControlError::new("internal", e, "check that pipo compile works (PIPO_COMPILE)"))?;
        let base_definition = self.base_definition(base, &base_source).await;
        // From here nothing awaits: `latest` is read in the transaction that stores the proposal.
        control_tx(&mut self.journal.borrow_mut(), |j| {
            let latest = j.latest_version().map_err(internal)?.map_or(0, |l| l.version);
            let v = validate_proposal(ValidateArgs {
                base_version: base,
                base_source: &base_source,
                base: &base_definition,
                latest,
                source,
                author_kind,
                compiled: &compiled,
            });
            let d = unified_diff(&base_source, source, &format!("{pipeline} v{base}"), &format!("{pipeline} proposal {id}"), 3);
            let state = if v.problems.is_empty() { "validated" } else { "rejected" };
            let changed: Vec<String> = v.changed.iter().map(|p| dotted(p)).collect();
            let redact = |t: &str| self.redact(t);
            let problems = redact_deep(&serde_json::to_value(&v.problems).map_err(internal)?, &redact);
            let diagnostics = redact_deep(&Value::Array(v.diagnostics), &redact);
            let safe_reason = self.redact(reason);
            let at = (self.opts.now)();
            j.db()
                .execute(
                    "INSERT INTO proposals (id, pipeline, base_version, source, diff, added, removed, changed_paths, author,
                       author_kind, reason, state, problems, diagnostics, verify, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    params![
                        id,
                        pipeline,
                        base,
                        source,
                        d.diff,
                        d.added as i64,
                        d.removed as i64,
                        crate::expr::js_json(&json!(changed)),
                        author,
                        author_kind,
                        safe_reason,
                        state,
                        crate::expr::js_json(&problems),
                        crate::expr::js_json(&diagnostics),
                        v.verify,
                        at
                    ],
                )
                .map_err(internal)?;
            let mut detail = json!({
                "id": id, "base_version": base, "author": author, "author_kind": author_kind, "reason": safe_reason,
                "changed_paths": changed,
            });
            let listed: Vec<Value> = problems
                .as_array()
                .into_iter()
                .flatten()
                .map(|p| {
                    let mut m = Map::new();
                    m.insert("code".into(), p["code"].clone());
                    if let Some(path) = p.get("path").filter(|p| p.as_str().is_some_and(|s| !s.is_empty())) {
                        m.insert("path".into(), path.clone());
                    }
                    Value::Object(m)
                })
                .collect();
            if !listed.is_empty() {
                detail["problems"] = Value::Array(listed);
            }
            j.event(&format!("proposal.{state}"), Some(&detail), None, None).map_err(internal)?;
            self.get_in(j, &id)
        })
    }

    fn get_in(&self, j: &Journal, id: &str) -> Result<Proposal, ControlError> {
        read_get(j.db(), id).map_err(internal)?.ok_or_else(|| {
            let name = &self.opts.pipeline;
            ControlError::new("not_found", format!("{name} has no proposal {id}"), format!("list them with pipo proposals {name}"))
        })
    }

    pub fn get(&self, id: &str) -> Result<Proposal, ControlError> {
        self.get_in(&self.journal.borrow(), id)
    }

    pub fn list(&self, state: Option<&str>, limit: Option<i64>) -> Result<Vec<ProposalSummary>, ControlError> {
        read_list(self.journal.borrow().db(), state, limit).map_err(internal)
    }

    /// The dry run passed. validated → verified.
    pub fn mark_verified(&self, id: &str, by: &str, report: Option<Value>, summary: Option<String>) -> Result<Proposal, ControlError> {
        let extra = Extra { decision: Some(summary), verification: report, ..Default::default() };
        self.transition_in(&mut self.journal.borrow_mut(), id, &["validated"], "verified", by, extra)
    }

    /// A dry run diverged, the base went stale at apply, or a human rejected it. validated|verified → rejected.
    pub fn mark_rejected(&self, id: &str, by: &str, reason: &str, report: Option<Value>) -> Result<Proposal, ControlError> {
        let extra = Extra { decision: Some(Some(reason.to_string())), verification: report, ..Default::default() };
        self.transition_in(&mut self.journal.borrow_mut(), id, &["validated", "verified"], "rejected", by, extra)
    }

    /// The one path to a required dry run, for `propose` and `apply_proposal` alike (D48, D51): a proposal that needs
    /// none comes back as it is. The dry run itself is not ported yet, so one that needs it is `unavailable`.
    pub async fn dry_run_if_required(&self, id: &str) -> Result<Proposal, ControlError> {
        let p = self.get(id)?;
        match &p.verify {
            Some(verify) if p.state == "validated" => Err(ControlError::new(
                "unavailable",
                format!("the dry run is not ported yet: proposal {id} needs one first (agent.verify: {verify})"),
                "see docs/rust-runner.md; reject it, or have a human propose the change",
            )),
            _ => Ok(p),
        }
    }

    /// Version `version` was stored from this proposal. Call it inside the transaction that adds the version
    /// (`control_tx(j, |j| { let v = j.add_version(…)?; proposals.mark_applied_in(j, id, v, by) })`), so a crash keeps
    /// both or neither. Fails, rolling that transaction back, unless `version` exists and directly follows the
    /// proposal's base, and unless a required dry run passed.
    pub fn mark_applied_in(&self, j: &mut Journal, id: &str, version: i64, by: &str) -> Result<Proposal, ControlError> {
        let p = self.get_in(j, id)?;
        if let Some(verify) = p.verify.as_ref().filter(|_| p.state != "verified") {
            return Err(ControlError::new(
                "invalid_state",
                format!("proposal {id} needs a dry run first (agent.verify: {verify}) and is {}", p.state),
                format!(
                    "apply it again: pipo proposals {} apply {id} (the apply_proposal op) runs the dry run first",
                    self.opts.pipeline
                ),
            ));
        }
        let exists = j
            .db()
            .query_row("SELECT version FROM versions WHERE version = ?", [version], |_| Ok(()))
            .optional()
            .map_err(internal)?
            .is_some();
        if !exists || version != p.base_version + 1 {
            return Err(ControlError::new(
                "invalid_state",
                format!(
                    "proposal {id} is against v{}, so it can only become v{}, not v{version}",
                    p.base_version,
                    p.base_version + 1
                ),
                "propose the change again against the current version",
            ));
        }
        let extra = Extra { applied_version: Some(version), ..Default::default() };
        self.transition_in(j, id, &["validated", "verified"], "applied", by, extra)
    }

    /// One state move: the row and its `proposal.<to>` event in one transaction; refused unless the row is in `from`.
    fn transition_in(&self, j: &mut Journal, id: &str, from: &[&str], to: &str, by: &str, extra: Extra) -> Result<Proposal, ControlError> {
        let by_name = self.redact(str_arg(&json!(by), "by", MAX_AUTHOR_CHARS)?);
        control_tx(j, |j| {
            let p = self.get_in(j, id)?;
            if !from.contains(&p.state.as_str()) {
                return Err(ControlError::new(
                    "invalid_state",
                    format!("proposal {id} is {}, so it can't become {to}", p.state),
                    if p.state == "applied" || p.state == "rejected" {
                        "it is decided; propose the change again if you still want it".to_string()
                    } else {
                        format!("it must be {} first", from.join(" or "))
                    },
                ));
            }
            let decision = match extra.decision {
                None => p.decision.clone(),
                Some(None) => None,
                Some(Some(d)) => Some(self.redact(&d)),
            };
            let redact = |t: &str| self.redact(t);
            let verification = extra.verification.map(|v| crate::expr::js_json(&redact_deep(&v, &redact)));
            let at = (self.opts.now)();
            j.db()
                .execute(
                    "UPDATE proposals SET state = ?, decided_by = ?, decided_at = ?, decision = ?,
                       verification = COALESCE(?, verification), applied_version = COALESCE(?, applied_version)
                     WHERE id = ? AND state = ?",
                    params![to, by_name, at, decision, verification, extra.applied_version, id, p.state],
                )
                .map_err(internal)?;
            let mut detail = json!({ "id": id, "base_version": p.base_version, "by": by_name });
            if let Some(d) = decision.as_ref().filter(|d| !d.is_empty()) {
                detail["reason"] = json!(d);
            }
            if let Some(v) = extra.applied_version {
                detail["version"] = json!(v);
            }
            for (k, v) in extra.event.unwrap_or_default() {
                detail[k] = v;
            }
            j.event(&format!("proposal.{to}"), Some(&detail), None, None).map_err(internal)?;
            self.get_in(j, id)
        })
    }
}
