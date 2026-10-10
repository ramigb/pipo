// Is the process a registry entry names still that process? (docs/spec.md §7.2, D25, D27.) Port of liveness.ts: a
// pid outlives its process, so sameness is checked with the process start time from /proc on Linux.

use crate::time::parse_iso;

/// Slack between a process starting and it writing `started_at`'s clock: /proc's boot time is whole seconds.
const REUSE_SLACK_MS: i64 = 2000;

/// `/proc/<pid>/stat` fields from field 3 (state) on; None off Linux or when the process is gone.
fn proc_stat(pid: i64) -> Option<Vec<String>> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let at = stat.rfind(')')?;
    Some(stat.get(at + 2..)?.split(' ').map(str::to_owned).collect())
}

/// The pid exists (EPERM: someone else's, still alive) and is not a zombie.
pub fn pid_running(pid: i64) -> bool {
    if pid <= 0 || pid > i32::MAX as i64 {
        return false;
    }
    // SAFETY: kill with signal 0 only checks that the process exists.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if rc != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EPERM) {
        return false;
    }
    !matches!(proc_stat(pid).and_then(|f| f.first().cloned()).as_deref(), Some("Z") | Some("X"))
}

/// When `pid` started, in clock ticks since boot; None off Linux or when unknown.
pub fn proc_start(pid: i64) -> Option<i64> {
    proc_stat(pid)?.get(19)?.parse().ok()
}

pub fn own_proc_start() -> Option<i64> {
    proc_start(std::process::id() as i64)
}

/// When `pid` started (ms since the epoch), from /proc on Linux.
pub fn process_started_at(pid: i64) -> Option<i64> {
    let ticks = proc_start(pid)?;
    let stat = std::fs::read_to_string("/proc/stat").ok()?;
    let btime: i64 = stat.lines().find_map(|l| l.strip_prefix("btime "))?.trim().parse().ok()?;
    // starttime is in clock ticks since boot; USER_HZ is 100 on Linux.
    Some(btime * 1000 + ticks * 10)
}

/// True when `pid` now belongs to a process that started after `started_at` (the pid was reused).
pub fn pid_reused(pid: i64, started_at: Option<&str>) -> bool {
    match (process_started_at(pid), started_at.and_then(parse_iso)) {
        (Some(started), Some(registered)) => started > registered + REUSE_SLACK_MS,
        _ => false,
    }
}

/// The process an entry names is still running and is the same process (D27).
pub fn entry_alive(pid: i64, started_at: Option<&str>, proc_start_ticks: Option<i64>) -> bool {
    if !pid_running(pid) {
        return false;
    }
    if let Some(ticks) = proc_start_ticks {
        if let Some(now) = proc_start(pid) {
            return now == ticks;
        }
    }
    !pid_reused(pid, started_at)
}

/// `entry_alive` for a registry entry as JSON (`pid`, `started_at`, `proc_start`).
pub fn entry_alive_json(entry: &serde_json::Value) -> bool {
    let Some(pid) = entry.get("pid").and_then(|p| p.as_i64()) else { return false };
    entry_alive(pid, entry.get("started_at").and_then(|s| s.as_str()), entry.get("proc_start").and_then(|p| p.as_i64()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_process_is_alive() {
        let me = std::process::id() as i64;
        assert!(pid_running(me));
        assert!(entry_alive(me, None, own_proc_start()));
        assert!(!pid_running(0));
        assert!(!pid_running(-1));
        if let Some(t) = own_proc_start() {
            assert!(!entry_alive(me, None, Some(t + 1)));
        }
    }
}
