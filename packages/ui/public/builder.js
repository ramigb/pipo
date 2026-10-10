// The builder (docs/spec.md §8 "Phase 2: build", D62): drag blocks from the palette onto a canvas, wire them port to
// port, fill them in with forms generated from each connector's `with:` schema, and watch `pipo check` live. The
// `.pipo` file stays the source of truth: the canvas edits the parsed value, the engine writes it back as YAML
// (keeping the opened file's comments), and saving writes the file. A running pipeline is changed through a human
// proposal (§9.3), then its file is saved. The 🧪 panel dry-runs the draft against sample packets (outputs and taps
// mocked, nothing written). The canvas shows the pipeline as a graph or as a small town (city.js, D75); both edit the
// same value. Routes: #/build (new), #/build/f/<file>, #/build/p/<pipeline>.

import { createCity } from "./city.js";
import { ApiError, api, EngineDown, h, s, toast } from "./dom.js";
import { autoLayout } from "./layout.js";
import { badge, connectorEmoji, fmtJson, kindEmoji, mascot } from "./look.js";
import {
  addInput,
  addNode,
  blankPipeline,
  blocks,
  connect,
  connectProblem,
  dataPaths,
  diagnosticsByBlock,
  disconnect,
  edges,
  exampleOf,
  firstInput,
  getPath,
  History,
  inputOf,
  inputPath,
  inputsOf,
  isInput,
  outPorts,
  parseRef,
  refOf,
  removeBranch,
  removeNode,
  renameBranch,
  renameNode,
  renameProblem,
  setInput,
  setOutput,
  setPath,
  shapeIn,
  shapeOut,
  slug,
  starterSchema,
  switchAgent,
} from "./model.js";

const W = 184;
const H = 66;
const PORT_GAP = 22;
const store = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null");
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

let B = null; // the open builder: one at a time
let ctx = null; // what app.js handed over
let catalog = null;
let agentInfo = null; // which agents can run here and their models (GET /api/builder/agents, D67); null while probing
let agentProbe = null;

let navSeq = 0; // the latest route the builder was asked for: an older, slower load must not replace it

export async function builderView(c) {
  ctx = c;
  const [mode, arg] = c.rest;
  const key = mode === "f" || mode === "p" ? `${mode}:${decodeURIComponent(arg ?? "")}` : "new";
  if (B?.key === key && B.root?.isConnected) return;
  const nav = ++navSeq;
  catalog ??= await api("/builder/catalog");
  loadAgents();
  const engine = await api("/engine").catch(() => null);
  if (engine) c.onEngine(engine);
  let opened = null;
  if (mode === "f") opened = await api(`/builder/open?file=${encodeURIComponent(decodeURIComponent(arg))}`);
  else if (mode === "p") opened = await api(`/builder/open?pipeline=${encodeURIComponent(decodeURIComponent(arg))}`);
  if (nav !== navSeq || !location.hash.startsWith("#/build")) return;
  start(key, opened);
}

/** Ask the engine which agents can run on this machine (D67); the palette and inspector redraw when it answers. */
function loadAgents(refresh = false) {
  if (agentProbe && !refresh) return agentProbe;
  if (refresh) agentInfo = null;
  agentProbe = api(`/builder/agents${refresh ? "?refresh=1" : ""}`)
    .then((r) => {
      agentInfo = r.agents ?? {};
    })
    .catch(() => {
      // An engine from before D67 can't say: nothing is greyed out, and a runner still refuses what can't run.
      agentInfo = {};
    })
    .finally(() => {
      if (!B?.root?.isConnected) return;
      const fresh = h("aside", { class: "b-palette card", "aria-label": "blocks to add" }, palette());
      el.palette.replaceWith(fresh);
      el.palette = fresh;
      // Don't pull a field out from under someone typing in it.
      if (B.selected?.type === "block" && !el.side.contains(document.activeElement)) side();
    });
  return agentProbe;
}

/** The model a new agent node starts with: Codex's first listed model; Claude ones come from model.js. */
const starterModel = (agent) => (agent === "codex" ? agentInfo?.codex?.models?.[0] : undefined);

const agentLabel = (name) => catalog.agents[name]?.label ?? name;

// ── state ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function start(key, opened) {
  let pipeline = opened?.pipeline ?? null;
  // Unsaved edits live in the browser per file (or for the one new draft), so leaving the builder never loses them.
  // An opened file's edits come back only while the file is still what they were made against.
  const draftKey = opened ? `pipo-builder:file:${opened.file}` : "pipo-builder:new";
  const draft = store.get(draftKey);
  let restored = false;
  let dropped = false;
  if (!opened) {
    if (draft?.pipeline) {
      pipeline = draft.pipeline;
      restored = true;
    } else pipeline = blankPipeline(`my-pipeline-${Math.random().toString(36).slice(2, 6)}`);
  } else if (draft?.pipeline && pipeline) {
    if (draft.base === opened.source) restored = true;
    else {
      store.set(draftKey, null);
      dropped = true;
    }
  }
  const first = opened?.fixtures?.[0];
  B = {
    key,
    draftKey,
    file: opened?.file ?? null,
    base: opened?.source ?? null,
    running: opened?.running ?? null,
    fixtures: opened?.fixtures ?? [],
    fixturesError: opened?.fixtures_error ?? null,
    stubs: opened?.stubs ?? null,
    hist: pipeline ? new History(pipeline) : null,
    source: opened?.source ?? "",
    diagnostics: opened?.diagnostics ?? [],
    selected: null,
    pos: new Map(Object.entries(store.get(`pipo-pos:${opened?.file ?? key}`) ?? {})),
    view: { x: 40, y: 40, k: 1 },
    mode: store.get("pipo-builder-view") === "city" ? "city" : "graph",
    panel: "inspect",
    dirty: restored,
    // The packet starts as the file's first fixture, so a dry run tries what its tests try.
    test: {
      input: first ? fmtJson(first.data) : '{\n  "hello": "world"\n}',
      fixture: first?.name ?? null,
      stubs: "",
      stubsFor: null,
      result: null,
      running: false,
    },
    trace: new Map(),
    // schema files the pipeline names, as read from the engine: path → {exists, schema, problem} (or {loading})
    schemas: new Map(),
    schemasFor: null,
    coalesce: null,
    checkTimer: null,
    checkSeq: 0,
  };
  ctx.setFresh();
  if (!pipeline) {
    ctx.show(
      h(
        "div",
        { class: "card oops" },
        h("div", { class: "oops-title" }, `😬 ${B.file} can't be drawn: its YAML doesn't parse.`),
        h(
          "div",
          { class: "hint" },
          "💡 Fix the syntax in your editor (pipo check shows the line), then open it here again.",
        ),
        h(
          "pre",
          null,
          B.diagnostics.map((d) => `${d.line}:${d.col} ${d.code} ${d.message}\n`),
        ),
      ),
    );
    B = null;
    return;
  }
  layoutMissing();
  ctx.show(frame());
  fit();
  setMode(B.mode);
  side();
  top();
  check();
  if (restored && opened) {
    // the file's version stays one undo away
    B.hist.push(draft.pipeline);
    afterJump();
    toast("Welcome back! I kept your unsaved changes to this file 💾", "ok", "↩️ Undo shows the saved version");
  } else if (restored) toast("Welcome back! I kept your unsaved draft 💾", "ok");
  if (dropped) toast("The file changed since your unsaved edits, so I opened the saved version", "warn");
}

const P = () => B.hist.value;

/** Record a new pipeline value: undo history (typing in one field coalesces), live check, redraw. */
function commit(next, opts = {}) {
  if (next === P()) return;
  if (opts.coalesce && B.coalesce === opts.coalesce) B.hist.stack[B.hist.at] = next;
  else B.hist.push(next);
  B.coalesce = opts.coalesce ?? null;
  B.dirty = true;
  B.trace = new Map();
  keepDraft();
  layoutMissing();
  draw();
  if (!opts.keepSide) side();
  top();
  check();
}

function undo() {
  B.hist.undo();
  B.coalesce = null;
  afterJump();
}
function redo() {
  B.hist.redo();
  B.coalesce = null;
  afterJump();
}
function afterJump() {
  B.dirty = true;
  keepDraft();
  if (B.selected?.type === "block" && !blocks(P()).some((b) => b.id === B.selected.id)) B.selected = null;
  layoutMissing();
  draw();
  side();
  top();
  check();
}

function keepDraft() {
  store.set(B.draftKey, { pipeline: P(), base: B.base });
}

/**
 * The pipeline's file: where it was opened from or saved to, else where it will be saved by default. Checks, dry runs
 * and schema files all resolve relative paths from here, so they agree with where Save puts the pipeline.
 */
function fileFor(b) {
  if (b.file) return b.file;
  const name = b.hist.value.name ?? "pipeline";
  return `${catalog.workspace}/${name}/${name}.pipo`;
}

/** The open builder is still `b` (async work started in one builder must not land in another). */
const still = (b) => B === b && b.root?.isConnected;

function check() {
  const b = B;
  clearTimeout(b.checkTimer);
  const seq = ++b.checkSeq;
  b.checking = true;
  top();
  b.checkTimer = setTimeout(async () => {
    try {
      const r = await api("/builder/check", {
        pipeline: b.hist.value,
        ...(b.base ? { base: b.base } : {}),
        file: fileFor(b),
      });
      if (seq !== b.checkSeq) return;
      b.source = r.source;
      b.diagnostics = r.diagnostics ?? [];
    } catch (e) {
      if (e instanceof EngineDown) return still(b) && ctx.napping();
      if (seq !== b.checkSeq) return;
      b.diagnostics = [
        { severity: "error", code: e.code ?? "error", message: e.message, hint: e.hint, line: 0, col: 0 },
      ];
    }
    b.checking = false;
    if (!still(b)) return;
    draw();
    top();
    if (B.panel !== "inspect") side();
    else refreshProblems();
  }, 300);
}

const errorsOf = (list) => (list ?? []).filter((d) => d.severity === "error");

// ── layout and geometry ───────────────────────────────────────────────────────────────────────────────────────────

function sizeOf(p, id) {
  const ports = outPorts(p, id).length;
  return { w: W, h: Math.max(H, 18 + ports * PORT_GAP) };
}

/** Blocks without a remembered position get one: the auto-layout's, or next to their first parent. */
function layoutMissing() {
  const bs = blocks(P());
  const missing = bs.filter((b) => !B.pos.has(b.id));
  if (!missing.length) return;
  if (missing.length === bs.length) {
    const { pos } = autoLayout(bs, { w: W, h: H + 14, gx: 80, gy: 30, pad: 0 });
    for (const [id, p] of pos) B.pos.set(id, { x: p.x, y: p.y });
  } else {
    for (const b of missing) {
      const parent = b.from.map((f) => B.pos.get(f.node)).find(Boolean);
      const at = B.drop ?? (parent ? { x: parent.x + W + 70, y: parent.y } : { x: 0, y: 0 });
      let { x, y } = at;
      // don't land on top of someone
      while ([...B.pos.values()].some((q) => Math.abs(q.x - x) < 40 && Math.abs(q.y - y) < 40)) y += H + 24;
      B.pos.set(b.id, { x, y });
    }
  }
  B.drop = null;
  savePos();
}
function savePos() {
  store.set(`pipo-pos:${B.file ?? B.key}`, Object.fromEntries(B.pos));
}

