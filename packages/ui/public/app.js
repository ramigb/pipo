// Pipo dashboard (docs/spec.md §8). Hash routes: #/ pipeline cards, #/p/<name> graph, logs, agent feed, DLQ and
// versions tabs, #/p/<name>/<packet id> inspector, #/build… the builder (builder.js). Live through /events (SSE),
// which also keeps the engine awake (D61); falls back to polling /api every 2 s when the stream is down, and to the
// "napping" screen when the engine can't be reached. Everything from the API is rendered as text nodes, never HTML.
import { ApiError, api, clean, EngineDown, h, morph, s, toast } from "./dom.js";
import { autoLayout, edgePath } from "./layout.js";
import {
  badge,
  cheer,
  connectorEmoji,
  dash,
  fmtAge,
  fmtJson,
  fmtLeft,
  fmtTime,
  kindEmoji,
  mascot,
  plural,
} from "./look.js";

const app = document.getElementById("app");
const $live = document.getElementById("live");
const $engine = document.getElementById("engine");
document.getElementById("logo").append(mascot("happy", 30));

// ---- theme: auto -> light -> dark ----
const root = document.documentElement;
const THEMES = ["auto", "light", "dark"];
const THEME_ICON = { auto: "🌗", light: "☀️", dark: "🌙" };
const $theme = document.getElementById("theme");
try {
  const saved = localStorage.getItem("pipo-theme");
  if (saved) root.dataset.theme = saved;
} catch {}
const themeLabel = () => {
  const m = THEMES.includes(root.dataset.theme) ? root.dataset.theme : "auto";
  $theme.textContent = THEME_ICON[m];
  $theme.title = `Theme: ${m}. Click to switch.`;
};
$theme.onclick = () => {
  const next = THEMES[(THEMES.indexOf(root.dataset.theme ?? "auto") + 1) % THEMES.length];
  try {
    if (next === "auto") localStorage.removeItem("pipo-theme");
    else localStorage.setItem("pipo-theme", next);
  } catch {}
  if (next === "auto") delete root.dataset.theme;
  else root.dataset.theme = next;
  themeLabel();
};
themeLabel();

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

// ---- rendering ----
let fresh = true;
const show = (...kids) => {
  const nodes = clean(kids);
  if (fresh || !app.firstChild) {
    fresh = false;
    app.replaceChildren(...nodes);
    return;
  }
  const next = app.cloneNode(false);
  next.append(...nodes);
  morph(app, next);
};

const lifetimeCell = (lt) =>
  lt?.ends_at
    ? h(
        "span",
        { class: "left", "data-ends": lt.ends_at, title: `ttl ${lt.ttl}, ends ${lt.ends_at}` },
        fmtLeft(Date.parse(lt.ends_at) - Date.now()),
      )
    : h(
        "span",
        { class: "muted", title: lt?.ttl ? `ttl ${lt.ttl}` : "no lifetime.ttl" },
        lt?.ttl ? `ttl ${lt.ttl}` : "∞",
      );
setInterval(() => {
  for (const el of document.querySelectorAll("[data-ends]")) {
    el.textContent = fmtLeft(Date.parse(el.dataset.ends) - Date.now());
  }
}, 1000);

const thead = (cols, numIdx = [], optIdx = [], cls = {}) =>
  h(
    "thead",
    null,
    h(
      "tr",
      null,
      cols.map((c, i) =>
        h(
          "th",
          {
            class: [numIdx.includes(i) ? "num" : "", optIdx.includes(i) ? "opt" : "", cls[i] ?? ""]
              .filter(Boolean)
              .join(" "),
          },
          c,
        ),
      ),
    ),
  );
// Error messages often start with "Packet <id>"; the id is already in the row, so drop it.
const errText = (msg, id) => {
  const m = msg ?? "";
  return m.startsWith(`Packet ${id}`) ? m.slice(`Packet ${id}`.length).replace(/^[:\s]+/, "") || m : m;
};
const wrap = (table) => h("div", { class: "card flush scroll" }, table);
const errorCard = (e) =>
  h(
    "div",
    { class: "card oops" },
    h("div", { class: "oops-title" }, "😬 ", e.message ?? String(e)),
    e.hint ? h("div", { class: "hint" }, "💡 ", e.hint) : null,
  );
/** A friendly empty state: Pipo, a line, and an optional nudge. */
const empty = (text, nudge, mood = "happy") =>
  h(
    "div",
    { class: "empty" },
    mascot(mood, 56),
    h("div", null, h("p", null, text), nudge ? h("p", { class: "muted" }, nudge) : null),
  );
const section = (title, ...kids) => h("section", { class: "block" }, h("h2", null, title), ...kids);

// ---- engine status and the napping screen ----
let down = false;
let wake = null;
// An engine older than Pipo's code on disk (D64): it says so (`code_changed`), or is too old to say at all.
const $banner = document.getElementById("banner");
let bannerShut = false;
function outdated(info) {
  if (restarting) return;
  const old = info.code_changed === true || !("code_changed" in info);
  if (!old || bannerShut) {
    $banner.hidden = true;
    return;
  }
  $banner.hidden = false;
  $banner.replaceChildren(
    h(
      "div",
      { class: "banner card" },
      h("span", { class: "banner-emoji", "aria-hidden": "true" }, "🔄"),
      h(
        "div",
        null,
        h("b", null, "Pipo was updated since this engine started."),
        " Some buttons may not work until it restarts.",
        // An engine from before D64/D65 has no restart route: it can only be restarted from a terminal.
        "code_changed" in info
          ? null
          : [
              " Run ",
              h("code", null, "pipo engine stop"),
              ", then ",
              h("code", null, "pipo ui"),
              " and open the link it prints.",
            ],
      ),
      "code_changed" in info
        ? h("button", { type: "button", class: "btn small primary", onclick: restartEngine }, "🔄 Restart now")
        : null,
      h(
        "button",
        {
          type: "button",
          class: "icon-btn",
          title: "Hide until the next page load",
          onclick: () => {
            bannerShut = true;
            $banner.hidden = true;
          },
        },
        "✖️",
      ),
    ),
  );
}

// Restart from the banner (D65): the engine hands over to a fresh one on this same address, then this page reloads.
let restarting = null; // the old engine's pid while it hands over
async function restartEngine() {
  const running = await api("/pipelines")
    .then((r) => r.pipelines.filter((p) => p.state === "running" && !p.detached).length)
    .catch(() => 0);
  const ok = confirm(
    `Restart the engine?\n\nIt finishes what's in flight, stops, and a fresh one starts at this same address${
      running ? `, starting your ${plural(running, "running pipeline")} again` : ""
    }. This page reloads by itself.`,
  );
  if (!ok) return;
  let r;
  try {
    r = await api("/engine/restart", {});
  } catch (e) {
    if (e instanceof EngineDown) return napping();
    return toast(`Couldn't restart: ${e.message}`, "bad", e.hint);
  }
  restarting = r.from ?? window.pipoEngine?.pid ?? null;
  $banner.hidden = false;
  $banner.replaceChildren(
    h(
      "div",
      { class: "banner card" },
      h("span", { class: "banner-emoji", "aria-hidden": "true" }, "⏳"),
      h(
        "div",
        null,
        h("b", null, "Restarting the engine…"),
        r.pipelines?.length ? ` ${r.pipelines.join(", ")} will start again.` : "",
        " This page reloads when the new one is up.",
      ),
    ),
  );
  const until = Date.now() + 15 * 60_000;
  const poll = setInterval(async () => {
    try {
      const res = await fetch("/api/engine", { cache: "no-store" });
      if (res.ok) {
        const j = await res.json();
        if (j.pid !== restarting && j.ready) {
          clearInterval(poll);
          location.reload();
          return;
        }
      }
    } catch {}
    if (Date.now() > until) {
      clearInterval(poll);
      toast("The new engine didn't come up 😬", "bad", "see logs/engine.log in your Pipo home, then run pipo ui");
    }
  }, 1000);
}

