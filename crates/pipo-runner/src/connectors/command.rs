// `via: command` (docs/spec.md §3.3.2, D87): run a long-running program for as long as the runner runs and hand over
// each line it prints on stdout. No shell, like an exec step (D71). It runs in its own process group, stopped with
// SIGTERM and SIGKILL 2 s later. When it exits it is started again (`restart`), waiting 1 s, doubling to 60 s, back to
// 1 s once it has run for a minute. At most once: a program's output has no position to come back to.

use super::tail::{LineParse, MAX_LINE, line_data};
use super::{InputAdapter, InputRuntime, Intake, IntakeResult, LocalBoxFuture, Log, Origin, Stopper};
use crate::proc::{signal_group, signal_name};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::rc::Rc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::task::JoinHandle;

const FIRST_WAIT_MS: u64 = 1_000;
const MAX_WAIT_MS: u64 = 60_000;
/// A run this long resets the restart wait.
const HEALTHY_MS: u128 = 60_000;
const RETRY_MS: u64 = 1_000;
const CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Restart {
    Always,
    OnFailure,
    Never,
}

pub struct CommandOptions {
    /// The program, found already (a path).
    pub program: PathBuf,
    /// As written, for logs and `meta.source`.
    pub command: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub parse: LineParse,
    pub restart: Restart,
    pub log: Option<Log>,
    /// Restart waits (tests shorten them).
    pub first_wait_ms: Option<u64>,
}

struct Inner {
    o: CommandOptions,
    stop: Stopper,
    pid: RefCell<Option<u32>>,
}

pub struct CommandInput {
    inner: Rc<Inner>,
    task: RefCell<Option<JoinHandle<()>>>,
}

impl CommandInput {
    pub fn new(o: CommandOptions) -> CommandInput {
        CommandInput {
            inner: Rc::new(Inner { o, stop: Stopper::default(), pid: RefCell::new(None) }),
            task: RefCell::new(None),
        }
    }
}

impl Inner {
    fn log(&self, level: &str, message: &str) {
        if let Some(l) = &self.o.log {
            l(level, message);
        }
    }

    async fn run(self: Rc<Self>, intake: Intake) {
        let first = self.o.first_wait_ms.unwrap_or(FIRST_WAIT_MS);
        let mut wait = first;
        loop {
            let started = Instant::now();
            let (failed, how) = match self.once(&intake).await {
                Ok(r) => r,
                Err(e) => (true, e),
            };
            if self.stop.stopped() {
                return;
            }
            if started.elapsed().as_millis() >= HEALTHY_MS {
                wait = first;
            }
            let again = match self.o.restart {
                Restart::Always => true,
                Restart::OnFailure => failed,
                Restart::Never => false,
            };
            if !again {
                self.log(
                    if failed { "error" } else { "info" },
                    &format!(
                        "command {} {how}; not started again (restart: {})",
                        self.o.command,
                        match self.o.restart {
                            Restart::Never => "never",
                            _ => "on-failure",
                        }
                    ),
                );
                return;
            }
            self.log(
                if failed { "error" } else { "warn" },
                &format!("command {} {how}; starting it again in {}s", self.o.command, wait as f64 / 1000.0),
            );
            if !self.stop.sleep(wait).await {
                return;
            }
            wait = (wait * 2).min(MAX_WAIT_MS);
        }
    }