function geometry() {
  const p = P();
  const g = new Map();
  for (const b of blocks(p)) {
    const at = B.pos.get(b.id) ?? { x: 0, y: 0 };
    const { w, h: hh } = sizeOf(p, b.id);
    const ports = outPorts(p, b.id);
    g.set(b.id, {
      ...b,
      x: at.x,
      y: at.y,
      w,
      h: hh,
      ports: ports.map((branch, i) => ({
        branch,
        x: at.x + w,
        y: at.y + (ports.length === 1 ? hh / 2 : 20 + i * PORT_GAP),
      })),
      inPort: b.kind === "input" ? null : { x: at.x, y: at.y + hh / 2 },
    });
  }
  return g;
}

function curve(x1, y1, x2, y2) {
  if (x2 > x1 + 20) {
    const mx = (x1 + x2) / 2;
    return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
  }
  const dx = 70;
  const drop = Math.max(y1, y2) + 70;
  return `M${x1},${y1} C${x1 + dx},${y1} ${x1 + dx},${drop} ${(x1 + x2) / 2},${drop} S${x2 - dx},${y2} ${x2},${y2}`;
}

// ── the frame ─────────────────────────────────────────────────────────────────────────────────────────────────────

const el = {};
function frame() {
  el.top = h("div", { class: "b-top card" });
  el.palette = h("aside", { class: "b-palette card", "aria-label": "blocks to add" }, palette());
  el.world = s("g", { class: "b-world" });
  el.svg = s("svg", { class: "b-svg", role: "application", "aria-label": "pipeline canvas" }, el.world);
  el.hint = h("div", { class: "b-hint muted small" });
  const b = B;
  el.city = createCity({
    key: B.file ?? B.key,
    state: () => ({ p: b.hist.value, selected: b.selected, diagnostics: b.diagnostics, trace: b.trace }),
    select: (sel) => still(b) && select(sel),
    wire: (ref, to) => still(b) && wireTo(ref, to),
    hint: (text) => {
      el.hint.textContent = text ?? CITY_HINT;
    },
    focus: () => el.canvas.focus({ preventScroll: true }),
  });
  el.views = h(
    "div",
    { class: "b-views", role: "group", "aria-label": "canvas view" },
    [
      ["graph", "🔀 Graph", "Blocks and wires"],
      ["city", "🏙️ City", "The same pipeline as a little town: buildings and data lanes"],
    ].map(([mode, label, title]) =>
      h("button", { type: "button", "data-mode": mode, title, onclick: () => setMode(mode) }, label),
    ),
  );
  const city = () => B.mode === "city";
  el.canvas = h(
    "div",
    { class: "b-canvas card flush", tabindex: 0 },
    el.svg,
    el.city.el,
    el.views,
    el.hint,
    h(
      "div",
      { class: "b-zoom" },
      h(
        "button",
        {
          type: "button",
          class: "icon-btn",
          title: "Zoom in",
          onclick: () => (city() ? el.city.zoomBy(1.2) : zoomBy(1.2)),
        },
        "➕",
      ),
      h(
        "button",
        {
          type: "button",
          class: "icon-btn",
          title: "Zoom out",
          onclick: () => (city() ? el.city.zoomBy(1 / 1.2) : zoomBy(1 / 1.2)),
        },
        "➖",
      ),
      h(
        "button",
        {
          type: "button",
          class: "icon-btn",
          title: "Fit to screen",
          onclick: () => {
            if (city()) return el.city.fit();
            fit();
            draw();
          },
        },
        "🎯",
      ),
      h("button", { type: "button", class: "icon-btn", title: "Tidy up (auto-layout)", onclick: tidyUp }, "🪄"),
    ),
  );
  el.side = h("aside", { class: "b-side card" });
  B.root = h("div", { class: "builder" }, el.top, h("div", { class: "b-main" }, el.palette, el.canvas, el.side));
  wireCanvas();
  return B.root;
}

/** Show the canvas as a graph or as a town; the choice is remembered per browser. */
function setMode(mode) {
  B.mode = mode;
  store.set("pipo-builder-view", mode);
  for (const btn of el.views.children) {
    btn.className = btn.dataset.mode === mode ? "on" : "";
    btn.setAttribute("aria-pressed", String(btn.dataset.mode === mode));
  }
  el.svg.style.display = mode === "city" ? "none" : "";
  el.canvas.classList.toggle("is-city", mode === "city");
  el.city.show(mode === "city");
  if (mode === "graph" && !B.graphFitted) fit();
  draw();
}

function tidyUp() {
  if (B.mode === "city") {
    el.city.tidy();
    return toast("Tidied up the town ✨");
  }
  B.pos.clear();
  layoutMissing();
  fit();
  draw();
  toast("Tidied up ✨");
}

// ── top bar ───────────────────────────────────────────────────────────────────────────────────────────────────────

function top() {
  if (!B) return;
  const p = P();
  const errs = errorsOf(B.diagnostics);
  const warns = (B.diagnostics ?? []).filter((d) => d.severity === "warning");
  const live = B.running?.state === "running";
  const status = B.checking
    ? h("span", { class: "chip" }, "🔍 checking…")
    : errs.length
      ? h(
          "button",
          { type: "button", class: "chip bad", onclick: () => showPanel("problems") },
          `⚠️ ${errs.length} to fix`,
        )
      : h(
          "span",
          { class: "chip ok" },
          warns.length ? `✅ valid · ${warns.length} note${warns.length > 1 ? "s" : ""}` : "✅ looks good",
        );
  el.top.replaceChildren(
    h("span", { class: "b-mascot" }, mascot(errs.length ? "wow" : "happy", 36)),
    h(
      "div",
      { class: "b-title" },
      h("input", {
        class: "b-name",
        value: p.name ?? "",
        "aria-label": "pipeline name",
        title: "Pipeline name: lowercase letters, digits and dashes",
        onchange: (e) => commit(setPath(P(), "name", slug(e.target.value))),
      }),
      h(
        "div",
        { class: "muted small wrapany" },
        B.file ? `📄 ${B.file}` : "📝 new draft, not saved yet",
        B.running ? h("span", null, " · ", badge(B.running.state), ` v${B.running.version ?? "?"}`) : null,
        B.dirty ? h("span", { class: "c-warn" }, " · unsaved changes") : null,
      ),
    ),
    status,
    h("span", { class: "spacer" }),
    h(
      "div",
      { class: "toolbar" },
      h(
        "button",
        { type: "button", class: "icon-btn", title: "Undo (Ctrl+Z)", disabled: !B.hist.canUndo, onclick: undo },
        "↩️",
      ),
      h(
        "button",
        { type: "button", class: "icon-btn", title: "Redo (Ctrl+Shift+Z)", disabled: !B.hist.canRedo, onclick: redo },
        "↪️",
      ),
      h("button", { type: "button", class: "btn", onclick: openDialog }, "📂 Open"),
      h("a", { class: "btn", href: "#/build", onclick: newDraft }, "✨ New"),
      h("button", { type: "button", class: "btn", onclick: () => showPanel("test") }, "🧪 Test"),
      h("button", { type: "button", class: "btn", onclick: save }, "💾 Save"),
      live
        ? h(
            "button",
            {
              type: "button",
              class: "btn primary",
              onclick: applyLive,
              title: "Propose this as the next version of the running pipeline",
            },
            "🚀 Apply live",
          )
        : h(
            "button",
            { type: "button", class: "btn primary", onclick: run, title: "Save, then start the pipeline" },
            "▶️ Save & run",
          ),
    ),
  );
}

function newDraft(e) {
  if (B?.key === "new") {
    e?.preventDefault();
    if (B.dirty && !confirm("Start over with a blank pipeline? Your current draft goes away.")) return;
    store.set("pipo-builder:new", null);
    store.set("pipo-pos:new", null);
    B = null;
    builderView({ ...ctx, rest: [] });
  }
}

// ── palette ───────────────────────────────────────────────────────────────────────────────────────────────────────

const BLURB = {
  input: "Where packets come from",
  tap: "Do something on the side",
  transform: "Reshape the data",
  filter: "Keep only some packets",
  route: "Send packets down different paths",
  agent: "Ask an AI model",
  output: "Where packets end up",
};
function palette() {
  const item = (kind, connector, title, description, off = null) =>
    h(
      "button",
      {
        type: "button",
        class: `pal k-${kind}${off ? " off" : ""}`,
        draggable: off ? "false" : "true",
        "aria-disabled": off ? "true" : null,
        title: off ? `${title} can't be used here: ${off.reason}` : (description ?? BLURB[kind]),
        ondragstart: (e) => {
          if (off) return e.preventDefault();
          e.dataTransfer.setData("application/x-pipo", JSON.stringify({ kind, connector }));
          e.dataTransfer.effectAllowed = "copy";
        },
        onclick: () =>
          off
            ? toast(`${title} can't be used here: ${off.reason}`, "warn", off.hint ? `💡 ${off.hint}` : null)
            : place({ kind, connector }, null),
      },
      h("span", { class: "pal-emoji", "aria-hidden": "true" }, connector ? connectorEmoji(connector) : kindEmoji(kind)),
      h("span", null, title),
      off ? h("span", { class: "pal-off", "aria-hidden": "true" }, "⚠️") : null,
    );
  const group = (title, kids) => h("div", { class: "pal-group" }, h("div", { class: "pal-title" }, title), kids);
  // The agents fold in and out under one row (D67); open or closed is remembered per browser.
  const open = store.get("pipo-builder-agents-open") === true;
  const agents = h(
    "div",
    { class: "pal-sub", id: "pal-agents", hidden: open ? null : true },
    agentInfo === null ? h("div", { class: "pal-checking muted small" }, "⏳ checking which agents are set up…") : null,
    Object.entries(catalog.agents).map(([name, m]) => {
      const info = agentInfo?.[name];
      return item("agent", name, m.label ?? name, m.description, info && info.ready === false ? info : null);
    }),
    agentInfo !== null
      ? h(
          "button",
          { type: "button", class: "btn small pal-recheck", onclick: () => loadAgents(true) },
          "🔄 check again",
        )
      : null,
  );
  const chevron = h("span", { class: "pal-chevron", "aria-hidden": "true" }, open ? "▾" : "▸");
  const folder = h(
    "button",
    {
      type: "button",
      class: "pal pal-folder k-agent",
      "aria-expanded": String(open),
      "aria-controls": "pal-agents",
      title: BLURB.agent,
      onclick: (e) => {
        const now = agents.hidden;
        agents.hidden = !now;
        e.currentTarget.setAttribute("aria-expanded", String(now));
        chevron.textContent = now ? "▾" : "▸";
        store.set("pipo-builder-agents-open", now);
      },
    },
    h("span", { class: "pal-emoji", "aria-hidden": "true" }, kindEmoji("agent")),
    h("span", null, "Agents"),
    chevron,
  );
  return [
    h("div", { class: "pal-intro muted small" }, "Drag a block onto the canvas, or click it to add 👇"),
    group(
      "📥 Inputs",
      Object.entries(catalog.inputs).map(([name, m]) => item("input", name, name, m.description)),
    ),
    group("🪄 Steps", [
      item("transform", "map", "map", catalog.transforms.map?.description),
      item("transform", "http", "http call", catalog.transforms.http?.description),
      item("transform", "exec", "run program", catalog.transforms.exec?.description),
      item("filter", null, "filter"),
      item("route", null, "route"),
      ...Object.entries(catalog.taps).map(([name, m]) => item("tap", name, `${name} tap`, m.description)),
      folder,
      agents,
    ]),
    group(
      "📤 Outputs",
      Object.entries(catalog.outputs).map(([name, m]) => item("output", name, name, m.description)),
    ),
  ];
}

