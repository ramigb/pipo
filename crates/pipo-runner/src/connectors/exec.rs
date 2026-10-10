// `tap: exec` and `transform: exec` (docs/spec.md §3.4, D71). Port of exec.ts: run a program installed on this
// machine. No shell: the rendered `args` go to the program as they are. It runs like a CLI agent (D67, `run_cli`):
// its own process group, stdin from a file, stdout and stderr to files read after it exits, the whole group killed on
// `timeout`. Relative paths (`command` with a slash, `cwd`) resolve against the pipeline file's folder; `outputs` against `cwd`.
// A crash before the step commits runs the program again, so output paths keyed on `${meta.packet_id}` make a rerun
// overwrite rather than duplicate.

use super::{LocalBoxFuture, StepAdapter, StepInput, StepResult, as_i64, resolve_path, string_of};
use crate::duration::parse_duration;
use crate::proc::{RunOptions, run_cli};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;

const DEFAULT_TIMEOUT: &str = "5m";
/// How much of stdout and stderr `result: info` keeps (the end of each).
const KEEP: usize = 64 * 1024;
/// The most stdout `result: text | json` takes; bigger results belong in a file listed in `outputs`.
const MAX_STDOUT: usize = 1024 * 1024;

/// The last `n` characters of `s`.
fn tail(s: &str, n: usize) -> String {
    let count = s.chars().count();
    if count > n { s.chars().skip(count - n).collect() } else { s.to_string() }
}

pub struct ExecStep {
    pub dir: PathBuf,
    pub transform: bool,
    pub redact: Rc<dyn Fn(&str) -> String>,
}

impl ExecStep {
    async fn exec(&self, i: StepInput) -> Result<StepResult, String> {
        let w = &i.with;
        let at = format!("nodes.{}.with", i.node);
        let command = w.get("command").map(string_of).unwrap_or_default();
        if command.is_empty() {
            return Err(format!("{at}.command is empty after rendering; check the template"));
        }
        let args: Vec<String> =
            w.get("args").and_then(|a| a.as_array()).map(|a| a.iter().map(string_of).collect()).unwrap_or_default();
        let cwd = match w.get("cwd").filter(|c| super::truthy(c)) {
            Some(c) => resolve_path(&self.dir, &string_of(c)),
            None => self.dir.clone(),
        };
        if !cwd.exists() {
            let given = w.get("cwd").map(string_of).unwrap_or_default();
            return Err(format!("{at}.cwd '{given}' does not exist; create it or fix the path"));
        }
        let outputs: Vec<PathBuf> = w
            .get("outputs")
            .and_then(|o| o.as_array())
            .map(|a| a.iter().map(|o| resolve_path(&cwd, &string_of(o))).collect())
            .unwrap_or_default();
        for o in &outputs {
            if let Some(parent) = o.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("{at}.outputs: can't create {}: {e}", parent.display()))?;
            }
        }
        let env: HashMap<String, String> = w
            .get("env")
            .and_then(|e| e.as_object())
            .map(|e| e.iter().map(|(k, v)| (k.clone(), string_of(v))).collect())
            .unwrap_or_default();
        let success: Vec<i64> = match w.get("success").and_then(|s| s.as_array()) {
            Some(a) => a.iter().filter_map(as_i64).collect(),
            None => vec![0],
        };
        let timeout =
            w.get("timeout").filter(|t| !t.is_null()).map(string_of).unwrap_or_else(|| DEFAULT_TIMEOUT.into());
        let timeout_ms = parse_duration(&timeout)?;
        // A path is the pipeline folder's (D71), whatever `cwd` is.
        let program = if command.contains('/') {
            resolve_path(&self.dir, &command).display().to_string()
        } else {
            command.clone()
        };

        let started = std::time::Instant::now();
        let options = RunOptions {
            stdin: Some(w.get("stdin").filter(|s| !s.is_null()).map(string_of).unwrap_or_default()),
            cwd: Some(cwd),
            timeout_ms: Some(timeout_ms),
            env,
            ..Default::default()
        };
        let run = run_cli(&program, &args, options).await.map_err(|e| {
            let hint = if command.contains('/') { "check the path" } else { "is it installed and on PATH?" };
            format!("{at}.command '{command}' could not be started ({e}); {hint}")
        })?;
        let duration_ms = started.elapsed().as_millis() as u64;
        let ok = run.signal.is_none() && run.code.is_some_and(|c| success.contains(&(c as i64)));
        if !ok {
            let how = match &run.signal {
                Some(sig) => {
                    let timed_out = if duration_ms >= timeout_ms {
                        format!(", after the {timeout} timeout")
                    } else {
                        String::new()
                    };
                    format!("was killed ({sig}{timed_out})")
                }
                None => {
                    format!("exited with code {}", run.code.map(|c| c.to_string()).unwrap_or_else(|| "null".into()))
                }
            };
            let source = if run.stderr.trim().is_empty() { run.stdout.trim() } else { run.stderr.trim() };
            let why = tail(source, 500).split_whitespace().collect::<Vec<_>>().join(" ");
            let why = if why.is_empty() { String::new() } else { format!(": {}", (self.redact)(&why)) };
            return Err(format!("{command} {how}{why}"));
        }
        let code = run.code.unwrap_or(0);
        let missing: Vec<String> = outputs.iter().filter(|o| !o.exists()).map(|o| o.display().to_string()).collect();
        if !missing.is_empty() {
            return Err(format!(
                "{command} exited with code {code} but did not write {} ({at}.outputs)",
                missing.join(", ")
            ));
        }
        if !self.transform {
            return Ok(StepResult::default());
        }
        let result = w.get("result").and_then(|r| r.as_str()).unwrap_or("info");
        if result == "info" {
            let files: Vec<String> = outputs.iter().map(|o| o.display().to_string()).collect();
            let data = json!({
                "exit_code": code,
                "stdout": (self.redact)(&tail(&run.stdout, KEEP)),
                "stderr": (self.redact)(&tail(&run.stderr, KEEP)),
                "duration_ms": duration_ms,
                "files": files,
            });
            return Ok(StepResult { data: Some(data), events: vec![] });
        }
        if run.stdout.len() > MAX_STDOUT {
            return Err(format!(
                "{command} wrote {} bytes to stdout, over the 1 MB limit for result: {result}; write it to a file listed in {at}.outputs and use result: info",
                run.stdout.len()
            ));
        }
        let stdout = (self.redact)(&run.stdout);
        if result == "text" {
            return Ok(StepResult { data: Some(Value::String(stdout)), events: vec![] });
        }
        match serde_json::from_str::<Value>(&stdout) {
            Ok(v) => Ok(StepResult { data: Some(v), events: vec![] }),
            Err(_) => Err(format!(
                "{command} printed something that is not JSON ({at}.result is json): {}",
                tail(&stdout, 200)
            )),
        }
    }
}

