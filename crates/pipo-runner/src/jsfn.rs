// The QuickJS host for `fn` modules (docs/spec.md §3.6, docs/rust-runner.md). One runtime per runner, owned by a
// dedicated OS thread; tokio tasks send it requests over a channel, so calls are serialized. Each version's bundle is
// its own module, so packets pinned to different versions run their own code. Values cross as JSON text.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use rquickjs::{
    CatchResultExt, Coerced, Context, Ctx, Function, Module, Object, Persistent, Promise, Runtime,
    Value,
};
use tokio::sync::oneshot;

use crate::compile::FnModule;

/// How long one call (or one module load) may run before it is interrupted.
pub const CALL_LIMIT: Duration = Duration::from_secs(30);
/// The QuickJS runtime's memory limit.
pub const MEMORY_LIMIT: usize = 256 * 1024 * 1024;

/// Receives what functions write with `console.*`: the level (`log`, `info`, `debug`, `warn`, `error`) and the line.
pub type LogFn = Box<dyn Fn(&str, &str) + Send>;

pub struct JsOptions {
    pub call_limit: Duration,
    pub memory_limit: usize,
    /// Where `console.*` lines go; `None` drops them.
    pub log: Option<LogFn>,
}

impl Default for JsOptions {
    fn default() -> Self {
        JsOptions {
            call_limit: CALL_LIMIT,
            memory_limit: MEMORY_LIMIT,
            log: None,
        }
    }
}

type Reply<T> = oneshot::Sender<Result<T, String>>;

enum Request {
    Load {
        version: u32,
        module: FnModule,
        reply: Reply<()>,
    },
    Call {
        version: u32,
        name: String,
        data: String,
        meta: String,
        reply: Reply<Option<String>>,
    },
}

/// A handle to the thread that runs `fn` modules. Dropping it stops the thread.
pub struct JsFns {
    tx: mpsc::Sender<Request>,
}

impl Default for JsFns {
    fn default() -> Self {
        JsFns::new()
    }
}

impl JsFns {
    /// A host whose `console.*` output is dropped.
    pub fn new() -> JsFns {
        JsFns::with_options(JsOptions::default())
    }

    /// A host that hands `console.*` lines to `log`.
    pub fn with_log(log: LogFn) -> JsFns {
        JsFns::with_options(JsOptions {
            log: Some(log),
            ..JsOptions::default()
        })
    }

    pub fn with_options(options: JsOptions) -> JsFns {
        let (tx, rx) = mpsc::channel::<Request>();
        // If the thread can't start, `rx` is dropped with the closure and every request fails with `gone()`.
        let _ = std::thread::Builder::new()
            .name("pipo-jsfn".into())
            .stack_size(16 * 1024 * 1024)
            .spawn(move || serve(options, rx));
        JsFns { tx }
    }

    /// Load one bundled ES module for `version`, replacing what that version had.
    pub async fn load(&self, version: u32, module: &FnModule) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.send(Request::Load {
            version,
            module: module.clone(),
            reply,
        })?;
        rx.await.map_err(|_| gone())?
    }

    /// Call export `name` of `version`'s module with `(data, meta)`, awaiting a returned Promise. `undefined` is `None`.
    pub async fn call(
        &self,
        version: u32,
        name: &str,
        data: &serde_json::Value,
        meta: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, String> {
        let (reply, rx) = oneshot::channel();
        let (data, meta) = (data.to_string(), meta.to_string());
        self.send(Request::Call {
            version,
            name: name.to_string(),
            data,
            meta,
            reply,
        })?;
        match rx.await.map_err(|_| gone())?? {
            None => Ok(None),
            Some(text) => serde_json::from_str(&text)
                .map(Some)
                .map_err(|e| format!("fn.{name} returned a value Pipo can't read as JSON: {e}")),
        }
    }

    fn send(&self, req: Request) -> Result<(), String> {
        self.tx.send(req).map_err(|_| gone())
    }
}