// Stop the engine from the dashboard, as `pipo engine stop` does: pipelines drain, detached runners keep running.
let stopped = false;
async function stopEngine() {
  const live = await api("/pipelines")
    .then((r) => r.pipelines.filter((p) => p.state === "running"))
    .catch(() => []);
  const drained = live.filter((p) => !p.detached).length;
  const detached = live.length - drained;
  const ok = confirm(
    `Stop the engine?\n\n${
      drained ? `Your ${plural(drained, "running pipeline")} finish what's in flight and stop. ` : ""
    }${detached ? `${plural(detached, "detached runner")} keep running on their own. ` : ""}The dashboard goes offline until you run pipo ui again.`,
  );
  if (!ok) return;
  try {
    await api("/engine/stop", {});
  } catch (e) {
    if (e instanceof EngineDown) return napping();
    return toast(`Couldn't stop the engine: ${e.message}`, "bad", e.hint);
  }
  stopped = true;
  toast("Stopping the engine 👋 pipelines are draining");
}
const stopEngineBtn = (cls = "btn") =>
  h("button", { type: "button", class: `${cls} danger`, onclick: stopEngine }, "⏻ Stop engine");

// A page left open across an update learns about it too.
setInterval(async () => {
  if (down) return;
  try {
    const r = await fetch("/api/engine", { cache: "no-store" });
    if (r.ok) outdated(await r.json());
  } catch {}
}, 30_000);

function setEngine(info) {
  outdated(info);
  $engine.textContent = info.idle ? `😌 idle · pid ${info.pid}` : `✨ awake · pid ${info.pid}`;
  $engine.className = "chip ok";
  $engine.title = `engine ${info.engine_id ?? ""} · ${plural(info.pipelines, "pipeline")} · workspace ${info.workspace ?? "?"}`;
  window.pipoEngine = info;
}
function napping() {
  if (down) return;
  down = true;
  stream?.close();
  stream = null;
  streamKey = undefined;
  $engine.textContent = restarting ? "🔄 restarting" : "😴 napping";
  $engine.className = restarting ? "chip warn" : "chip bad";
  $live.textContent = "offline";
  $live.className = "chip bad";
  fresh = true;
  if (restarting) {
    // restartEngine() reloads the page once the new engine answers
    show(
      h(
        "div",
        { class: "nap" },
        mascot("sleepy", 140),
        h("h1", null, "Restarting the engine 🔄"),
        h(
          "p",
          { class: "muted" },
          "The old one is finishing what's in flight; a fresh one starts right after, at this same address. This page reloads by itself.",
        ),
        h("div", { class: "dots", "aria-hidden": "true" }, h("span", null), h("span", null), h("span", null)),
      ),
    );
    return;
  }
  show(
    h(
      "div",
      { class: "nap" },
      mascot("sleepy", 140),
      h("h1", null, stopped ? "The engine is stopped 👋" : "The engine is napping 😴"),
      h(
        "p",
        { class: "muted" },
        stopped
          ? "You stopped it, so there's nothing to show right now. Start it again from a terminal:"
          : "It went to sleep or stopped, so there's nothing to show right now. Wake it up from a terminal:",
      ),
      h("pre", { class: "cmd" }, "pipo ui"),
      h(
        "p",
        { class: "muted small" },
        "This page checks every few seconds and comes back by itself. If the engine wakes on a new port, ",
        h("code", null, "pipo ui"),
        " opens a fresh tab for you.",
      ),
      h("div", { class: "dots", "aria-hidden": "true" }, h("span", null), h("span", null), h("span", null)),
    ),
  );
  wake = setInterval(async () => {
    try {
      const r = await fetch("/api/engine", { cache: "no-store" });
      if (!r.ok) return;
      clearInterval(wake);
      wake = null;
      down = false;
      stopped = false;
      toast("The engine is back! 🌞");
      render();
    } catch {}
  }, 2500);
}

// ---- live updates ----
let refresh = null;
let timer = null;
function schedule() {
  if (timer || !refresh || down) return;
  timer = setTimeout(() => {
    timer = null;
    refresh?.();
  }, 400);
}
// Does this event change what the current view shows? The logs tab follows the log file on its own timer, and a
// packet inspector only cares about its own packet and pipeline-level events.
function relevant(e) {
  const [, kind, , id] = location.hash.split("/");
  if (kind === "build") return false;
  if (kind === "p" && id) return !e.packet_id || e.packet_id === decodeURIComponent(id);
  if (kind === "p" && pipelineView.tab === "logs") return false;
  return true;
}
let poll = null;
let stream = null;
let streamKey;
// One filtered stream per pipeline view (/events?pipeline=<name>), the unfiltered one elsewhere. An open stream keeps
// the engine awake (D61), so the dashboard always holds one.
function connect(pipeline = null) {
  if (stream && streamKey === pipeline) return;
  stream?.close();
  streamKey = pipeline;
  const es = new EventSource(pipeline ? `/events?pipeline=${encodeURIComponent(pipeline)}` : "/events");
  stream = es;
  es.onopen = () => {
    $live.textContent = "🟢 live";
    $live.className = "chip ok";
    if (poll) clearInterval(poll);
    poll = null;
  };
  es.onmessage = (m) => {
    let e = {};
    try {
      e = JSON.parse(m.data);
    } catch {}
    flow(e);
    dispatchEvent(new CustomEvent("pipo:event", { detail: e }));
    if (relevant(e)) schedule();
  };
  es.addEventListener("state", () => schedule());
  es.onerror = () => {
    $live.textContent = "🟡 polling";
    $live.className = "chip warn";
    if (!poll) poll = setInterval(() => refresh?.(), 2000);
  };
}

// A packet moving through the live graph: a dot runs along the edges out of the node that just finished.
function flow(e) {
  if (reducedMotion.matches || !e.type) return;
  const svg = document.querySelector("svg.graph-svg");
  if (!svg || svg.dataset.pipeline !== e.pipeline) return;
  let from = null;
  if (e.type === "packet.accepted") from = "input";
  else if (e.type === "node.done" || e.type === "node.looped") from = e.node;
  if (!from) return;
  const branch = e.detail?.branch;
  for (const path of svg.querySelectorAll("path.edge")) {
    if (path.dataset.from !== from) continue;
    if (branch && path.dataset.branch && path.dataset.branch !== branch) continue;
    const motion = s("animateMotion", {
      dur: "0.9s",
      begin: "indefinite",
      fill: "freeze",
      path: path.getAttribute("d"),
    });
    const dot = s("circle", { r: 5, class: "packet-dot", "data-fx": "" }, motion);
    svg.append(dot);
    motion.beginElement?.();
    setTimeout(() => dot.remove(), 1000);
  }
  const box = svg.querySelector(`g.gnode[data-id="${CSS.escape(from)}"]`);
  if (box) {
    box.classList.remove("pulse");
    void box.getBoundingClientRect();
    box.classList.add("pulse");
  }
}

async function act(label, path, body, okText) {
  try {
    await api(path, body ?? {});
    toast(okText ?? `${label}: done`);
  } catch (e) {
    if (e instanceof EngineDown) return napping();
    toast(`${label} failed: ${e.message}`, "bad", e.hint);
  }
  refresh?.();
}

// ---- views ----
const statsFor = async (p) => {
  const st = p.stats;
  if (st)
    return {
      per_min: st.throughput_per_min,
      pending: st.pending ?? st.in_flight,
      delivered: st.delivered,
      dead_lettered: st.dead_lettered,
      oldest_ms: st.oldest_pending_age_ms,
    };
  if (p.state !== "running") return null;
  const r = await api(`/pipelines/${encodeURIComponent(p.name)}`)
    .then((d) => d.runner?.stats ?? null)
    .catch(() => null);
  return (
    r && {
      per_min: r.in_per_min,
      pending: r.pending,
      delivered: r.delivered,
      dead_lettered: r.dead_lettered,
      oldest_ms: null,
    }
  );
};
const greeting = () => {
  const hr = new Date().getHours();
  return hr < 5
    ? "Burning the midnight oil 🌙"
    : hr < 12
      ? "Good morning ☀️"
      : hr < 18
        ? "Good afternoon 🌤️"
        : "Good evening 🌆";
};
const mini = (emoji, label, value, cls = "") =>
  h(
    "div",
    { class: `mini ${cls}`, title: label },
    h("span", { class: "mini-emoji", "aria-hidden": "true" }, emoji),
    h("b", null, dash(value)),
    h("span", { class: "mini-label" }, label),
  );
const shownState = (p) => (p.state === "running" && p.status && p.status !== "active" ? p.status : p.state);

