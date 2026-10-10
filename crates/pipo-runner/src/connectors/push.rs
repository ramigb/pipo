// `via: push` (docs/spec.md §3.3, D24) and `via: pipeline` (§3.14, D77): no listener of their own. Packets arrive
// only through the runner's control socket (`push` and `deliver` ops), which journals them before replying.

use super::{InputAdapter, InputRuntime, Intake, LocalBoxFuture};

pub struct PushInput;

impl InputAdapter for PushInput {
    fn start(&self, _intake: Intake, _runtime: InputRuntime) -> LocalBoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn stop(&self) -> LocalBoxFuture<'_, ()> {
        Box::pin(async {})
    }
    fn describe(&self) -> String {
        "push (control socket)".into()
    }
}

/// `via: pipeline`: fed by other pipelines' `to: pipeline` outputs through the `deliver` op; `from` lists who may.
pub struct PipelineInput {
    pub from: Vec<String>,
}

impl InputAdapter for PipelineInput {
    fn start(&self, _intake: Intake, _runtime: InputRuntime) -> LocalBoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn stop(&self) -> LocalBoxFuture<'_, ()> {
        Box::pin(async {})
    }
    fn describe(&self) -> String {
        format!("from pipeline {}", self.from.join(", "))
    }
}
