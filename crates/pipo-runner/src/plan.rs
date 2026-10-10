// Compile a checked version into what the runner executes (docs/spec.md §7.3). Port of plan.ts: the step graph,
// the input-schema and agent-schema validators, and the version's fn module loaded into the QuickJS host. One plan
// per pipeline version, so in-flight packets finish on the version that accepted them, with its own code.

use crate::compile::Compiled;
use crate::journal::OUTPUT_STEP;
use crate::jsfn::JsFns;
use crate::pipeline::{Pipeline, fn_ref};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

pub struct SchemaCheck {
    pub path: String,
    pub schema: Value,
    validator: jsonschema::Validator,
    /// How many errors a mismatch reports (the input check reports the first; agent output up to three).
    limit: usize,
}

impl SchemaCheck {
    /// `$schema` is dropped, so draft-07 and 2020-12 files both load.
    pub fn new(path: &str, schema: &Value, limit: usize) -> Result<SchemaCheck, String> {
        let mut bare = schema.clone();
        if let Some(o) = bare.as_object_mut() {
            o.remove("$schema");
        }
        let validator = jsonschema::validator_for(&bare).map_err(|e| e.to_string())?;
        Ok(SchemaCheck { path: path.to_string(), schema: schema.clone(), validator, limit })
    }

    /// None when `data` matches; otherwise `<path or "data"> <message>` per error, joined with `; `.
    pub fn check(&self, data: &Value) -> Option<String> {
        let errors: Vec<String> = self
            .validator
            .iter_errors(data)
            .take(self.limit)
            .map(|e| {
                let at = e.instance_path().to_string();
                format!("{} {}", if at.is_empty() { "data" } else { at.as_str() }, e)
            })
            .collect();
        if errors.is_empty() { None } else { Some(errors.join("; ")) }
    }
}

pub struct Plan {
    pub version: i64,
    pub pipeline: Rc<Pipeline>,
    /// Source ref (an input name, node id, `route.branch`) → the steps that consume it, in file order (nodes, then
    /// the output). More than one is a fan-out: each consumer gets its own copy (spec §3.4, D22).
    pub next: HashMap<String, Vec<String>>,
    /// `fn.<name>` refs this version uses; the code lives in the JsFns host under this version's number.
    pub fns: HashSet<String>,
    /// Input name → its `schema` check, for the inputs that declare one (§3.3.1).
    pub input_schemas: HashMap<String, SchemaCheck>,
    /// Agent node id → its output schema (`with.schema`, spec §3.4).
    pub agent_schemas: HashMap<String, SchemaCheck>,
    /// The fn module's hash as compiled, and its path as written (D60).
    pub fn_hash: Option<String>,
    pub compiled: Rc<Compiled>,
}

impl Plan {
    pub fn next_of(&self, reference: &str) -> &[String] {
        self.next.get(reference).map(Vec::as_slice).unwrap_or(&[])
    }
}

/// Build a plan from a compiled version, loading its fn module into `fns` when it has one.
pub async fn build(version: i64, compiled: Rc<Compiled>, fns: &JsFns) -> Result<Plan, String> {
    let value = compiled.pipeline.clone().ok_or("the version has errors and can't run")?;
    let pipeline = Rc::new(Pipeline::from_value(value)?);
    let mut next: HashMap<String, Vec<String>> = HashMap::new();
    let mut link = |reference: String, step: &str| {
        let list = next.entry(reference).or_default();
        if !list.iter().any(|s| s == step) {
            list.push(step.to_string());
        }
    };
    for (id, node) in pipeline.nodes.iter() {
        for r in node.from.list() {
            link(r, id);
        }
    }
    for r in pipeline.output.from.list() {
        link(r, OUTPUT_STEP);
    }

    let used: HashSet<String> = pipeline
        .nodes
        .iter()
        .flat_map(|(_, n)| [n.tap.clone(), n.transform.clone()])
        .flatten()
        .filter(|a| fn_ref(a).is_some())
        .collect();
    if !used.is_empty() {
        let module = compiled.fn_module.as_ref().ok_or("pipeline uses fn.* but declares no fn module")?;
        for r in &used {
            let name = fn_ref(r).unwrap_or_default();
            if !module.exports.iter().any(|e| e == name) {
                return Err(format!("{} does not export a function '{name}'", module.path));
            }
        }
        fns.load(version as u32, module).await?;
    }

    let schema =
        |path: &str| compiled.schemas.get(path).cloned().ok_or_else(|| format!("schema {path} was not compiled"));
    let mut input_schemas = HashMap::new();
    for (name, input) in pipeline.inputs() {
        if let Some(path) = &input.schema {
            let check = SchemaCheck::new(path, &schema(path)?, 1)
                .map_err(|e| format!("{}.schema {path} can't be used: {e}", pipeline.input_path(name)))?;
            input_schemas.insert(name.to_string(), check);
        }
    }
    let mut agent_schemas = HashMap::new();
    for (id, node) in pipeline.nodes.iter() {
        if node.agent.is_none() {
            continue;
        }
        let path = node.with.as_ref().and_then(|w| w.get("schema")).map(crate::expr::to_text).unwrap_or_default();
        let check = schema(&path)
            .and_then(|s| SchemaCheck::new(&path, &s, 3))
            .map_err(|e| format!("agent node '{id}': schema {path} can't be used: {e}"))?;
        agent_schemas.insert(id.clone(), check);
    }
    Ok(Plan {
        version,
        pipeline,
        next,
        fns: used,
        input_schemas,
        agent_schemas,
        fn_hash: compiled.fn_module.as_ref().map(|m| m.hash.clone()),
        compiled,
    })
}