/**
 * Add a palette item: a node joins in before the output (or after the selected block); the output is swapped. An
 * input swaps the selected input's connector, else it is added, feeding what the first input feeds (D76).
 */
function place(item, at) {
  let p = P();
  if (item.kind === "input") {
    const sel = B.selected?.type === "block" && isInput(p, B.selected.id) ? B.selected.id : null;
    if (sel) {
      commit(setInput(p, item.connector, sel));
      select({ type: "block", id: sel });
      return toast(`${sel} is now ${connectorEmoji(item.connector)} ${item.connector}`);
    }
    const first = firstInput(p);
    const fed = edges(p)
      .filter((e) => e.ref === first)
      .map((e) => e.to);
    let id;
    ({ p, id } = addInput(p, item.connector));
    for (const to of fed) p = connect(p, id, to);
    const from = B.pos.get(first);
    if (at) B.drop = at;
    else if (from) B.drop = makeRoom(from.x, from.y + H + 40);
    commit(p);
    select({ type: "block", id });
    return toast(
      `Added ${connectorEmoji(item.connector)} ${id}, feeding what ${first} feeds; select an input to swap it instead`,
    );
  }
  if (item.kind === "output") {
    commit(setOutput(p, item.connector));
    select({ type: "block", id: "output" });
    return toast(`Output is now ${connectorEmoji(item.connector)} ${item.connector}`);
  }
  const sel = B.selected?.type === "block" && B.selected.id !== "output" ? B.selected.id : null;
  let id;
  if (sel) {
    // Spliced in after the selected block: it takes over what that block's first port fed.
    const ref = refOf(sel, outPorts(p, sel)[0] ?? null);
    const fed = edges(p)
      .filter((e) => e.ref === ref)
      .map((e) => e.to);
    ({ p, id } = addNode(p, item.kind, item.connector, ref, { model: starterModel(item.connector) }));
    const own = refOf(id, outPorts(p, id)[0] ?? null);
    for (const to of fed) p = connect(disconnect(p, ref, to), own, to);
    const from = B.pos.get(sel);
    if (!at && from) at = makeRoom(from.x + W + 70, from.y);
  } else {
    // Slotted in before the output: it takes the output's feeds, and feeds the output.
    ({ p, id } = addNode(p, item.kind, item.connector, p.output?.from ?? firstInput(p), {
      model: starterModel(item.connector),
    }));
    p = setPath(p, "output.from", refOf(id, outPorts(p, id)[0] ?? null));
    const out = B.pos.get("output");
    if (!at && out) at = makeRoom(out.x, out.y);
  }
  if (at) B.drop = at;
  commit(p);
  select({ type: "block", id });
  if ([...B.pos.keys()].some((b) => !visible(b))) {
    fit();
    draw();
  }
  toast(`Added ${kindEmoji(item.kind)} ${id}`);
}

/** Push every block at or right of `x` one column to the right, so a new one fits at (x, y). */
function makeRoom(x, y) {
  for (const [id, q] of B.pos) if (q.x >= x - 10) B.pos.set(id, { x: q.x + W + 70, y: q.y });
  return { x, y };
}

/** Whether a block is fully on screen at the current pan and zoom. */
function visible(id) {
  const q = B.pos.get(id);
  const r = el.svg.getBoundingClientRect();
  if (!q || !r.width) return true;
  const x = B.view.x + q.x * B.view.k;
  const y = B.view.y + q.y * B.view.k;
  return x >= 0 && y >= 0 && x + W * B.view.k <= r.width && y + H * B.view.k <= r.height;
}

// ── canvas drawing ────────────────────────────────────────────────────────────────────────────────────────────────

const CITY_HINT = "🏗️ Drag buildings between lots · pull from a ● port to lay a lane · scroll to zoom · drag to pan";

function draw() {
  if (!B) return;
  if (B.mode === "city") {
    el.city.draw();
    el.hint.textContent = B.selected?.type === "edge" ? "✂️ Press Delete to close this lane" : CITY_HINT;
    return;
  }
  const p = P();
  const g = geometry();
  const diag = diagnosticsByBlock(B.diagnostics);
  const kids = [];
  for (const e of edges(p)) {
    const a = g.get(e.from);
    const b = g.get(e.to);
    if (!a || !b) continue;
    const port = a.ports.find((q) => q.branch === e.branch) ?? a.ports[0];
    if (!port || !b.inPort) continue;
    const d = curve(port.x, port.y, b.inPort.x, b.inPort.y);
    const sel = B.selected?.type === "edge" && B.selected.ref === e.ref && B.selected.to === e.to;
    const traced = B.trace.get(e.to)?.via?.has(e.ref);
    kids.push(
      s(
        "g",
        { class: `b-edge${sel ? " sel" : ""}${traced ? " traced" : ""}` },
        s("path", {
          class: "hit",
          d,
          onpointerdown: (ev) => {
            ev.stopPropagation();
            select({ type: "edge", ref: e.ref, to: e.to });
          },
        }),
        s("path", { class: "line", d }),
      ),
    );
  }
  for (const b of g.values()) {
    const problems = diag.get(b.id) ?? [];
    const bad = errorsOf(problems).length;
    const sel = B.selected?.type === "block" && B.selected.id === b.id;
    const t = B.trace.get(b.id);
    const node = b.kind === "input" ? inputOf(p, b.id) : b.id === "output" ? p.output : p.nodes?.[b.id];
    const sub = b.kind === "filter" ? node?.filter : b.kind === "route" ? `${b.ports.length} paths` : b.connector;
    kids.push(
      s(
        "g",
        {
          class: `b-node k-${b.kind}${sel ? " sel" : ""}${bad ? " bad" : problems.length ? " warn" : ""}${t ? ` t-${t.status}` : ""}`,
          transform: `translate(${b.x},${b.y})`,
          "data-id": b.id,
          tabindex: 0,
          role: "button",
          "aria-label": `${b.kind} ${b.id}${bad ? `, ${bad} problem(s)` : ""}`,
          onpointerdown: (ev) => startDrag(ev, b.id),
          onkeydown: (ev) => {
            if (ev.key === "Enter") select({ type: "block", id: b.id });
          },
        },
        s("rect", { class: "box", width: b.w, height: b.h, rx: 18 }),
        s(
          "text",
          { class: "emoji", x: 14, y: 31 },
          b.connector && b.kind !== "filter" && b.kind !== "route" ? connectorEmoji(b.connector) : kindEmoji(b.kind),
        ),
        s("text", { class: "id", x: 44, y: 27 }, clip(b.id, 15)),
        s("text", { class: "sub", x: 44, y: 44 }, clip(`${kindEmoji(b.kind)} ${sub ?? b.kind}`, 22)),
        b.loop ? s("text", { class: "sub", x: b.w - 14, y: b.h - 10, "text-anchor": "end" }, "🔁") : null,
        bad || problems.length
          ? s(
              "g",
              { class: "b-badge", transform: `translate(${b.w - 4},4)` },
              s("circle", { r: 11 }),
              s("text", { y: 4, "text-anchor": "middle" }, bad ? String(bad) : "!"),
              s("title", null, problems.map((d) => `${d.code} ${d.message}`).join("\n")),
            )
          : null,
        t
          ? s(
              "text",
              { class: "trace-mark", x: 14, y: b.h - 9 },
              t.status === "ok" ? "✅ ran" : t.status === "bad" ? "💥 failed here" : "🫥 stopped",
            )
          : null,
        b.inPort ? s("circle", { class: "port in", cx: 0, cy: b.h / 2, r: 7 }) : null,
        b.ports.map((q) => [
          q.branch
            ? s(
                "text",
                { class: "port-label", x: b.w - 14, y: q.y - b.y + 4, "text-anchor": "end" },
                clip(q.branch, 12),
              )
            : null,
          s("circle", {
            class: "port out",
            cx: b.w,
            cy: q.y - b.y,
            r: 8,
            "data-ref": refOf(b.id, q.branch),
            onpointerdown: (ev) => startWire(ev, b.id, q),
          }),
        ]),
      ),
    );
  }
  if (B.wire) kids.push(s("path", { class: "b-wire", d: curve(B.wire.x1, B.wire.y1, B.wire.x2, B.wire.y2) }));
  el.world.replaceChildren(...kids);
  el.world.setAttribute("transform", `translate(${B.view.x},${B.view.y}) scale(${B.view.k})`);
  el.hint.textContent =
    B.selected?.type === "edge"
      ? "✂️ Press Delete to cut this wire"
      : B.wire
        ? "🎯 Drop the wire on the block it should feed"
        : "🖱️ Drag blocks around · pull from a ● port to wire · scroll to zoom · drag the background to pan";
}
const clip = (t, n) => (String(t).length > n ? `${String(t).slice(0, n - 1)}…` : String(t));

// ── canvas interaction ────────────────────────────────────────────────────────────────────────────────────────────

const toWorld = (ev) => {
  const r = el.svg.getBoundingClientRect();
  return { x: (ev.clientX - r.left - B.view.x) / B.view.k, y: (ev.clientY - r.top - B.view.y) / B.view.k };
};

function wireCanvas() {
  el.svg.onpointerdown = (ev) => {
    if (ev.button !== 0) return;
    // background: pan, and drop the selection
    const start = { x: ev.clientX, y: ev.clientY, vx: B.view.x, vy: B.view.y };
    let moved = false;
    el.svg.setPointerCapture(ev.pointerId);
    el.svg.onpointermove = (m) => {
      if (Math.abs(m.clientX - start.x) + Math.abs(m.clientY - start.y) > 3) moved = true;
      B.view.x = start.vx + m.clientX - start.x;
      B.view.y = start.vy + m.clientY - start.y;
      el.world.setAttribute("transform", `translate(${B.view.x},${B.view.y}) scale(${B.view.k})`);
    };
    el.svg.onpointerup = () => {
      el.svg.onpointermove = null;
      el.svg.onpointerup = null;
      if (!moved) select(null);
    };
  };
  el.svg.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const r = el.svg.getBoundingClientRect();
      zoomBy(Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top);
    },
    { passive: false },
  );
  el.canvas.ondragover = (ev) => {
    if (ev.dataTransfer.types.includes("application/x-pipo")) {
      ev.preventDefault();
      el.canvas.classList.add("drop");
    }
  };
  el.canvas.ondragleave = () => el.canvas.classList.remove("drop");
  el.canvas.ondrop = (ev) => {
    el.canvas.classList.remove("drop");
    const raw = ev.dataTransfer.getData("application/x-pipo");
    if (!raw) return;
    ev.preventDefault();
    if (B.mode === "city") {
      const { onto } = el.city.dropAt(ev);
      B.selected = onto && onto !== "output" ? { type: "block", id: onto } : null;
      return place(JSON.parse(raw), null);
    }
    const at = toWorld(ev);
    // dropped onto a block: it feeds the new one
    const g = geometry();
    const onto = [...g.values()].find((b) => at.x >= b.x && at.x <= b.x + b.w && at.y >= b.y && at.y <= b.y + b.h);
    if (onto && onto.id !== "output") B.selected = { type: "block", id: onto.id };
    else if (!onto) B.selected = null;
    place(JSON.parse(raw), { x: at.x - W / 2, y: at.y - H / 2 });
  };
  el.canvas.onkeydown = (ev) => {
    if (ev.target.closest?.("input, textarea, select")) return;
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.key.toLowerCase() === "z") {
      ev.preventDefault();
      return ev.shiftKey ? redo() : undo();
    }
    if (mod && ev.key.toLowerCase() === "y") {
      ev.preventDefault();
      return redo();
    }
    if (ev.key === "Delete" || ev.key === "Backspace") {
      ev.preventDefault();
      deleteSelected();
    }
    if (ev.key === "Escape") select(null);
  };
}
// A running pipeline's live events (app.js relays the /events stream) send packets through the City view.
addEventListener("pipo:event", (ev) => {
  if (B?.mode === "city" && B.root?.isConnected && B.running && ev.detail?.pipeline === B.running.name)
    el.city.event(ev.detail);
});
// Undo/redo also work while the canvas isn't focused (but never steal them from a text field).
addEventListener("keydown", (ev) => {
  if (!B?.root?.isConnected || ev.target.closest?.("input, textarea, select, .b-canvas")) return;
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && ev.key.toLowerCase() === "z") {
    ev.preventDefault();
    if (ev.shiftKey) redo();
    else undo();
  } else if (mod && ev.key.toLowerCase() === "y") {
    ev.preventDefault();
    redo();
  }
});

