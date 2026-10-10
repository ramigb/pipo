// The control ops a runner answers on its socket (docs/spec.md §7.2, D24). Port of control/ops.ts. Each op maps
// onto a Runner method; the server redacts every response.

use super::protocol::{ControlError, OPS, PROTOCOL};
use super::reads::{READ_OPS, read};
use super::versions::version_arg;
use crate::connectors::{IntakeResult, Origin};
use crate::journal::{IN_FLIGHT, OUTPUT_STEP, PacketRow, ReplayItem, ReplayLeaf};
use crate::runner::apply::How;
use crate::runner::{RESOLVE_ACTIONS, Runner, RunnerState};
use crate::stats::{compute_metrics, compute_stats};
use crate::time::{iso, now_ms};
use serde_json::{Map, Value, json};
use std::rc::Rc;

const PAUSE_REASONS: &[&str] = &["manual", "agent"];
const MAX_EVENTS: i64 = 1000;
/// Explicit ids per replay or purge request; `all` has no limit.
const MAX_IDS: usize = 1000;
/// `all` commits this many packets per transaction, yielding in between so the runner keeps serving.
const CHUNK: usize = 200;
/// At most this many replayed packets are listed in a reply (the count is always exact).
const LISTED: usize = 100;


fn internal(e: impl ToString) -> ControlError {
    ControlError::new("internal", e.to_string(), "see the runner log")
}

fn hello(r: &Runner) -> Value {
    json!({
        "protocol": PROTOCOL,
        "pipeline": r.pipeline().name,
        "version": r.version(),
        "pid": std::process::id(),
        "state": r.state().as_str(),
        "status": r.status(),
        "started_at": iso(r.started_at()),
        "socket": r.socket.display().to_string(),
        "ops": OPS,
    })
}

fn live(r: &Runner, op: &str) -> Result<(), ControlError> {
    let st = r.state();
    if st == RunnerState::Stopped || st == RunnerState::Failed {
        return Err(ControlError::new(
            "invalid_state",
            format!("pipeline is {}; '{op}' needs a running pipeline", st.as_str()),
            "start it again",
        ));
    }
    Ok(())
}

fn running(r: &Runner) -> bool {
    matches!(r.state(), RunnerState::Active | RunnerState::Paused)
}

fn by_arg(args: &Map<String, Value>) -> String {
    match args.get("by").and_then(|b| b.as_str()) {
        Some(b) if !b.is_empty() => b.chars().take(200).collect(),
        _ => "control".into(),
    }
}

fn unavailable_hint(reason: &str) -> &'static str {
    if reason.starts_with("buffer full") {
        "wait for pending packets to finish, or raise buffer.max"
    } else if reason.contains("lifetime") {
        "the pipeline reached its lifetime; start it again to accept packets"
    } else {
        "push works while the pipeline is active or paused"
    }
}

fn whole(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 9e15).map(|f| f as i64))
}

/// `ids` (packet ids) or `all: true`, never both; ids deduplicated. None means all.
fn targets(args: &Map<String, Value>, op: &str) -> Result<Option<Vec<String>>, ControlError> {
    let example = format!(r#"{{"op":"{op}","args":{{"ids":["01J…"]}}}} or {{"op":"{op}","args":{{"all":true}}}}"#);
    let all = match args.get("all") {
        None | Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) => true,
        Some(_) => return Err(ControlError::new("bad_request", "`all` must be true or false", example)),
    };
    if all && args.contains_key("ids") {
        return Err(ControlError::new("bad_request", format!("{op} takes `ids` or `all`, not both"), example));
    }
    if all {
        return Ok(None);
    }
    let ids = id_list(args.get("ids")).ok_or_else(|| {
        ControlError::new("bad_request", format!("{op} needs `ids` (packet ids) or `all: true`"), example.clone())
    })?;
    if ids.len() > MAX_IDS {
        return Err(ControlError::new("bad_request", format!("at most {MAX_IDS} ids per {op}"), "split the list, or use all: true"));
    }
    Ok(Some(ids))
}

/// A non-empty list of non-empty id strings (≤ 400 chars), deduplicated in order.
fn id_list(v: Option<&Value>) -> Option<Vec<String>> {
    let arr = v?.as_array()?;
    if arr.is_empty() {
        return None;
    }
    let mut out: Vec<String> = vec![];
    for id in arr {
        let s = id.as_str().filter(|s| !s.is_empty() && s.chars().count() <= 400)?;
        if !out.iter().any(|o| o == s) {
            out.push(s.to_string());
        }
    }
    Some(out)
}