// The workspace's .pipo files (/builder/files) can take a while to walk on a big or slow disk: the list renders at
// once with the files it last saw, and again when a newer listing arrives.
let wsFiles = null;
let wsLoading = null;
const onList = () => {
  const [, kind, name] = location.hash.split("/");
  return !["build", "bots", "settings", "top"].includes(kind) && !(kind === "p" && name);
};
function loadWorkspaceFiles() {
  if (wsLoading) return;
  wsLoading = api("/builder/files")
    .then((ws) => {
      const changed = JSON.stringify(ws.files) !== JSON.stringify(wsFiles);
      wsFiles = ws.files;
      if (changed && onList()) refresh?.();
    })
    .catch(() => {
      wsFiles ??= [];
    })
    .finally(() => {
      wsLoading = null;
    });
}

async function listView() {
  loadWorkspaceFiles();
  const [{ pipelines }, info] = await Promise.all([api("/pipelines"), api("/engine")]);
  setEngine(info);
  const known = new Set(pipelines.map((p) => p.name));
  const looking = wsFiles === null;
  const idle = (wsFiles ?? []).filter((f) => f.name && !known.has(f.name));
  const stats = await Promise.all(pipelines.map(statsFor));
  const running = pipelines.filter((p) => p.state === "running").length;
  const dlq = stats.reduce((n, st) => n + (st?.dead_lettered ?? 0), 0);
  const cards = pipelines.map((p, i) => {
    const st = stats[i];
    const state = shownState(p);
    return h(
      "a",
      { class: "pcard", "data-state": state, href: `#/p/${p.name}` },
      h("div", { class: "pcard-top" }, h("span", { class: "pname" }, p.name), badge(state)),
      h(
        "div",
        { class: "pcard-meta muted" },
        h("span", null, `v${dash(p.version)}`),
        h("span", null, "⏱️ ", lifetimeCell(p.lifetime)),
        st?.oldest_ms ? h("span", null, `🐢 oldest ${fmtAge(st.oldest_ms)}`) : null,
      ),
      h(
        "div",
        { class: "minis" },
        mini("📨", "in/min", st?.per_min),
        mini("⏳", "pending", st?.pending),
        mini("✅", "delivered", st?.delivered),
        mini("💀", "dlq", st?.dead_lettered, st?.dead_lettered ? "hot" : ""),
      ),
    );
  });
  show(
    h(
      "section",
      { class: "hero" },
      mascot(pipelines.length ? "happy" : "wow", 72),
      h(
        "div",
        { class: "hero-text" },
        h("h1", null, greeting()),
        h(
          "p",
          { class: "muted" },
          pipelines.length
            ? `${plural(pipelines.length, "pipeline")} · ${running} running · ${dlq ? `${plural(dlq, "dead letter")} 💀` : "no dead letters 🎉"}`
            : idle.length
              ? "Nothing running yet. Pick one below, or make a new one!"
              : looking
                ? "Looking for pipelines in your workspace…"
                : "No pipelines yet. Let's make your first one!",
        ),
      ),
      h("a", { class: "btn primary", href: "#/build" }, "✨ New pipeline"),
    ),
    pipelines.length
      ? h(
          "div",
          { class: "cards" },
          cards,
          h("a", { class: "pcard ghost", href: "#/build" }, h("span", null, "➕"), " Build another one"),
        )
      : idle.length || looking
        ? null
        : empty(
            "Nothing flowing yet.",
            "Open the builder and drag a few blocks together, or run: pipo start <file.pipo>",
            "wow",
          ),
    idle.length
      ? section(
          `🧰 Ready to run (${idle.length})`,
          h(
            "div",
            { class: "cards" },
            idle.map((f) =>
              h(
                "div",
                { class: "pcard", "data-state": "stopped" },
                h("div", { class: "pcard-top" }, h("span", { class: "pname" }, f.name)),
                h("div", { class: "pcard-meta muted mono", title: f.file }, f.rel),
                h(
                  "div",
                  { class: "toolbar" },
                  h(
                    "button",
                    {
                      type: "button",
                      class: "btn small primary",
                      onclick: () => act("Start", "/pipelines", { file: f.file }, `Started ${f.name} 🌱`),
                    },
                    "▶️ Run",
                  ),
                  h("a", { class: "btn small", href: `#/build/f/${encodeURIComponent(f.file)}` }, "✏️ Edit"),
                ),
              ),
            ),
          ),
        )
      : null,
  );
}

// Pause/resume, drain, stop, restart or start, by the pipeline's state: shared by its page and the task manager.
function controls(name, state, status, cls = "btn") {
  const base = `/pipelines/${encodeURIComponent(name)}`;
  const running = state === "running";
  const btn = (label, disabled, onclick) => h("button", { type: "button", class: cls, disabled, onclick }, label);
  const sure = (q, f) => () => confirm(q) && f();
  return [
    status === "paused"
      ? btn("▶️ Resume", !running, () => act("Resume", `${base}/resume`, {}, "Back to work ▶️"))
      : btn("⏸️ Pause", !running, () => act("Pause", `${base}/pause`, {}, "Paused ⏸️")),
    btn(
      "🚰 Drain",
      !running || status === "draining",
      sure(`Drain ${name}? It stops taking new input and finishes what is in flight.`, () =>
        act("Drain", `${base}/drain`, {}, "Draining 🚰 it stops once its packets are done"),
      ),
    ),
    state === "stopped" || state === "failed"
      ? btn("🌱 Start", false, () => act("Start", `${base}/start`, {}, "Started 🌱"))
      : btn(
          "⏹️ Stop",
          state === "stopping" || state === "unreachable",
          sure(`Stop ${name}? Packets in flight stay in the journal and resume on the next start.`, () =>
            act("Stop", `${base}/stop`, {}, "Stopped ⏹️"),
          ),
        ),
    btn(
      "🔄 Restart",
      state === "stopping" || state === "unreachable",
      sure(`Restart ${name}?`, () => act("Restart", `${base}/restart`, {}, "Restarted 🔄")),
    ),
  ];
}
const fmtBytes = (n) =>
  n >= 1 << 30
    ? `${(n / (1 << 30)).toFixed(1)} GB`
    : n >= 1 << 20
      ? `${Math.round(n / (1 << 20))} MB`
      : `${Math.round(n / 1024)} KB`;

// ---- the task manager: what each pipeline costs right now, with its controls ----
async function topView() {
  const [{ pipelines }, info] = await Promise.all([api("/pipelines"), api("/engine")]);
  setEngine(info);
  const live = pipelines.filter((p) => p.resources);
  const cpu = live.reduce((n, p) => n + p.resources.cpu, 0);
  const rss = live.reduce((n, p) => n + p.resources.rss, 0);
  const rows = [...pipelines].sort((a, b) => (b.resources?.cpu ?? -1) - (a.resources?.cpu ?? -1));
  show(
    h(
      "section",
      { class: "hero" },
      mascot("happy", 72),
      h(
        "div",
        { class: "hero-text" },
        h("h1", null, "Task manager 🧮"),
        h(
          "p",
          { class: "muted" },
          `${plural(live.length, "runner")} · ${Math.round(cpu * 10) / 10}% cpu · ${fmtBytes(rss)} memory · live every 2 s`,
        ),
      ),
      stopEngineBtn(),
    ),
    pipelines.length
      ? wrap(
          h(
            "table",
            null,
            thead(
              ["pipeline", "state", "pid", "cpu", "memory", "procs", "in/min", "pending", ""],
              [2, 3, 4, 5, 6, 7],
              [2, 5, 6],
            ),
            h(
              "tbody",
              null,
              rows.map((p) => {
                const r = p.resources;
                const st = p.stats;
                return h(
                  "tr",
                  null,
                  h("td", null, h("a", { href: `#/p/${p.name}` }, p.name)),
                  h("td", null, badge(shownState(p))),
                  h("td", { class: "num opt mono" }, dash(p.pid)),
                  h("td", { class: "num" }, r ? `${r.cpu}%` : "—"),
                  h("td", { class: "num" }, r ? fmtBytes(r.rss) : "—"),
                  h("td", { class: "num opt" }, dash(r?.procs)),
                  h("td", { class: "num opt" }, dash(st?.throughput_per_min)),
                  h("td", { class: "num" }, dash(st?.pending ?? st?.in_flight)),
                  h("td", null, h("div", { class: "toolbar" }, controls(p.name, p.state, p.status, "btn small"))),
                );
              }),
            ),
          ),
        )
      : empty("Nothing running.", "Start one with: pipo start <file.pipo>", "wow"),
  );
}
setInterval(() => {
  if (location.hash.startsWith("#/top") && !down) refresh?.();
}, 2000);

