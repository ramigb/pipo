// Calls `pipo compile`, the only checker (docs/spec.md D73): its JSON reply is a version's compiled
// form (the definition, the bundled `fn` module, schemas, D60 file hashes, agent settings), stored per version.

use std::path::Path;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FnModule {
    /// The module as written in `fn:`.
    pub path: String,
    /// sha256 of the module file as compiled.
    pub hash: String,
    /// One self-contained ES module.
    pub code: String,
    /// Its exported functions.
    pub exports: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Compiled {
    /// As `pipo check --json` gives them (`code`, `severity`, `message`, `hint`, `line`, `col`, `path`, `file`).
    pub diagnostics: Vec<Value>,
    /// `load()`'s value; None when any diagnostic is an error. `crate::pipeline::Pipeline::from_value` types it.
    pub pipeline: Option<Value>,
    pub fn_module: Option<FnModule>,
    /// Parsed JSON Schemas (`input.schema`, agent `with.schema`), keyed by the path as written.
    pub schemas: Map<String, Value>,
    /// D60: sha256 of each referenced file, keyed by the path as written.
    pub files: Map<String, Value>,
    /// `{settings: {agents, timezone, engine_budget}, problems}` from `<home>/config.yaml`, when there are agent nodes.
    pub agents: Option<Value>,
    /// The agent provider manifests (`AGENTS` in `@pipo/spec`).
    pub agent_manifests: Value,
    /// The exact JSON text, stored per version.
    pub raw: String,
}

#[derive(Deserialize)]
struct Reply {
    diagnostics: Vec<Value>,
    pipeline: Option<Value>,
    #[serde(rename = "fn")]
    fn_module: Option<FnModule>,
    #[serde(default)]
    schemas: Map<String, Value>,
    #[serde(default)]
    files: Map<String, Value>,
    #[serde(default)]
    agents: Option<Value>,
    #[serde(default)]
    agent_manifests: Value,
}

impl Compiled {
    pub fn errors(&self) -> Vec<&Value> {
        self.diagnostics.iter().filter(|d| d.get("severity").and_then(Value::as_str) == Some("error")).collect()
    }

    pub fn from_json(text: &str) -> Result<Compiled, String> {
        let r: Reply = serde_json::from_str(text).map_err(|e| {
            format!("pipo compile's reply is not the JSON it should be ({e}); check that PIPO_COMPILE runs `pipo compile` from the same Pipo version")
        })?;
        Ok(Compiled {
            diagnostics: r.diagnostics,
            pipeline: r.pipeline,
            fn_module: r.fn_module,
            schemas: r.schemas,
            files: r.files,
            agents: r.agents,
            agent_manifests: r.agent_manifests,
            raw: text.to_string(),
        })
    }
}

/// The compiler's argv: `$PIPO_COMPILE` (a JSON array of strings), else `pipo compile`.
pub fn compiler_argv() -> Result<Vec<String>, String> {
    match std::env::var("PIPO_COMPILE") {
        Ok(text) if !text.trim().is_empty() => match serde_json::from_str::<Vec<String>>(&text) {
            Ok(argv) if !argv.is_empty() => Ok(argv),
            _ => Err(format!(
                "PIPO_COMPILE must be a JSON array of strings, such as [\"bun\",\"/repo/packages/cli/src/main.ts\",\"compile\"], not {text}"
            )),
        },
        _ => Ok(vec!["pipo".into(), "compile".into()]),
    }
}

/// Run the compiler: argv from $PIPO_COMPILE or `pipo compile`, plus `<file> --home <home> [--stdin]`, with `source`
/// on stdin when given.
pub async fn compile(file: &Path, home: &Path, source: Option<&str>) -> Result<Compiled, String> {
    compile_with(&compiler_argv()?, file, home, source).await
}

/// How long one compile may take before it counts as hung: Bun under WSL now and then spins forever loading modules
/// before any code runs (the engine restarts such runners for the same reason). `PIPO_COMPILE_TIMEOUT` (ms) overrides.
const ATTEMPT_MS: u64 = 8000;
const ATTEMPTS: u32 = 3;

/// `compile` with an explicit compiler argv. A compiler that hangs is killed and run again, up to three times.
pub async fn compile_with(argv: &[String], file: &Path, home: &Path, source: Option<&str>) -> Result<Compiled, String> {
    let ms = std::env::var("PIPO_COMPILE_TIMEOUT").ok().and_then(|v| v.parse().ok()).unwrap_or(ATTEMPT_MS);
    for attempt in 1..=ATTEMPTS {
        match tokio::time::timeout(std::time::Duration::from_millis(ms), compile_once(argv, file, home, source)).await {
            Ok(result) => return result,
            Err(_) if attempt < ATTEMPTS => continue,
            Err(_) => {}
        }
    }
    Err(format!(
        "pipo compile (`{}`) did not answer within {ms} ms, {ATTEMPTS} times; run it by hand to see why, or raise PIPO_COMPILE_TIMEOUT",
        argv.join(" ")
    ))
}

async fn compile_once(argv: &[String], file: &Path, home: &Path, source: Option<&str>) -> Result<Compiled, String> {
    let (program, prefix) = argv.split_first().ok_or("the compiler command is empty; set PIPO_COMPILE")?;
    let shown = argv.join(" ");
    let mut cmd = Command::new(program);
    cmd.args(prefix).arg(file).arg("--home").arg(home);
    if source.is_some() {
        cmd.arg("--stdin");
    }
    cmd.stdin(if source.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!(
                "can't run the pipeline compiler `{shown}`: {program} was not found; set PIPO_COMPILE (a JSON argv such as [\"bun\",\"<repo>/packages/cli/src/main.ts\",\"compile\"]) or put pipo on PATH"
            )
        } else {
            format!("can't run the pipeline compiler `{shown}`: {e}; set PIPO_COMPILE or put pipo on PATH")
        }
    })?;
    // Write stdin from its own task while the output is read, so a large source can't deadlock on full pipes.
    let writer = match (source, child.stdin.take()) {
        (Some(text), Some(mut stdin)) => {
            let text = text.to_string();
            Some(tokio::spawn(async move {
                let r = stdin.write_all(text.as_bytes()).await;
                drop(stdin);
                r
            }))
        }
        _ => None,
    };
    let out = child.wait_with_output().await.map_err(|e| format!("pipo compile (`{shown}`) failed: {e}"))?;
    if let Some(w) = writer {
        // A compiler that exits without reading stdin breaks the pipe; its own exit status says more.
        let _ = w.await;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let tail = || {
        let t = stderr.trim();
        if t.is_empty() {
            String::new()
        } else {
            format!(
                ": {}",
                t.lines().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" | ")
            )
        }
    };
    match out.status.code() {
        Some(0) | Some(1) => Compiled::from_json(stdout.trim()).map_err(|e| format!("{e} (`{shown}`{})", tail())),
        Some(64) => Err(format!(
            "pipo compile (`{shown}`) refused its arguments{}; is it a Pipo version with `pipo compile`?",
            tail()
        )),
        Some(code) => Err(format!("pipo compile (`{shown}`) failed with exit code {code}{}", tail())),
        None => Err(format!("pipo compile (`{shown}`) crashed ({}){}", out.status, tail())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_a_reply() {
        let text = json!({
            "diagnostics": [{"code": "P053", "severity": "warning", "message": "m"}, {"code": "P012", "severity": "error", "message": "x"}],
            "pipeline": null,
            "fn": {"path": "./a.ts", "hash": "h", "code": "export {}", "exports": ["a"]},
            "schemas": {"./s.json": {"type": "object"}},
            "files": {"./s.json": "abc"},
            "agents": null,
            "agent_manifests": {"claude_api": {"runs": "api"}}
        })
        .to_string();
        let c = Compiled::from_json(&text).unwrap();
        assert_eq!(c.errors().len(), 1);
        assert_eq!(c.errors()[0]["code"], "P012");
        assert_eq!(c.fn_module.as_ref().unwrap().exports, vec!["a"]);
        assert_eq!(c.schemas["./s.json"], json!({"type": "object"}));
        assert_eq!(c.agent_manifests["claude_api"]["runs"], "api");
        assert_eq!(c.raw, text);
        assert!(Compiled::from_json("not json").unwrap_err().contains("not the JSON"));
    }

    #[tokio::test]
    async fn a_missing_compiler_says_what_to_do() {
        let argv = vec!["pipo-compiler-that-does-not-exist".to_string()];
        let e = compile_with(&argv, Path::new("x.pipo"), Path::new("/tmp"), None).await.unwrap_err();
        assert!(e.contains("was not found") && e.contains("PIPO_COMPILE") && e.contains("PATH"), "{e}");
    }

    #[tokio::test]
    async fn non_json_and_crashes_are_errors() {
        let sh = |script: &str| vec!["sh".to_string(), "-c".to_string(), script.to_string(), "sh".to_string()];
        let e = compile_with(&sh("echo hello"), Path::new("x.pipo"), Path::new("/tmp"), None).await.unwrap_err();
        assert!(e.contains("not the JSON"), "{e}");
        let e =
            compile_with(&sh("echo boom >&2; exit 3"), Path::new("x.pipo"), Path::new("/tmp"), None).await.unwrap_err();
        assert!(e.contains("exit code 3") && e.contains("boom"), "{e}");
        let e = compile_with(&sh("kill -9 $$"), Path::new("x.pipo"), Path::new("/tmp"), None).await.unwrap_err();
        assert!(e.contains("crashed"), "{e}");
        // Arguments and stdin reach the compiler.
        let echo =
            sh(r#"src=$(cat); printf '{"diagnostics":[],"pipeline":{"args":"%s","src":"%s"},"fn":null}' "$*" "$src""#);
        let c = compile_with(&echo, Path::new("x.pipo"), Path::new("/h"), Some("SRC")).await.unwrap();
        assert_eq!(c.pipeline.unwrap(), json!({"args": "x.pipo --home /h --stdin", "src": "SRC"}));
    }
}