    /// One run of the program: (whether it failed, how it ended).
    async fn once(&self, intake: &Intake) -> Result<(bool, String), String> {
        let mut cmd = tokio::process::Command::new(&self.o.program);
        cmd.args(&self.o.args)
            .current_dir(&self.o.cwd)
            .envs(&self.o.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| format!("could not start: {e}"))?;
        let pid = child.id();
        *self.pid.borrow_mut() = pid;
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let last_err: Rc<RefCell<String>> = Rc::default();
        let errs = {
            let last = last_err.clone();
            let log = self.o.log.clone();
            let command = self.o.command.clone();
            async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let line: String = line.chars().take(500).collect();
                    if let Some(l) = &log {
                        l("warn", &format!("command {command}: {line}"));
                    }
                    if !line.trim().is_empty() {
                        *last.borrow_mut() = line;
                    }
                }
            }
        };
        let errs = tokio::task::spawn_local(errs);
        let read = self.read(stdout, intake);
        let stopped = tokio::select! {
            _ = read => false,
            _ = self.stop.wait() => true,
        };
        if stopped {
            signal_group(pid, libc::SIGTERM);
            if tokio::time::timeout(Duration::from_secs(2), child.wait()).await.is_err() {
                signal_group(pid, libc::SIGKILL);
                let _ = child.wait().await;
            }
            errs.abort();
            return Ok((false, "was stopped".into()));
        }
        let status = child.wait().await.map_err(|e| e.to_string())?;
        // What it left running in its group goes with it.
        signal_group(pid, libc::SIGTERM);
        let _ = tokio::time::timeout(Duration::from_millis(500), errs).await;
        use std::os::unix::process::ExitStatusExt;
        let (failed, how) = match (status.code(), status.signal()) {
            (Some(0), _) => (false, "exited with code 0".to_string()),
            (Some(c), _) => (true, format!("exited with code {c}")),
            (None, Some(s)) => (true, format!("was killed ({})", signal_name(s))),
            _ => (true, "ended".to_string()),
        };
        let why = last_err.borrow().clone();
        Ok((failed, if why.is_empty() { how } else { format!("{how}: {why}") }))
    }

    /// Hand over stdout line by line until it closes.
    async fn read(&self, stdout: tokio::process::ChildStdout, intake: &Intake) {
        let mut out = stdout;
        let mut buf = vec![0u8; CHUNK];
        let mut partial: Vec<u8> = vec![];
        let mut skipping = false;
        loop {
            let n = match out.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            partial.extend_from_slice(&buf[..n]);
            loop {
                if skipping {
                    match partial.iter().position(|b| *b == b'\n') {
                        Some(i) => {
                            partial.drain(..=i);
                            skipping = false;
                        }
                        None => {
                            partial.clear();
                            break;
                        }
                    }
                }
                let (len, used, cut) = match partial.iter().position(|b| *b == b'\n') {
                    Some(i) if i <= MAX_LINE => (i, i + 1, false),
                    Some(_) => (MAX_LINE, MAX_LINE, true),
                    None if partial.len() > MAX_LINE => (MAX_LINE, MAX_LINE, true),
                    None => break,
                };
                let line: Vec<u8> = partial.drain(..used).take(len).collect();
                skipping = cut;
                if !self.send(&line, cut, intake).await {
                    return;
                }
            }
        }
        if !partial.is_empty() && !skipping {
            self.send(&partial, false, intake).await;
        }
    }

    /// False when stopped while waiting for room.
    async fn send(&self, line: &[u8], cut: bool, intake: &Intake) -> bool {
        let data = match line_data(line, cut, self.o.parse, None) {
            Ok(d) => d,
            Err(e) => {
                self.log("warn", &format!("command {}: {e}", self.o.command));
                return true;
            }
        };
        loop {
            let origin = Origin { trigger: "command".into(), source: self.o.command.clone() };
            match intake(data.clone(), origin, None).await {
                // The program blocks on its next write meanwhile: stdout isn't read until there is room.
                IntakeResult::Unavailable { .. } => {
                    if !self.stop.sleep(RETRY_MS).await {
                        return false;
                    }
                }
                _ => return true,
            }
        }
    }
}