function zoomBy(f, cx, cy) {
  const r = el.svg.getBoundingClientRect();
  const px = cx ?? r.width / 2;
  const py = cy ?? r.height / 2;
  const k = Math.min(2.5, Math.max(0.3, B.view.k * f));
  B.view.x = px - ((px - B.view.x) * k) / B.view.k;
  B.view.y = py - ((py - B.view.y) * k) / B.view.k;
  B.view.k = k;
  el.world.setAttribute("transform", `translate(${B.view.x},${B.view.y}) scale(${B.view.k})`);
}

function fit() {
  const g = [...geometry().values()];
  const r = el.svg.getBoundingClientRect();
  if (!g.length || !r.width) return;
  const minX = Math.min(...g.map((b) => b.x));
  const minY = Math.min(...g.map((b) => b.y));
  const maxX = Math.max(...g.map((b) => b.x + b.w));
  const maxY = Math.max(...g.map((b) => b.y + b.h));
  const k = Math.min(
    1.2,
    Math.max(0.35, Math.min((r.width - 80) / (maxX - minX || 1), (r.height - 80) / (maxY - minY || 1))),
  );
  B.view = { k, x: (r.width - (maxX - minX) * k) / 2 - minX * k, y: (r.height - (maxY - minY) * k) / 2 - minY * k };
  B.graphFitted = true;
}

function startDrag(ev, id) {
  if (ev.button !== 0 || ev.target.classList.contains("port")) return;
  ev.stopPropagation();
  const at = B.pos.get(id) ?? { x: 0, y: 0 };
  const start = { x: ev.clientX, y: ev.clientY };
  let moved = false;
  el.svg.setPointerCapture(ev.pointerId);
  el.svg.onpointermove = (m) => {
    const dx = (m.clientX - start.x) / B.view.k;
    const dy = (m.clientY - start.y) / B.view.k;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    B.pos.set(id, { x: Math.round((at.x + dx) / 2) * 2, y: Math.round((at.y + dy) / 2) * 2 });
    draw();
  };
  el.svg.onpointerup = () => {
    el.svg.onpointermove = null;
    el.svg.onpointerup = null;
    if (moved) savePos();
    select({ type: "block", id });
    el.canvas.focus({ preventScroll: true });
  };
}

function startWire(ev, id, port) {
  ev.stopPropagation();
  const ref = refOf(id, port.branch);
  B.wire = { ref, x1: port.x, y1: port.y, x2: port.x, y2: port.y };
  el.svg.setPointerCapture(ev.pointerId);
  el.svg.onpointermove = (m) => {
    const w = toWorld(m);
    B.wire.x2 = w.x;
    B.wire.y2 = w.y;
    draw();
  };
  el.svg.onpointerup = (m) => {
    el.svg.onpointermove = null;
    el.svg.onpointerup = null;
    const at = toWorld(m);
    B.wire = null;
    const onto = [...geometry().values()].find(
      (b) => b.id !== id && at.x >= b.x - 12 && at.x <= b.x + b.w && at.y >= b.y - 8 && at.y <= b.y + b.h + 8,
    );
    if (!onto) return draw();
    wireTo(ref, onto.id);
  };
}

/** Wire an out-port to a block, or say why it can't be. */
function wireTo(ref, to) {
  const problem = connectProblem(P(), ref, to);
  if (problem) {
    draw();
    return toast(`Can't wire that: ${problem}`, "warn");
  }
  commit(connect(P(), ref, to));
  toast(`Wired ${ref} → ${to} 🔗`);
}

function select(sel) {
  B.selected = sel;
  if (sel && B.panel !== "inspect" && B.panel !== "test") B.panel = "inspect";
  draw();
  side();
}

function deleteSelected() {
  const sel = B.selected;
  if (!sel) return;
  if (sel.type === "edge") {
    commit(disconnect(P(), sel.ref, sel.to));
    B.selected = null;
    draw();
    side();
    return toast("Snip ✂️");
  }
  if (sel.id === "output" || (isInput(P(), sel.id) && inputsOf(P()).length < 2))
    return toast("The input and output always stay; drop another one from the palette to swap it 🔁", "warn");
  removeBlock(sel.id);
}

/** Remove a node, and stitch its parents straight into what it fed so the line doesn't break. */
function removeBlock(id) {
  const p = P();
  const parents = [p.nodes?.[id]?.from ?? []].flat();
  let next = removeNode(p, id);
  for (const e of edges(p)) {
    if (e.from !== id) continue;
    for (const ref of parents) if (!connectProblem(next, ref, e.to)) next = connect(next, ref, e.to);
  }
  B.pos.delete(id);
  B.selected = null;
  commit(next);
  toast(`Removed ${id} 👋`);
}

// ── side panel ────────────────────────────────────────────────────────────────────────────────────────────────────

function showPanel(name) {
  B.panel = name;
  side();
}

function side() {
  if (!B) return;
  const errs = errorsOf(B.diagnostics).length;
  const tabs = [
    ["inspect", "🔧 Inspect"],
    ["yaml", "📜 YAML"],
    ["test", "🧪 Test"],
    ["problems", errs ? `⚠️ ${errs}` : "⚠️ 0"],
  ];
  const body =
    B.panel === "yaml"
      ? yamlPanel()
      : B.panel === "test"
        ? testPanel()
        : B.panel === "problems"
          ? problemsPanel()
          : inspector();
  el.side.replaceChildren(
    h(
      "div",
      { class: "tabs b-tabs", role: "tablist" },
      tabs.map(([t, label]) =>
        h(
          "button",
          {
            type: "button",
            role: "tab",
            "aria-selected": String(B.panel === t),
            class: B.panel === t ? "tab on" : "tab",
            onclick: () => showPanel(t),
          },
          label,
        ),
      ),
    ),
    h("div", { class: "b-side-body" }, body),
  );
}
function refreshProblems() {
  const tab = el.side.querySelector(".b-tabs .tab:last-child");
  if (tab) tab.textContent = `⚠️ ${errorsOf(B.diagnostics).length}`;
  const box = el.side.querySelector(".b-problems-here");
  if (box && B.selected?.type === "block")
    box.replaceChildren(...problemList(diagnosticsByBlock(B.diagnostics).get(B.selected.id) ?? []));
}

const problemList = (list) =>
  list.map((d) =>
    h(
      "div",
      { class: `problem ${d.severity}` },
      h(
        "div",
        null,
        h("b", null, d.severity === "error" ? "🚧 " : "💭 "),
        h("span", { class: "mono small" }, d.code),
        " ",
        d.message,
      ),
      d.hint ? h("div", { class: "hint small" }, `💡 ${d.hint}`) : null,
      fixFor(d),
    ),
  );

/**
 * A one-click fix for a problem, when there is one: create a schema file the pipeline names but doesn't have, or give
 * agent nodes a small daily cost cap (editable under 📋 Pipeline → 🤖 Agent budget).
 */
function fixFor(d) {
  const path = d.path ?? [];
  if (d.code === "P053") {
    return h(
      "button",
      {
        type: "button",
        class: "btn small fix",
        onclick: () => {
          commit(setPath(P(), ["agent_budget"], { per_day: 1 }));
          toast("Capped agent spend at $1 a day 💰", "ok", "change it under 📋 Pipeline → 🤖 Agent budget");
        },
      },
      "💰 Cap it at $1/day",
    );
  }
  if (d.code !== "P014" || path.at(-1) !== "schema") return null;
  const rel = getPath(P(), path);
  if (typeof rel !== "string") return null;
  const purpose = path[0] === "input" || path[0] === "inputs" ? "input" : "agent";
  return h(
    "button",
    { type: "button", class: "btn small primary fix", onclick: () => writeSchema(rel, starterSchema(rel, purpose)) },
    `✨ Create ${rel}`,
  );
}

// ── schema files ──────────────────────────────────────────────────────────────────────────────────────────────────

/** What is known about schema files, for the pipeline's current file (a draft's file moves when it is renamed). */
function schemas(b) {
  const file = fileFor(b);
  if (b.schemasFor !== file) {
    b.schemas = new Map();
    b.schemasFor = file;
  }
  return b.schemas;
}

/** Read a schema file the pipeline names (once per path; `force` reads it again). */
async function loadSchema(rel, force = false) {
  const b = B;
  if (!force && schemas(b).has(rel)) return;
  schemas(b).set(rel, { loading: true });
  try {
    const r = await api(`/builder/schema?file=${encodeURIComponent(fileFor(b))}&path=${encodeURIComponent(rel)}`);
    schemas(b).set(rel, r);
  } catch (e) {
    schemas(b).set(rel, { exists: false, schema: null, problem: e.message, error: true });
  }
  if (still(b) && (b.panel === "test" || b.panel === "inspect")) side();
}

/** Write a schema file next to the pipeline (replacing it when it exists), then check again. */
async function writeSchema(rel, schema) {
  const b = B;
  const known = schemas(b).get(rel);
  try {
    const r = await api("/builder/schema", { file: fileFor(b), path: rel, schema, overwrite: !!known?.exists });
    schemas(b).set(rel, { exists: true, schema, problem: null, file: r.file });
    toast(
      r.created ? `Created ${rel} ✨` : `Saved ${rel} 💾`,
      "ok",
      b.file ? null : `next to where the pipeline will be saved: ${fileFor(b)}`,
    );
  } catch (e) {
    if (e instanceof EngineDown) return still(b) && ctx.napping();
    if (e.code === "conflict") {
      await loadSchema(rel, true);
      return toast(`${rel} already exists; it's loaded in the 📐 answer shape now`, "warn");
    }
    return toast(`Couldn't write ${rel}: ${e.message}`, "bad", e.hint);
  }
  if (!still(b)) return;
  check();
  side();
}

