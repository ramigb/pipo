// Change proposals (docs/spec.md §9.3, D45–D51). Port of proposals.ts. Interface for the runner; bodies come with
// the proposals port.

use crate::control::ControlError;
use serde_json::Value;

/// The store of change proposals in the pipeline's journal.
pub struct Proposals {}

impl Proposals {
    pub fn new() -> Proposals {
        Proposals {}
    }
    pub async fn propose(&self, _runner: &crate::runner::Runner, _input: &Value) -> Result<Value, ControlError> {
        Err(ControlError::new("invalid_state", "proposals are not ported to the Rust runner yet", "see docs/rust-runner.md"))
    }
    pub fn get(&self, _runner: &crate::runner::Runner, id: &str) -> Result<Value, ControlError> {
        Err(ControlError::new("not_found", format!("no proposal '{id}'"), "proposals are not ported yet"))
    }
    pub fn mark_rejected(&self, _runner: &crate::runner::Runner, id: &str, _by: &str, _reason: &str) -> Result<Value, ControlError> {
        Err(ControlError::new("not_found", format!("no proposal '{id}'"), "proposals are not ported yet"))
    }
    pub async fn dry_run_if_required(&self, _runner: &crate::runner::Runner, id: &str) -> Result<Value, ControlError> {
        Err(ControlError::new("not_found", format!("no proposal '{id}'"), "proposals are not ported yet"))
    }
}

impl Default for Proposals {
    fn default() -> Self {
        Self::new()
    }
}
