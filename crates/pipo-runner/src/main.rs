// Runner process entry: one pipeline per process (docs/spec.md §7.1). Port of main.ts and foreground.ts.
// Usage: pipo-runner <file.pipo> [--listen <port>] [--home <dir>] [--env-allow A,B] [--engine-id <id>] [--detached]
//        [--ttl <duration>]
// SIGINT/SIGTERM drain; a second signal stops at once. Exit codes: 0 stopped, 2 halted, 1 failed to start, 64 usage.

use pipo_runner::format::format_diagnostic;
use pipo_runner::runner::{Runner, RunnerOptions};
use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;

const USAGE: &str = "usage: pipo-runner <file.pipo> [--listen <port>] [--home <dir>] [--env-allow A,B] [--engine-id <id>] [--detached] [--ttl <duration>]";

fn parse_args(args: &[String]) -> Result<RunnerOptions, String> {
    let mut o = RunnerOptions::default();
    let mut file: Option<String> = None;
    let mut home: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let (flag, inline) = match a.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f, Some(v.to_string())),
            _ => (a, None),
        };
        let mut value = || -> Result<String, String> {
            if let Some(v) = inline.clone() {
                return Ok(v);
            }
            i += 1;
            args.get(i).cloned().ok_or_else(|| format!("{flag} needs a value"))
        };
        match flag {
            "--listen" => {
                let v = value()?;
                o.listen = Some(v.parse().map_err(|_| format!("--listen must be a port number, got '{v}'"))?);
            }
            "--home" => home = Some(value()?),
            "--env-allow" => o.env_allow = value()?.split(',').filter(|s| !s.is_empty()).map(str::to_owned).collect(),
            "--engine-id" => o.engine_id = Some(value()?),
            "--detached" => o.detached = true,
            "--ttl" => o.ttl = Some(value()?),
            f if f.starts_with("--") => return Err(format!("unknown option {f}")),
            _ if file.is_none() => file = Some(a.to_string()),
            _ => return Err(format!("unexpected argument {a}")),
        }
        i += 1;
    }
    o.file = PathBuf::from(file.ok_or("missing <file.pipo>")?);
    o.home = match home.or_else(|| std::env::var("PIPO_HOME").ok().filter(|h| !h.is_empty())) {
        Some(h) => PathBuf::from(h),
        None => PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(".pipo"),
    };
    Ok(o)
}

/// Run one pipeline until it ends or is signalled; the exit code.
async fn run_foreground(opts: RunnerOptions) -> i32 {
    use tokio::signal::unix::{SignalKind, signal};
    let (Ok(mut int), Ok(mut term)) = (signal(SignalKind::interrupt()), signal(SignalKind::terminate())) else {
        eprintln!("pipo: can't install signal handlers");
        return 1;
    };
    let signals = Rc::new(Cell::new(0u32));
    // Signals that land while the runner is still starting are remembered and honoured as soon as it can be.
    let opening = Runner::open(opts);
    tokio::pin!(opening);
    let runner = loop {
        tokio::select! {
            r = &mut opening => break r,
            _ = int.recv() => signals.set(signals.get() + 1),
            _ = term.recv() => signals.set(signals.get() + 1),
        }
    };
    let runner = match runner {
        Ok(r) => r,
        Err(e) => {
            report(&e);
            return 1;
        }
    };
    if signals.get() > 0 {
        runner.stop(0).await;
        return 0;
    }
    if let Err(e) = runner.start().await {
        report(&e);
        return 1;
    }
    if signals.get() > 0 {
        let r = runner.clone();
        tokio::task::spawn_local(async move { r.drain().await });
    }
    let finished = runner.finished();
    tokio::pin!(finished);
    loop {
        tokio::select! {
            code = &mut finished => return code,
            _ = int.recv() => on_signal(&runner, &signals),
            _ = term.recv() => on_signal(&runner, &signals),
        }
    }
}

fn on_signal(runner: &Rc<Runner>, signals: &Cell<u32>) {
    signals.set(signals.get() + 1);
    let r = runner.clone();
    if signals.get() == 1 {
        tokio::task::spawn_local(async move { r.drain().await });
    } else {
        tokio::task::spawn_local(async move { r.stop(130).await });
    }
}

fn report(e: &pipo_runner::runner::StartError) {
    eprintln!("pipo: {}", e.message);
    for d in &e.diagnostics {
        eprintln!("{}", format_diagnostic(d));
    }
    for g in &e.gaps {
        eprintln!("  {}: {} at {}", if g.level == "refuse" { "not implemented" } else { "ignored" }, g.feature, g.path);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let opts = match parse_args(&args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("pipo-runner: {e}\n{USAGE}");
            std::process::exit(64);
        }
    };
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("tokio runtime");
    let local = tokio::task::LocalSet::new();
    let code = local.block_on(&rt, run_foreground(opts));
    std::process::exit(code);
}