// ---- chat bots (§3.13, D69): the Telegram bots pipelines use, in <home>/bots.json. Tokens go in, never out. ----
const botField = (label, control, hint) =>
  h(
    "label",
    { class: "field" },
    h("span", { class: "field-label" }, label),
    control,
    hint ? h("span", { class: "field-hint" }, hint) : null,
  );

async function botAct(label, path, body) {
  try {
    const res = await api(path, body ?? {});
    if (res.ok === false) return toast(`${label}: ${res.error}`, "bad");
    toast(res.username ? `${label}: @${res.username} answered` : `${label}: done`);
  } catch (e) {
    if (e instanceof EngineDown) return napping();
    return toast(`${label} failed: ${e.message}`, "bad", e.hint);
  }
  if (location.hash === "#/bots") render();
  else location.hash = "#/bots";
}

async function botsView(editing) {
  const { telegram } = await api("/bots");
  const bot = telegram.bots.find((b) => b.name === editing);
  const name = h("input", { value: bot?.name ?? "", placeholder: "main", autocomplete: "off" });
  const token = h("input", {
    type: "password",
    autocomplete: "off",
    placeholder: bot ? "leave empty to keep the current token" : "123456:ABC... from @BotFather, or op://... / env:...",
  });
  const allow = h("input", { value: (bot?.allow ?? []).join(", "), placeholder: "12345678, 87654321" });
  const poll = h("input", { value: bot?.poll_every ?? "", placeholder: "25s" });
  const def = h("input", { type: "checkbox", checked: bot ? bot.default : !telegram.bots.length });
  const save = (ev) => {
    ev.preventDefault();
    const ids = allow.value.split(/[\s,]+/).filter(Boolean);
    if (ids.some((x) => !/^-?\d+$/.test(x)))
      return toast("The allow list takes numeric ids only", "bad", "message the bot: the pipeline's log names your id");
    const newName = name.value.trim();
    const body = {
      allow: ids.map(Number),
      poll_every: poll.value.trim() || null,
      ...(token.value.trim() ? { token: token.value.trim() } : {}),
      ...(def.checked ? { default: true } : {}),
      ...(bot && newName !== bot.name ? { rename: newName } : {}),
    };
    botAct(`Bot ${newName}`, `/bots/telegram/${encodeURIComponent(bot ? bot.name : newName)}`, body);
  };
  const card = (b) =>
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "toolbar" },
        h("b", null, `✈️ ${b.name}`),
        b.default ? h("span", { class: "chip ok" }, "default") : null,
        h("span", { class: "spacer" }),
        h(
          "button",
          { class: "btn small", type: "button", onclick: () => botAct("Test", `/bots/telegram/${b.name}/test`) },
          "🔌 Test",
        ),
        h("a", { class: "btn small", href: `#/bots/${encodeURIComponent(b.name)}` }, "✏️ Edit"),
        b.default
          ? null
          : h(
              "button",
              {
                class: "btn small",
                type: "button",
                onclick: () => botAct("Default", `/bots/telegram/${b.name}`, { default: true }),
              },
              "⭐ Make default",
            ),
        h(
          "button",
          {
            class: "btn small danger",
            type: "button",
            onclick: () =>
              confirm(`Remove bot ${b.name}? Pipelines that use it won't start.`) &&
              botAct("Remove", `/bots/telegram/${b.name}/delete`),
          },
          "🗑️ Remove",
        ),
      ),
      h(
        "p",
        { class: "muted" },
        b.bot_id ? `bot id ${b.bot_id} · token saved` : `token from ${b.token}`,
        ` · ${b.allow.length ? `accepts ${b.allow.join(", ")}` : "accepts nobody yet"}`,
        ` · polls ${b.poll_every ?? "25s"}`,
      ),
    );
  show(
    h(
      "section",
      { class: "hero" },
      mascot("happy", 72),
      h(
        "div",
        { class: "hero-text" },
        h("h1", null, "Bots 🤖"),
        h(
          "p",
          { class: "muted" },
          "Telegram bots your pipelines read from and send with. A running pipeline picks up a change when it restarts.",
        ),
      ),
    ),
    telegram.bots.length
      ? section("Telegram", ...telegram.bots.map(card))
      : empty("No bots yet.", "In Telegram, message @BotFather, send /newbot, and paste the token below.", "wow"),
    section(
      bot ? `Edit ${bot.name}` : "Add a Telegram bot",
      h(
        "form",
        { class: "card", onsubmit: save },
        h(
          "div",
          { class: "grid2" },
          botField("Name", name, "pipelines pick it with `with: { bot: <name> }`"),
          botField("Token", token, "kept in ~/.pipo/bots.json (owner only); never shown again"),
          botField("Allow", allow, "chat or user ids that may talk to it; the log names anyone else who tries"),
          botField("Poll every", poll, "how long one poll waits for messages (at least 1s)"),
        ),
        h("label", { class: "toolbar" }, def, " Default bot (used when a pipeline names none)"),
        h(
          "div",
          { class: "toolbar" },
          h("button", { class: "btn primary", type: "submit" }, bot ? "💾 Save" : "➕ Add bot"),
          bot ? h("a", { class: "btn", href: "#/bots" }, "Cancel") : null,
        ),
      ),
    ),
    section(
      "Use it",
      h(
        "pre",
        { class: "card mono" },
        "input: { via: telegram }               # messages to the default bot\n" +
          "nodes:\n  ping: { from: input, tap: telegram, with: { bot: alerts, chat_id: 123, text: 'got ${data.text}' } }\n" +
          "output: { from: ping, to: telegram, with: { text: 'thanks!' } }   # replies to the sender",
      ),
    ),
  );
}

// ---- the live graph ----
const narrow = matchMedia("(max-width: 640px)");
narrow.onchange = () => refresh?.();
function graphSvg(graph, onPick, picked, held = new Map()) {
  const { pos, width, height } = autoLayout(graph.nodes, { stacked: narrow.matches });
  const edges = [];
  for (const n of graph.nodes) {
    for (const f of n.from) {
      const a = pos.get(f.node);
      const b = pos.get(n.id);
      if (!a || !b) continue;
      const d = narrow.matches
        ? `M${a.x + a.w / 2},${a.y + a.h} C${a.x + a.w / 2 + (b.y > a.y + a.h + 40 ? 80 : 0)},${(a.y + a.h + b.y) / 2} ${b.x + b.w / 2},${(a.y + a.h + b.y) / 2} ${b.x + b.w / 2},${b.y}`
        : edgePath(a, b);
      edges.push(s("path", { class: "edge", d, "data-from": f.node, "data-branch": f.branch ?? "" }));
      if (f.branch) {
        const lx = narrow.matches ? a.x + a.w / 2 + 8 : (a.x + a.w + b.x) / 2;
        const ly = narrow.matches ? a.y + a.h + 14 : (a.y + a.h / 2 + b.y + b.h / 2) / 2 - 6;
        edges.push(
          s(
            "text",
            { class: "edge-label", x: lx, y: ly, "text-anchor": narrow.matches ? "start" : "middle" },
            f.branch,
          ),
        );
      }
    }
  }
  const boxes = graph.nodes.map((n) => {
    const p = pos.get(n.id);
    const c = n.counts;
    const label = n.label ? `${connectorEmoji(n.label)} ${n.label}` : n.kind;
    return s(
      "g",
      {
        class: `gnode k-${n.kind}${c.failed ? " hot" : ""}${picked === n.id ? " sel" : ""}`,
        "data-id": n.id,
        transform: `translate(${p.x},${p.y})`,
        tabindex: 0,
        role: "button",
        "aria-label": `${n.kind} ${n.id}: in ${c.in}, ok ${c.ok}, failed ${c.failed}`,
        onclick: () => onPick(n.id),
        onkeydown: (ev) => {
          if (ev.key === "Enter" || ev.key === " ") onPick(n.id);
        },
      },
      s("rect", { class: "gbox", width: p.w, height: p.h, rx: 16 }),
      s("text", { class: "gemoji", x: 14, y: 30 }, kindEmoji(n.kind)),
      s("text", { class: "gid", x: 42, y: 26 }, n.id.length > 16 ? `${n.id.slice(0, 15)}…` : n.id),
      s("text", { class: "gkind", x: 42, y: 42 }, label.length > 22 ? `${label.slice(0, 21)}…` : label),
      held.get(n.id)
        ? s("text", { class: "c-warn", x: p.w - 12, y: 20, "text-anchor": "end" }, `🙋 ${held.get(n.id)}`)
        : null,
      s("text", { class: "gcount", x: 14, y: 62 }, `📨 ${c.in}`),
      s("text", { class: "gcount ok", x: 72, y: 62 }, `✅ ${c.ok}`),
      s("text", { class: c.failed ? "gcount bad" : "gcount", x: 130, y: 62 }, `💥 ${c.failed}`),
    );
  });
  return s(
    "svg",
    {
      class: "graph-svg",
      "data-pipeline": graph.name,
      width: "100%",
      viewBox: `0 0 ${width} ${height}`,
      style: `max-width:${width}px;aspect-ratio:${width} / ${height}`,
    },
    ...edges,
    ...boxes,
  );
}

