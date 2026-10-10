// The QuickJS host for `fn` modules (docs/spec.md §3.6, docs/rust-runner.md). One runtime per runner, owned by a
// dedicated OS thread that runs an event loop: tokio tasks send it requests over a channel at any time, each call runs
// until its promise settles, and calls waiting on timers interleave as in Bun. Each version's bundle is its own
// module, so packets pinned to different versions run their own code. Values cross as JSON text.
//
// Ownership: every piece of JS runs on behalf of one task (a call or a module load): its start, the timers it set,
// and the promise jobs that follow (the job queue is drained after each, so every job descends from the activity that
// ran just before it). A task's limit covers its wall time, timers included; the interrupt handler stops CPU-bound
// code of the task that is over its limit. A task's timers are cancelled when it settles, fails or times out.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, TryRecvError};
use std::time::{Duration, Instant};

use rquickjs::{
    CatchResultExt, Coerced, Context, Ctx, Function, Module, Object, Persistent, Promise, Runtime, Value,
    promise::PromiseState,
};
use tokio::sync::oneshot;

use crate::compile::FnModule;

/// How long one call (or one module load) may take, from its start until its promise settles, timers included.
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
        JsOptions { call_limit: CALL_LIMIT, memory_limit: MEMORY_LIMIT, log: None }
    }
}

type Reply<T> = oneshot::Sender<Result<T, String>>;

enum Request {
    Load { version: u32, module: FnModule, reply: Reply<()> },
    Call { version: u32, name: String, data: String, meta: String, reply: Reply<Option<String>> },
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
        JsFns::with_options(JsOptions { log: Some(log), ..JsOptions::default() })
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