fn gone() -> String {
    "the fn thread stopped (its JS runtime could not start or crashed); restart the pipeline".into()
}

/// The host helpers, evaluated once per context: a `console` that forwards lines, and `call`, which turns every outcome
/// into a plain object so errors keep the message Bun would give (`err.message`, or `String(x)` for a non-Error throw).
const PRELUDE: &str = r#"(log) => {
  const show = (a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.stack ? `${a}\n${a.stack}`.trimEnd() : String(a);
    try { const s = JSON.stringify(a); return s === undefined ? String(a) : s; } catch { return String(a); }
  };
  const line = (level) => (...args) => log(level, args.map(show).join(" "));
  globalThis.console = { log: line("log"), info: line("info"), debug: line("debug"), warn: line("warn"), error: line("error") };
  return async (ns, name, data, meta) => {
    const f = ns[name];
    if (typeof f !== "function") {
      return { missing: Object.keys(ns).filter((k) => typeof ns[k] === "function").join(", ") };
    }
    try {
      const r = await f(JSON.parse(data), JSON.parse(meta));
      return { ok: r === undefined ? undefined : JSON.stringify(r) };
    } catch (e) {
      let message;
      try { message = e instanceof Error ? String(e.message) : String(e); } catch { message = "a value that can't be shown"; }
      // QuickJS throws null when it runs out of memory and can't even build the error.
      return { err: message, null: e === null };
    }
  };
}"#;

struct Loaded {
    path: String,
    namespace: Persistent<Object<'static>>,
}

// Fields drop in order: the persistent handles must go before the context and runtime that own their values.
struct Host {
    call: Persistent<Function<'static>>,
    modules: HashMap<u32, Loaded>,
    ctx: Context,
    rt: Runtime,
    /// Milliseconds since `start` at which the running code is interrupted; 0 when nothing runs.
    deadline: Arc<AtomicU64>,
    tripped: Arc<AtomicBool>,
    start: Instant,
    limit: Duration,
    memory_limit: usize,
    seq: u64,
}

fn serve(options: JsOptions, rx: mpsc::Receiver<Request>) {
    match Host::new(options) {
        Ok(mut host) => {
            for req in rx {
                match req {
                    Request::Load {
                        version,
                        module,
                        reply,
                    } => drop(reply.send(host.load(version, &module))),
                    Request::Call {
                        version,
                        name,
                        data,
                        meta,
                        reply,
                    } => drop(reply.send(host.call(version, &name, &data, &meta))),
                }
            }
        }
        Err(e) => {
            for req in rx {
                match req {
                    Request::Load { reply, .. } => drop(reply.send(Err(e.clone()))),
                    Request::Call { reply, .. } => drop(reply.send(Err(e.clone()))),
                }
            }
        }
    }
}

