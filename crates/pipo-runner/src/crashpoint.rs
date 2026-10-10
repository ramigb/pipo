// Test-only crash points for the SIGKILL tests of docs/spec.md §7.3 (D49). Port of crashpoint.ts: with
// `PIPO_TEST_CRASH_AT=<name>` in its environment, the runner SIGKILLs itself at that point. Unset, it does nothing.

use std::sync::OnceLock;

fn at() -> Option<&'static str> {
    static AT: OnceLock<Option<String>> = OnceLock::new();
    AT.get_or_init(|| std::env::var("PIPO_TEST_CRASH_AT").ok().filter(|s| !s.is_empty())).as_deref()
}

/// Named points: `apply.prepared`, `apply.in_transaction`, `apply.committed`, `escalate.prepared`,
/// `resolve.committed`, `dryrun.replayed`, `dryrun.decided`.
pub fn crash_point(name: &str) {
    if at() != Some(name) {
        return;
    }
    // SAFETY: SIGKILL to our own pid; it can't be caught, so nothing after it runs.
    unsafe {
        libc::kill(libc::getpid(), libc::SIGKILL);
    }
    loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}