const TABS = [
  ["overview", "🗺️ Overview"],
  ["logs", "📜 Logs"],
  ["agent", "🤖 Agent"],
  ["dlq", "💀 DLQ"],
  ["versions", "🕰️ Versions"],
];
async function pipelineView(name) {
  const tab = TABS.some(([t]) => t === pipelineView.tab) ? pipelineView.tab : "overview";
  const info = await api(`/pipelines/${name}`);
  const stats = info.runner?.stats;
  const base = `/pipelines/${encodeURIComponent(name)}`;
  const status = info.status;
  // A tab that can't load (e.g. no journal yet) shows its error in place; the header, with ✏️ Edit, always stays.
  const body = await { overview: overviewTab, logs: logsTab, agent: agentTab, dlq: dlqTab, versions: versionsTab }
    [tab](name, info, base)
    .catch((e) => {
      if (e instanceof EngineDown) throw e;
      return errorCard(e);
    });
  const state = status === "paused" || status === "draining" ? status : info.state;
  show(
    h("nav", { class: "crumbs" }, h("a", { href: "#/" }, "🏠 pipelines"), h("span", null, " / "), h("b", null, name)),
    h(
      "section",
      { class: "card phero" },
      h(
        "div",
        { class: "phero-top" },
        h("h1", null, name),
        badge(state),
        h("span", { class: "chip" }, `v${info.version ?? "?"}`),
        h("span", { class: "spacer" }),
        h(
          "div",
          { class: "toolbar" },
          controls(name, info.state, status),
          h("a", { class: "btn primary", href: `#/build/p/${encodeURIComponent(name)}` }, "✏️ Edit"),
        ),
      ),
      info.file ? h("div", { class: "muted small mono wrapany" }, `📄 ${info.file}`) : null,
      stats || info.lifetime?.ttl
        ? h(
            "div",
            { class: "minis wide" },
            stats
              ? [
                  mini("📨", "accepted", stats.accepted),
                  mini("✅", "delivered", stats.delivered),
                  mini("⏳", "pending", stats.pending),
                  mini("💀", "dlq", stats.dead_lettered, stats.dead_lettered ? "hot" : ""),
                  mini("⚡", "per min", stats.in_per_min),
                  info.resources ? mini("🧠", "cpu", `${info.resources.cpu}%`) : null,
                  info.resources ? mini("🐘", "memory", fmtBytes(info.resources.rss)) : null,
                ]
              : null,
            info.lifetime?.ttl
              ? h(
                  "div",
                  { class: "mini" },
                  h("span", { class: "mini-emoji" }, "⏱️"),
                  h("b", null, lifetimeCell(info.lifetime)),
                  h("span", { class: "mini-label" }, "left"),
                )
              : null,
          )
        : null,
    ),
    h(
      "div",
      { class: "tabs", role: "tablist" },
      TABS.map(([t, label]) =>
        h(
          "button",
          {
            type: "button",
            role: "tab",
            "aria-selected": t === tab ? "true" : "false",
            class: t === tab ? "tab on" : "tab",
            onclick: () => {
              pipelineView.tab = t;
              refresh?.();
            },
          },
          label,
        ),
      ),
    ),
    body,
  );
  if (tab === "overview") placeCity();
}

// The overview draws the pipeline as a graph or as a town (city.js, D75), remembered per browser. One City per page,
// kept across live refreshes: its placeholder carries data-keep, so morph leaves the canvas alone.
const runMode = () => {
  try {
    return localStorage.getItem("pipo-run-view") === "city" ? "city" : "graph";
  } catch {
    return "graph";
  }
};
let runCity = null;
const NO_TRACE = new Map();
async function cityFor(name, info, graph) {
  if (runCity?.name !== name) {
    const { createCity } = await import("./city.js");
    const rc = { name, def: graph.definition };
    rc.city = createCity({
      key: info.file ?? `pipeline:${name}`,
      readOnly: true,
      state: () => ({
        p: rc.def,
        selected: pipelineView.picked ? { type: "block", id: pipelineView.picked } : null,
        diagnostics: [],
        trace: NO_TRACE,
      }),
      select: (sel) => {
        const id = sel?.type === "block" ? sel.id : null;
        if (id === pipelineView.picked) return;
        pipelineView.picked = id;
        refresh?.();
      },
      wire: () => {},
      hint: () => {},
      focus: () => {},
    });
    runCity = rc;
  }
  runCity.def = graph.definition;
  return runCity;
}
/** After a render: put the City's canvas in its placeholder (once) and redraw it with the latest state. */
function placeCity() {
  const slot = document.querySelector(".run-city");
  if (!slot || !runCity || slot.dataset.pipeline !== runCity.name) return;
  if (runCity.city.el.parentNode !== slot) {
    slot.append(runCity.city.el);
    runCity.city.show(true);
  } else runCity.city.draw();
}
// The live stream sends packets down the City's lanes, as it moves dots along the graph's edges.
addEventListener("pipo:event", (ev) => {
  if (runCity && ev.detail?.pipeline === runCity.name && runCity.city.el.isConnected) runCity.city.event(ev.detail);
});

async function overviewTab(name, info, base) {
  const [graph, page, escalated] = await Promise.all([
    api(`${base}/graph`),
    // A pipeline that never ran has no journal yet: no packets, but its graph and the Edit button still show.
    api(`${base}/packets?limit=30`).catch((e) => {
      if (e instanceof ApiError && e.code === "not_found") return { packets: [], total: 0 };
      throw e;
    }),
    api(`${base}/packets?state=escalated&limit=200`).catch(() => ({ packets: [] })),
  ]);
  const held = new Map();
  for (const p of escalated.packets ?? []) if (p.node) held.set(p.node, (held.get(p.node) ?? 0) + 1);
  const picked = pipelineView.picked;
  const pickedNode = graph.nodes.find((n) => n.id === picked);
  const mode = graph.definition ? runMode() : "graph";
  if (mode === "city") await cityFor(name, info, graph);
  const setMode = (m) => {
    try {
      localStorage.setItem("pipo-run-view", m);
    } catch {}
    refresh?.();
  };
  return [
    h(
      "div",
      { class: `card graph${mode === "city" ? " is-city" : ""}` },
      graph.definition
        ? h(
            "div",
            { class: "b-views run-views", role: "group", "aria-label": "pipeline view" },
            [
              ["graph", "🔀 Graph", "Blocks and wires, with their counters"],
              ["city", "🏙️ City", "The same pipeline as a little town: buildings and data lanes"],
            ].map(([m, label, title]) =>
              h(
                "button",
                {
                  type: "button",
                  title,
                  class: m === mode ? "on" : "",
                  "aria-pressed": String(m === mode),
                  onclick: () => setMode(m),
                },
                label,
              ),
            ),
          )
        : null,
      mode === "city"
        ? h("div", { class: "run-city", "data-keep": "", "data-pipeline": name })
        : graphSvg(
            graph,
            (id) => {
              pipelineView.picked = id === pipelineView.picked ? null : id;
              refresh?.();
            },
            picked,
            held,
          ),
      pickedNode
        ? h(
            "div",
            { class: "picked" },
            h("b", null, `${kindEmoji(pickedNode.kind)} ${pickedNode.id}`),
            h(
              "span",
              { class: "muted" },
              ` · in ${pickedNode.counts.in} · ok ${pickedNode.counts.ok} · failed ${pickedNode.counts.failed} · filtered ${pickedNode.counts.filtered}${pickedNode.label ? ` · ${pickedNode.label}` : ""}`,
            ),
          )
        : h(
            "div",
            { class: "picked muted" },
            mode === "city"
              ? "👆 Tap a building to see its counters. Packets ride the coloured lanes as little vans."
              : "👆 Tap a block to see its counters. Packets hop along the lines as they flow.",
          ),
    ),
    pushCard(name, info, base),
    section(`📦 Recent packets (${page.total})`, packetTable(name, page.packets)),
  ];
}

