// Shapes of a parsed .pipo file (docs/spec.md §3), as `pipo compile` hands them over: `load()`'s value, already
// checked. Mirrors packages/spec/src/types.ts. Unknown keys are kept out of these structs on purpose: the JSON
// Schema is the validator, and `with:` blocks stay raw JSON because each connector reads its own keys.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub type With = Map<String, Value>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ErrorPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backoff: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_delay: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub then: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InvalidPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub respond: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub then: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Input {
    pub via: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub with: Option<With>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validate: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_invalid: Option<InvalidPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Loop {
    pub back_to: String,
    pub until: String,
    pub max: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub then: Option<String>,
}

/// `from:` is one ref or a list of refs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Refs {
    One(String),
    Many(Vec<String>),
}

impl Refs {
    pub fn list(&self) -> Vec<String> {
        match self {
            Refs::One(s) => vec![s.clone()],
            Refs::Many(v) => v.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    Tap,
    Transform,
    Filter,
    Route,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Node {
    pub from: Refs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tap: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<String>,
    /// Branch name → condition, in file order (`else` last).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub with: Option<With>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_error: Option<ErrorPolicy>,
    #[serde(default, rename = "loop", skip_serializing_if = "Option::is_none")]
    pub loop_: Option<Loop>,
}

impl Node {
    /// The kind key the node declares (`nodeKind` in @pipo/spec): the first of tap, transform, filter, route, agent.
    pub fn kind(&self) -> Option<NodeKind> {
        if self.tap.is_some() {
            Some(NodeKind::Tap)
        } else if self.transform.is_some() {
            Some(NodeKind::Transform)
        } else if self.filter.is_some() {
            Some(NodeKind::Filter)
        } else if self.route.is_some() {
            Some(NodeKind::Route)
        } else if self.agent.is_some() {
            Some(NodeKind::Agent)
        } else {
            None
        }
    }

    /// The route's branches in file order, each condition as a string.
    pub fn routes(&self) -> Vec<(String, String)> {
        self.route
            .as_ref()
            .map(|r| {
                r.iter()
                    .map(|(k, v)| (k.clone(), v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string())))
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Batch {
    pub size: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub within: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Output {
    pub from: Refs,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch: Option<Batch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub with: Option<With>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validate: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_invalid: Option<InvalidPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_error: Option<ErrorPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Stall {
    pub after: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub then: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Delivered {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub with: Option<With>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub within: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_fail: Option<ErrorPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stall: Option<Stall>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Lifetime {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_packets: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_end: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drain_timeout: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redact: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_stall: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentBudget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_day: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_packet: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warn_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Retention {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rejected: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dlq: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Buffer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Pipeline {
    pub pipo: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fn_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secrets: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifetime: Option<Lifetime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concurrency: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub buffer: Option<Buffer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub errors: Option<ErrorPolicy>,
    pub input: Input,
    /// Node id → node, in file order.
    #[serde(default)]
    pub nodes: indexmap_like::Nodes,
    pub output: Output,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered: Option<Delivered>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_budget: Option<AgentBudget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retention: Option<Retention>,
}

pub mod indexmap_like {
    //! Nodes in file order. serde_json's `preserve_order` keeps object order; this wraps it with typed nodes.
    use super::Node;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use serde_json::{Map, Value};

    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct Nodes(pub Vec<(String, Node)>);

    impl Nodes {
        pub fn get(&self, id: &str) -> Option<&Node> {
            self.0.iter().find(|(k, _)| k == id).map(|(_, n)| n)
        }
        pub fn iter(&self) -> impl Iterator<Item = (&String, &Node)> {
            self.0.iter().map(|(k, n)| (k, n))
        }
        pub fn is_empty(&self) -> bool {
            self.0.is_empty()
        }
        pub fn len(&self) -> usize {
            self.0.len()
        }
    }

    impl Serialize for Nodes {
        fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            let mut m = Map::new();
            for (k, n) in &self.0 {
                m.insert(k.clone(), serde_json::to_value(n).map_err(serde::ser::Error::custom)?);
            }
            m.serialize(s)
        }
    }

    impl<'de> Deserialize<'de> for Nodes {
        fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            let m = Option::<Map<String, Value>>::deserialize(d)?.unwrap_or_default();
            let mut out = Vec::with_capacity(m.len());
            for (k, v) in m {
                let n: Node =
                    serde_json::from_value(v).map_err(|e| serde::de::Error::custom(format!("nodes.{k}: {e}")))?;
                out.push((k, n));
            }
            Ok(Nodes(out))
        }
    }
}

impl Pipeline {
    /// Parse `load()`'s value. `fn` is renamed by hand since it is a Rust keyword.
    pub fn from_value(mut v: Value) -> Result<Pipeline, String> {
        if let Some(obj) = v.as_object_mut()
            && let Some(f) = obj.remove("fn")
        {
            obj.insert("fn_".into(), f);
        }
        serde_json::from_value(v).map_err(|e| format!("pipeline does not match the runner's model: {e}"))
    }

    /// Back to the shape `load()` gives (`fn`, not `fn_`): what `meta`, the dry run and control replies show.
    pub fn to_value(&self) -> Value {
        let mut v = serde_json::to_value(self).expect("pipeline serializes");
        if let Some(obj) = v.as_object_mut()
            && let Some(f) = obj.remove("fn_")
        {
            obj.insert("fn".into(), f);
        }
        v
    }

    pub fn concurrency(&self) -> u32 {
        self.concurrency.unwrap_or(4)
    }
}

/// `fn.<name>` references (FN_REF in @pipo/spec): the export name, when `action` is one.
pub fn fn_ref(action: &str) -> Option<&str> {
    let name = action.strip_prefix("fn.")?;
    let mut chars = name.chars();
    let first = chars.next()?;
    if !(first.is_ascii_alphabetic() || first == '_' || first == '$') {
        return None;
    }
    if chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$') { Some(name) } else { None }
}
