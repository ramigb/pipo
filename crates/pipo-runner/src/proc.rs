// Run a program to its exit (docs/spec.md D67, D71). Port of `runCli` in agents/cli.ts, shared by CLI agents and
// exec steps: stdin from a file, stdout and stderr to files read after the exit (no pipe to drain), its own process
// group, SIGTERMed whole on timeout or abort and SIGKILLed 2 s later.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::rc::Rc;
use std::time::Duration;
use tokio::sync::Notify;

#[derive(Debug, Clone, PartialEq)]
pub struct CliRun {
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Default, Clone)]
pub struct RunOptions {
    pub stdin: Option<String>,
    /// Where the process runs; the run's own folder when not given.
    pub cwd: Option<PathBuf>,
    /// Aborts the run when notified (an agent call's timeout).
    pub abort: Option<Rc<Notify>>,
    pub timeout_ms: Option<u64>,
    /// The folder for the stdin/stdout/stderr files; a temp folder, removed afterwards, when not given.
    pub dir: Option<PathBuf>,
    /// Added to the runner's environment.
    pub env: HashMap<String, String>,
}

fn temp_dir() -> std::io::Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("pipo-cli-{}", crate::ids::ulid().to_lowercase()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn signal_group(pid: Option<u32>, sig: libc::c_int) {
    if let Some(pid) = pid.filter(|p| *p > 0) {
        // SAFETY: a negative pid signals the child's own process group, created with process_group(0).
        unsafe {
            libc::kill(-(pid as libc::pid_t), sig);
        }
    }
}

fn signal_name(sig: i32) -> String {
    match sig {
        libc::SIGTERM => "SIGTERM".into(),
        libc::SIGKILL => "SIGKILL".into(),
        libc::SIGINT => "SIGINT".into(),
        libc::SIGHUP => "SIGHUP".into(),
        libc::SIGSEGV => "SIGSEGV".into(),
        libc::SIGABRT => "SIGABRT".into(),
        libc::SIGPIPE => "SIGPIPE".into(),
        n => format!("signal {n}"),
    }
}

/// Run `command` to its exit. Errs only when it can't be started.
pub async fn run_cli(command: &str, args: &[String], o: RunOptions) -> Result<CliRun, String> {
    let own = o.dir.is_none();
    let dir = match &o.dir {
        Some(d) => d.clone(),
        None => temp_dir().map_err(|e| format!("can't make a temp folder: {e}"))?,
    };
    let result = run_in(command, args, &o, &dir).await;
    if own {
        let _ = std::fs::remove_dir_all(&dir);
    }
    result
}

async fn run_in(command: &str, args: &[String], o: &RunOptions, dir: &Path) -> Result<CliRun, String> {
    use std::os::unix::process::ExitStatusExt;
    let (p_in, p_out, p_err) = (dir.join("stdin"), dir.join("stdout"), dir.join("stderr"));
    let io = |e: std::io::Error| e.to_string();
    std::fs::write(&p_in, o.stdin.as_deref().unwrap_or("")).map_err(io)?;
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(args)
        .current_dir(o.cwd.as_deref().unwrap_or(dir))
        .stdin(Stdio::from(std::fs::File::open(&p_in).map_err(io)?))
        .stdout(Stdio::from(std::fs::File::create(&p_out).map_err(io)?))
        .stderr(Stdio::from(std::fs::File::create(&p_err).map_err(io)?))
        .envs(&o.env)
        .process_group(0)
        .kill_on_drop(false);
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { format!("spawn {command} ENOENT") } else { format!("spawn {command}: {e}") }
    })?;
    let pid = child.id();
    let deadline = async {
        match o.timeout_ms {
            Some(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
            None => std::future::pending().await,
        }
    };
    let aborted = async {
        match &o.abort {
            Some(n) => n.notified().await,
            None => std::future::pending().await,
        }
    };
    let status = tokio::select! {
        s = child.wait() => s,
        _ = deadline => kill_then_wait(&mut child, pid).await,
        _ = aborted => kill_then_wait(&mut child, pid).await,
    }
    .map_err(io)?;
    // Whatever the program left running in its group (MCP servers, shells) goes with it.
    signal_group(pid, libc::SIGTERM);
    let read = |p: &Path| std::fs::read(p).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    Ok(CliRun {
        code: status.code(),
        signal: status.signal().map(signal_name),
        stdout: read(&p_out),
        stderr: read(&p_err),
    })
}

async fn kill_then_wait(child: &mut tokio::process::Child, pid: Option<u32>) -> std::io::Result<std::process::ExitStatus> {
    signal_group(pid, libc::SIGTERM);
    match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
        Ok(s) => s,
        Err(_) => {
            signal_group(pid, libc::SIGKILL);
            child.wait().await
        }
    }
}

/// The last `n` characters of a program's output, on one line, for an error message.
pub fn tail(text: &str, n: usize) -> String {
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = t.chars().count();
    if count > n { format!("…{}", t.chars().skip(count - n).collect::<String>()) } else { t }
}

pub fn exit_text(label: &str, run: &CliRun) -> String {
    let how = match &run.signal {
        Some(s) => format!("was killed ({s})"),
        None => format!("exited with code {}", run.code.map(|c| c.to_string()).unwrap_or_else(|| "null".into())),
    };
    let why = Some(tail(&run.stderr, 300)).filter(|s| !s.is_empty()).unwrap_or_else(|| tail(&run.stdout, 300));
    if why.is_empty() { format!("{label} {how}") } else { format!("{label} {how}: {why}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn runs_and_times_out() {
        let r = run_cli("sh", &["-c".into(), "cat; echo err >&2; exit 3".into()], RunOptions { stdin: Some("hi".into()), ..Default::default() }).await.unwrap();
        assert_eq!((r.code, r.stdout.as_str(), r.stderr.as_str()), (Some(3), "hi", "err\n"));
        let r = run_cli("sleep", &["5".into()], RunOptions { timeout_ms: Some(100), ..Default::default() }).await.unwrap();
        assert_eq!(r.signal.as_deref(), Some("SIGTERM"));
        assert!(run_cli("pipo-no-such-command", &[], RunOptions::default()).await.unwrap_err().contains("ENOENT"));
    }
}