    /// Load one bundled ES module for `version`, replacing what that version had (once its top-level code settles).
    pub async fn load(&self, version: u32, module: &FnModule) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.send(Request::Load { version, module: module.clone(), reply })?;
        rx.await.map_err(|_| gone())?
    }

    /// Call export `name` of `version`'s module with `(data, meta)`, awaiting a returned Promise. `undefined` is `None`.
    /// Calls run concurrently on the JS thread: while one awaits a timer, others run.
    pub async fn call(
        &self,
        version: u32,
        name: &str,
        data: &serde_json::Value,
        meta: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, String> {
        let (reply, rx) = oneshot::channel();
        let (data, meta) = (data.to_string(), meta.to_string());
        self.send(Request::Call { version, name: name.to_string(), data, meta, reply })?;
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

/// The host helpers, evaluated once per context: a `console` that forwards lines, timers backed by the Rust queue
/// (`schedule`/`unschedule`), and `call`, which turns every outcome into a plain object so errors keep the message Bun
/// would give (`err.message`, or `String(x)` for a non-Error throw).
const PRELUDE: &str = r#"(log, schedule, unschedule) => {
  const show = (a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.stack ? `${a}\n${a.stack}`.trimEnd() : String(a);
    try { const s = JSON.stringify(a); return s === undefined ? String(a) : s; } catch { return String(a); }
  };
  const line = (level) => (...args) => log(level, args.map(show).join(" "));
  globalThis.console = { log: line("log"), info: line("info"), debug: line("debug"), warn: line("warn"), error: line("error") };
  const message = (e) => {
    try { return e instanceof Error ? String(e.message) : String(e); } catch { return "a value that can't be shown"; }
  };
  const timers = new Map();
  const add = (repeat) => (fn, ms, ...args) => {
    const id = schedule(Number(ms) || 0, repeat);
    timers.set(id, { fn, args });
    return id;
  };
  const clear = (id) => { if (typeof id === "number" && timers.delete(id)) unschedule(id); };
  globalThis.setTimeout = add(false);
  globalThis.setInterval = add(true);
  globalThis.clearTimeout = clear;
  globalThis.clearInterval = clear;
  const fire = (id, keep) => {
    const t = timers.get(id);
    if (!t) return undefined;
    if (!keep) timers.delete(id);
    if (typeof t.fn !== "function") return undefined;
    try { t.fn(...t.args); return undefined; } catch (e) { return message(e); }
  };
  const forget = (id) => { timers.delete(id); };
  const call = async (ns, name, data, meta) => {
    const f = ns[name];
    if (typeof f !== "function") {
      return { missing: Object.keys(ns).filter((k) => typeof ns[k] === "function").join(", ") };
    }
    try {
      const r = await f(JSON.parse(data), JSON.parse(meta));
      return { ok: r === undefined ? undefined : JSON.stringify(r) };
    } catch (e) {
      // QuickJS throws null when it runs out of memory and can't even build the error.
      return { err: message(e), null: e === null };
    }
  };
  return { call, fire, forget };
}"#;

/// Smallest `setInterval` period, so a 0 ms interval can't spin the loop.
const MIN_INTERVAL: Duration = Duration::from_millis(1);

struct Timer {
    due: Instant,
    owner: u64,
    every: Option<Duration>,
}

/// The timer queue, shared with the `schedule`/`unschedule` host functions. Ids are JS numbers.
#[derive(Default)]
struct Timers {
    next: u64,
    by_id: HashMap<u64, Timer>,
    queue: BTreeSet<(Instant, u64)>,
}

impl Timers {
    fn add(&mut self, owner: u64, delay: Duration, repeat: bool) -> u64 {
        self.next += 1;
        let id = self.next;
        let due = Instant::now() + delay;
        let every = repeat.then(|| delay.max(MIN_INTERVAL));
        self.by_id.insert(id, Timer { due, owner, every });
        self.queue.insert((due, id));
        id
    }

    fn cancel(&mut self, id: u64) {
        if let Some(t) = self.by_id.remove(&id) {
            self.queue.remove(&(t.due, id));
        }
    }

    fn next_due(&self) -> Option<Instant> {
        self.queue.first().map(|(due, _)| *due)
    }

    /// The timers due at `now`, in order, as (id, owner, repeats). Intervals are queued again.
    fn take_due(&mut self, now: Instant) -> Vec<(u64, u64, bool)> {
        let mut out = Vec::new();
        while let Some(&(due, id)) = self.queue.first() {
            if due > now {
                break;
            }
            self.queue.pop_first();
            let Some(t) = self.by_id.get_mut(&id) else { continue };
            let owner = t.owner;
            match t.every {
                Some(every) => {
                    t.due = now + every;
                    self.queue.insert((t.due, id));
                    out.push((id, owner, true));
                }
                None => {
                    self.by_id.remove(&id);
                    out.push((id, owner, false));
                }
            }
        }
        out
    }

    fn owned_by(&self, owner: u64) -> Vec<u64> {
        self.by_id.iter().filter(|(_, t)| t.owner == owner).map(|(id, _)| *id).collect()
    }
}

struct Loaded {
    path: String,
    namespace: Persistent<Object<'static>>,
}

enum Job {
    Load { version: u32, path: String, namespace: Persistent<Object<'static>>, reply: Reply<()> },
    Call { name: String, path: String, reply: Reply<Option<String>> },
}

/// A call or module load whose promise hasn't settled yet.
struct Task {
    promise: Persistent<Promise<'static>>,
    deadline: Instant,
    job: Job,
}

/// How a task ended.
enum End {
    /// The call's result object, or the load's namespace is ready.
    Settled,
    Failed(String),
    TimedOut,
    Stuck,
}

// Fields drop in order: the persistent handles must go before the context and runtime that own their values.
struct Host {
    tasks: HashMap<u64, Task>,
    helpers: Persistent<Object<'static>>,
    modules: HashMap<u32, Loaded>,
    ctx: Context,
    rt: Runtime,
    timers: Rc<RefCell<Timers>>,
    /// The task the running JS belongs to (0: none); timers it sets are owned by it.
    owner: Rc<Cell<u64>>,
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
        Ok(host) => host.run(rx),
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
        let timers = Rc::new(RefCell::new(Timers::default()));
        let owner = Rc::new(Cell::new(0u64));
        let log = options.log;
        let helpers = ctx.with(|ctx| -> Result<Persistent<Object<'static>>, String> {
            let err = |e: rquickjs::Error| e.to_string();
            let sink = Function::new(ctx.clone(), move |level: String, text: String| {
                if let Some(log) = &log {
                    log(&level, &text);
                }
            })
            .map_err(err)?;
            let (t, o) = (timers.clone(), owner.clone());
            let schedule = Function::new(ctx.clone(), move |ms: f64, repeat: bool| -> f64 {
                let ms = if ms.is_finite() && ms > 0.0 { ms.min(2_147_483_647.0) } else { 0.0 };
                t.borrow_mut().add(o.get(), Duration::from_secs_f64(ms / 1000.0), repeat) as f64
            })
            .map_err(err)?;
            let t = timers.clone();
            let unschedule =
                Function::new(ctx.clone(), move |id: f64| t.borrow_mut().cancel(id as u64)).map_err(err)?;
            let setup: Function = ctx.eval(PRELUDE).catch(&ctx).map_err(|e| e.to_string())?;
            let helpers: Object = setup.call((sink, schedule, unschedule)).catch(&ctx).map_err(|e| e.to_string())?;
            Ok(Persistent::save(&ctx, helpers))
        })?;
        Ok(Host {
            tasks: HashMap::new(),
            helpers,
            modules: HashMap::new(),
            ctx,
            rt,
            timers,
            owner,
            deadline,
            tripped,
            start,
            limit: options.call_limit,
            memory_limit: options.memory_limit,
            seq: 0,
        })
    }

    /// The event loop: take a request (waiting only when nothing is due), fire due timers, end tasks that settled,
    /// timed out or can never settle. Returns when every `JsFns` handle is gone.
    fn run(mut self, rx: mpsc::Receiver<Request>) {
        loop {
            let wake = self.next_wake();
            let req = match wake {
                None => match rx.recv() {
                    Ok(r) => Some(r),
                    Err(_) => return,
                },
                Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                    Ok(r) => Some(r),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => return,
                },
            };
            if let Some(req) = req {
                self.begin(req);
                // Start whatever else is queued before timers fire, so ready calls don't wait on each other.
                loop {
                    match rx.try_recv() {
                        Ok(req) => self.begin(req),
                        Err(TryRecvError::Empty) => break,
                        Err(TryRecvError::Disconnected) => return,
                    }
                }
            }
            self.fire_timers();
            self.sweep();
        }
    }

    /// When the loop must wake without a request: the next timer or task deadline.
    fn next_wake(&self) -> Option<Instant> {
        let timer = self.timers.borrow().next_due();
        let deadline = self.tasks.values().map(|t| t.deadline).min();
        match (timer, deadline) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// Run `f` as task `owner` (until `deadline`), then drain the job queue it fed. Returns `f`'s result and whether
    /// the interrupt handler stopped the code for being over the limit.
    fn activity<R>(&self, owner: u64, deadline: Instant, f: impl FnOnce(&Ctx<'_>) -> R) -> (R, bool) {
        self.owner.set(owner);
        self.tripped.store(false, Ordering::Relaxed);
        let at = deadline.saturating_duration_since(self.start).as_millis() as u64;
        self.deadline.store(at.max(1), Ordering::Relaxed);
        let r = self.ctx.with(|ctx| {
            let r = f(&ctx);
            while ctx.execute_pending_job() {}
            r
        });
        self.deadline.store(0, Ordering::Relaxed);
        self.owner.set(0);
        (r, self.tripped.load(Ordering::Relaxed))
    }

    fn begin(&mut self, req: Request) {
        self.seq += 1;
        let id = self.seq;
        let deadline = Instant::now() + self.limit;
        match req {
            Request::Load { version, module, reply } => {
                let path = module.path.clone();
                let name = format!("fn-v{version}-{id}.js");
                let (started, tripped) = self.activity(id, deadline, |ctx| {
                    let declared = Module::declare(ctx.clone(), name.as_str(), module.code.as_str())
                        .catch(ctx)
                        .map_err(|e| format!("fn module {path} doesn't compile: {e}"))?;
                    let (evaluated, promise) = declared
                        .eval()
                        .catch(ctx)
                        .map_err(|e| format!("fn module {path} failed while loading: {e}"))?;
                    let ns = evaluated.namespace().catch(ctx).map_err(|e| e.to_string())?;
                    Ok::<_, String>((Persistent::save(ctx, promise), Persistent::save(ctx, ns)))
                });
                match started {
                    Ok((promise, namespace)) => {
                        let job = Job::Load { version, path, namespace, reply };
                        self.tasks.insert(id, Task { promise, deadline, job });
                        if tripped {
                            self.end(id, End::TimedOut);
                        }
                    }
                    Err(e) => {
                        self.cancel_timers(id);
                        let msg = if tripped { load_timeout(&path, self.limit) } else { e };
                        drop(reply.send(Err(msg)));
                    }
                }
            }
            Request::Call { version, name, data, meta, reply } => {
                let Some(loaded) = self.modules.get(&version) else {
                    let msg = format!(
                        "no fn module is loaded for version {version}; load the version's compiled module first"
                    );
                    drop(reply.send(Err(msg)));
                    return;
                };
                let path = loaded.path.clone();
                let ns = loaded.namespace.clone();
                let helpers = self.helpers.clone();
                let (started, tripped) = self.activity(id, deadline, |ctx| {
                    let ns = ns.restore(ctx).map_err(|e| e.to_string())?;
                    let helpers = helpers.restore(ctx).map_err(|e| e.to_string())?;
                    let call: Function = helpers.get("call").map_err(|e| e.to_string())?;
                    let promise: Promise = call
                        .call((ns, name.as_str(), data.as_str(), meta.as_str()))
                        .catch(ctx)
                        .map_err(|e| e.to_string())?;
                    Ok::<_, String>(Persistent::save(ctx, promise))
                });
                match started {
                    Ok(promise) => {
                        let job = Job::Call { name, path, reply };
                        self.tasks.insert(id, Task { promise, deadline, job });
                        if tripped {
                            self.end(id, End::TimedOut);
                        }
                    }
                    Err(e) => {
                        self.cancel_timers(id);
                        let msg = if tripped { call_timeout(&name, self.limit) } else { e };
                        drop(reply.send(Err(msg)));
                    }
                }
            }
        }
    }

    /// Fire the timers that are due, each as its owner, and fail an owner whose timer callback throws.
    fn fire_timers(&mut self) {
        let due = self.timers.borrow_mut().take_due(Instant::now());
        for (timer, owner, repeats) in due {
            // A timer of a task that is gone, or over its limit (the sweep stops it), doesn't fire.
            let Some(deadline) = self.tasks.get(&owner).map(|t| t.deadline).filter(|d| *d > Instant::now()) else {
                self.timers.borrow_mut().cancel(timer);
                self.forget(&[timer]);
                continue;
            };
            let helpers = self.helpers.clone();
            let (thrown, tripped) = self.activity(owner, deadline, |ctx| {
                let helpers = helpers.restore(ctx).map_err(|e| e.to_string())?;
                let fire: Function = helpers.get("fire").map_err(|e| e.to_string())?;
                let thrown: Option<String> =
                    fire.call((timer as f64, repeats)).catch(ctx).map_err(|e| e.to_string())?;
                Ok::<_, String>(thrown)
            });
            if tripped {
                self.end(owner, End::TimedOut);
            } else {
                match thrown {
                    Ok(None) => {}
                    Ok(Some(message)) | Err(message) => self.end(owner, End::Failed(message)),
                }
            }
        }
    }

    /// End the tasks that settled, timed out, or wait on nothing that could ever settle them.
    fn sweep(&mut self) {
        let now = Instant::now();
        let mut ended = Vec::new();
        self.ctx.with(|ctx| {
            for (id, task) in &self.tasks {
                let state = task.promise.clone().restore(&ctx).map(|p| p.state());
                match state {
                    Ok(PromiseState::Pending) if task.deadline <= now => ended.push((*id, End::TimedOut)),
                    Ok(PromiseState::Pending) => {}
                    Ok(_) => ended.push((*id, End::Settled)),
                    Err(e) => ended.push((*id, End::Failed(e.to_string()))),
                }
            }
        });
        for (id, how) in ended {
            self.end(id, how);
        }
        // Nothing queued and no timer anywhere: what's still pending can't settle (nothing else runs JS but a new
        // request, and a call isn't meant to wait for another one).
        if !self.tasks.is_empty() && self.timers.borrow().by_id.is_empty() && !self.rt.is_job_pending() {
            let stuck: Vec<u64> = self.tasks.keys().copied().collect();
            for id in stuck {
                self.end(id, End::Stuck);
            }
        }
    }

    /// Finish task `id`: cancel its timers and reply.
    fn end(&mut self, id: u64, how: End) {
        let Some(task) = self.tasks.remove(&id) else { return };
        self.cancel_timers(id);
        let limit = self.limit;
        let mb = self.memory_limit / (1024 * 1024);
        let Task { promise, job, .. } = task;
        match job {
            Job::Load { version, path, namespace, reply } => {
                let result = match how {
                    End::Settled => self.ctx.with(|ctx| match promise.restore(&ctx) {
                        Ok(p) => match p.result::<Value>() {
                            Some(Ok(_)) => Ok(()),
                            Some(Err(_)) => {
                                Err(format!("fn module {path} failed while loading: {}", shown(&ctx.catch())))
                            }
                            None => Err(format!("fn module {path} failed while loading: it did not finish")),
                        },
                        Err(e) => Err(e.to_string()),
                    }),
                    End::Failed(e) => Err(format!("fn module {path} failed while loading: {e}")),
                    End::TimedOut => Err(load_timeout(&path, limit)),
                    End::Stuck => {
                        Err(format!("fn module {path} failed while loading: its top-level await never settles"))
                    }
                };
                if result.is_ok() {
                    self.modules.insert(version, Loaded { path, namespace });
                    self.rt.run_gc();
                }
                drop(reply.send(result));
            }
            Job::Call { name, path, reply } => {
                let result = match how {
                    End::Settled => self.ctx.with(|ctx| {
                        let p = promise.restore(&ctx).map_err(|e| e.to_string())?;
                        let out: Object = match p.result::<Object>() {
                            Some(Ok(out)) => out,
                            Some(Err(_)) => return Err(shown(&ctx.catch())),
                            None => return Err(format!("fn.{name} did not finish")),
                        };
                        let get = |key: &str| out.get::<_, Option<String>>(key).map_err(|e| e.to_string());
                        if let Some(exports) = get("missing")? {
                            let has = if exports.is_empty() {
                                "it exports no functions".to_string()
                            } else {
                                format!("exports: {exports}")
                            };
                            return Err(format!("'{path}' does not export '{name}' ({has})"));
                        }
                        if let Some(message) = get("err")? {
                            if out.get::<_, bool>("null").unwrap_or(false) {
                                return Err(format!(
                                    "fn.{name} threw null: it probably ran out of memory (fn modules get {mb} MB)"
                                ));
                            }
                            return Err(message);
                        }
                        get("ok")
                    }),
                    End::Failed(e) => Err(e),
                    End::TimedOut => Err(call_timeout(&name, limit)),
                    End::Stuck => Err(format!(
                        "fn.{name} returned a Promise that never settles: it waits on nothing (no timer or job is pending)"
                    )),
                };
                let result = result.map_err(|e| {
                    if e == "out of memory" {
                        format!("fn.{name} ran out of memory (fn modules get {mb} MB)")
                    } else {
                        e
                    }
                });
                drop(reply.send(result));
            }
        }
    }

    fn cancel_timers(&mut self, owner: u64) {
        let ids = self.timers.borrow().owned_by(owner);
        if ids.is_empty() {
            return;
        }
        for id in &ids {
            self.timers.borrow_mut().cancel(*id);
        }
        self.forget(&ids);
    }

    /// Drop timers' callbacks on the JS side.
    fn forget(&self, ids: &[u64]) {
        self.ctx.with(|ctx| {
            if let Ok(forget) = self.helpers.clone().restore(&ctx).and_then(|h| h.get::<_, Function>("forget")) {
                for id in ids {
                    let _ = forget.call::<_, ()>((*id as f64,));
                }
            }
        });
    }
}

fn call_timeout(name: &str, limit: Duration) -> String {
    format!("fn.{name} ran longer than {} and was stopped", human(limit))
}

fn load_timeout(path: &str, limit: Duration) -> String {
    format!("fn module {path} ran longer than {} while loading and was stopped", human(limit))
}

fn shown(v: &Value) -> String {
    if let Some(ex) = v.as_exception() {
        return ex.message().unwrap_or_else(|| "an error with no message".into());
    }
    if let Some(Ok(Some(m))) = v.as_object().map(|o| o.get::<_, Option<String>>("message")) {
        return m;
    }
    v.get::<Coerced<String>>().map(|c| c.0).unwrap_or_else(|_| "a value that can't be shown".into())
}

fn human(d: Duration) -> String {
    if d.subsec_millis() == 0 { format!("{}s", d.as_secs()) } else { format!("{}ms", d.as_millis()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    fn module(code: &str) -> FnModule {
        FnModule { path: "./t.fn.ts".into(), hash: "h".into(), code: code.into(), exports: vec![] }
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
        js.load(1, &module("export function add(d, m) { return { sum: d.a + d.b, id: m.packet_id }; }")).await.unwrap();
        let r = js.call(1, "add", &json!({"a": 1, "b": 2}), &json!({"packet_id": "p1"})).await.unwrap();
        assert_eq!(r, Some(json!({"sum": 3, "id": "p1"})));
    }

    #[tokio::test]
    async fn awaits_an_async_export_and_maps_undefined_to_none() {
        let js = JsFns::new();
        let code = "export async function later(d) { await null; return [d.x, await Promise.resolve(2)]; }\n\
                    export function nothing() {}\nexport const isNull = (d) => d === null;";
        js.load(1, &module(code)).await.unwrap();
        assert_eq!(call(&js, 1, "later", json!({"x": 1})).await.unwrap(), Some(json!([1, 2])));
        assert_eq!(call(&js, 1, "nothing", json!({})).await.unwrap(), None);
        assert_eq!(call(&js, 1, "isNull", json!(null)).await.unwrap(), Some(json!(true)));
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
        assert_eq!(call(&js, 1, "later", json!({})).await.unwrap_err(), "async boom");
        assert_eq!(call(&js, 1, "raw", json!({})).await.unwrap_err(), "42");
        assert_eq!(call(&js, 1, "obj", json!({})).await.unwrap_err(), "[object Object]");
        assert!(call(&js, 1, "big", json!({})).await.unwrap_err().contains("BigInt"));
        // The runtime is still usable afterwards.
        js.load(2, &module("export const ok = () => 1;")).await.unwrap();
        assert_eq!(call(&js, 2, "ok", json!({})).await.unwrap(), Some(json!(1)));
    }

    #[tokio::test]
    async fn missing_export_and_unloaded_version() {
        let js = JsFns::new();
        js.load(1, &module("export function a() {}\nexport function b() {}\nexport const n = 1;")).await.unwrap();
        assert_eq!(call(&js, 1, "c", json!({})).await.unwrap_err(), "'./t.fn.ts' does not export 'c' (exports: a, b)");
        assert_eq!(call(&js, 1, "n", json!({})).await.unwrap_err(), "'./t.fn.ts' does not export 'n' (exports: a, b)");
        let e = call(&js, 7, "a", json!({})).await.unwrap_err();
        assert!(e.contains("no fn module is loaded for version 7"), "{e}");
    }

    #[tokio::test]
    async fn bad_modules_fail_to_load() {
        let js = JsFns::new();
        let e = js.load(1, &module("export function (")).await.unwrap_err();
        assert!(e.starts_with("fn module ./t.fn.ts doesn't compile"), "{e}");
        let e = js.load(1, &module("throw new Error('top level');")).await.unwrap_err();
        assert!(e.contains("top level"), "{e}");
        let e = js.load(1, &module("import fs from 'node:fs'; export const f = () => fs;")).await.unwrap_err();
        assert!(e.starts_with("fn module ./t.fn.ts"), "{e}");
    }

    #[tokio::test]
    async fn versions_side_by_side() {
        let js = JsFns::new();
        js.load(1, &module("let calls = 0; export function v() { calls++; return 'one:' + calls; }")).await.unwrap();
        js.load(2, &module("let calls = 0; export function v() { calls++; return 'two:' + calls; }")).await.unwrap();
        assert_eq!(call(&js, 1, "v", json!({})).await.unwrap(), Some(json!("one:1")));
        assert_eq!(call(&js, 2, "v", json!({})).await.unwrap(), Some(json!("two:1")));
        assert_eq!(call(&js, 1, "v", json!({})).await.unwrap(), Some(json!("one:2")));
        // Reloading a version replaces its module.
        js.load(1, &module("export function v() { return 'one again'; }")).await.unwrap();
        assert_eq!(call(&js, 1, "v", json!({})).await.unwrap(), Some(json!("one again")));
        assert_eq!(call(&js, 2, "v", json!({})).await.unwrap(), Some(json!("two:2")));
    }

    #[tokio::test]
    async fn runaway_code_is_interrupted() {
        let js = JsFns::with_options(JsOptions { call_limit: Duration::from_millis(200), ..JsOptions::default() });
        let code = "export function spin() { while (true) {} }\n\
                    export async function spinLater() { await null; for (;;) {} }\n\
                    export function guarded() { try { while (true) {} } catch (e) { return 'caught'; } }\n\
                    export const ok = (d) => d;";
        js.load(1, &module(code)).await.unwrap();
        let t = Instant::now();
        assert_eq!(call(&js, 1, "spin", json!({})).await.unwrap_err(), "fn.spin ran longer than 200ms and was stopped");
        assert!(t.elapsed() < Duration::from_secs(5));
        let e = call(&js, 1, "spinLater", json!({})).await.unwrap_err();
        assert_eq!(e, "fn.spinLater ran longer than 200ms and was stopped");
        let e = call(&js, 1, "guarded", json!({})).await.unwrap_err();
        assert_eq!(e, "fn.guarded ran longer than 200ms and was stopped", "an interrupt can't be caught");
        assert_eq!(call(&js, 1, "ok", json!(5)).await.unwrap(), Some(json!(5)));
        let e = js.load(2, &module("while (true) {}")).await.unwrap_err();
        assert_eq!(e, "fn module ./t.fn.ts ran longer than 200ms while loading and was stopped");
        assert_eq!(human(CALL_LIMIT), "30s");
    }

    #[tokio::test]
    async fn a_promise_that_never_settles_is_an_error() {
        let js = JsFns::new();
        js.load(1, &module("export function hang() { return new Promise(() => {}); }")).await.unwrap();
        let e = call(&js, 1, "hang", json!({})).await.unwrap_err();
        assert!(e.contains("never settles"), "{e}");
    }

    #[tokio::test]
    async fn memory_limit_stops_a_runaway_allocation() {
        let js = JsFns::with_options(JsOptions { memory_limit: 16 * 1024 * 1024, ..JsOptions::default() });
        let code = "export function grow() { const a = []; for (;;) a.push('x'.repeat(1024) + a.length); }\n\
                    export const ok = () => 'still here';";
        js.load(1, &module(code)).await.unwrap();
        let e = call(&js, 1, "grow", json!({})).await.unwrap_err();
        assert!(e.contains("out of memory") && e.contains("16 MB"), "{e}");
        assert_eq!(call(&js, 1, "ok", json!({})).await.unwrap(), Some(json!("still here")));
    }

    #[tokio::test]
    async fn unicode_and_numbers_round_trip() {
        let js = JsFns::new();
        js.load(1, &module("export const echo = (d) => d;\nexport const len = (d) => [...d.s].length;")).await.unwrap();
        let v = json!({
            "s": "héllo wörld — 你好 🎉 \u{0} \"q\" \\ \n",
            "n": [0, -1, 1.5, 1e21, 9007199254740991i64, -0.000001, 123456789.125, 1e-7],
            "nested": {"a": [true, false, null], "ünï": "✓"}
        });
        assert_eq!(call(&js, 1, "echo", v.clone()).await.unwrap(), Some(v));
        assert_eq!(call(&js, 1, "len", json!({"s": "a🎉b"})).await.unwrap(), Some(json!(3)));
    }

    #[tokio::test]
    async fn console_lines_go_to_the_log_callback() {
        let lines = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let sink = lines.clone();
        let js = JsFns::with_log(Box::new(move |level, text| sink.lock().unwrap().push((level.into(), text.into()))));
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
    async fn concurrent_sync_calls_each_run_once() {
        let js = Arc::new(JsFns::new());
        js.load(1, &module("let n = 0; export function inc() { return ++n; }")).await.unwrap();
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

    const SLEEP: &str = "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n";

    #[tokio::test]
    async fn a_slow_async_call_does_not_hold_back_a_fast_one() {
        let js = Arc::new(JsFns::new());
        let code = format!(
            "{SLEEP}export async function slow() {{ await sleep(300); return 'slow'; }}\nexport const fast = () => 'fast';"
        );
        js.load(1, &module(&code)).await.unwrap();
        let t = Instant::now();
        let slow = {
            let js = js.clone();
            tokio::spawn(async move { (call(&js, 1, "slow", json!({})).await.unwrap(), t.elapsed()) })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        let fast = call(&js, 1, "fast", json!({})).await.unwrap();
        let fast_at = t.elapsed();
        let (slow, slow_at) = slow.await.unwrap();
        assert_eq!((fast, slow), (Some(json!("fast")), Some(json!("slow"))));
        assert!(fast_at < Duration::from_millis(200), "fast took {fast_at:?}");
        assert!(slow_at >= Duration::from_millis(300) && fast_at < slow_at, "{fast_at:?} {slow_at:?}");
    }

    #[tokio::test]
    async fn set_timeout_with_args_clear_timeout_and_intervals() {
        let js = JsFns::new();
        let code = "export function args() { return new Promise((r) => setTimeout((a, b) => r(a + b), 10, 2, 3)); }\n\
                    export function cleared() { return new Promise((r) => { const t = setTimeout(() => r('fired'), 20); clearTimeout(t); setTimeout(() => r('kept'), 40); }); }\n\
                    export function order() { const seen = []; return new Promise((r) => { setTimeout(() => seen.push('b'), 20); setTimeout(() => seen.push('a'), 0); setTimeout(() => r(seen), 40); }); }\n\
                    export function ticks() { let n = 0; return new Promise((r) => { const i = setInterval(() => { if (++n === 3) { clearInterval(i); r(n); } }, 5); }); }\n\
                    export async function throwsLater() { await new Promise(() => setTimeout(() => { throw new Error('in a timer'); }, 5)); }";
        js.load(1, &module(code)).await.unwrap();
        assert_eq!(call(&js, 1, "args", json!({})).await.unwrap(), Some(json!(5)));
        assert_eq!(call(&js, 1, "cleared", json!({})).await.unwrap(), Some(json!("kept")));
        assert_eq!(call(&js, 1, "order", json!({})).await.unwrap(), Some(json!(["a", "b"])));
        assert_eq!(call(&js, 1, "ticks", json!({})).await.unwrap(), Some(json!(3)));
        assert_eq!(call(&js, 1, "throwsLater", json!({})).await.unwrap_err(), "in a timer");
    }

    #[tokio::test]
    async fn the_limit_counts_time_spent_sleeping() {
        let js = JsFns::with_options(JsOptions { call_limit: Duration::from_millis(150), ..JsOptions::default() });
        let code = format!(
            "{SLEEP}let after = 0;\nexport async function nap() {{ await sleep(10_000); after++; }}\nexport const count = () => after;\nexport async function short() {{ await sleep(20); return 'ok'; }}"
        );
        js.load(1, &module(&code)).await.unwrap();
        let t = Instant::now();
        let e = call(&js, 1, "nap", json!({})).await.unwrap_err();
        assert_eq!(e, "fn.nap ran longer than 150ms and was stopped");
        assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
        assert_eq!(call(&js, 1, "short", json!({})).await.unwrap(), Some(json!("ok")));
        // The stopped call's timer was cancelled: its continuation never runs.
        assert_eq!(call(&js, 1, "count", json!({})).await.unwrap(), Some(json!(0)));
    }

    #[tokio::test]
    async fn a_sync_runaway_is_interrupted_and_queued_calls_run_after() {
        let js =
            Arc::new(JsFns::with_options(JsOptions { call_limit: Duration::from_millis(300), ..JsOptions::default() }));
        let code = format!(
            "{SLEEP}export async function nap() {{ await sleep(100); return 'rested'; }}\nexport function spin() {{ for (;;) {{}} }}"
        );
        js.load(1, &module(&code)).await.unwrap();
        let spin = {
            let js = js.clone();
            tokio::spawn(async move { call(&js, 1, "spin", json!({})).await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        // Sent while the loop spins: its clock starts when the thread takes it, once the runaway is stopped.
        assert_eq!(call(&js, 1, "nap", json!({})).await.unwrap(), Some(json!("rested")));
        assert_eq!(spin.await.unwrap().unwrap_err(), "fn.spin ran longer than 300ms and was stopped");
    }

    #[tokio::test]
    async fn many_sleeping_calls_overlap() {
        let js = Arc::new(JsFns::new());
        let code = format!("{SLEEP}export async function nap(d) {{ await sleep(50); return d.i; }}");
        js.load(1, &module(&code)).await.unwrap();
        let t = Instant::now();
        let tasks: Vec<_> = (0..50)
            .map(|i| {
                let js = js.clone();
                tokio::spawn(async move { call(&js, 1, "nap", json!({"i": i})).await.unwrap() })
            })
            .collect();
        for (i, task) in tasks.into_iter().enumerate() {
            assert_eq!(task.await.unwrap(), Some(json!(i)));
        }
        assert!(t.elapsed() < Duration::from_millis(1000), "50 x 50 ms took {:?}", t.elapsed());
    }

    #[tokio::test]
    async fn a_promise_waiting_on_nothing_fails_fast_even_beside_a_sleeper() {
        let js = Arc::new(JsFns::new());
        let code = format!(
            "{SLEEP}export function hang() {{ return new Promise(() => {{}}); }}\nexport async function nap() {{ await sleep(200); return 1; }}"
        );
        js.load(1, &module(&code)).await.unwrap();
        let t = Instant::now();
        let e = call(&js, 1, "hang", json!({})).await.unwrap_err();
        assert!(e.contains("never settles"), "{e}");
        assert!(t.elapsed() < Duration::from_millis(100), "{:?}", t.elapsed());
        // Beside a sleeping call it waits until nothing is pending, then fails.
        let nap = {
            let js = js.clone();
            tokio::spawn(async move { call(&js, 1, "nap", json!({})).await })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        let e = call(&js, 1, "hang", json!({})).await.unwrap_err();
        assert!(e.contains("never settles"), "{e}");
        assert_eq!(nap.await.unwrap().unwrap(), Some(json!(1)));
    }

    #[tokio::test]
    async fn a_module_may_await_a_timer_while_loading() {
        let js = JsFns::new();
        let code = "const ready = await new Promise((r) => setTimeout(() => r('ready'), 10));\nexport const state = () => ready;";
        js.load(1, &module(code)).await.unwrap();
        assert_eq!(call(&js, 1, "state", json!({})).await.unwrap(), Some(json!("ready")));
    }
}