/// A packet in the dead-letter queue, or an error saying why `id` isn't one.
fn dlq_entry(r: &Runner, id: &str, op: &str) -> Result<PacketRow, ControlError> {
    let name = r.pipeline().name.clone();
    let row = r.journal.borrow().get(id).map_err(internal)?.ok_or_else(|| {
        ControlError::new("not_found", format!("no packet '{id}' in {name}"), format!("list the dead-letter queue with pipo dlq {name}"))
    })?;
    if let Some(root) = &row.root {
        return Err(ControlError::new(
            "invalid_state",
            format!("{id} is a branch copy of {root}; the dead-letter queue holds whole packets"),
            format!(
                "{op} {root} instead: it {}",
                if op == "replay" { "replays the copies that failed" } else { "purges every copy" }
            ),
        ));
    }
    if row.state != "dead_lettered" {
        let moving = IN_FLIGHT.contains(&row.state.as_str()) || row.state == "branched";
        return Err(ControlError::new(
            "invalid_state",
            format!("packet {id} is {}, not in the dead-letter queue", row.state),
            if moving {
                format!("it is in flight (replayed already?); follow it with pipo inspect {name} {id}")
            } else {
                format!("pipo inspect {name} {id} shows what happened to it")
            },
        ));
    }
    Ok(row)
}

/// Where each failed unit of a dead-lettered packet resumes (D33): the node it failed on, with the data it had
/// there; an output or delivery-check failure writes again (idempotent on its key), then checks again.
async fn plan_replay(r: &Runner, id: &str) -> Result<ReplayItem, ControlError> {
    let name = r.pipeline().name.clone();
    dlq_entry(r, id, "replay")?;
    let dead = r.journal.borrow().dead_leaves(id).map_err(internal)?;
    let mut leaves = vec![];
    for leaf in dead {
        let at = leaf.error.as_ref().and_then(|e| e.node.clone());
        let reset = if leaf.error.as_ref().map(|e| e.code == "loop.max").unwrap_or(false) { Some(0) } else { None };
        if matches!(at.as_deref(), Some("output") | Some("delivered")) {
            leaves.push(ReplayLeaf { id: leaf.id.clone(), cursor: OUTPUT_STEP.into(), state: "writing".into(), iteration: reset });
            continue;
        }
        let pinned = r.pipeline_of(leaf.version).await.map_err(internal)?;
        match at {
            Some(node) if pinned.nodes.get(&node).is_some() => {
                leaves.push(ReplayLeaf { id: leaf.id.clone(), cursor: node, state: "processing".into(), iteration: reset })
            }
            other => {
                return Err(ControlError::new(
                    "invalid_state",
                    format!(
                        "can't tell where packet {} failed ({}), so it can't be replayed",
                        leaf.id,
                        match other {
                            Some(a) => format!("'{a}' is not a step of v{}", leaf.version),
                            None => "its error names no step".into(),
                        }
                    ),
                    format!("purge it (pipo dlq purge {name} {id}) and push its data again"),
                ));
            }
        }
    }
    if leaves.is_empty() {
        return Err(ControlError::new("internal", format!("packet {id} is dead-lettered but none of its copies is"), "see the runner log"));
    }
    Ok(ReplayItem { packet_id: id.to_string(), leaves })
}

fn commit_replay(r: &Runner, items: &[ReplayItem], by: &str) -> Result<(), ControlError> {
    if items.is_empty() {
        return Ok(());
    }
    let name = r.pipeline().name.clone();
    r.journal.borrow_mut().replay(items, by).map_err(|e| {
        ControlError::new("invalid_state", e.to_string(), format!("list the dead-letter queue again: pipo dlq {name}"))
    })?;
    r.requeue(items.iter().flat_map(|i| i.leaves.iter().map(|l| l.id.clone())).collect());
    Ok(())
}

fn commit_purge(r: &Runner, ids: &[String], by: &str) -> Result<(), ControlError> {
    if ids.is_empty() {
        return Ok(());
    }
    let name = r.pipeline().name.clone();
    r.journal.borrow_mut().purge(ids, by).map_err(|e| {
        ControlError::new("invalid_state", e.to_string(), format!("list the dead-letter queue again: pipo dlq {name}"))
    })
}