impl InputAdapter for CommandInput {
    fn start(&self, intake: Intake, _runtime: InputRuntime) -> LocalBoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.inner.stop.reset();
            *self.task.borrow_mut() = Some(tokio::task::spawn_local(self.inner.clone().run(intake)));
            Ok(())
        })
    }

    fn stop(&self) -> LocalBoxFuture<'_, ()> {
        Box::pin(async move {
            self.inner.stop.stop();
            let task = self.task.borrow_mut().take();
            if let Some(t) = task {
                let _ = t.await;
            }
        })
    }

    fn describe(&self) -> String {
        let args =
            if self.inner.o.args.is_empty() { String::new() } else { format!(" {}", self.inner.o.args.join(" ")) };
        format!("command {}{args}", self.inner.o.command)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::test_util::*;
    use serde_json::{Value, json};
    use std::cell::Cell;

    fn sh(script: &str, parse: LineParse, restart: Restart, logs: Option<Rc<RefCell<Vec<String>>>>) -> CommandInput {
        let log: Option<Log> =
            logs.map(|l| Rc::new(move |level: &str, m: &str| l.borrow_mut().push(format!("{level}: {m}"))) as Log);
        CommandInput::new(CommandOptions {
            program: PathBuf::from("/bin/sh"),
            command: "sh".into(),
            args: vec!["-c".into(), script.into()],
            cwd: std::env::temp_dir(),
            env: HashMap::from([("GREETING".into(), "hi".into())]),
            parse,
            restart,
            log,
            first_wait_ms: Some(30),
        })
    }

    #[test]
    fn each_stdout_line_is_a_packet_and_stderr_is_logged() {
        local(async {
            let logs: Rc<RefCell<Vec<String>>> = Rc::default();
            let input = sh(
                "echo $GREETING; printf 'a\\nb'; echo oops >&2; exit 3",
                LineParse::Text,
                Restart::Never,
                Some(logs.clone()),
            );
            let dir = TempDir::new();
            let (intake, got) = recording_intake(accepted);
            input.start(intake, runtime(&dir)).await.unwrap();
            wait_for(|| logs.borrow().iter().any(|l| l.contains("not started again")), 5000, "the exit").await;
            input.stop().await;
            let data: Vec<Value> = got.borrow().iter().map(|(d, _)| d.clone()).collect();
            assert_eq!(data, vec![json!({ "line": "hi" }), json!({ "line": "a" }), json!({ "line": "b" })]);
            assert_eq!((got.borrow()[0].1.trigger.as_str(), got.borrow()[0].1.source.as_str()), ("command", "sh"));
            let logs = logs.borrow();
            assert!(logs.contains(&"warn: command sh: oops".to_string()), "{logs:?}");
            assert!(
                logs.iter()
                    .any(|l| l == "error: command sh exited with code 3: oops; not started again (restart: never)"),
                "{logs:?}"
            );
            assert_eq!(input.describe(), "command sh -c echo $GREETING; printf 'a\\nb'; echo oops >&2; exit 3");
        });
    }

    #[test]
    fn restarts_with_backoff_and_on_failure_stops_after_a_clean_exit() {
        local(async {
            let input = sh("echo '{\"n\":1}'; echo nope", LineParse::Json, Restart::Always, None);
            let dir = TempDir::new();
            let (intake, got) = recording_intake(accepted);
            input.start(intake, runtime(&dir)).await.unwrap();
            wait_for(|| got.borrow().len() >= 3, 5000, "three runs").await;
            input.stop().await;
            assert!(got.borrow().iter().all(|(d, _)| *d == json!({ "n": 1 })), "a line that isn't JSON is skipped");

            let logs: Rc<RefCell<Vec<String>>> = Rc::default();
            let input = sh("echo once", LineParse::Text, Restart::OnFailure, Some(logs.clone()));
            let (intake, got) = recording_intake(accepted);
            input.start(intake, runtime(&dir)).await.unwrap();
            wait_for(|| logs.borrow().iter().any(|l| l.contains("not started again")), 5000, "the clean exit").await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            input.stop().await;
            assert_eq!(got.borrow().len(), 1);
            assert!(logs.borrow()[0].starts_with("info: command sh exited with code 0"));
        });
    }

    #[test]
    fn stop_ends_the_program_and_a_full_buffer_holds_its_output() {
        local(async {
            let dir = TempDir::new();
            let marker = dir.join("still-running");
            let script = format!(
                "trap 'rm -f {0}; exit 0' TERM; touch {0}; i=0; while true; do i=$((i+1)); echo $i; sleep 0.01; done",
                marker.display()
            );
            let input = sh(&script, LineParse::Text, Restart::Always, None);
            let open = Rc::new(Cell::new(false));
            let (intake, got) = journaling_intake(&runtime(&dir), open.clone());
            input.start(intake, runtime(&dir)).await.unwrap();
            wait_for(|| marker.exists(), 5000, "the program").await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert!(got.borrow().is_empty());
            open.set(true);
            wait_for(|| got.borrow().len() >= 5, 5000, "lines once there is room").await;
            input.stop().await;
            assert_eq!(got.borrow()[0].0, json!({ "line": "1" }), "the held line is sent first");
            wait_for(|| !marker.exists(), 5000, "the program to end on SIGTERM").await;
        });
    }
}