/** The agent's answer shape: the JSON Schema file its `with.schema` names, editable in place. */
function schemaFold(rel, purpose) {
  if (typeof rel !== "string" || !rel.trim()) return null;
  if (rel.includes("${")) return null;
  const st = schemas(B).get(rel);
  if (!st) loadSchema(rel);
  const title = purpose === "input" ? "📐 Packet shape" : "📐 Answer shape";
  if (!st || st.loading) return fold(title, true, h("p", { class: "muted small" }, "Reading the schema file…"));
  const draft = st.draft ?? fmtJson(st.exists ? (st.schema ?? st.text ?? {}) : starterSchema(rel, purpose));
  const ta = h("textarea", {
    class: "code",
    rows: Math.min(14, Math.max(5, draft.split("\n").length)),
    value: draft,
    spellcheck: "false",
    "aria-label": `${rel} JSON Schema`,
    oninput: (e) => {
      st.draft = e.target.value;
      try {
        JSON.parse(st.draft);
        ta.classList.remove("invalid");
      } catch {
        ta.classList.add("invalid");
      }
    },
  });
  const save = () => {
    let schema;
    try {
      schema = JSON.parse(st.draft ?? draft);
    } catch (e) {
      return toast(`That isn't JSON yet: ${e.message}`, "bad");
    }
    st.draft = undefined;
    writeSchema(rel, schema);
  };
  return fold(
    title,
    !st.exists || !!st.problem,
    h(
      "p",
      { class: "muted small" },
      purpose === "input"
        ? "The JSON Schema every packet must match at the door. "
        : "The JSON Schema the agent's answer must match; the answer becomes the packet's data. ",
      st.exists ? `It lives in ${rel}, next to the pipeline.` : `${rel} doesn't exist yet: here's a starter.`,
    ),
    st.problem ? h("div", { class: "problem error" }, `🚧 ${st.problem}`) : null,
    ta,
    h(
      "div",
      { class: "toolbar" },
      h(
        "button",
        { type: "button", class: st.exists ? "btn small" : "btn small primary", onclick: save },
        st.exists ? "💾 Save schema" : `✨ Create ${rel}`,
      ),
    ),
  );
}

function problemsPanel() {
  const by = diagnosticsByBlock(B.diagnostics);
  if (!B.diagnostics.length)
    return h("div", { class: "empty" }, mascot("happy", 48), h("p", null, "No problems at all. Nice work! 🎉"));
  return [...by.entries()].map(([id, list]) =>
    h(
      "div",
      { class: "pgroup" },
      h(
        "button",
        {
          type: "button",
          class: "btn small",
          disabled: id === "pipeline",
          onclick: () => select({ type: "block", id }),
        },
        id === "pipeline" ? "📋 pipeline" : `${kindEmoji(blocks(P()).find((b) => b.id === id)?.kind ?? "node")} ${id}`,
      ),
      problemList(list),
    ),
  );
}

function yamlPanel() {
  return [
    h(
      "p",
      { class: "muted small" },
      "This is the .pipo file the canvas makes. Saving writes exactly this. ",
      B.base ? "Comments in the file are kept." : "",
    ),
    h("pre", { class: "b-yaml" }, B.source || "…"),
    h(
      "div",
      { class: "toolbar" },
      h(
        "button",
        {
          type: "button",
          class: "btn small",
          onclick: () =>
            navigator.clipboard?.writeText(B.source).then(
              () => toast("Copied 📋"),
              () => toast("Couldn't copy", "warn"),
            ),
        },
        "📋 Copy",
      ),
    ),
  ];
}

// ── inspector ─────────────────────────────────────────────────────────────────────────────────────────────────────

const field = (label, control, hint) =>
  h(
    "label",
    { class: "field" },
    h("span", { class: "field-label" }, label),
    control,
    hint ? h("span", { class: "field-hint" }, hint) : null,
  );
const fold = (title, open, ...kids) =>
  h("details", { class: "fold", open: open ? true : null }, h("summary", null, title), ...kids);

/** One input bound to a path in the pipeline. `kind`: text, code, number, int, bool, json, lines, select. */
function bound(path, kind = "text", opts = {}) {
  const value = getPath(P(), path);
  const key = Array.isArray(path) ? path.join("\u0000") : path;
  const set = (v) => commit(setPath(P(), path, v), { coalesce: key, keepSide: true });
  if (kind === "bool")
    return h("input", {
      type: "checkbox",
      checked: value === true,
      onchange: (e) => commit(setPath(P(), path, e.target.checked || undefined), { keepSide: true }),
    });
  if (kind === "select") {
    return h(
      "select",
      {
        onchange: (e) =>
          commit(setPath(P(), path, e.target.value === "" ? undefined : e.target.value), { keepSide: true }),
      },
      opts.optional === false ? null : h("option", { value: "" }, opts.none ?? "—"),
      opts.options.map((o) => h("option", { value: o, selected: value === o ? true : null }, o)),
    );
  }
  if (kind === "number" || kind === "int") {
    return h("input", {
      type: "number",
      step: kind === "int" ? 1 : "any",
      value: value ?? "",
      placeholder: opts.placeholder ?? "",
      oninput: (e) => set(e.target.value === "" ? undefined : Number(e.target.value)),
    });
  }
  if (kind === "lines") {
    return h("textarea", {
      class: "code",
      "data-expr": opts.expr ? "" : null,
      rows: opts.rows ?? 3,
      value: Array.isArray(value) ? value.join("\n") : "",
      placeholder: opts.placeholder ?? "",
      oninput: (e) => {
        const list = e.target.value
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        set(list.length ? list : undefined);
      },
    });
  }
  if (kind === "json") {
    const text = value === undefined ? "" : typeof value === "string" && opts.loose ? value : fmtJson(value);
    const ta = h("textarea", {
      class: "code",
      rows: opts.rows ?? Math.min(10, Math.max(3, text.split("\n").length)),
      value: text,
      placeholder: opts.placeholder ?? (opts.loose ? "JSON, or plain text with ${…}" : "JSON"),
      spellcheck: "false",
      oninput: (e) => {
        const t = e.target.value;
        if (!t.trim()) {
          ta.classList.remove("invalid");
          return set(undefined);
        }
        try {
          const v = JSON.parse(t);
          ta.classList.remove("invalid");
          set(v);
        } catch {
          if (opts.loose) {
            ta.classList.remove("invalid");
            set(t);
          } else ta.classList.add("invalid");
        }
      },
    });
    return ta;
  }
  const input = h("input", {
    class: kind === "code" ? "code" : "",
    "data-expr": opts.expr ? "" : null,
    value: value ?? "",
    placeholder: opts.placeholder ?? "",
    spellcheck: kind === "code" ? "false" : null,
    oninput: (e) => set(e.target.value === "" ? undefined : e.target.value),
  });
  if (!opts.suggest?.length) return input;
  // A free-text field with suggestions (an agent's models, D67).
  const id = `suggest-${key.replace(/[^\w-]/g, "_")}`;
  input.setAttribute("list", id);
  return h(
    "div",
    { class: "combo" },
    input,
    h(
      "datalist",
      { id },
      opts.suggest.map((v) => h("option", { value: v })),
    ),
  );
}

/** A form for a connector's `with:` block, generated from its JSON Schema (manifests in @pipo/spec). */
function schemaForm(schema, base, opts = {}) {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const keys = Object.keys(props);
  if (!keys.length) return h("p", { class: "muted small" }, "Nothing to set up here. It just works ✨");
  return keys.map((k) => {
    const ps = props[k] ?? {};
    const path = [...base, k];
    const label = `${k}${required.has(k) ? " *" : ""}`;
    const types = [ps.type].flat().filter(Boolean);
    if (ps.enum) return field(label, bound(path, "select", { options: ps.enum.map(String) }));
    if (types.includes("boolean")) return field(label, bound(path, "bool"));
    if (types.length === 1 && (types[0] === "integer" || types[0] === "number"))
      return field(
        label,
        bound(path, types[0] === "integer" ? "int" : "number", {
          placeholder: ps.minimum !== undefined ? `≥ ${ps.minimum}` : "",
        }),
      );
    if (types.length === 1 && types[0] === "array" && ps.items?.enum) {
      const now = new Set(getPath(P(), path) ?? []);
      return field(
        label,
        h(
          "div",
          { class: "checks" },
          ps.items.enum.map((o) =>
            h(
              "label",
              { class: "check" },
              h("input", {
                type: "checkbox",
                checked: now.has(o),
                onchange: (e) => {
                  const cur = new Set(getPath(P(), path) ?? []);
                  if (e.target.checked) cur.add(o);
                  else cur.delete(o);
                  const list = ps.items.enum.filter((x) => cur.has(x));
                  commit(setPath(P(), path, list.length ? list : undefined), { keepSide: true });
                },
              }),
              ` ${o}`,
            ),
          ),
        ),
      );
    }
    if (types.length === 1 && types[0] === "string") {
      const long = k === "prompt" || k === "message" || k === "sql" || k === "query";
      if (long)
        return field(
          label,
          h("textarea", {
            class: "code",
            rows: 4,
            value: getPath(P(), path) ?? "",
            oninput: (e) =>
              commit(setPath(P(), path, e.target.value || undefined), {
                coalesce: path.join("\u0000"),
                keepSide: true,
              }),
          }),
          "Use ${data.field} to put packet values in",
        );
      return field(
        label,
        bound(path, "code", {
          placeholder:
            opts.placeholder?.[k] ??
            (ps.default !== undefined
              ? String(ps.default)
              : ps.pattern === "^\\d+(\\.\\d+)?(ms|s|m|h|d)$"
                ? "e.g. 30s, 5m, 1h"
                : ""),
          suggest: opts.suggest?.[k],
        }),
        opts.suggest?.[k]?.length ? `pick one of the ${opts.suggest[k].length} listed here, or type any` : null,
      );
    }
    // objects, arrays and anything-goes values: JSON (or text with ${…} when any type fits)
    return field(
      label,
      bound(path, "json", { loose: !types.length }),
      types.length ? null : "JSON, or text such as ${data}",
    );
  });
}

const THEN_HELP = "what happens once retries run out";
function policyForm(base) {
  return fold(
    "🛟 When it fails",
    getPath(P(), base) !== undefined,
    h(
      "div",
      { class: "grid2" },
      field("retry", bound([...base, "retry"], "int", { placeholder: "0" })),
      field("backoff", bound([...base, "backoff"], "select", { options: ["fixed", "exponential"] })),
      field("delay", bound([...base, "delay"], "code", { placeholder: "1s" })),
      field("then", bound([...base, "then"], "select", { options: catalog.then }), THEN_HELP),
    ),
  );
}

function inspector() {
  const sel = B.selected;
  if (sel?.type === "edge") {
    return [
      h("h3", null, "🔗 Wire"),
      h("p", null, h("b", { class: "mono" }, sel.ref), " → ", h("b", { class: "mono" }, sel.to)),
      h("button", { type: "button", class: "btn danger", onclick: deleteSelected }, "✂️ Cut this wire"),
    ];
  }
  if (sel?.type !== "block") return pipelineForm();
  const id = sel.id;
  const p = P();
  const here = h("div", { class: "b-problems-here" }, problemList(diagnosticsByBlock(B.diagnostics).get(id) ?? []));
  if (isInput(p, id))
    return [heading("input", inputsOf(p).length > 1 ? id : inputOf(p, id).via, id), here, dataFold(id), inputForm(id)];
  if (id === "output") return [heading("output", p.output.to, "output"), here, dataFold(id), outputForm()];
  const node = p.nodes?.[id];
  if (!node) return pipelineForm();
  const kind = blocks(p).find((b) => b.id === id)?.kind ?? "node";
  return [heading(kind, id, id), here, dataFold(id), nodeForm(id, node, kind)];
}

