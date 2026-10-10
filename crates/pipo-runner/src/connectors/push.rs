// `via: push` (docs/spec.md §3.3, D24). Port of push-input.ts: no listener of its own. Packets arrive only through
// the runner's control socket (`push` op), which journals them before replying.

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
