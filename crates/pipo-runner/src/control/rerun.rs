// The `rerun` control op (docs/spec.md D79): settled packets go back in flight at a node they passed, with the data
// they had there, and run from it to the output again. `dry` answers the plan without committing anything.

use super::protocol::ControlError;
use crate::duration::parse_duration;
use crate::journal::{BATCH_STEP, OUTPUT_STEP, PacketRow, RerunItem, RerunUnit};
use crate::pipeline::NodeKind;
use crate::plan::Plan;
use crate::runner::Runner;
use crate::time::now_ms;
use serde_json::{Map, Value, json};
use std::collections::VecDeque;

/// Explicit ids per request.
const MAX_IDS: usize = 1000;
/// Packets per transaction for `last`, `since` and `all`, yielding in between so the runner keeps serving.
const CHUNK: usize = 200;
/// At most this many packets (and skipped packets) are listed in a reply; the counts are always exact.
const LISTED: usize = 100;

fn internal(e: impl ToString) -> ControlError {
    ControlError::new("internal", e.to_string(), "see the runner log")
}

const EXAMPLE: &str = r#"{"op":"rerun","args":{"from":"<node>","ids":["01J…"]}} (or last: 5, since: "1h", all: true)"#;

fn bad(message: impl Into<String>) -> ControlError {
    ControlError::new("bad_request", message, EXAMPLE)
}

/// Which packets a rerun takes.
enum Select {
    Ids(Vec<String>),
    Recent { last: Option<usize>, since: Option<i64> },
}

struct Args {
    from: String,
    select: Select,
    current: bool,
    dry: bool,
}

fn flag(args: &Map<String, Value>, key: &str) -> Result<bool, ControlError> {
    match args.get(key) {
        None | Some(Value::Null) | Some(Value::Bool(false)) => Ok(false),
        Some(Value::Bool(true)) => Ok(true),
        Some(_) => Err(bad(format!("`{key}` must be true or false"))),
    }
}

fn parse(args: &Map<String, Value>) -> Result<Args, ControlError> {
    let from = match args.get("from") {
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
        _ => return Err(bad("rerun needs `from`: the node to run again from (or `output`)")),
    };
    let all = flag(args, "all")?;
    let last = match args.get("last") {
        None | Some(Value::Null) => None,
        Some(v) => match v.as_u64() {
            Some(n) if (1..=1_000_000).contains(&n) => Some(n as usize),
            _ => return Err(bad("`last` must be a whole number from 1")),
        },
    };
    let since = match args.get("since") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(parse_duration(s).map_err(bad)? as i64),
        Some(_) => return Err(bad("`since` must be a duration such as 30m, 1h or 7d")),
    };
    let ids = match args.get("ids") {
        None | Some(Value::Null) => None,
        Some(v) => {
            let list = v
                .as_array()
                .filter(|a| !a.is_empty())
                .and_then(|a| {
                    a.iter()
                        .map(|i| i.as_str().filter(|s| !s.is_empty()).map(str::to_string))
                        .collect::<Option<Vec<_>>>()
                })
                .ok_or_else(|| bad("`ids` must be a non-empty list of packet ids"))?;
            let mut out: Vec<String> = vec![];
            for id in list {
                if !out.contains(&id) {
                    out.push(id);
                }
            }
            if out.len() > MAX_IDS {
                return Err(bad(format!("at most {MAX_IDS} ids per rerun; split the list, or use last, since or all")));
            }
            Some(out)
        }
    };
    let ranged = all || last.is_some() || since.is_some();
    let select = match ids {
        Some(_) if ranged => return Err(bad("rerun takes `ids`, or `last`/`since`/`all`, not both")),
        Some(ids) => Select::Ids(ids),
        None if !ranged => return Err(bad("rerun needs `ids`, `last`, `since` or `all: true`")),
        None => Select::Recent { last, since },
    };
    Ok(Args { from, select, current: flag(args, "current")?, dry: flag(args, "dry")? })
}

/// The cursor a rerun from `from` restarts at, and the cursors whose first setting marks where the trail got there.
fn steps_of(from: &str) -> (&str, Vec<&str>) {
    if from == "output" { (OUTPUT_STEP, vec![OUTPUT_STEP, BATCH_STEP]) } else { (from, vec![from]) }
}