/** The text field the user was last in, so a 📦 data path can be put there (D70). */
let lastField = null;
document.addEventListener("focusin", (e) => {
  if (e.target.matches?.(".b-side textarea, .b-side input:not([type=checkbox])")) lastField = e.target;
});

/** 📦 What `data` looks like here, as an example; a click on a path puts it in the last field (D70). */
function dataFold(id) {
  const ctx = {
    inputs: catalog.inputs,
    schemaOf: (rel) => {
      if (rel.includes("${")) return null;
      const st = schemas(B).get(rel);
      if (!st) loadSchema(rel);
      return st?.exists ? (st.schema ?? null) : null;
    },
  };
  const shape = isInput(P(), id) ? shapeOut(P(), id, ctx) : shapeIn(P(), id, ctx);
  const title = isInput(P(), id) ? "📦 Data it sends" : "📦 Data coming in";
  if (shape === null)
    return fold(
      title,
      false,
      h(
        "p",
        { class: "muted small" },
        "Not known before a run: the sender, a function, an http call or an agent without a schema decides it. " +
          "A 🧪 test run shows the real data, and a schema file (input or agent) makes it known here.",
      ),
    );
  const put = (path) => {
    const f = lastField;
    if (!f?.isConnected) return toast("Click into a field first, then on a path", "warn");
    const text = f.dataset.expr !== undefined ? path : `\${${path}}`;
    f.setRangeText(text, f.selectionStart ?? f.value.length, f.selectionEnd ?? f.value.length, "end");
    f.dispatchEvent(new Event("input", { bubbles: true }));
    f.focus();
  };
  return fold(
    title,
    false,
    h("pre", { class: "code small" }, fmtJson(shape)),
    h(
      "div",
      { class: "chips" },
      dataPaths(shape).map((path) =>
        h(
          "button",
          {
            type: "button",
            class: "tag mono",
            title: "Put it in the field you were last in",
            onmousedown: (e) => e.preventDefault(), // keep the field's cursor
            onclick: () => put(path),
          },
          path,
        ),
      ),
    ),
    h("p", { class: "muted small" }, "An example. Click a path to put it in the field you were last in."),
  );
}

function heading(kind, title, id) {
  return h(
    "div",
    { class: "b-head" },
    h("span", { class: "b-head-emoji" }, kindEmoji(kind)),
    h("div", null, h("h3", null, title), h("div", { class: "muted small" }, BLURB[kind] ?? "")),
    id !== "output" && !(isInput(P(), id) && inputsOf(P()).length < 2)
      ? h(
          "button",
          {
            type: "button",
            class: "icon-btn danger",
            title: "Remove this block (Delete)",
            onclick: () => removeBlock(id),
          },
          "🗑️",
        )
      : null,
  );
}

function feedsField(path) {
  const from = [getPath(P(), path) ?? []].flat();
  return field(
    "fed by",
    h(
      "div",
      { class: "chips" },
      from.length
        ? from.map((ref) =>
            h(
              "span",
              { class: "tag" },
              ref,
              h(
                "button",
                {
                  type: "button",
                  class: "x",
                  title: `Cut ${ref}`,
                  onclick: () => commit(disconnect(P(), ref, path[0] === "output" ? "output" : path[1])),
                },
                "×",
              ),
            ),
          )
        : h("span", { class: "c-warn small" }, "nothing yet: drag a wire into this block"),
    ),
  );
}

/** The name field of a node or an input: other blocks refer to it by this name, so a rename fixes their refs. */
function nameField(id, hint) {
  const idInput = h("input", {
    class: "code",
    value: id,
    onchange: (e) => {
      const next = e.target.value.trim();
      const why = renameProblem(P(), id, next);
      if (why) {
        e.target.value = id;
        return toast(`Can't rename: ${why}`, "warn");
      }
      if (B.pos.has(id)) {
        B.pos.set(next, B.pos.get(id));
        B.pos.delete(id);
        savePos();
      }
      el.city.rename(id, next);
      B.selected = { type: "block", id: next };
      commit(renameNode(P(), id, next));
    },
  });
  return field("id", idInput, hint);
}

function nodeForm(id, node, kind) {
  const base = ["nodes", id];
  const parts = [
    nameField(id, "other blocks refer to it by this name"),
    field("label", bound([...base, "label"], "text", { placeholder: "a few words for humans" })),
    feedsField([...base, "from"]),
  ];
  if (kind === "filter") {
    parts.push(
      field(
        "keep when",
        bound([...base, "filter"], "code", { expr: true }),
        "an expression; true keeps the packet, e.g. data.age >= 18",
      ),
    );
  } else if (kind === "route") {
    parts.push(routeForm(id, node));
  } else {
    const list = kind === "tap" ? catalog.taps : kind === "agent" ? catalog.agents : catalog.transforms;
    const current = String(node[kind]);
    const isFn = current.startsWith("fn.");
    parts.push(
      field(
        kind === "tap" ? "tap" : kind === "agent" ? "provider" : "transform",
        h(
          "select",
          {
            onchange: (e) => {
              const v = e.target.value;
              if (v === "fn.") {
                const name = prompt("Name of the exported function in your fn module (fn.<name>):", "clean");
                if (!name) return side();
                return commit(setPath(setPath(P(), [...base, kind], `fn.${name}`), [...base, "with"], undefined));
              }
              if (kind === "agent") return commit(switchAgent(P(), id, v, list[v]?.with, starterModel(v)));
              commit(setPath(P(), [...base, kind], v));
            },
          },
          Object.keys(list).map((name) =>
            h(
              "option",
              { value: name, selected: current === name ? true : null },
              kind === "agent"
                ? `${connectorEmoji(name)} ${agentLabel(name)}${agentInfo?.[name]?.ready === false ? " (not set up here)" : ""}`
                : `${connectorEmoji(name)} ${name}`,
            ),
          ),
          kind !== "agent"
            ? h(
                "option",
                { value: isFn ? current : "fn.", selected: isFn ? true : null },
                isFn ? `🧩 ${current}` : "🧩 my own function (fn.…)",
              )
            : null,
        ),
        isFn
          ? "set `fn:` on the pipeline (📋 nothing selected) to your module's path"
          : kind === "agent" && current === "claude_api"
            ? `${list[current]?.description}; when it runs it needs ANTHROPIC_API_KEY (or agents.claude_api.api_key in config.yaml)`
            : kind === "agent" && list[current]?.runs === "cli"
              ? `${list[current]?.description}. It runs on this machine as you, in a fresh empty folder with its tools off; cwd and allow_tools change that`
              : list[current]?.description,
      ),
    );
    const off = kind === "agent" ? agentInfo?.[current] : null;
    if (off && off.ready === false)
      parts.push(
        h(
          "div",
          { class: "b-warn" },
          h("b", null, `⚠️ ${agentLabel(current)} can't be used here: `),
          off.reason,
          off.hint ? h("div", { class: "small" }, `💡 ${off.hint}`) : null,
          h("button", { type: "button", class: "btn small", onclick: () => loadAgents(true) }, "🔄 check again"),
        ),
      );
    if (!isFn)
      parts.push(
        h(
          "div",
          { class: "fold-plain" },
          h("div", { class: "field-label" }, "⚙️ settings"),
          schemaForm(
            list[current]?.with,
            [...base, "with"],
            kind === "agent"
              ? {
                  suggest: { model: agentInfo?.[current]?.models ?? [] },
                  placeholder: list[current]?.runs === "cli" ? { model: "the CLI's own default" } : {},
                }
              : {},
          ),
        ),
      );
    if (kind === "agent") parts.push(schemaFold(node.with?.schema, "agent"));
  }
  parts.push(policyForm([...base, "on_error"]));
  const loop = node.loop;
  const upstream = Object.keys(P().nodes ?? {}).filter((n) => n !== id);
  parts.push(
    fold(
      "🔁 Loop back",
      !!loop,
      h("p", { class: "muted small" }, "Run again from an earlier block until a condition holds."),
      h(
        "div",
        { class: "grid2" },
        field("back to", bound([...base, "loop", "back_to"], "select", { options: upstream })),
        field("max passes", bound([...base, "loop", "max"], "int", { placeholder: "3" })),
      ),
      field("until", bound([...base, "loop", "until"], "code", { placeholder: "data.done == true", expr: true })),
      loop
        ? h(
            "button",
            { type: "button", class: "btn small", onclick: () => commit(setPath(P(), [...base, "loop"], undefined)) },
            "Remove loop",
          )
        : null,
    ),
  );
  return parts;
}

function routeForm(id, node) {
  const base = ["nodes", id, "route"];
  const branches = Object.entries(node.route ?? {});
  return h(
    "div",
    { class: "fold-plain" },
    h("div", { class: "field-label" }, "🔀 paths, checked top to bottom"),
    branches.map(([name, expr]) =>
      h(
        "div",
        { class: "branch" },
        h("input", {
          class: "code b-branch-name",
          value: name,
          "aria-label": "path name",
          onchange: (e) => {
            const next = e.target.value.trim();
            const renamed = renameBranch(P(), id, name, next);
            if (renamed === P()) {
              e.target.value = name;
              return toast("Use letters, digits, _ and -, and a name no other path has", "warn");
            }
            commit(renamed);
          },
        }),
        h("input", {
          class: "code",
          value: expr,
          "data-expr": "",
          "aria-label": `when ${name}`,
          placeholder: "data.x > 1, or else",
          oninput: (e) =>
            commit(setPath(P(), [...base, name], e.target.value), { coalesce: `route:${id}:${name}`, keepSide: true }),
        }),
        h(
          "button",
          {
            type: "button",
            class: "icon-btn",
            title: `Remove ${name}`,
            onclick: () => commit(removeBranch(P(), id, name)),
          },
          "🗑️",
        ),
      ),
    ),
    h(
      "button",
      {
        type: "button",
        class: "btn small",
        onclick: () => {
          const names = new Set(Object.keys(node.route ?? {}));
          let n = 1;
          while (names.has(`path${n}`)) n++;
          // a new path goes before `else`, which must stay last
          const entries = Object.entries(P().nodes[id].route ?? {});
          const at = entries.findIndex(([, v]) => v === "else");
          entries.splice(at < 0 ? entries.length : at, 0, [`path${n}`, "data != null"]);
          commit(setPath(P(), base, Object.fromEntries(entries)));
        },
      },
      "➕ Add a path",
    ),
    h(
      "p",
      { class: "muted small" },
      "A packet takes the first path whose expression is true. `else` catches the rest and goes last.",
    ),
  );
}