impl StepAdapter for ExecStep {
    fn run(&self, input: StepInput) -> LocalBoxFuture<'_, Result<StepResult, String>> {
        Box::pin(self.exec(input))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::find_command;
    use crate::connectors::test_util::*;

    fn step(dir: &TempDir, transform: bool) -> ExecStep {
        ExecStep { dir: dir.path().to_path_buf(), transform, redact: Rc::new(|s: &str| s.to_string()) }
    }

    async fn call(s: &ExecStep, w: Value) -> Result<StepResult, String> {
        s.run(StepInput {
            packet_id: "p1".into(),
            node: "n".into(),
            data: json!({"a": 1}),
            with: w.as_object().cloned().unwrap(),
            origin: None,
        })
        .await
    }

    #[test]
    fn result_info_exit_code_stdout_stderr_files() {
        local(async {
            let b = TempDir::new();
            let r = call(&step(&b, true), json!({"command": "sh", "args": ["-c", "echo hi; echo oops >&2; echo x > out/p1.txt"], "outputs": ["out/p1.txt"]})).await.unwrap();
            let d = r.data.unwrap();
            assert_eq!(
                (d["exit_code"].clone(), d["stdout"].clone(), d["stderr"].clone()),
                (json!(0), json!("hi\n"), json!("oops\n"))
            );
            assert_eq!(d["files"], json!([b.join("out/p1.txt").display().to_string()]));
            assert!(d["duration_ms"].is_u64());
        });
    }

    #[test]
    fn args_are_passed_as_they_are_with_no_shell() {
        local(async {
            let b = TempDir::new();
            let r = call(
                &step(&b, true),
                json!({"command": "printf", "args": ["%s|", "a b", "$(echo no)", "'q'"], "result": "text"}),
            )
            .await
            .unwrap();
            assert_eq!(r.data, Some(json!("a b|$(echo no)|'q'|")));
        });
    }