/// Plan one packet, or say why it can't rerun.
async fn plan_one(r: &Runner, row: &PacketRow, a: &Args) -> Result<Result<RerunItem, String>, ControlError> {
    let id = &row.id;
    if row.state != "delivered" && row.state != "filtered" {
        let why = match row.state.as_str() {
            "dead_lettered" => "it is dead-lettered; replay it with pipo dlq replay".to_string(),
            "rejected" => "it was rejected at its input and never ran".to_string(),
            s => format!("it is {s}, not settled; rerun it once it is delivered or filtered"),
        };
        return Ok(Err(why));
    }
    let version = if a.current { r.version() } else { row.version };
    let (cursor, marks) = steps_of(&a.from);
    if cursor != OUTPUT_STEP {
        let pipeline = r.pipeline_of(version).await.map_err(internal)?;
        if pipeline.nodes.get(cursor).is_none() {
            return Ok(Err(format!("v{version} has no node '{}'", a.from)));
        }
    }
    let j = r.journal.borrow();
    let mut units = vec![row.clone()];
    units.extend(j.copies(id).map_err(internal)?);
    let mut out = vec![];
    for u in &units {
        let Some((data, hops)) = j.entry_of(&u.id, &marks).map_err(internal)? else { continue };
        if units.iter().any(|c| c.parent.as_deref() == Some(u.id.as_str())) {
            return Ok(Err(format!(
                "it fans out at or after '{}', so its copies would be made again; rerun from a node inside a branch",
                a.from
            )));
        }
        if j.data_cleared(&u.id).map_err(internal)? {
            return Ok(Err("its data was cleared by retention (retention.data)".into()));
        }
        let state = if cursor == OUTPUT_STEP { "writing" } else { "processing" };
        out.push(RerunUnit { id: u.id.clone(), cursor: cursor.to_string(), state: state.into(), data, hops });
    }
    if out.is_empty() {
        return Ok(Err(format!("it never reached '{}'", a.from)));
    }
    Ok(Ok(RerunItem { packet_id: id.clone(), version, units: out }))
}

/// The step a rerun starts at and every step after it, to the output, as `{step, kind, effect}` (D79).
fn path(plan: &Plan, start: &str) -> Vec<Value> {
    let p = &plan.pipeline;
    let mut seen: Vec<String> = vec![];
    let mut queue = VecDeque::from([start.to_string()]);
    while let Some(step) = queue.pop_front() {
        if seen.contains(&step) {
            continue;
        }
        seen.push(step.clone());
        let mut refs = vec![step.clone()];
        if let Some(branches) = p.nodes.get(&step).and_then(|n| n.route.as_ref()) {
            refs.extend(branches.keys().map(|b| format!("{step}.{b}")));
        }
        for reference in refs {
            queue.extend(plan.next_of(&reference).iter().cloned());
        }
    }
    seen.iter()
        .map(|s| {
            if s == OUTPUT_STEP {
                let to = p.output.to.as_str();
                let effect = if matches!(to, "http" | "telegram") { "external" } else { "write" };
                return json!({ "step": "output", "kind": format!("output: {to}"), "effect": effect });
            }
            let Some(n) = p.nodes.get(s) else { return json!({ "step": s, "kind": null, "effect": null }) };
            let (kind, effect) = match n.kind() {
                Some(NodeKind::Tap) => {
                    let t = n.tap.clone().unwrap_or_default();
                    let effect = match t.as_str() {
                        "http" | "exec" | "telegram" => Some("external"),
                        "file" => Some("write"),
                        _ => None,
                    };
                    (format!("tap: {t}"), effect)
                }
                Some(NodeKind::Transform) => {
                    let t = n.transform.clone().unwrap_or_default();
                    (format!("transform: {t}"), matches!(t.as_str(), "http" | "exec").then_some("external"))
                }
                Some(NodeKind::Agent) => (format!("agent: {}", n.agent.clone().unwrap_or_default()), Some("spend")),
                Some(NodeKind::Filter) => ("filter".into(), None),
                Some(NodeKind::Route) => ("route".into(), None),
                None => (String::new(), None),
            };
            json!({ "step": s, "kind": kind, "effect": effect })
        })
        .collect()
}

fn view(i: &RerunItem) -> Value {
    json!({
        "packet_id": i.packet_id,
        "version": i.version,
        "units": i.units.iter().map(|u| u.id.clone()).collect::<Vec<_>>(),
    })
}