// Live test (§8): push a packet into the running pipeline and watch it travel through the graph.
const pushDrafts = new Map();
function pushCard(name, info, base) {
  const running = info.state === "running";
  const draft = pushDrafts.get(name) ?? '{\n  "hello": "world"\n}';
  const send = async () => {
    const text = pushDrafts.get(name) ?? draft;
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return toast(`That isn't JSON yet: ${e.message}`, "bad", 'try something like {"name": "Ada"}');
    }
    try {
      const r = await api(`${base}/push`, { data, source: "ui" });
      const id = r.packet_id ?? r.id;
      toast(id ? `Packet sent 🚀 ${String(id).slice(-8)}` : "Packet sent 🚀", "ok");
      if (id) pushCard.last = { name, id };
    } catch (e) {
      if (e instanceof EngineDown) return napping();
      toast(`Push failed: ${e.message}`, "bad", e.hint);
    }
    refresh?.();
  };
  const last = pushCard.last?.name === name ? pushCard.last.id : null;
  return h(
    "details",
    { class: "card push", open: pushCard.open === name ? true : null },
    h(
      "summary",
      { onclick: () => (pushCard.open = pushCard.open === name ? null : name) },
      "🧪 Send a test packet",
      h(
        "span",
        { class: "muted small" },
        running ? " · it runs for real: taps fire and the output is written" : " · start the pipeline first",
      ),
    ),
    h("textarea", {
      class: "code",
      rows: 5,
      spellcheck: "false",
      "aria-label": "packet data as JSON",
      value: draft,
      oninput: (ev) => pushDrafts.set(name, ev.target.value),
    }),
    h(
      "div",
      { class: "toolbar" },
      h("button", { type: "button", class: "btn primary", disabled: !running, onclick: send }, "🚀 Send it"),
      last ? h("a", { class: "btn", href: `#/p/${name}/${encodeURIComponent(last)}` }, "🔍 Follow the last one") : null,
    ),
  );
}

// ---- logs: the runner's log file, followed by byte offset (GET .../logs?after=) ----
const logs = { name: null, lines: [], next: null, el: null, stick: true, top: 0 };
const LOG_KEEP = 1000;
async function logsTab(name, _info, base) {
  if (logs.name !== name) {
    Object.assign(logs, { name, lines: [], next: null, stick: true, top: 0 });
    logs.el = h("pre", { class: "logs", "data-keep": "" });
    logs.el.onscroll = () => {
      if (!logs.el.isConnected) return;
      logs.top = logs.el.scrollTop;
      logs.stick = logs.el.scrollHeight - logs.el.scrollTop - logs.el.clientHeight < 24;
    };
  }
  const page = await api(`${base}/logs?${logs.next === null ? "tail=300" : `after=${logs.next}`}`);
  if (page.reset) logs.lines = [];
  logs.lines = logs.lines.concat(page.lines).slice(-LOG_KEEP);
  logs.next = page.next;
  logs.el.replaceChildren(
    ...logs.lines.map((l) => {
      const level = /^\S+\s+(ERROR|WARN|INFO|DEBUG)\b/.exec(l)?.[1];
      return h("div", { class: level ? `log-${level.toLowerCase()}` : "" }, l || " ");
    }),
  );
  requestAnimationFrame(() => {
    logs.el.scrollTop = logs.stick ? logs.el.scrollHeight : logs.top;
  });
  return section(
    h("span", null, "📜 Runner log ", h("span", { class: "muted small" }, `(last ${logs.lines.length} lines, live)`)),
    logs.lines.length
      ? h("div", { class: "card flush" }, logs.el)
      : empty("The log is empty so far.", "It fills up as soon as the runner says something."),
  );
}
setInterval(() => {
  if (pipelineView.tab === "logs" && location.hash.split("/").length === 3 && !down) refresh?.();
}, 2000);

// ---- agent: proposals (status, author, reason) and what was handed to the agent or resolved ----
async function agentTab(name, _info, base) {
  const [props, actv] = await Promise.all([api(`${base}/proposals?limit=30`), api(`${base}/activity?limit=40`)]);
  const open = agentTab.open && props.proposals.some((p) => p.id === agentTab.open) ? agentTab.open : null;
  const detail = open ? await api(`${base}/proposals/${encodeURIComponent(open)}`).catch(() => null) : null;
  const rows = props.proposals.map((p) => [
    h(
      "tr",
      {
        class: `click${p.id === open ? " sel" : ""}`,
        onclick: () => {
          agentTab.open = p.id === open ? null : p.id;
          refresh?.();
        },
      },
      h("td", null, h("span", { class: "caret" }, p.id === open ? "▾ " : "▸ "), badge(p.state)),
      h(
        "td",
        { class: "opt" },
        p.author ?? "—",
        " ",
        h("span", { class: "tag" }, p.author_kind === "agent" ? "🤖 agent" : "🧑 human"),
      ),
      h("td", { class: "wraps" }, dash(p.reason)),
      h(
        "td",
        { class: "num mono" },
        h("span", { class: "c-ok" }, `+${p.added}`),
        " ",
        h("span", { class: "c-bad" }, `−${p.removed}`),
      ),
      h("td", { class: "num opt" }, dash(p.applied_version === null ? null : `v${p.applied_version}`)),
      h("td", { class: "muted time opt" }, fmtTime(p.created_at)),
    ),
    p.id === open && detail
      ? h(
          "tr",
          null,
          h(
            "td",
            { colspan: 6, class: "detail" },
            detail.decision ? h("p", { class: "muted" }, `${detail.decided_by ?? "?"}: ${detail.decision}`) : null,
            (detail.problems ?? []).map((q) =>
              h("div", { class: "c-bad wrapany" }, `${q.code ?? ""} ${q.message ?? fmtJson(q)}`),
            ),
            detail.diff ? h("pre", { class: "diff" }, diffLines(detail.diff)) : null,
          ),
        )
      : null,
  ]);
  return [
    section(
      `📝 Proposals (${props.proposals.length})`,
      props.proposals.length
        ? wrap(
            h(
              "table",
              null,
              thead(["status", "author", "reason", "change", "applied", "created"], [3, 4], [1, 4, 5]),
              h("tbody", null, rows),
            ),
          )
        : empty(
            "No proposals yet.",
            "Edits from the builder, the CLI (pipo proposals propose) or an agent show up here.",
          ),
    ),
    section(
      `🤖 Agent activity (${actv.events.length})`,
      actv.events.length
        ? h(
            "div",
            { class: "card feed" },
            actv.events.map((e) => feedItem(name, e)),
          )
        : empty("Nothing was handed to the agent, and no version was applied yet.", null),
    ),
  ];
}

function feedItem(name, e) {
  const d = e.detail ?? {};
  const pk = e.packet_id
    ? h("a", { class: "mono", href: `#/p/${name}/${encodeURIComponent(e.packet_id)}` }, e.packet_id.slice(-10))
    : null;
  let what;
  if (e.type === "packet.escalated") {
    what = [
      h("b", { class: "c-warn" }, "🙋 handed to agent"),
      " ",
      pk,
      ` at ${e.node ?? "?"}: ${d.reason ?? ""}`,
      d.error?.message ? ` (${d.error.message})` : "",
    ];
  } else if (e.type === "packet.resolved") {
    what = [
      h("b", { class: "c-ok" }, `🤝 resolved: ${d.action ?? "?"}`),
      " ",
      pk,
      ` by ${d.by ?? "?"}${d.by_kind ? ` (${d.by_kind})` : ""}`,
      d.reason ? `: ${d.reason}` : "",
    ];
  } else {
    what = [
      h("b", null, `🚀 v${d.version ?? "?"} applied`),
      ` by ${d.author ?? "?"}`,
      d.reason ? `: ${d.reason}` : "",
      d.proposal ? ` (${d.proposal})` : "",
    ];
  }
  return h("div", { class: "feed-item" }, h("span", { class: "muted mono" }, fmtTime(e.at)), h("div", null, what));
}