    #[test]
    fn result_json_stdin_env_and_cwd() {
        local(async {
            let b = TempDir::new();
            std::fs::create_dir(b.join("sub")).unwrap();
            let w = json!({
                "command": "sh",
                "args": ["-c", "read x; printf '{\"in\":\"%s\",\"env\":\"%s\",\"cwd\":\"%s\"}' \"$x\" \"$GREETING\" \"$(pwd -P)\""],
                "stdin": "hello\n", "env": {"GREETING": "hey"}, "cwd": "sub", "result": "json"
            });
            let r = call(&step(&b, true), w).await.unwrap();
            assert_eq!(r.data, Some(json!({"in": "hello", "env": "hey", "cwd": b.join("sub").display().to_string()})));
            let e = call(&step(&b, true), json!({"command": "echo", "args": ["nope"], "result": "json"}))
                .await
                .unwrap_err();
            assert_eq!(e, "echo printed something that is not JSON (nodes.n.with.result is json): nope\n");
            let e = call(&step(&b, true), json!({"command": "true", "cwd": "missing"})).await.unwrap_err();
            assert_eq!(e, "nodes.n.with.cwd 'missing' does not exist; create it or fix the path");
        });
    }

    #[test]
    fn a_failing_exit_code_is_an_error_with_stderr_and_success_widens_it() {
        local(async {
            let b = TempDir::new();
            let s = step(&b, true);
            let e = call(&s, json!({"command": "sh", "args": ["-c", "echo broken >&2; exit 3"]})).await.unwrap_err();
            assert_eq!(e, "sh exited with code 3: broken");
            let r = call(&s, json!({"command": "sh", "args": ["-c", "echo broken >&2; exit 3"], "success": [0, 3]}))
                .await
                .unwrap();
            assert_eq!(r.data.unwrap()["exit_code"], json!(3));
        });
    }

    #[test]
    fn timeout_kills_the_program() {
        local(async {
            let b = TempDir::new();
            let t0 = std::time::Instant::now();
            let e = call(&step(&b, false), json!({"command": "sh", "args": ["-c", "sleep 10"], "timeout": "200ms"}))
                .await
                .unwrap_err();
            assert_eq!(e, "sh was killed (SIGTERM, after the 200ms timeout)");
            assert!(t0.elapsed().as_millis() < 5000);
        });
    }

    #[test]
    fn a_listed_output_the_program_didnt_write_is_an_error() {
        local(async {
            let b = TempDir::new();
            let e = call(&step(&b, true), json!({"command": "true", "outputs": ["out/x.mp4"]})).await.unwrap_err();
            assert!(e.contains(&format!("did not write {}", b.join("out/x.mp4").display())), "{e}");
            assert!(b.join("out").exists());
        });
    }

    #[test]
    fn a_missing_program_a_tap_and_redaction() {
        local(async {
            let b = TempDir::new();
            let e = call(&step(&b, true), json!({"command": "pipo-no-such-program"})).await.unwrap_err();
            assert!(e.contains("could not be started") && e.ends_with("is it installed and on PATH?"), "{e}");
            assert_eq!(call(&step(&b, false), json!({"command": "true"})).await.unwrap(), StepResult::default());
            let s = ExecStep {
                dir: b.path().to_path_buf(),
                transform: true,
                redact: Rc::new(|s: &str| s.replace("s3cret", "***")),
            };
            let r = call(&s, json!({"command": "echo", "args": ["s3cret"], "result": "text"})).await.unwrap();
            assert_eq!(r.data, Some(json!("***\n")));
            let e = call(&s, json!({"command": "sh", "args": ["-c", "echo s3cret >&2; exit 1"]})).await.unwrap_err();
            assert_eq!(e, "sh exited with code 1: ***");
            assert!(call(&s, json!({"command": ""})).await.unwrap_err().contains("command is empty"));
        });
    }

    #[test]
    fn a_path_command_runs_from_the_pipeline_folder() {
        local(async {
            use std::os::unix::fs::PermissionsExt;
            let b = TempDir::new();
            std::fs::create_dir(b.join("sub")).unwrap();
            std::fs::write(b.join("tool.sh"), "#!/bin/sh\necho tool in $(basename $(pwd -P))\n").unwrap();
            std::fs::set_permissions(b.join("tool.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
            let r =
                call(&step(&b, true), json!({"command": "./tool.sh", "cwd": "sub", "result": "text"})).await.unwrap();
            assert_eq!(r.data, Some(json!("tool in sub\n")));
            assert_eq!(find_command("./tool.sh", b.path()), Some(b.join("tool.sh")));
            std::fs::write(b.join("plain.txt"), "").unwrap();
            assert!(find_command("./plain.txt", b.path()).is_some(), "a path only has to exist (D71)");
            assert!(find_command("./nope.sh", b.path()).is_none());
            assert!(find_command("sh", b.path()).is_some());
            assert!(find_command("pipo-no-such-program", b.path()).is_none());
        });
    }
}