function inputForm(id) {
  const p = P();
  const input = inputOf(p, id);
  const at = inputPath(p, id);
  const m = catalog.inputs[input.via];
  return [
    feedsHint(
      inputsOf(p).length > 1
        ? "Packets enter the pipeline here; meta.input tells them apart from the other inputs' packets."
        : "Packets enter the pipeline here. Drop another input from the palette to take packets from two places.",
    ),
    nameField(id, "nodes take packets from it by this name (from:)"),
    field(
      "comes from",
      h(
        "select",
        { onchange: (e) => commit(setInput(P(), e.target.value, id)) },
        Object.keys(catalog.inputs).map((n) =>
          h("option", { value: n, selected: input.via === n ? true : null }, `${connectorEmoji(n)} ${n}`),
        ),
      ),
      m?.description,
    ),
    h(
      "div",
      { class: "fold-plain" },
      h("div", { class: "field-label" }, "⚙️ settings"),
      schemaForm(m?.with, [...at, "with"]),
    ),
    input.via === "http" && window.pipoEngine?.listen
      ? h(
          "p",
          { class: "muted small wrapany" },
          "📮 Once it runs, send packets to ",
          h("code", null, `http://127.0.0.1:${window.pipoEngine.listen}/in/${p.name}${input.with?.path ?? "/"}`),
        )
      : null,
    input.via === "pipeline"
      ? feedsHint("Other pipelines feed it with `to: pipeline`; list the ones allowed in `from`.")
      : null,
    fold(
      "🛂 Checks at the door",
      !!(input.validate || input.schema || input.format),
      field("format", bound([...at, "format"], "select", { options: ["json", "text", "csv", "form", "bytes"] })),
      field(
        "schema",
        bound([...at, "schema"], "code", { placeholder: "./person.schema.json" }),
        "a JSON Schema file next to the pipeline",
      ),
      schemaFold(input.schema, "input"),
      field(
        "validate",
        bound([...at, "validate"], "lines", { placeholder: "data.email != null", expr: true }),
        "one rule per line; all must hold",
      ),
      field("if invalid", bound([...at, "on_invalid", "then"], "select", { options: catalog.then })),
    ),
  ];
}
const feedsHint = (text) => h("p", { class: "muted small" }, text);

function outputForm() {
  const p = P();
  const m = catalog.outputs[p.output.to];
  const checks = ["ack", "external", "none", ...(m?.checks ?? [])];
  const check = p.delivered?.check;
  return [
    feedsField(["output", "from"]),
    field(
      "goes to",
      h(
        "select",
        { onchange: (e) => commit(setOutput(P(), e.target.value)) },
        Object.keys(catalog.outputs).map((n) =>
          h("option", { value: n, selected: p.output.to === n ? true : null }, `${connectorEmoji(n)} ${n}`),
        ),
      ),
      m?.description,
    ),
    h(
      "div",
      { class: "fold-plain" },
      h("div", { class: "field-label" }, "⚙️ settings"),
      schemaForm(m?.with, ["output", "with"]),
    ),
    m?.batch
      ? fold(
          "📦 Batching",
          !!p.output.batch,
          h(
            "div",
            { class: "grid2" },
            field("size", bound(["output", "batch", "size"], "int", { placeholder: "100" })),
            field("within", bound(["output", "batch", "within"], "code", { placeholder: "5s" })),
          ),
        )
      : null,
    fold(
      "✅ Delivery check",
      !!p.delivered,
      h("p", { class: "muted small" }, "How Pipo makes sure a packet really arrived."),
      field("check", bound(["delivered", "check"], "select", { options: checks })),
      check && catalog.checks[check]
        ? h("div", null, schemaForm(catalog.checks[check].with, ["delivered", "with"]))
        : null,
      field("within", bound(["delivered", "within"], "code", { placeholder: "30s" })),
    ),
    policyForm(["output", "on_error"]),
  ];
}

function pipelineForm() {
  const p = P();
  const secrets = Object.entries(p.secrets ?? {});
  return [
    h(
      "div",
      { class: "b-head" },
      h("span", { class: "b-head-emoji" }, "📋"),
      h(
        "div",
        null,
        h("h3", null, "Pipeline"),
        h("div", { class: "muted small" }, "Click a block to set it up. These apply to the whole pipeline."),
      ),
    ),
    h("div", { class: "b-problems-here" }, problemList(diagnosticsByBlock(B.diagnostics).get("pipeline") ?? [])),
    field("description", bound(["description"], "text", { placeholder: "What does it do?" })),
    field("fn module", bound(["fn"], "code", { placeholder: "./my.fn.ts" }), "your own functions, used as fn.<name>"),
    h(
      "div",
      { class: "grid2" },
      field("concurrency", bound(["concurrency"], "int", { placeholder: "4" }), "1 keeps order"),
      field("ttl", bound(["lifetime", "ttl"], "code", { placeholder: "e.g. 8h" }), "stop after"),
    ),
    fold(
      "🔐 Secrets",
      secrets.length > 0,
      h(
        "p",
        { class: "muted small" },
        "Name → reference. Use ",
        h("code", null, "op://vault/item/field"),
        " (1Password, recommended) or ",
        h("code", null, "env:NAME"),
        ". Never paste the secret itself 🙅",
      ),
      secrets.map(([name, ref]) =>
        h(
          "div",
          { class: "branch" },
          h("input", { class: "code", value: name, readonly: true, "aria-label": "secret name" }),
          h("input", {
            class: "code",
            value: ref,
            "aria-label": `${name} reference`,
            oninput: (e) =>
              commit(setPath(P(), ["secrets", name], e.target.value), { coalesce: `secret:${name}`, keepSide: true }),
          }),
          h(
            "button",
            {
              type: "button",
              class: "icon-btn",
              title: `Remove ${name}`,
              onclick: () => {
                let next = setPath(P(), ["secrets", name], undefined);
                if (!Object.keys(next.secrets ?? {}).length) next = setPath(next, ["secrets"], undefined);
                commit(next);
              },
            },
            "🗑️",
          ),
        ),
      ),
      h(
        "button",
        {
          type: "button",
          class: "btn small",
          onclick: () => {
            const name = prompt("Secret name (used as ${secrets.<name>}):", "api_token");
            if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return;
            commit(setPath(P(), ["secrets", name], "op://Pipo/item/field"));
          },
        },
        "➕ Add a secret reference",
      ),
    ),
    policyForm(["errors"]),
    fold(
      "🤖 Agent budget",
      !!p.agent_budget,
      h("p", { class: "muted small" }, "A daily cap for agent nodes, in USD."),
      h(
        "div",
        { class: "grid2" },
        field("per day", bound(["agent_budget", "per_day"], "number", { placeholder: "5" })),
        field("per packet", bound(["agent_budget", "per_packet"], "number", { placeholder: "0.05" })),
      ),
    ),
  ];
}

// ── test panel (dry run) ──────────────────────────────────────────────────────────────────────────────────────────

/** Nodes a dry run needs a stub for: agent nodes and transforms other than map and fn.* (as `pipo test`). */
const stubbable = (p) =>
  Object.entries(p.nodes ?? {})
    .filter(
      ([, n]) =>
        n.agent !== undefined ||
        (n.transform !== undefined && n.transform !== "map" && !String(n.transform).startsWith("fn.")),
    )
    .map(([id]) => id);

function testPanel() {
  const t = B.test;
  const need = stubbable(P());
  // Prefilled per set of stubbable nodes: the file's fixtures/stubs.json, else for an agent an answer made from its
  // schema (so it passes the schema check), else a placeholder.
  const schemaOf = (id) => {
    const rel = P().nodes?.[id]?.agent !== undefined ? P().nodes[id].with?.schema : undefined;
    if (typeof rel !== "string" || rel.includes("${")) return null;
    if (!schemas(B).has(rel)) loadSchema(rel);
    return schemas(B).get(rel);
  };
  const key = need.map((id) => `${id}:${JSON.stringify(schemaOf(id)?.schema ?? null)}`).join();
  if (t.stubsFor !== key) {
    t.stubsFor = key;
    const known = B.stubs ?? {};
    const guess = (id) => {
      const st = schemaOf(id);
      return st?.exists && st.schema ? exampleOf(st.schema) : { example: "what it would return" };
    };
    t.stubs = need.length ? fmtJson(Object.fromEntries(need.map((id) => [id, known[id] ?? guess(id)]))) : "";
  }
  const r = t.result;
  return [
    h(
      "p",
      { class: "muted small" },
      "🧪 A dry run sends a packet through this draft in memory. Nothing is called, sent or written: taps and the output only show what they ",
      h("i", null, "would"),
      " do.",
    ),
    B.fixtures.length
      ? field(
          "fixtures",
          h(
            "div",
            { class: "chips" },
            B.fixtures.map((f) =>
              h(
                "button",
                {
                  type: "button",
                  class: t.fixture === f.name ? "tag ok" : "tag",
                  title: "Use this fixture's packet (with its meta and stubs)",
                  onclick: () => {
                    t.input = fmtJson(f.data);
                    t.fixture = f.name;
                    side();
                  },
                },
                `📎 ${f.name}`,
              ),
            ),
            h("button", { type: "button", class: "btn small", onclick: () => dryRun(B.fixtures) }, "▶️ Run all"),
          ),
        )
      : null,
    B.fixturesError ? h("div", { class: "problem warning" }, `🤔 fixtures: ${B.fixturesError}`) : null,
    field(
      "packet data",
      h("textarea", {
        class: "code",
        rows: 6,
        value: t.input,
        spellcheck: "false",
        oninput: (e) => (t.input = e.target.value),
      }),
      t.fixture ? `from fixture ${t.fixture}; edit it and it runs as a one-off packet` : null,
    ),
    need.length
      ? field(
          "stubs",
          h("textarea", {
            class: "code",
            rows: 5,
            value: t.stubs,
            spellcheck: "false",
            oninput: (e) => (t.stubs = e.target.value),
          }),
          `what ${need.join(", ")} would answer (they're never called in a test)`,
        )
      : null,
    h(
      "div",
      { class: "toolbar" },
      h(
        "button",
        { type: "button", class: "btn primary", disabled: t.running, onclick: () => dryRun() },
        t.running ? "⏳ running…" : "🧪 Dry run",
      ),
      B.running?.state === "running"
        ? h("a", { class: "btn", href: `#/p/${B.running.name}` }, "🛰️ Push a real one")
        : null,
    ),
    r ? testResult(r) : null,
  ];
}

async function dryRun(fixtures) {
  const b = B;
  const t = b.test;
  let list = fixtures;
  if (!list) {
    let data;
    try {
      data = JSON.parse(t.input);
    } catch (e) {
      return toast(`The packet isn't JSON yet: ${e.message}`, "bad");
    }
    // The picked fixture as is (its meta and stubs too), unless its data was edited.
    const fx = b.fixtures.find((f) => f.name === t.fixture);
    list = [fx && JSON.stringify(fx.data) === JSON.stringify(data) ? fx : { name: "ui-test", data }];
  }
  let stubs;
  if (t.stubs?.trim()) {
    try {
      stubs = JSON.parse(t.stubs);
    } catch (e) {
      return toast(`The stubs aren't JSON yet: ${e.message}`, "bad");
    }
  }
  t.running = true;
  side();
  try {
    const r = await api("/builder/test", {
      source: b.source,
      file: fileFor(b),
      fixtures: list.map(({ name, data, meta, stubs: own }) => ({
        name,
        data,
        ...(meta ? { meta } : {}),
        ...(own ? { stubs: own } : {}),
      })),
      ...(stubs ? { stubs } : {}),
    });
    t.result = r;
    b.trace = traceOf(r.fixtures?.[0]);
    t.running = false;
    if (!still(b)) return;
    const f = r.fixtures?.[0];
    if (r.fixtures?.length === 1)
      toast(
        f?.outcome === "delivered" ? "It made it all the way through! 🎉" : `Outcome: ${f?.outcome}`,
        f?.outcome === "delivered" ? "ok" : "warn",
      );
    else toast(`Ran ${r.fixtures.length} fixtures 🧪`);
  } catch (e) {
    t.running = false;
    if (!still(b)) return;
    if (e instanceof EngineDown) return ctx.napping();
    t.result = { error: e.message, hint: e.hint, diagnostics: e.body?.diagnostics ?? [], gaps: e.body?.gaps ?? [] };
    b.trace = new Map();
  }
  draw();
  side();
}