fn dead_ids(r: &Runner) -> Result<Vec<String>, ControlError> {
    let j = r.journal.borrow();
    let mut stmt = j
        .db()
        .prepare("SELECT id FROM packets WHERE state = 'dead_lettered' AND branch = '' ORDER BY id")
        .map_err(internal)?;
    let ids = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(internal)?.collect::<Result<Vec<_>, _>>().map_err(internal)?;
    Ok(ids)
}

fn replay_view(i: &ReplayItem) -> Value {
    json!({ "packet_id": i.packet_id, "units": i.leaves.iter().map(|l| json!({ "id": l.id, "node": l.cursor })).collect::<Vec<_>>() })
}

pub async fn handle(r: &Rc<Runner>, op: &str, args: &Map<String, Value>) -> Result<(Value, Option<super::server::After>), ControlError> {
    let name = r.pipeline().name.clone();
    let plain = |v: Value| Ok((v, None));
    match op {
        "hello" => plain(hello(r)),
        "status" => {
            live(r, "status")?;
            let j = r.journal.borrow();
            let mut stats = compute_stats(&j, r.started_at(), now_ms()).map_err(internal)?.to_value();
            let nodes: Vec<String> = r.pipeline().nodes.iter().map(|(k, _)| k.clone()).collect();
            let metrics = compute_metrics(&j, &nodes, now_ms()).map_err(internal)?;
            for (k, v) in metrics.as_object().cloned().unwrap_or_default() {
                stats[k] = v;
            }
            let stall = r.stall_info();
            stats["stalled"] = stall.as_ref().map(|s| json!({ "node": s.node, "since": s.since })).unwrap_or(Value::Null);
            stats["agent_spend_today"] = json!(r.agent_spend_today());
            let last_seq = j.last_seq().map_err(internal)?;
            drop(j);
            let mut out = hello(r);
            out["paused_reason"] =
                if r.state() == RunnerState::Paused { json!(r.pause_reason().unwrap_or_else(|| "manual".into())) } else { Value::Null };
            out["stats"] = stats;
            out["budget_resumes_at"] = json!(r.budget_resumes_at());
            out["note"] = stall.map(|s| json!(format!("stalled at '{}'", s.node))).unwrap_or(Value::Null);
            out["awaiting_ack"] = json!(r.awaiting_ack());
            out["input"] = json!(r.address());
            out["listen"] = json!(r.port());
            out["last_seq"] = json!(last_seq);
            plain(out)
        }
        "pause" => {
            let reason = args.get("reason").cloned().unwrap_or(json!("manual"));
            let reason = reason.as_str().filter(|s| PAUSE_REASONS.contains(s)).ok_or_else(|| {
                ControlError::new(
                    "bad_request",
                    format!("pause reason must be one of {}", PAUSE_REASONS.join(", ")),
                    r#"{"op":"pause","args":{"reason":"manual"}}"#,
                )
            })?;
            if r.state() == RunnerState::Paused {
                return plain(json!({ "state": "paused", "already": true }));
            }
            if r.state() != RunnerState::Active {
                return Err(ControlError::new("invalid_state", format!("cannot pause: pipeline is {}", r.state().as_str()), "pause works while it is active"));
            }
            r.pause(reason, Map::new());
            plain(json!({ "state": r.state().as_str(), "already": false }))
        }
        "resume" => {
            if r.state() == RunnerState::Active {
                return plain(json!({ "state": "active", "already": true }));
            }
            if r.state() != RunnerState::Paused {
                return Err(ControlError::new("invalid_state", format!("cannot resume: pipeline is {}", r.state().as_str()), "resume works while it is paused"));
            }
            r.resume(false);
            plain(json!({ "state": r.state().as_str(), "already": false }))
        }
        "drain" => {
            if r.state() == RunnerState::Draining {
                return plain(json!({ "state": "draining", "already": true }));
            }
            if !running(r) {
                return Err(ControlError::new("invalid_state", format!("cannot drain: pipeline is {}", r.state().as_str()), "drain works while it runs"));
            }
            // Reply first: draining ends with the socket closing.
            let after: super::server::After = Box::new(|r: Rc<Runner>| {
                tokio::task::spawn_local(async move { r.drain().await });
            });
            Ok((json!({ "state": "draining", "already": false }), Some(after)))
        }
        "stop" => {
            live(r, "stop")?;
            let after: super::server::After = Box::new(|r: Rc<Runner>| {
                tokio::task::spawn_local(async move { r.stop(0).await });
            });
            Ok((json!({ "state": "stopping" }), Some(after)))
        }
        "push" => {
            let data = args.get("data").cloned().ok_or_else(|| {
                ControlError::new("bad_request", "push needs `data`", r#"{"op":"push","args":{"data":{"name":"Ada"}}}"#)
            })?;
            let source = match args.get("source") {
                None => "control".to_string(),
                Some(Value::String(s)) if s.chars().count() <= 200 => s.clone(),
                Some(_) => {
                    return Err(ControlError::new("bad_request", "`source` must be a string of at most 200 characters", "e.g. cli, ui, mcp"));
                }
            };
            match r.intake(data, Origin { trigger: "push".into(), source }, None).await {
                IntakeResult::Accepted { packet_id } => plain(json!({ "packet_id": packet_id, "state": "accepted" })),
                IntakeResult::Rejected { packet_id, message, .. } => {
                    let mut e = ControlError::new(
                        "rejected",
                        message,
                        "the packet failed input validation and is journaled as rejected; fix the data and push it again",
                    );
                    e.packet_id = Some(packet_id);
                    Err(e)
                }
                IntakeResult::Unavailable { reason } => {
                    let hint = unavailable_hint(&reason);
                    Err(ControlError::new("unavailable", reason, hint))
                }
            }
        }
        "ack" => {
            let id = args.get("packet_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).ok_or_else(|| {
                ControlError::new("bad_request", "ack needs `packet_id`", r#"{"op":"ack","args":{"packet_id":"01J…"}}"#)
            })?;
            let by: String = args.get("by").and_then(|b| b.as_str()).map(|b| b.chars().take(200).collect()).unwrap_or_else(|| "control".into());
            plain(r.ack(id, &by).await?)
        }
        "events" => {
            let after = args.get("after_seq").map(whole).unwrap_or(Some(0)).filter(|a| *a >= 0).ok_or_else(|| {
                ControlError::new("bad_request", "`after_seq` must be a whole number ≥ 0", "use the last seq you saw, or 0")
            })?;
            let limit = args.get("limit").map(whole).unwrap_or(Some(100)).filter(|l| (1..=MAX_EVENTS).contains(l)).ok_or_else(|| {
                ControlError::new("bad_request", format!("`limit` must be between 1 and {MAX_EVENTS}"), "page with after_seq")
            })?;
            let j = r.journal.borrow();
            let events = j.events_after(after, limit).map_err(internal)?;
            let last = events.last().map(|e| e.seq).unwrap_or(after);
            let more = last < j.last_seq().map_err(internal)?;
            plain(json!({ "events": events, "last_seq": last, "more": more }))
        }
        op if READ_OPS.contains(&op) => {
            live(r, op)?;
            let j = r.journal.borrow();
            plain(read(j.db(), op, args, &name, r.version())?)
        }
        "apply" => {
            let source = args.get("source").and_then(|s| s.as_str()).filter(|s| !s.trim().is_empty()).ok_or_else(|| {
                ControlError::new(
                    "bad_request",
                    "apply needs `source`: the whole .pipo definition",
                    r#"{"op":"apply","args":{"source":"pipo: 1\n…","reason":"why"}}"#,
                )
            })?;
            let reason = match args.get("reason").and_then(|s| s.as_str()) {
                Some(s) if !s.trim().is_empty() => s.chars().take(500).collect(),
                _ => "applied".to_string(),
            };
            let applied = r.apply_version(source, How { author: by_arg(args), reason, author_kind: None, proposal: None }).await?;
            plain(applied.to_value())
        }
        "rollback" => {
            let version = version_arg(args.get("version"), "version")?;
            plain(r.rollback(version, &by_arg(args)).await?)
        }
        "apply_proposal" | "propose" | "reject_proposal" => Err(ControlError::new(
            "unavailable",
            format!("'{op}' is not ported to the Rust runner yet"),
            "see docs/rust-runner.md",
        )),
        "resolve" => {
            let example = r#"{"op":"resolve","args":{"ids":["01J…"],"action":"retry","by":"agent-ops","by_kind":"agent"}}"#;
            let action = args.get("action").and_then(|a| a.as_str()).filter(|a| RESOLVE_ACTIONS.contains(a)).ok_or_else(|| {
                ControlError::new("bad_request", format!("resolve needs `action`: one of {}", RESOLVE_ACTIONS.join(", ")), example)
            })?;
            if args.contains_key("ids") && args.contains_key("packet_id") {
                return Err(ControlError::new("bad_request", "resolve takes `ids` or `packet_id`, not both", example));
            }
            let raw = match (args.get("ids"), args.get("packet_id")) {
                (Some(ids), _) => Some(ids.clone()),
                (None, Some(p)) => Some(json!([p])),
                _ => None,
            };
            let ids = id_list(raw.as_ref())
                .ok_or_else(|| ControlError::new("bad_request", "resolve needs `ids` (unit ids: packet ids or copy ids)", example))?;
            if ids.len() > MAX_IDS {
                return Err(ControlError::new("bad_request", format!("at most {MAX_IDS} ids per resolve"), "split the list"));
            }
            let kind = match args.get("by_kind") {
                None | Some(Value::Null) => None,
                Some(Value::String(k)) if k == "agent" || k == "human" => Some(k.clone()),
                Some(_) => return Err(ControlError::new("bad_request", "`by_kind` must be agent or human", example)),
            };
            let reason = match args.get("reason") {
                None => None,
                Some(Value::String(s)) => Some(s.chars().take(2000).collect::<String>()).filter(|s| !s.trim().is_empty()),
                Some(_) => return Err(ControlError::new("bad_request", "`reason` must be a string", example)),
            };
            plain(r.resolve(&ids, action, &by_arg(args), kind.as_deref(), reason.as_deref())?)
        }
        "replay" => {
            if !running(r) {
                return Err(ControlError::new(
                    "invalid_state",
                    format!("cannot replay: pipeline is {}", r.state().as_str()),
                    "replay works while the pipeline is active or paused; start it again (pipo start)",
                ));
            }
            let target = targets(args, "replay")?;
            let by = r.redact(&by_arg(args));
            if let Some(ids) = target {
                // Validate every id before committing any: a bad id replays nothing.
                let mut items = vec![];
                for id in &ids {
                    items.push(plan_replay(r, id).await?);
                }
                commit_replay(r, &items, &by)?;
                let packets: Vec<Value> = items.iter().take(LISTED).map(replay_view).collect();
                return plain(json!({ "replayed": items.len(), "packets": packets, "skipped": [] }));
            }
            // `all` is a snapshot: a packet that dead-letters again while this runs is not picked up twice.
            let ids = dead_ids(r)?;
            let (mut packets, mut skipped, mut replayed) = (vec![], vec![], 0);
            for chunk in ids.chunks(CHUNK) {
                if !running(r) {
                    break;
                }
                let mut items = vec![];
                for id in chunk {
                    match plan_replay(r, id).await {
                        Ok(i) => items.push(i),
                        Err(e) => {
                            // Replayed or purged by someone else meanwhile: not an error for `all`.
                            let still = r.journal.borrow().get(id).ok().flatten().map(|p| p.state == "dead_lettered").unwrap_or(false);
                            if still {
                                skipped.push(json!({ "packet_id": id, "error": e.message }));
                            }
                        }
                    }
                }
                commit_replay(r, &items, &by)?;
                replayed += items.len();
                for it in &items {
                    if packets.len() < LISTED {
                        packets.push(replay_view(it));
                    }
                }
                tokio::task::yield_now().await;
            }
            plain(json!({ "replayed": replayed, "packets": packets, "skipped": skipped }))
        }
        "purge" => {
            live(r, "purge")?;
            let target = targets(args, "purge")?;
            let by = r.redact(&by_arg(args));
            if let Some(ids) = target {
                for id in &ids {
                    dlq_entry(r, id, "purge")?;
                }
                commit_purge(r, &ids, &by)?;
                let listed: Vec<&String> = ids.iter().take(LISTED).collect();
                return plain(json!({ "purged": ids.len(), "packets": listed }));
            }
            let ids = dead_ids(r)?;
            let (mut packets, mut purged) = (vec![], 0);
            for chunk in ids.chunks(CHUNK) {
                if matches!(r.state(), RunnerState::Stopped | RunnerState::Failed) {
                    break;
                }
                let chunk: Vec<String> = chunk
                    .iter()
                    .filter(|id| r.journal.borrow().get(id).ok().flatten().map(|p| p.state == "dead_lettered").unwrap_or(false))
                    .cloned()
                    .collect();
                commit_purge(r, &chunk, &by)?;
                purged += chunk.len();
                for id in chunk {
                    if packets.len() < LISTED {
                        packets.push(id);
                    }
                }
                tokio::task::yield_now().await;
            }
            plain(json!({ "purged": purged, "packets": packets }))
        }
        _ => Err(ControlError::new("unknown_op", format!("unknown op '{op}'"), format!("ops: {}", OPS.join(", ")))),
    }
}

