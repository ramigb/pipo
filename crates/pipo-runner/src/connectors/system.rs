// `via: system` (docs/spec.md §3.3, §7.4). Port of system-input.ts. The runner samples the operating system every
// `every` and hands each sample to the intake, which journals it before the next sample is armed. A metric the
// platform can't provide (battery on a server, network without /proc) is null.

use super::{InputAdapter, InputRuntime, Intake, IntakeResult, LocalBoxFuture, Log, Origin, Stopper};
use crate::duration::{format_duration, parse_duration};
use crate::time::{iso, now_ms};
use serde_json::{Map, Value, json};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use tokio::task::JoinHandle;

pub const SYSTEM_METRICS: &[&str] = &["cpu", "memory", "disk", "battery", "network"];

/// Takes one sample of the requested metrics.
pub type Sampler = Rc<dyn Fn(&[String]) -> Map<String, Value>>;

/// One decimal place, as `Math.round(x * 1000) / 10` for a ratio.
fn percent(ratio: f64) -> Value {
    crate::expr::js_number((ratio * 1000.0).round() / 10.0)
}

fn read(path: &str) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// (idle, total) CPU time over all cores, from /proc/stat (node's `os.cpus()` sums the same fields).
fn cpu_times() -> Option<(u64, u64)> {
    let stat = read("/proc/stat")?;
    let line = stat.lines().find(|l| l.starts_with("cpu "))?;
    let f: Vec<u64> = line.split_whitespace().skip(1).map(|x| x.parse().unwrap_or(0)).collect();
    let (user, nice, sys, idle, irq) =
        (*f.first()?, *f.get(1)?, *f.get(2)?, *f.get(3)?, f.get(5).copied().unwrap_or(0));
    Some((idle, user + nice + sys + idle + irq))
}

fn cores() -> usize {
    read("/proc/stat")
        .map(|s| {
            s.lines()
                .filter(|l| l.starts_with("cpu") && l.as_bytes().get(3).is_some_and(|b| b.is_ascii_digit()))
                .count()
        })
        .filter(|n| *n > 0)
        .unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1))
}

fn meminfo(key: &str) -> Option<u64> {
    let text = read("/proc/meminfo")?;
    let line = text.lines().find(|l| l.starts_with(key) && l[key.len()..].starts_with(':'))?;
    line[key.len() + 1..].split_whitespace().next()?.parse::<u64>().ok().map(|kb| kb * 1024)
}

fn statvfs(path: &str) -> Option<(u64, u64)> {
    let c = std::ffi::CString::new(path).ok()?;
    // SAFETY: statvfs fills the zeroed struct for a valid NUL-terminated path; the result is checked.
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    let size = s.f_frsize;
    Some((s.f_blocks * size, s.f_bavail * size))
}

/// The default sampler: /proc, /sys and statvfs where they exist.
pub fn os_sampler(disk_path: &str) -> Sampler {
    let last_cpu: Rc<Cell<Option<(u64, u64)>>> = Rc::default();
    let disk_path = disk_path.to_string();
    Rc::new(move |metrics: &[String]| {
        let mut out = Map::new();
        for m in metrics {
            let v = match m.as_str() {
                "cpu" => {
                    let now = cpu_times();
                    let prev = last_cpu.replace(now);
                    let pct = match (prev, now) {
                        (Some((pi, pt)), Some((ni, nt))) if nt > pt => percent(1.0 - (ni.saturating_sub(pi)) as f64 / (nt - pt) as f64),
                        _ => Value::Null,
                    };
                    let load: Vec<Value> = read("/proc/loadavg")
                        .map(|l| l.split_whitespace().take(3).map(|x| crate::expr::js_number(x.parse().unwrap_or(0.0))).collect())
                        .unwrap_or_else(|| vec![json!(0), json!(0), json!(0)]);
                    Some(json!({ "percent": pct, "cores": cores(), "load": load }))
                }
                "memory" => meminfo("MemTotal").filter(|t| *t > 0).map(|total| {
                    let free = meminfo("MemAvailable").or_else(|| meminfo("MemFree")).unwrap_or(0);
                    json!({ "total": total, "free": free, "used": total - free.min(total), "percent": percent((total - free.min(total)) as f64 / total as f64) })
                }),
                "disk" => statvfs(&disk_path).map(|(total, free)| {
                    let pct = if total > 0 { percent(1.0 - free as f64 / total as f64) } else { Value::Null };
                    json!({ "path": disk_path, "total": total, "free": free, "used": total.saturating_sub(free), "percent": pct })
                }),
                "battery" => (|| {
                    let dir = "/sys/class/power_supply";
                    let mut names: Vec<String> = std::fs::read_dir(dir).ok()?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
                    names.sort();
                    let Some(bat) = names.into_iter().find(|n| n.starts_with("BAT")) else { return Some(Value::Null) };
                    let field = |f: &str| read(&format!("{dir}/{bat}/{f}")).map(|s| s.trim().to_string());
                    let capacity = field("capacity")?;
                    let pct = capacity.parse::<f64>().map(crate::expr::js_number).unwrap_or(Value::Null);
                    Some(json!({ "percent": pct, "status": field("status") }))
                })(),
                "network" => read("/proc/net/dev").map(|text| {
                    let (mut rx, mut tx) = (0u64, 0u64);
                    for line in text.lines().skip(2) {
                        let Some((name, rest)) = line.split_once(':') else { continue };
                        if name.trim() == "lo" {
                            continue;
                        }
                        let f: Vec<u64> = rest.split_whitespace().map(|x| x.parse().unwrap_or(0)).collect();
                        rx += f.first().copied().unwrap_or(0);
                        tx += f.get(8).copied().unwrap_or(0);
                    }
                    json!({ "rx_bytes": rx, "tx_bytes": tx })
                }),
                _ => None,
            };
            out.insert(m.clone(), v.unwrap_or(Value::Null));
        }
        out
    })
}