fn commit(r: &Runner, items: &[RerunItem], from: &str, by: &str) -> Result<(), ControlError> {
    if items.is_empty() {
        return Ok(());
    }
    let name = r.pipeline().name.clone();
    r.journal.borrow_mut().rerun(items, from, by).map_err(|e| {
        ControlError::new("invalid_state", e.to_string(), format!("list the packets again: pipo packets {name}"))
    })?;
    r.requeue(items.iter().flat_map(|i| i.units.iter().map(|u| u.id.clone())).collect());
    Ok(())
}

/// Settled packets (ids), newest first, received at or after `since` (ms).
fn candidates(r: &Runner, since: Option<i64>) -> Result<Vec<String>, ControlError> {
    let j = r.journal.borrow();
    let mut stmt = j
        .db()
        .prepare(
            "SELECT id FROM packets WHERE branch = '' AND state IN ('delivered', 'filtered') AND received_at >= ?
             ORDER BY id DESC",
        )
        .map_err(internal)?;
    let ids = stmt
        .query_map([since.unwrap_or(i64::MIN)], |row| row.get(0))
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;
    Ok(ids)
}

pub async fn handle(r: &Runner, args: &Map<String, Value>, by: &str) -> Result<Value, ControlError> {
    let name = r.pipeline().name.clone();
    let a = parse(args)?;
    let (cursor, _) = steps_of(&a.from);
    let current = r.plan(r.version()).await.map_err(internal)?;
    if cursor != OUTPUT_STEP && current.pipeline.nodes.get(cursor).is_none() && a.current {
        let nodes: Vec<&str> = current.pipeline.nodes.iter().map(|(n, _)| n.as_str()).collect();
        return Err(ControlError::new(
            "bad_request",
            format!("v{} of {name} has no node '{}'", r.version(), a.from),
            format!("rerun from one of: {}, output", nodes.join(", ")),
        ));
    }
    let mut packets = vec![];
    let mut skipped = vec![];
    let (mut count, mut skipped_count) = (0, 0);
    match &a.select {
        Select::Ids(ids) => {
            // All or nothing: one packet that can't rerun refuses the request.
            let mut items = vec![];
            for id in ids {
                let row = r.journal.borrow().get(id).map_err(internal)?.ok_or_else(|| {
                    ControlError::new(
                        "not_found",
                        format!("no packet '{id}' in {name}"),
                        format!("list them with pipo packets {name}"),
                    )
                })?;
                if let Some(root) = &row.root {
                    return Err(ControlError::new(
                        "invalid_state",
                        format!("{id} is a branch copy of {root}"),
                        format!("rerun {root} instead: it reruns the copies that passed '{}'", a.from),
                    ));
                }
                match plan_one(r, &row, &a).await? {
                    Ok(item) => items.push(item),
                    Err(why) => {
                        let mut e = ControlError::new(
                            "invalid_state",
                            format!("packet {id} can't rerun from '{}': {why}", a.from),
                            "nothing was rerun; leave it out, or pick another node",
                        );
                        e.packet_id = Some(id.clone());
                        return Err(e);
                    }
                }
            }
            if !a.dry {
                commit(r, &items, &a.from, by)?;
            }
            count = items.len();
            packets = items.iter().take(LISTED).map(view).collect();
        }
        Select::Recent { last, since } => {
            // A snapshot: a packet that settles while this runs is not picked up.
            let ids = candidates(r, since.map(|s| now_ms() - s))?;
            let mut items = vec![];
            for id in &ids {
                if last.is_some_and(|n| count + items.len() >= n) {
                    break;
                }
                let Some(row) = r.journal.borrow().get(id).map_err(internal)? else { continue };
                match plan_one(r, &row, &a).await? {
                    Ok(item) => items.push(item),
                    Err(why) => {
                        skipped_count += 1;
                        if skipped.len() < LISTED {
                            skipped.push(json!({ "packet_id": row.id, "reason": why }));
                        }
                    }
                }
                if items.len() == CHUNK {
                    if !a.dry {
                        commit(r, &items, &a.from, by)?;
                    }
                    count += items.len();
                    packets.extend(items.drain(..).take(LISTED.saturating_sub(packets.len())).map(|i| view(&i)));
                    tokio::task::yield_now().await;
                }
            }
            if !a.dry {
                commit(r, &items, &a.from, by)?;
            }
            count += items.len();
            packets.extend(items.iter().take(LISTED.saturating_sub(packets.len())).map(view));
        }
    }
    Ok(json!({
        "from": a.from,
        "current": a.current,
        "dry": a.dry,
        "rerun": count,
        "packets": packets,
        "skipped": skipped,
        "skipped_count": skipped_count,
        "path": path(&current, cursor),
    }))
}