/** Where a fixture went, to light up the canvas: per block ran, failed here, or stopped (filtered), and the wires in. */
function traceOf(f) {
  const trace = new Map();
  if (!f) return trace;
  if (f.outcome === "rejected") return trace.set(f.input ?? firstInput(P()), { status: "bad", via: new Set() });
  const mark = (id, status) => {
    const cur = trace.get(id) ?? { status: "ok", via: new Set() };
    if (status !== "ok") cur.status = status;
    trace.set(id, cur);
    return cur;
  };
  // Every leaf unit's steps run from the input (a copy starts with its parent's history).
  for (const u of (f.units ?? []).filter((x) => x.outcome !== "branched")) {
    let prev = null;
    for (const st of u.steps ?? []) {
      const cur = mark(parseRef(st.step).node, "ok");
      if (prev) cur.via.add(prev);
      prev = st.step;
    }
    if (u.error) mark(u.error.step === "output" ? "output" : parseRef(u.error.step).node, "bad");
    else if (u.outcome === "filtered" && prev && parseRef(prev).node !== "output") mark(parseRef(prev).node, "stop");
  }
  return trace;
}

function testResult(r) {
  if (r.error) {
    return h(
      "div",
      { class: "card oops" },
      h("div", { class: "oops-title" }, `😬 ${r.error}`),
      r.hint ? h("div", { class: "hint" }, `💡 ${r.hint}`) : null,
      problemList(r.diagnostics.filter((d) => d.severity === "error")),
      r.gaps.map((g) => h("div", { class: "hint small" }, `🚧 ${g.feature ?? g.message ?? fmtJson(g)}`)),
    );
  }
  return r.fixtures.map((f) =>
    h(
      "div",
      { class: "result" },
      h("div", { class: "result-head" }, h("b", null, `📎 ${f.fixture}`), badge(f.outcome)),
      f.error
        ? h(
            "div",
            { class: "c-bad small" },
            `${f.error.step}: ${f.error.message}`,
            f.error.hint ? h("div", { class: "hint small" }, `💡 ${f.error.hint}`) : null,
          )
        : null,
      (f.units ?? [])
        .filter((u) => u.outcome !== "branched")
        .map((u) =>
          h(
            "div",
            { class: "unit" },
            f.units.length > 1
              ? h("div", { class: "muted small" }, `🌿 ${u.branch || "packet"} → `, badge(u.outcome))
              : null,
            h(
              "ol",
              { class: "trail" },
              (u.steps ?? []).map((st, i) =>
                h(
                  "li",
                  null,
                  h(
                    "details",
                    { open: i === (u.steps.length ?? 0) - 1 ? true : null },
                    h(
                      "summary",
                      null,
                      h(
                        "span",
                        { class: "mono" },
                        `${kindEmoji(isInput(P(), st.step) ? "input" : st.step === "output" ? "output" : blocks(P()).find((b) => b.id === parseRef(st.step).node)?.kind)} ${st.step}`,
                      ),
                    ),
                    h("pre", null, fmtJson(st.data)),
                  ),
                ),
              ),
            ),
            u.error ? h("div", { class: "c-bad small" }, `💥 ${u.error.step}: ${u.error.message}`) : null,
            (u.warnings ?? []).map((w) => h("div", { class: "c-warn small" }, `🤔 ${w.step}: ${w.message}`)),
            u.write
              ? h(
                  "details",
                  { class: "would" },
                  h("summary", null, `📤 would write to ${u.write.to} (key ${u.write.key})`),
                  h("pre", null, fmtJson(u.write.record ?? u.write.with)),
                )
              : null,
          ),
        ),
      f.taps?.length
        ? h(
            "details",
            { class: "would" },
            h("summary", null, `🪝 ${f.taps.length} tap(s) would fire`),
            h("pre", null, fmtJson(f.taps)),
          )
        : null,
      f.calls?.length
        ? h(
            "details",
            { class: "would" },
            h("summary", null, `📞 ${f.calls.length} call(s) were stubbed`),
            h("pre", null, fmtJson(f.calls)),
          )
        : null,
    ),
  );
}

// ── save, run, apply ──────────────────────────────────────────────────────────────────────────────────────────────

/** Wait for the check of the latest edit, so what is saved is what is shown. */
async function settled(b) {
  for (let i = 0; i < 50 && b.checking; i++) await new Promise((r) => setTimeout(r, 100));
}

// save, run and applyLive work on the builder they started in (`b`): if another file is opened meanwhile, they
// finish for `b` and leave the screen alone.
async function save({ quiet = false, b = B } = {}) {
  await settled(b);
  if (!b.source) return false;
  let file = b.file;
  let overwrite = !!b.file;
  if (!file) {
    file = prompt("Save as (a .pipo file inside the engine's workspace):", fileFor(b));
    if (!file) return false;
  }
  const source = b.source;
  for (;;) {
    try {
      const r = await api("/builder/save", { file, source, overwrite });
      const wasNew = !b.file;
      b.file = r.file ?? file;
      b.base = source;
      // an edit made while saving is still unsaved
      b.dirty = b.source !== source;
      store.set(b.draftKey, null);
      b.draftKey = `pipo-builder:file:${b.file}`;
      store.set(b.draftKey, b.dirty ? { pipeline: b.hist.value, base: b.base } : null);
      if (wasNew) {
        store.set(`pipo-pos:${b.file}`, Object.fromEntries(b.pos));
        b.key = `f:${b.file}`;
        if (still(b)) history.replaceState(null, "", `#/build/f/${encodeURIComponent(b.file)}`);
      }
      // Off screen (another file is open now), the save still says which file it was.
      const what = still(b) ? "Saved 💾" : `Saved ${b.file.split("/").pop()} 💾`;
      if (!quiet || !still(b))
        toast(
          errorsOf(r.diagnostics).length ? `${what} (it still has problems to fix)` : what,
          errorsOf(r.diagnostics).length ? "warn" : "ok",
        );
      if (still(b)) top();
      return true;
    } catch (e) {
      if (e instanceof EngineDown) {
        if (still(b)) ctx.napping();
        return false;
      }
      if (e.code === "conflict" && !overwrite && still(b)) {
        if (!confirm(`${file} already exists. Replace it?`)) return false;
        overwrite = true;
        continue;
      }
      toast(`Couldn't save ${file}: ${e.message}`, "bad", e.hint);
      return false;
    }
  }
}

async function run() {
  const b = B;
  await settled(b);
  if (!still(b)) return;
  if (errorsOf(b.diagnostics).length) {
    showPanel("problems");
    return toast("Let's fix the problems first 🚧", "warn", "they're listed in the ⚠️ tab");
  }
  if (!(await save({ quiet: true, b }))) return;
  const name = b.hist.value.name;
  try {
    const known = await api(`/pipelines/${encodeURIComponent(name)}`).catch(() => null);
    if (known && known.state === "running")
      return toast(`${name} is already running: use 🚀 Apply live to change it`, "warn");
    await api("/pipelines", { file: b.file });
    toast(`${name} is running! 🏃`);
    if (still(b)) location.hash = `#/p/${name}`;
  } catch (e) {
    if (e instanceof EngineDown) return still(b) && ctx.napping();
    toast(`Couldn't start ${name}: ${e.message}`, "bad", e.hint);
  }
}

async function applyLive() {
  const b = B;
  await settled(b);
  if (!still(b)) return;
  if (errorsOf(b.diagnostics).length) {
    showPanel("problems");
    return toast("Let's fix the problems first 🚧", "warn");
  }
  const name = b.running.name;
  const reason = prompt("What does this change do? (kept in the version history)", "Edited in the builder");
  if (reason === null) return;
  try {
    const info = await api(`/pipelines/${encodeURIComponent(name)}`);
    const r = await api(`/pipelines/${encodeURIComponent(name)}/proposals`, {
      source: b.source,
      base_version: info.version,
      reason: reason || "Edited in the builder",
      by: "ui",
      by_kind: "human",
      apply: true,
    });
    const prop = r.proposal ?? r;
    if (prop.state !== "applied") {
      const why = (prop.problems ?? []).map((q) => q.message).join("; ");
      return toast(`The engine said no (${prop.state})${why ? `: ${why}` : ""}`, "bad", prop.problems?.[0]?.hint);
    }
    // The running version changed; now the file follows, so the next start runs the same thing.
    await save({ quiet: true, b });
    b.running = { ...b.running, version: prop.applied_version ?? (info.version ?? 0) + 1 };
    toast(`${name} v${b.running.version} is live 🚀`);
    if (still(b)) top();
  } catch (e) {
    if (e instanceof EngineDown) return still(b) && ctx.napping();
    toast(`Couldn't apply to ${name}: ${e.message}`, "bad", e.hint);
  }
}

// ── open dialog ───────────────────────────────────────────────────────────────────────────────────────────────────

async function openDialog() {
  let files = [];
  let pipelines = [];
  try {
    [{ files }, { pipelines }] = await Promise.all([api("/builder/files"), api("/pipelines")]);
  } catch (e) {
    if (e instanceof EngineDown) return ctx.napping();
    return toast(`Couldn't list files: ${e.message}`, "bad", e.hint);
  }
  const dlg = h(
    "dialog",
    { class: "card b-dialog" },
    h("h3", null, "📂 Open a pipeline"),
    pipelines.length ? h("div", { class: "pal-title" }, "Known to the engine") : null,
    h(
      "div",
      { class: "b-list" },
      pipelines.map((p) =>
        h(
          "a",
          { href: `#/build/p/${encodeURIComponent(p.name)}`, onclick: () => dlg.close() },
          badge(p.state),
          ` ${p.name}`,
        ),
      ),
    ),
    h("div", { class: "pal-title" }, `In the workspace (${window.pipoEngine?.workspace ?? "?"})`),
    h(
      "div",
      { class: "b-list" },
      files.length
        ? files.map((f) =>
            h(
              "a",
              { href: `#/build/f/${encodeURIComponent(f.file)}`, onclick: () => dlg.close() },
              `📄 ${f.rel}`,
              f.name ? h("span", { class: "muted" }, ` · ${f.name}`) : null,
            ),
          )
        : h("p", { class: "muted" }, "No .pipo files here yet."),
    ),
    h("div", { class: "toolbar" }, h("button", { type: "button", class: "btn", onclick: () => dlg.close() }, "Close")),
  );
  dlg.onclose = () => dlg.remove();
  document.body.append(dlg);
  dlg.showModal();
}

export const _test = { stubbable, curve };
export { ApiError };