impl Host {
    fn new(options: JsOptions) -> Result<Host, String> {
        let fail = |e: rquickjs::Error| format!("can't start the JS runtime for fn modules: {e}");
        let rt = Runtime::new().map_err(fail)?;
        rt.set_memory_limit(options.memory_limit);
        let start = Instant::now();
        let deadline = Arc::new(AtomicU64::new(0));
        let tripped = Arc::new(AtomicBool::new(false));
        {
            let (deadline, tripped) = (deadline.clone(), tripped.clone());
            rt.set_interrupt_handler(Some(Box::new(move || {
                let at = deadline.load(Ordering::Relaxed);
                if at != 0 && start.elapsed().as_millis() as u64 >= at {
                    tripped.store(true, Ordering::Relaxed);
                    return true;
                }
                false
            })));
        }
        let ctx = Context::full(&rt).map_err(fail)?;
        let log = options.log;
        let call = ctx.with(|ctx| -> Result<Persistent<Function<'static>>, String> {
            let sink = Function::new(ctx.clone(), move |level: String, text: String| {
                if let Some(log) = &log {
                    log(&level, &text);
                }
            })
            .map_err(|e| e.to_string())?;
            let setup: Function = ctx.eval(PRELUDE).catch(&ctx).map_err(|e| e.to_string())?;
            let call: Function = setup.call((sink,)).catch(&ctx).map_err(|e| e.to_string())?;
            Ok(Persistent::save(&ctx, call))
        })?;
        Ok(Host {
            call,
            modules: HashMap::new(),
            ctx,
            rt,
            deadline,
            tripped,
            start,
            limit: options.call_limit,
            memory_limit: options.memory_limit,
            seq: 0,
        })
    }

    fn arm(&self) {
        self.tripped.store(false, Ordering::Relaxed);
        let at = (self.start.elapsed() + self.limit).as_millis() as u64;
        self.deadline.store(at.max(1), Ordering::Relaxed);
    }

    /// Stop the clock; true when the code that ran was interrupted.
    fn disarm(&self) -> bool {
        self.deadline.store(0, Ordering::Relaxed);
        self.tripped.load(Ordering::Relaxed)
    }

    fn load(&mut self, version: u32, module: &FnModule) -> Result<(), String> {
        self.seq += 1;
        let name = format!("fn-v{version}-{}.js", self.seq);
        let path = module.path.as_str();
        self.arm();
        let result = self
            .ctx
            .with(|ctx| -> Result<Persistent<Object<'static>>, String> {
                let declared = Module::declare(ctx.clone(), name.as_str(), module.code.as_str())
                    .catch(&ctx)
                    .map_err(|e| format!("fn module {path} doesn't compile: {e}"))?;
                let (evaluated, promise) = declared
                    .eval()
                    .catch(&ctx)
                    .map_err(|e| format!("fn module {path} failed while loading: {e}"))?;
                settle::<()>(&ctx, &promise)
                    .map_err(|e| format!("fn module {path} failed while loading: {e}"))?;
                let ns = evaluated
                    .namespace()
                    .catch(&ctx)
                    .map_err(|e| e.to_string())?;
                Ok(Persistent::save(&ctx, ns))
            });
        if self.disarm() {
            return Err(format!(
                "fn module {path} ran longer than {} while loading and was stopped",
                human(self.limit)
            ));
        }
        self.modules.insert(
            version,
            Loaded {
                path: module.path.clone(),
                namespace: result?,
            },
        );
        self.rt.run_gc();
        Ok(())
    }

    fn call(
        &mut self,
        version: u32,
        name: &str,
        data: &str,
        meta: &str,
    ) -> Result<Option<String>, String> {
        let Some(loaded) = self.modules.get(&version) else {
            return Err(format!(
                "no fn module is loaded for version {version}; load the version's compiled module first"
            ));
        };
        self.arm();
        let result = self.ctx.with(|ctx| -> Result<Option<String>, String> {
            let ns = loaded.namespace.clone().restore(&ctx).map_err(|e| e.to_string())?;
            let call = self.call.clone().restore(&ctx).map_err(|e| e.to_string())?;
            let promise: Promise = call.call((ns, name, data, meta)).catch(&ctx).map_err(|e| e.to_string())?;
            let out: Object = settle(&ctx, &promise)?;
            if let Some(exports) = out.get::<_, Option<String>>("missing").map_err(|e| e.to_string())? {
                let has = if exports.is_empty() { "it exports no functions".to_string() } else { format!("exports: {exports}") };
                return Err(format!("'{}' does not export '{name}' ({has})", loaded.path));
            }
            if let Some(message) = out.get::<_, Option<String>>("err").map_err(|e| e.to_string())? {
                if out.get::<_, bool>("null").unwrap_or(false) {
                    let mb = self.memory_limit / (1024 * 1024);
                    return Err(format!("fn.{name} threw null: it probably ran out of memory (fn modules get {mb} MB)"));
                }
                return Err(message);
            }
            out.get::<_, Option<String>>("ok").map_err(|e| e.to_string())
        });
        if self.disarm() {
            return Err(format!(
                "fn.{name} ran longer than {} and was stopped",
                human(self.limit)
            ));
        }
        result
    }
}

