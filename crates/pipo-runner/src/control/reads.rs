// Packet, version and proposal reads (docs/spec.md §6, §8, D33). Port of control/reads.ts. Interface for the ops;
// the bodies come with the reads port.

use super::ControlError;
use rusqlite::Connection;
use serde_json::{Map, Value};

pub const READ_OPS: &[&str] = &["packets", "packet", "dlq", "versions", "version", "diff", "proposals", "proposal"];

/// Answer a read op from the journal.
pub fn read(_db: &Connection, op: &str, _args: &Map<String, Value>, _pipeline: &str, _version: i64) -> Result<Value, ControlError> {
    Err(ControlError::new("unavailable", format!("'{op}' is not ported to the Rust runner yet"), "see docs/rust-runner.md"))
}