pub struct SystemOptions {
    pub every: String,
    pub metrics: Option<Vec<String>>,
    pub sampler: Option<Sampler>,
    pub log: Option<Log>,
}

struct Inner {
    every_ms: u64,
    metrics: Vec<String>,
    sampler: Sampler,
    log: Option<Log>,
    stop: Stopper,
}

pub struct SystemInput {
    inner: Rc<Inner>,
    task: RefCell<Option<JoinHandle<()>>>,
}

impl SystemInput {
    pub fn new(o: SystemOptions) -> Result<SystemInput, String> {
        let every_ms = parse_duration(&o.every)?;
        if every_ms < 1 {
            return Err("system `every` must be at least 1ms".into());
        }
        let metrics = o
            .metrics
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| SYSTEM_METRICS.iter().map(|m| m.to_string()).collect());
        let sampler = o.sampler.unwrap_or_else(|| os_sampler("/"));
        Ok(SystemInput {
            inner: Rc::new(Inner { every_ms, metrics, sampler, log: o.log, stop: Stopper::default() }),
            task: RefCell::new(None),
        })
    }
}

impl Inner {
    async fn run(self: Rc<Self>, intake: Intake) {
        while self.stop.sleep(self.every_ms).await {
            let source = iso(now_ms());
            let mut data = (self.sampler)(&self.metrics);
            data.insert("sampled_at".into(), Value::String(source.clone()));
            let why =
                match intake(Value::Object(data), Origin { trigger: "system".into(), source: source.clone() }, None)
                    .await
                {
                    IntakeResult::Accepted { .. } => continue,
                    IntakeResult::Rejected { message, .. } => message,
                    IntakeResult::Unavailable { reason } => reason,
                };
            if let Some(l) = &self.log {
                l("warn", &format!("system sample {source} was not accepted: {why}"));
            }
        }
    }
}

impl InputAdapter for SystemInput {
    fn start(&self, intake: Intake, _runtime: InputRuntime) -> LocalBoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.inner.stop.reset();
            // Prime the sampler so the first packet already has a cpu delta.
            (self.inner.sampler)(&self.inner.metrics);
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
        format!("system {} every {}", self.inner.metrics.join(","), format_duration(self.inner.every_ms))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::test_util::*;

    #[test]
    fn settings_errors() {
        let o = |every: &str| SystemOptions { every: every.into(), metrics: None, sampler: None, log: None };
        assert_eq!(SystemInput::new(o("0s")).err().unwrap(), "system `every` must be at least 1ms");
        assert!(SystemInput::new(o("x")).err().unwrap().contains("invalid duration"));
        assert_eq!(SystemInput::new(o("1m")).unwrap().describe(), "system cpu,memory,disk,battery,network every 1m0s");
    }

    #[test]
    fn an_injected_sampler_yields_samples_with_the_expected_shape() {
        local(async {
            let n = Rc::new(Cell::new(0));
            let calls = n.clone();
            let sampler: Sampler = Rc::new(move |m: &[String]| {
                let mut out = Map::new();
                for k in m {
                    out.insert(k.clone(), if k == "battery" { Value::Null } else { json!({ "n": calls.get() }) });
                }
                calls.set(calls.get() + 1);
                out.insert("calls".into(), json!(calls.get()));
                out
            });
            let input = SystemInput::new(SystemOptions {
                every: "20ms".into(),
                metrics: Some(vec!["cpu".into(), "battery".into()]),
                sampler: Some(sampler),
                log: None,
            })
            .unwrap();
            let (intake, got) = recording_intake(accepted);
            input.start(intake, runtime(&TempDir::new())).await.unwrap();
            assert_eq!(n.get(), 1, "primed at start");
            wait_for(|| got.borrow().len() >= 2, 5000, "two samples").await;
            input.stop().await;
            for (data, origin) in got.borrow().iter() {
                assert_eq!(origin.trigger, "system");
                let mut keys: Vec<&String> = data.as_object().unwrap().keys().collect();
                keys.sort();
                assert_eq!(keys, vec!["battery", "calls", "cpu", "sampled_at"]);
                assert_eq!(data["battery"], Value::Null);
                assert_eq!(data["sampled_at"], json!(origin.source));
            }
            let count = got.borrow().len();
            tokio::time::sleep(std::time::Duration::from_millis(60)).await;
            assert_eq!(got.borrow().len(), count);
        });
    }

    #[test]
    fn the_real_sampler_returns_every_requested_metric() {
        let s = os_sampler("/");
        let all: Vec<String> = SYSTEM_METRICS.iter().map(|m| m.to_string()).collect();
        s(&all);
        let sample = s(&all);
        let keys: Vec<&String> = sample.keys().collect();
        assert_eq!(keys, vec!["cpu", "memory", "disk", "battery", "network"]);
        assert!(sample["memory"]["total"].as_u64().unwrap() > 0);
        assert!(sample["disk"]["total"].as_u64().unwrap() > 0);
        assert_eq!(sample["cpu"]["load"].as_array().unwrap().len(), 3);
        assert!(sample["cpu"]["cores"].as_u64().unwrap() > 0);
        assert!(sample["network"]["rx_bytes"].is_u64());
    }
}