async function dlqTab(name, info, base) {
  const page = await api(`${base}/dlq?limit=50`);
  const running = info.state === "running";
  const replay = (body, label) => () => act(label, `${base}/dlq/replay`, body, "Replaying 🔁");
  const replayBtn = (p) =>
    h(
      "button",
      {
        type: "button",
        class: "btn small",
        disabled: !running,
        onclick: replay({ ids: [p.packet_id], by: "ui" }, "Replay"),
      },
      "🔁 Replay",
    );
  return section(
    h(
      "span",
      null,
      `💀 Dead letters (${page.total}) `,
      page.total
        ? h(
            "button",
            {
              type: "button",
              class: "btn small",
              disabled: !running,
              onclick: replay({ all: true, by: "ui" }, "Replay all"),
            },
            "🔁 Replay all",
          )
        : null,
    ),
    page.packets.length
      ? wrap(
          h(
            "table",
            null,
            thead(["", "packet", "at", "error", "v", "received", ""], [4], [2, 4, 5], { 0: "lead", 6: "tail" }),
            h(
              "tbody",
              null,
              page.packets.map((p) =>
                h(
                  "tr",
                  null,
                  h("td", { class: "actions lead" }, replayBtn(p)),
                  h(
                    "td",
                    { class: "id trunc" },
                    h("a", { href: `#/p/${name}/${encodeURIComponent(p.packet_id)}` }, p.packet_id),
                  ),
                  h("td", { class: "mono opt" }, dash(p.node)),
                  h(
                    "td",
                    { class: "wraps", title: p.error?.message ?? "" },
                    h("div", { class: "clamp c-bad" }, dash(errText(p.error?.message, p.packet_id))),
                    p.error?.code || (p.error?.node && p.error.node !== p.node)
                      ? h(
                          "div",
                          { class: "muted mono" },
                          [p.error.code, p.error.node === p.node ? null : p.error.node].filter(Boolean).join(" · "),
                        )
                      : null,
                  ),
                  h("td", { class: "num opt" }, p.version),
                  h("td", { class: "muted time opt" }, fmtTime(p.received_at)),
                  h("td", { class: "actions tail" }, replayBtn(p)),
                ),
              ),
            ),
          ),
        )
      : empty("The DLQ is empty. Squeaky clean! 🧼", null),
  );
}

async function versionsTab(_name, info, base) {
  const { versions, current } = await api(`${base}/versions`);
  if (!versions.length)
    return empty("No versions yet.", "A version is recorded each time the pipeline starts with a new definition.");
  const cur = current ?? versions[0].version;
  const picked =
    versionsTab.picked !== undefined && versions.some((v) => v.version === versionsTab.picked)
      ? versionsTab.picked
      : null;
  const diff = picked !== null && picked !== cur ? await api(`${base}/diff?from=${picked}&to=${cur}`) : null;
  const running = info.state === "running";
  const actions = (v) =>
    v.version === cur
      ? null
      : [
          h(
            "button",
            {
              type: "button",
              class: "btn small",
              onclick: () => {
                versionsTab.picked = v.version === picked ? undefined : v.version;
                refresh?.();
              },
            },
            `🔎 diff vs v${cur}`,
          ),
          " ",
          h(
            "button",
            {
              type: "button",
              class: "btn small",
              disabled: !running,
              onclick: () => {
                if (confirm(`Roll back to v${v.version}? This creates a new version from v${v.version}.`))
                  act(
                    "Rollback",
                    `${base}/rollback`,
                    { version: v.version, by: "ui" },
                    `Rolled back to v${v.version} ⏪`,
                  );
              },
            },
            "⏪ Roll back",
          ),
        ];
  return [
    section(
      `🕰️ Versions (current v${cur})`,
      wrap(
        h(
          "table",
          null,
          thead(["", "version", "author", "reason", "created", "pending", ""], [1, 5], [2, 4, 5], {
            0: "lead",
            6: "tail",
          }),
          h(
            "tbody",
            null,
            versions.map((v) =>
              h(
                "tr",
                { class: v.version === picked ? "sel" : "" },
                h("td", { class: "actions lead" }, actions(v)),
                h(
                  "td",
                  { class: "num" },
                  `v${v.version}`,
                  v.version === cur ? [" ", h("span", { class: "tag ok" }, "⭐ current")] : null,
                ),
                h("td", { class: "muted opt" }, dash(v.author)),
                h("td", { class: "wraps" }, dash(v.reason)),
                h("td", { class: "muted time opt" }, fmtTime(v.created_at)),
                h("td", { class: "num opt" }, v.pending),
                h("td", { class: "actions tail" }, actions(v)),
              ),
            ),
          ),
        ),
      ),
    ),
    diff
      ? section(
          `v${diff.from} → v${diff.to}: +${diff.added} −${diff.removed}`,
          diff.identical ? empty("Identical. Twins! 👯", null) : h("pre", { class: "diff" }, diffLines(diff.diff)),
        )
      : null,
  ];
}

const diffLines = (text) =>
  text
    .split("\n")
    .map((l) => h("div", { class: l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "" }, l || " "));

function packetTable(name, packets) {
  if (!packets.length)
    return empty(`${cheer(name.length)}: no packets yet.`, "Send one with the 🧪 test card above, or pipo push.");
  return wrap(
    h(
      "table",
      null,
      thead(["packet", "state", "at", "v", "source", "received"], [3], [2, 3, 4]),
      h(
        "tbody",
        null,
        packets.map((p) =>
          h(
            "tr",
            { class: "click", onclick: () => (location.hash = `#/p/${name}/${encodeURIComponent(p.packet_id)}`) },
            h("td", { class: "id trunc" }, p.packet_id),
            h("td", null, badge(p.state)),
            h("td", { class: "mono opt" }, p.node ?? ""),
            h("td", { class: "num opt" }, p.version),
            h("td", { class: "muted opt src", title: p.source ?? "" }, p.source),
            h("td", { class: "muted time" }, fmtTime(p.received_at)),
          ),
        ),
      ),
    ),
  );
}

// What a step changed: the top-level keys of `after` that are new or differ from `before` (`set`), and the keys of
// `before` it dropped (`removed`, shown as such, not as null); null when either is not a plain object.
const patchOf = (before, after) => {
  const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!plain(before) || !plain(after)) return null;
  const set = {};
  for (const k of Object.keys(after)) if (fmtJson(after[k]) !== fmtJson(before[k])) set[k] = after[k];
  return { set, removed: Object.keys(before).filter((k) => !(k in after)) };
};

function traceBody(t, top) {
  const p = t.packet;
  // The first step has nothing before it (p.data is where the packet ended up), so it shows its whole data.
  let prev;
  const steps = t.steps.map((st) => {
    const before = prev;
    if (st.data !== undefined) prev = st.data;
    const same = st.data !== undefined && before !== undefined && fmtJson(st.data) === fmtJson(before);
    const failed = st.event === "packet.dead_lettered" || st.error;
    const patch = st.data !== undefined && st.changed && !same ? patchOf(before, st.data) : null;
    return h(
      "li",
      { class: `step${st.error ? " err" : ""}` },
      h(
        "span",
        { class: "step-dot", "aria-hidden": "true" },
        st.error ? "💥" : st.event === "packet.delivered" ? "✅" : "🔹",
      ),
      h(
        "div",
        { class: "step-body" },
        h(
          "div",
          null,
          h("b", { class: "mono" }, st.node ?? "(copies)"),
          " ",
          h(
            "span",
            { class: "muted small" },
            `${st.event} · ${st.duration_ms} ms · attempts ${st.attempts} · ${fmtTime(st.at)}`,
          ),
        ),
        st.error
          ? h("div", { class: "c-bad wrapany" }, errText(st.error.message ?? fmtJson(st.error), p?.packet_id))
          : null,
        st.data === undefined || failed || st.changed || same
          ? null
          : h("div", { class: "muted small" }, "data unchanged"),
        patch ? h("div", { class: "muted small" }, "✏️ changed") : null,
        patch
          ? [
              Object.keys(patch.set).length ? h("pre", null, fmtJson(patch.set)) : null,
              patch.removed.length
                ? h(
                    "div",
                    { class: "c-bad small mono wrapany", title: "keys this step dropped from data" },
                    `removed: ${patch.removed.map((k) => `− ${k}`).join("  ")}`,
                  )
                : null,
            ]
          : st.data !== undefined && st.changed && !same
            ? h("pre", null, fmtJson(st.data))
            : null,
      ),
    );
  });
  return [
    p
      ? h(
          "div",
          { class: "card phead" },
          badge(p.state),
          p.node ? h("span", { class: "muted mono" }, `at ${p.node}`) : null,
          h("span", { class: "chip" }, `v${p.version}`),
          h("span", { class: "muted wrapany" }, `source ${p.source ?? "?"}`),
          h("span", { class: "muted" }, `received ${fmtTime(p.received_at)}`),
          p.key ? h("span", { class: "muted mono" }, `key ${p.key}`) : null,
          h("span", { class: "muted" }, `⏱️ ${t.steps.reduce((n, st) => n + (st.duration_ms ?? 0), 0)} ms total`),
          top && p.state === "dead_lettered"
            ? h(
                "button",
                {
                  type: "button",
                  class: "btn small",
                  onclick: () => act("Replay", `${top.base}/dlq/replay`, { ids: [top.id], by: "ui" }, "Replaying 🔁"),
                },
                "🔁 Replay",
              )
            : null,
        )
      : h("div", { class: "card" }, badge("purged")),
    p?.error ? h("div", { class: "card oops" }, errText(p.error.message ?? fmtJson(p.error), p.packet_id)) : null,
    p?.data !== undefined ? section("📦 Payload", h("pre", null, fmtJson(p.data))) : null,
    section("👣 Steps", steps.length ? h("ol", { class: "timeline" }, steps) : empty("No steps committed yet.", null)),
    t.pending
      ? h("p", { class: "muted" }, `⏳ in progress at ${t.pending.node ?? "?"} since ${fmtTime(t.pending.since)}`)
      : null,
    ...t.copies.map((c) => section(`🌿 Copy ${c.packet?.branch ?? ""}`, traceBody(c))),
  ];
}