/// Run the job queue until `promise` settles: its value, or the rejection's message.
fn settle<'js, T: rquickjs::FromJs<'js>>(
    ctx: &Ctx<'js>,
    promise: &Promise<'js>,
) -> Result<T, String> {
    loop {
        if let Some(result) = promise.result::<T>() {
            return result.map_err(|_| shown(&ctx.catch()));
        }
        if !ctx.execute_pending_job() {
            return Err(
                "it returned a Promise that never settles (fn modules have no timers or I/O)"
                    .into(),
            );
        }
    }
}

fn shown(v: &Value) -> String {
    if let Some(ex) = v.as_exception() {
        return ex
            .message()
            .unwrap_or_else(|| "an error with no message".into());
    }
    if let Some(Ok(Some(m))) = v.as_object().map(|o| o.get::<_, Option<String>>("message")) {
        return m;
    }
    v.get::<Coerced<String>>()
        .map(|c| c.0)
        .unwrap_or_else(|_| "a value that can't be shown".into())
}

fn human(d: Duration) -> String {
    if d.subsec_millis() == 0 {
        format!("{}s", d.as_secs())
    } else {
        format!("{}ms", d.as_millis())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    fn module(code: &str) -> FnModule {
        FnModule {
            path: "./t.fn.ts".into(),
            hash: "h".into(),
            code: code.into(),
            exports: vec![],
        }
    }

    async fn call(
        js: &JsFns,
        version: u32,
        name: &str,
        data: serde_json::Value,
    ) -> Result<Option<serde_json::Value>, String> {
        js.call(version, name, &data, &json!({})).await
    }

    #[tokio::test]
    async fn loads_and_calls_an_export() {
        let js = JsFns::new();
        js.load(
            1,
            &module("export function add(d, m) { return { sum: d.a + d.b, id: m.packet_id }; }"),
        )
        .await
        .unwrap();
        let r = js
            .call(
                1,
                "add",
                &json!({"a": 1, "b": 2}),
                &json!({"packet_id": "p1"}),
            )
            .await
            .unwrap();
        assert_eq!(r, Some(json!({"sum": 3, "id": "p1"})));
    }

    #[tokio::test]
    async fn awaits_an_async_export_and_maps_undefined_to_none() {
        let js = JsFns::new();
        let code = "export async function later(d) { await null; return [d.x, await Promise.resolve(2)]; }\n\
                    export function nothing() {}\nexport const isNull = (d) => d === null;";
        js.load(1, &module(code)).await.unwrap();
        assert_eq!(
            call(&js, 1, "later", json!({"x": 1})).await.unwrap(),
            Some(json!([1, 2]))
        );
        assert_eq!(call(&js, 1, "nothing", json!({})).await.unwrap(), None);
        assert_eq!(
            call(&js, 1, "isNull", json!(null)).await.unwrap(),
            Some(json!(true))
        );
    }

    #[tokio::test]
    async fn throws_give_the_message() {
        let js = JsFns::new();
        let code = "export function bad() { throw new TypeError('no name'); }\n\
                    export async function later() { throw new Error('async boom'); }\n\
                    export function raw() { throw 42; }\n\
                    export function obj() { throw { code: 1 }; }\n\
                    export function big() { return 1n; }";
        js.load(1, &module(code)).await.unwrap();
        assert_eq!(call(&js, 1, "bad", json!({})).await.unwrap_err(), "no name");
        assert_eq!(
            call(&js, 1, "later", json!({})).await.unwrap_err(),
            "async boom"
        );
        assert_eq!(call(&js, 1, "raw", json!({})).await.unwrap_err(), "42");
        assert_eq!(
            call(&js, 1, "obj", json!({})).await.unwrap_err(),
            "[object Object]"
        );
        assert!(
            call(&js, 1, "big", json!({}))
                .await
                .unwrap_err()
                .contains("BigInt")
        );
        // The runtime is still usable afterwards.
        js.load(2, &module("export const ok = () => 1;"))
            .await
            .unwrap();
        assert_eq!(call(&js, 2, "ok", json!({})).await.unwrap(), Some(json!(1)));
    }

    #[tokio::test]
    async fn missing_export_and_unloaded_version() {
        let js = JsFns::new();
        js.load(
            1,
            &module("export function a() {}\nexport function b() {}\nexport const n = 1;"),
        )
        .await
        .unwrap();
        assert_eq!(
            call(&js, 1, "c", json!({})).await.unwrap_err(),
            "'./t.fn.ts' does not export 'c' (exports: a, b)"
        );
        assert_eq!(
            call(&js, 1, "n", json!({})).await.unwrap_err(),
            "'./t.fn.ts' does not export 'n' (exports: a, b)"
        );
        let e = call(&js, 7, "a", json!({})).await.unwrap_err();
        assert!(e.contains("no fn module is loaded for version 7"), "{e}");
    }

    #[tokio::test]
    async fn bad_modules_fail_to_load() {
        let js = JsFns::new();
        let e = js.load(1, &module("export function (")).await.unwrap_err();
        assert!(e.starts_with("fn module ./t.fn.ts doesn't compile"), "{e}");
        let e = js
            .load(1, &module("throw new Error('top level');"))
            .await
            .unwrap_err();
        assert!(e.contains("top level"), "{e}");
        let e = js
            .load(
                1,
                &module("import fs from 'node:fs'; export const f = () => fs;"),
            )
            .await
            .unwrap_err();
        assert!(e.starts_with("fn module ./t.fn.ts"), "{e}");
    }

    #[tokio::test]
    async fn versions_side_by_side() {
        let js = JsFns::new();
        js.load(
            1,
            &module("let calls = 0; export function v() { calls++; return 'one:' + calls; }"),
        )
        .await
        .unwrap();
        js.load(
            2,
            &module("let calls = 0; export function v() { calls++; return 'two:' + calls; }"),
        )
        .await
        .unwrap();
        assert_eq!(
            call(&js, 1, "v", json!({})).await.unwrap(),
            Some(json!("one:1"))
        );
        assert_eq!(
            call(&js, 2, "v", json!({})).await.unwrap(),
            Some(json!("two:1"))
        );
        assert_eq!(
            call(&js, 1, "v", json!({})).await.unwrap(),
            Some(json!("one:2"))
        );
        // Reloading a version replaces its module.
        js.load(1, &module("export function v() { return 'one again'; }"))
            .await
            .unwrap();
        assert_eq!(
            call(&js, 1, "v", json!({})).await.unwrap(),
            Some(json!("one again"))
        );
        assert_eq!(
            call(&js, 2, "v", json!({})).await.unwrap(),
            Some(json!("two:2"))
        );
    }

    #[tokio::test]
    async fn runaway_code_is_interrupted() {
        let js = JsFns::with_options(JsOptions {
            call_limit: Duration::from_millis(200),
            ..JsOptions::default()
        });
        let code = "export function spin() { while (true) {} }\n\
                    export async function spinLater() { await null; for (;;) {} }\n\
                    export function guarded() { try { while (true) {} } catch (e) { return 'caught'; } }\n\
                    export const ok = (d) => d;";
        js.load(1, &module(code)).await.unwrap();
        let t = Instant::now();
        assert_eq!(
            call(&js, 1, "spin", json!({})).await.unwrap_err(),
            "fn.spin ran longer than 200ms and was stopped"
        );
        assert!(t.elapsed() < Duration::from_secs(5));
        let e = call(&js, 1, "spinLater", json!({})).await.unwrap_err();
        assert_eq!(e, "fn.spinLater ran longer than 200ms and was stopped");
        let e = call(&js, 1, "guarded", json!({})).await.unwrap_err();
        assert_eq!(
            e, "fn.guarded ran longer than 200ms and was stopped",
            "an interrupt can't be caught"
        );
        assert_eq!(call(&js, 1, "ok", json!(5)).await.unwrap(), Some(json!(5)));
        let e = js.load(2, &module("while (true) {}")).await.unwrap_err();
        assert_eq!(
            e,
            "fn module ./t.fn.ts ran longer than 200ms while loading and was stopped"
        );
        assert_eq!(human(CALL_LIMIT), "30s");
    }

    #[tokio::test]
    async fn a_promise_that_never_settles_is_an_error() {
        let js = JsFns::new();
        js.load(
            1,
            &module("export function hang() { return new Promise(() => {}); }"),
        )
        .await
        .unwrap();
        let e = call(&js, 1, "hang", json!({})).await.unwrap_err();
        assert!(e.contains("never settles"), "{e}");
    }

    #[tokio::test]
    async fn memory_limit_stops_a_runaway_allocation() {
        let js = JsFns::with_options(JsOptions {
            memory_limit: 16 * 1024 * 1024,
            ..JsOptions::default()
        });
        let code = "export function grow() { const a = []; for (;;) a.push('x'.repeat(1024) + a.length); }\n\
                    export const ok = () => 'still here';";
        js.load(1, &module(code)).await.unwrap();
        let e = call(&js, 1, "grow", json!({})).await.unwrap_err();
        assert!(e.contains("out of memory") && e.contains("16 MB"), "{e}");
        assert_eq!(
            call(&js, 1, "ok", json!({})).await.unwrap(),
            Some(json!("still here"))
        );
    }

    #[tokio::test]
    async fn unicode_and_numbers_round_trip() {
        let js = JsFns::new();
        js.load(
            1,
            &module("export const echo = (d) => d;\nexport const len = (d) => [...d.s].length;"),
        )
        .await
        .unwrap();
        let v = json!({
            "s": "héllo wörld — 你好 🎉 \u{0} \"q\" \\ \n",
            "n": [0, -1, 1.5, 1e21, 9007199254740991i64, -0.000001, 123456789.125, 1e-7],
            "nested": {"a": [true, false, null], "ünï": "✓"}
        });
        assert_eq!(call(&js, 1, "echo", v.clone()).await.unwrap(), Some(v));
        assert_eq!(
            call(&js, 1, "len", json!({"s": "a🎉b"})).await.unwrap(),
            Some(json!(3))
        );
    }

    #[tokio::test]
    async fn console_lines_go_to_the_log_callback() {
        let lines = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let sink = lines.clone();
        let js = JsFns::with_log(Box::new(move |level, text| {
            sink.lock().unwrap().push((level.into(), text.into()))
        }));
        let code = "console.log('loading');\n\
                    export function f(d) { console.warn('saw', d, 2); console.error(new Error('e')); return 1; }";
        js.load(1, &module(code)).await.unwrap();
        js.call(1, "f", &json!({"a": 1}), &json!({})).await.unwrap();
        let lines = lines.lock().unwrap();
        assert_eq!(lines[0], ("log".into(), "loading".into()));
        assert_eq!(lines[1], ("warn".into(), "saw {\"a\":1} 2".into()));
        assert_eq!(lines[2].0, "error");
        assert!(lines[2].1.starts_with("Error: e"), "{}", lines[2].1);
    }

    #[tokio::test]
    async fn concurrent_callers_are_serialized() {
        let js = Arc::new(JsFns::new());
        js.load(
            1,
            &module("let n = 0; export function inc() { return ++n; }"),
        )
        .await
        .unwrap();
        let tasks: Vec<_> = (0..50)
            .map(|_| {
                let js = js.clone();
                tokio::spawn(async move { call(&js, 1, "inc", json!({})).await.unwrap() })
            })
            .collect();
        let mut seen: Vec<i64> = Vec::new();
        for t in tasks {
            seen.push(t.await.unwrap().unwrap().as_i64().unwrap());
        }
        seen.sort();
        assert_eq!(seen, (1..=50).collect::<Vec<_>>());
    }
}