async function packetView(name, id) {
  const t = await api(`/pipelines/${name}/packets/${encodeURIComponent(id)}`);
  show(
    h(
      "nav",
      { class: "crumbs" },
      h("a", { href: "#/" }, "🏠 pipelines"),
      h("span", null, " / "),
      h("a", { href: `#/p/${name}` }, name),
      h("span", null, " / "),
      h("span", { class: "mono" }, id),
    ),
    h("h1", null, "📦 Packet ", h("span", { class: "mono small" }, id)),
    traceBody(t, { id, base: `/pipelines/${encodeURIComponent(name)}` }),
  );
}

// ---- settings (§8, D72): the folder the builder saves new pipelines in, saved as engine.workspace. ----
const FROM = {
  settings: "chosen here",
  flag: "from --workspace",
  config: "from config.yaml",
  default: "the folder the engine started in",
};

async function settingsView(browse) {
  const [cfg, engine] = await Promise.all([api("/settings"), api("/engine")]);
  setEngine(engine);
  const at = await api(`/folders?path=${encodeURIComponent(browse || cfg.workspace)}`).catch(() => api("/folders"));
  const go = (path) => {
    location.hash = `#/settings/${encodeURIComponent(path)}`;
  };
  const use = async (path, create = false) => {
    try {
      const res = await api("/settings/workspace", { path, create });
      toast(`📁 New pipelines now go in ${res.workspace}`);
    } catch (e) {
      if (e instanceof EngineDown) return napping();
      if (e.code === "bad_request" && /does not exist/.test(e.message) && confirm(`${path} doesn't exist. Create it?`))
        return use(path, true);
      return toast(e.message, "bad", e.hint);
    }
    if (location.hash === "#/settings") render();
    else location.hash = "#/settings";
  };
  const typed = h("input", { value: at.path, class: "mono", autocomplete: "off", spellcheck: "false" });
  const sep = at.path.endsWith("/") ? "" : "/";
  show(
    h(
      "section",
      { class: "hero" },
      mascot("happy", 72),
      h(
        "div",
        { class: "hero-text" },
        h("h1", null, "Settings ⚙️"),
        h("p", { class: "muted" }, "Where your pipes live. The builder saves new pipelines in the workspace folder."),
      ),
    ),
    section(
      "🔌 Engine",
      h(
        "div",
        { class: "card" },
        h(
          "p",
          null,
          `pid ${engine.pid}`,
          engine.listen ? ` · 127.0.0.1:${engine.listen}` : "",
          engine.started_at ? ` · up since ${fmtTime(Date.parse(engine.started_at))}` : "",
        ),
        h(
          "p",
          { class: "muted small" },
          "Stopping drains your pipelines first; detached runners keep running and the next engine picks them up.",
        ),
        h(
          "div",
          { class: "toolbar" },
          h("button", { type: "button", class: "btn", onclick: restartEngine }, "🔄 Restart engine"),
          stopEngineBtn(),
        ),
      ),
    ),
    section(
      "📁 Workspace",
      h(
        "div",
        { class: "card" },
        h("p", null, h("b", { class: "mono" }, cfg.workspace)),
        h(
          "p",
          { class: "muted small" },
          `${FROM[cfg.workspace_from] ?? cfg.workspace_from} · kept in ${cfg.home}/config.yaml for the next start`,
        ),
      ),
    ),
    section(
      "Pick another folder",
      h(
        "form",
        {
          class: "card",
          onsubmit: (ev) => {
            ev.preventDefault();
            use(typed.value.trim());
          },
        },
        h(
          "div",
          { class: "toolbar" },
          at.parent ? h("button", { class: "btn small", type: "button", onclick: () => go(at.parent) }, "⬆️ Up") : null,
          h("span", { class: "spacer" }),
          h("button", { class: "btn small", type: "button", onclick: () => use(at.path) }, "✅ Use this folder"),
        ),
        h("p", { class: "mono" }, at.path),
        at.folders.length
          ? h(
              "div",
              { class: "toolbar" },
              ...at.folders.map((f) =>
                h(
                  "button",
                  { class: "btn small", type: "button", onclick: () => go(`${at.path}${sep}${f}`) },
                  `📁 ${f}`,
                ),
              ),
            )
          : h("p", { class: "muted small" }, "No folders in here."),
        h(
          "label",
          { class: "field" },
          h("span", { class: "field-label" }, "Or type a path"),
          typed,
          h("span", { class: "field-hint" }, "an absolute path (~ works); a missing folder can be created"),
        ),
        h("div", { class: "toolbar" }, h("button", { class: "btn primary", type: "submit" }, "💾 Use this path")),
      ),
    ),
  );
}

async function builderRoute(rest) {
  const { builderView } = await import("./builder.js");
  return builderView({ app, rest, show, setFresh: () => (fresh = true), napping, onEngine: setEngine });
}

function navActive(kind) {
  document
    .getElementById("nav-home")
    .classList.toggle("on", kind !== "build" && kind !== "top" && kind !== "bots" && kind !== "settings");
  document.getElementById("nav-bots").classList.toggle("on", kind === "bots");
  document.getElementById("nav-settings").classList.toggle("on", kind === "settings");
  document.getElementById("nav-top").classList.toggle("on", kind === "top");
  document.getElementById("nav-build").classList.toggle("on", kind === "build");
}

async function render() {
  const [, kind, name, ...rest] = location.hash.split("/");
  fresh = true;
  navActive(kind);
  if (down) return;
  connect(kind === "p" && name ? name : null);
  const id = rest[0];
  const view =
    kind === "build"
      ? () => builderRoute([name, ...rest].filter((x) => x !== undefined))
      : kind === "bots"
        ? () => botsView(name && decodeURIComponent(name))
        : kind === "settings"
          ? () => settingsView(name && decodeURIComponent(name))
          : kind === "top"
            ? topView
            : kind === "p" && name
              ? id
                ? () => packetView(name, decodeURIComponent(id))
                : () => pipelineView(name)
              : listView;
  // The builder manages its own DOM; live refreshes only re-render the dashboard views.
  // The bots and settings pages hold forms: no live refresh under the user's typing.
  const still = kind === "build" || kind === "bots" || kind === "settings";
  refresh = still
    ? null
    : async () => {
        try {
          await view();
        } catch (e) {
          if (e instanceof EngineDown) return napping();
          show(errorCard(e), h("p", null, h("a", { class: "btn", href: "#/" }, "🏠 back to pipelines")));
        }
      };
  try {
    if (still) await view();
    else await refresh();
  } catch (e) {
    if (e instanceof EngineDown) return napping();
    show(errorCard(e instanceof ApiError || e instanceof Error ? e : new Error(String(e))));
  }
}
addEventListener("hashchange", render);
render();
