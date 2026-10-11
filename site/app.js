// Pipo landing page: the hero manifold, the playground's toy runner and the scripted agent session.
// Everything is simulated in the browser: no engine connections, API requests or external libraries.
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function svg(tag, attrs) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}
function onVisible(target, callback) {
  const io = new IntersectionObserver((entries) => callback(entries[0].isIntersecting), { threshold: 0.15 });
  io.observe(target);
}

// --- YAML highlighting (spans only, no innerHTML) ---
const TOKEN = /"[^"]*"|\$\{[^}]*\}|[A-Za-z_][\w-]*(?=:(?:\s|$))|\b\d+(?:\.\d+)?(?:ms|s|m|h)?\b/g;
function tokens(text, parent) {
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    parent.append(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('"')) {
      const s = el("span", "s");
      for (const part of t.split(/(\$\{[^}]*\})/)) s.append(part.startsWith("${") ? el("span", "t", part) : part);
      parent.append(s);
    } else if (t.startsWith("${")) parent.append(el("span", "t", t));
    else if (/^\d/.test(t)) parent.append(el("span", "n", t));
    else parent.append(el("span", "k", t));
    last = m.index + t.length;
  }
  parent.append(text.slice(last));
}
// Renders a .pipo source into <pre>, tagging each line with its block: a top-level key, or a node id under nodes:.
function renderYaml(pre, source) {
  pre.replaceChildren();
  const lines = [];
  let block = "head";
  let inNodes = false;
  for (const text of source.split("\n")) {
    const top = /^([a-z_]+):/.exec(text);
    const node = /^ {2}([\w-]+):/.exec(text);
    if (top) {
      inNodes = top[1] === "nodes";
      block = inNodes ? "head" : top[1];
    } else if (inNodes && node) block = node[1];
    const line = el("span", "ln");
    line.dataset.block = block;
    if (/^\s*#/.test(text)) line.append(el("span", "c", text));
    else tokens(text, line);
    line.append("\n");
    pre.append(line);
    lines.push(line);
  }
  return lines;
}

// --- Hero manifold ---
const LANES = [
  { color: "#8fd3ff", from: ["telegram", "a message"], to: ["telegram", "a reply"] },
  { color: "#d1ec8c", from: ["http", "a webhook"], to: ["sqlite", "a row, checked"] },
  { color: "#f4d06f", from: ["watch", "song.mp3 dropped"], to: ["file", "song.mp4 via ffmpeg"] },
  { color: "#c7a6ff", from: ["schedule", "every 5s"], to: ["file", "a jsonl line"] },
];
function manifold() {
  const root = $("manifold");
  if (!root) return;
  const pipes = $("manifold-pipes");
  const packets = $("manifold-packets");
  const ends = $("manifold-ends");
  const core = root.querySelector(".core");
  const counter = $("manifold-count");
  const ys = [70, 170, 270, 370];
  const cs = [168, 202, 238, 272];
  let delivered = 0;
  let visible = false;
  const lanes = LANES.map((lane, i) => {
    const y = ys[i];
    const c = cs[i];
    const d = `M 210 ${y} C 380 ${y}, 400 ${c}, 500 ${c} L 700 ${c} C 800 ${c}, 820 ${y}, 990 ${y}`;
    const g = svg("g", { class: "lane", style: `--lane:${lane.color}` });
    const bg = svg("path", { d, class: "pipe-bg" });
    const fg = svg("path", { d, class: "pipe-fg" });
    g.append(bg, fg);
    pipes.append(g);
    const end = (x, [name, sub], source) => {
      const e = svg("g", { class: `end${source ? " source" : ""}`, style: `--lane:${lane.color}` });
      e.append(svg("rect", { x, y: y - 30, width: 190, height: 60, rx: 18 }));
      const label = svg("text", { x: x + 22, y: y - 3, class: "name" });
      label.textContent = name;
      const small = svg("text", { x: x + 22, y: y + 16, class: "sub" });
      small.textContent = sub;
      e.append(label, small);
      ends.append(e);
      return e;
    };
    const src = end(20, lane.from, true);
    const dst = end(990, lane.to, false);
    src.setAttribute("tabindex", "0");
    src.setAttribute("role", "button");
    src.setAttribute("aria-label", `Send a packet from ${lane.from[0]} to ${lane.to[0]}`);
    return { ...lane, path: bg, group: g, src, dst, length: 0, flying: 0 };
  });
  for (const lane of lanes) lane.length = lane.path.getTotalLength();

  const arrive = (lane) => {
    delivered += 1;
    counter.textContent = String(delivered);
    lane.dst.classList.add("got");
    setTimeout(() => lane.dst.classList.remove("got"), 500);
  };
  const send = (lane) => {
    if (reduced.matches) return arrive(lane);
    const dot = svg("circle", { r: 7, class: "packet", style: `--lane:${lane.color}` });
    packets.append(dot);
    lane.flying += 1;
    lane.group.classList.add("hot");
    const start = performance.now();
    const duration = 3000;
    let pulsed = false;
    const frame = (now) => {
      const t = Math.min(1, (now - start) / duration);
      // Linger inside the core: the packet is journaled there before it moves on.
      const eased =
        t < 0.35 ? (t / 0.35) * 0.42 : t < 0.6 ? 0.42 + ((t - 0.35) / 0.25) * 0.16 : 0.58 + ((t - 0.6) / 0.4) * 0.42;
      const p = lane.path.getPointAtLength(eased * lane.length);
      dot.setAttribute("cx", p.x);
      dot.setAttribute("cy", p.y);
      if (!pulsed && eased > 0.42) {
        pulsed = true;
        core.classList.remove("pulse");
        void core.getBBox();
        core.classList.add("pulse");
      }
      if (t < 1) requestAnimationFrame(frame);
      else {
        dot.remove();
        lane.flying -= 1;
        if (!lane.flying) lane.group.classList.remove("hot");
        arrive(lane);
      }
    };
    requestAnimationFrame(frame);
  };
  for (const lane of lanes) {
    lane.src.addEventListener("click", () => send(lane));
    lane.src.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        send(lane);
      }
    });
  }
  onVisible(root, (v) => {
    visible = v;
  });
  setInterval(() => {
    if (visible && !document.hidden && !reduced.matches) send(lanes[Math.floor(Math.random() * lanes.length)]);
  }, 1300);
}

// --- Playground ---
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid() {
  let time = Date.now();
  let head = "";
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD[time % 32] + head;
    time = Math.floor(time / 32);
  }
  let tail = "";
  for (let i = 0; i < 16; i++) tail += CROCKFORD[Math.floor(Math.random() * 32)];
  return head + tail;
}
const shortId = (id) => `${id.slice(0, 2)}…${id.slice(-5)}`;
const clock = () => new Date().toLocaleTimeString([], { hour12: false });
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function triage(subject) {
  const s = subject.toLowerCase();
  if (/down|error|fail|broken|crash|500|bug/.test(s)) return { category: "bug", priority: "high" };
  if (/invoice|refund|charge|bill|pay|price/.test(s)) return { category: "billing", priority: "low" };
  if (/how|can i|where|\?/.test(s)) return { category: "question", priority: "low" };
  return { category: "other", priority: "low" };
}

const RECIPES = [
  {
    id: "telegram-echo",
    hint: "telegram → telegram",
    note: "examples/telegram-echo",
    source: `pipo: 1
name: telegram-echo
input:
  via: telegram
nodes:
  seen:
    from: input
    tap: log
    with: {message: "\${data.from.name} wrote: \${data.text}"}
output:
  from: seen
  to: telegram
  with: {text: "You said: \${data.text}"}`,
    steps: [
      { block: "input", icon: "✉", name: "input", kind: "telegram" },
      { block: "seen", icon: "✎", name: "seen", kind: "tap: log", done: (p) => `log "you wrote: ${p.data.text}"` },
      { block: "output", icon: "➤", name: "output", kind: "telegram" },
      { block: "output", icon: "✓", name: "ack", kind: "check", end: true },
    ],
    input: {
      label: "Message the bot",
      placeholder: "hello pipo",
      samples: ["hello pipo", "ping", "is this thing on?"],
    },
    data: (text) => ({ text, from: { name: "you" } }),
    dest: "telegram · chat with @your_bot",
    empty: "Say something to the bot.",
    idempotent: false,
    hold: "Telegram keeps the message until the runner polls again.",
    broken: "telegram: 502 Bad Gateway",
    before: (text, body) => body.append(el("div", "bubble me", text)),
    write: (p, body, again) => {
      const b = el("div", "bubble bot", `You said: ${p.data.text}`);
      if (again) b.append(el("small", "", "sent again: Telegram sends can repeat"));
      body.append(b);
    },
  },
  {
    id: "ticket-triage",
    hint: "http → agent → sqlite",
    note: "like examples/ticket-triage",
    source: `pipo: 1
name: ticket-triage
agent_budget: {per_day: 0.50}
input:
  via: http
  with: {listen: 8791, path: /tickets}
nodes:
  triage:
    from: input
    agent: claude_code
    with:
      prompt: "Triage this ticket: \${data.subject}"
      schema: ./triage.schema.json
      timeout: 60s
output:
  from: triage
  to: sqlite
  with:
    path: ./tickets.db
    table: tickets
    create: true
    columns:
      packet_id: "\${meta.packet_id}"
      category: "\${data.category}"
      priority: "\${data.priority}"
delivered:
  check: record_exists`,
    steps: [
      { block: "input", icon: "⇢", name: "input", kind: "http" },
      {
        block: "triage",
        icon: "✦",
        name: "triage",
        kind: "agent",
        dur: 1500,
        done: (p) => `claude_code → {category: ${p.data.category}, priority: ${p.data.priority}} · schema ok`,
      },
      { block: "output", icon: "▤", name: "output", kind: "sqlite" },
      { block: "delivered", icon: "✓", name: "record_exists", kind: "check", end: true },
    ],
    input: {
      label: "Ticket subject",
      placeholder: "Checkout is down for everyone",
      samples: ["Checkout is down for everyone", "Refund for a double charge", "How do I export my data?"],
    },
    data: (subject) => ({ subject, ...triage(subject) }),
    dest: "tickets.db · tickets",
    empty: "POST a ticket to /tickets.",
    idempotent: true,
    hold: null,
    down: "POST /tickets → connection refused. Nothing was acknowledged, so the client retries.",
    broken: "sqlite: database is locked",
    write: (p, body) => {
      let table = body.querySelector("table");
      if (!table) {
        table = el("table", "rows");
        const head = el("tr");
        for (const h of ["packet_id", "category", "priority", "subject"]) head.append(el("th", "", h));
        table.append(head);
        body.append(table);
      }
      const row = el("tr", "new");
      row.append(el("td", "", shortId(p.id)));
      const cat = el("td");
      cat.append(el("span", "tag", p.data.category));
      const pri = el("td");
      pri.append(el("span", `tag ${p.data.priority}`, p.data.priority));
      row.append(cat, pri, el("td", "", p.data.subject));
      table.append(row);
    },
  },
  {
    id: "audio-to-video",
    hint: "watch → exec → file",
    note: "like examples/audio-to-video",
    source: `pipo: 1
name: audio-to-video
input:
  via: watch
  with: {path: ./inbox/*.mp3, events: [create], read: path}
nodes:
  render:
    from: input
    transform: exec
    with:
      command: ffmpeg
      args: [-y, -loop, "1", -i, ./cover.jpg, -i, "\${data.path}",
             -shortest, "./out/\${data.name}.mp4"]
      outputs: ["./out/\${data.name}.mp4"]
      timeout: 10m
output:
  from: render
  to: file
  with: {path: ./out/videos.jsonl, format: jsonl}`,
    steps: [
      { block: "input", icon: "◫", name: "input", kind: "watch" },
      {
        block: "render",
        icon: "▶",
        name: "render",
        kind: "exec",
        dur: 1400,
        done: (p) => `ffmpeg exit 0 · wrote out/${p.data.name}.mp4`,
      },
      { block: "output", icon: "≡", name: "output", kind: "file" },
      { block: "output", icon: "✓", name: "ack", kind: "check", end: true },
    ],
    input: {
      label: "Drop an mp3 into ./inbox",
      placeholder: "night-drive",
      samples: ["night-drive", "demo-take-3", "podcast-ep12"],
    },
    data: (name) => {
      const clean =
        name
          .replace(/\.mp3$/i, "")
          .replace(/[^\w-]+/g, "-")
          .slice(0, 32) || "track";
      return { name: clean, path: `./inbox/${clean}.mp3` };
    },
    dest: "out/",
    empty: "Drop an mp3 to get a video.",
    idempotent: true,
    hold: "The watch input keeps a snapshot: it sees the new file when the runner is back.",
    broken: "file: ENOSPC: no space left on device",
    write: (p, body) => {
      let files = body.querySelector(".files");
      if (!files) {
        files = el("div", "files");
        body.append(files);
      }
      const card = el("div", "file-card");
      card.append(el("span", "", "▶"), el("small", "", `${p.data.name}.mp4`));
      files.append(card);
    },
  },
  {
    id: "heartbeat",
    hint: "schedule → file",
    note: "examples/heartbeat",
    source: `pipo: 1
name: heartbeat
input:
  via: schedule
  with: {every: 5s, payload: {status: alive}}
nodes:
  stamp:
    from: input
    transform: map
    with:
      data: {status: "\${data.status}", tick: "\${meta.source}"}
output:
  from: stamp
  to: file
  with: {path: ./out/heartbeat.jsonl, format: jsonl}
delivered:
  check: line_contains
  with: {value: "\${meta.packet_id}"}
  within: 5s`,
    steps: [
      { block: "input", icon: "◷", name: "input", kind: "schedule" },
      { block: "stamp", icon: "ƒ", name: "stamp", kind: "map" },
      { block: "output", icon: "≡", name: "output", kind: "file" },
      { block: "delivered", icon: "✓", name: "line_contains", kind: "check", end: true },
    ],
    tick: 5000,
    data: () => ({ status: "alive", tick: `schedule@${clock()}` }),
    dest: "out/heartbeat.jsonl",
    empty: "The first tick is on its way.",
    idempotent: true,
    hold: null,
    down: "No ticks while the runner is down.",
    broken: "file: EACCES: permission denied",
    write: (p, body) => {
      const line = el("div", "line");
      line.append(`{"status":"alive","tick":"${p.data.tick}","packet_id":"`, el("span", "t", shortId(p.id)), '"}');
      body.append(line);
    },
  },
];

function playground() {
  const tabs = $("recipe-tabs");
  if (!tabs) return;
  const ui = {
    yaml: $("yaml"),
    file: $("file-name"),
    note: $("file-note"),
    graph: $("graph"),
    form: $("send-form"),
    input: $("send-input"),
    label: $("send-label"),
    button: $("send-button"),
    crash: $("crash-button"),
    brk: $("break-button"),
    replay: $("replay-button"),
    dlqCount: $("dlq-count"),
    dest: $("dest"),
    destTitle: $("dest-title"),
    log: $("log"),
    pane: document.querySelector(".run-pane"),
    dot: $("runner-dot"),
    runner: $("runner-label"),
  };
  const s = { recipe: null, lines: [], nodes: [], packets: new Set(), dlq: [], held: [], running: true, broken: false };
  let delivered = 0;
  let visible = false;
  let tickTimer = 0;
  let nextTick = 0;

  const status = () => {
    ui.runner.textContent = s.running ? `runner · running · ${delivered} delivered` : "runner · down";
    ui.dot.className = `dot ${s.running ? "live" : "down"}`;
    ui.pane.classList.toggle("down", !s.running);
    ui.dlqCount.textContent = String(s.dlq.length);
    ui.replay.disabled = !s.dlq.length || s.broken || !s.running;
  };
  const log = (p, event, detail, tone = "") => {
    const li = el("li");
    li.append(el("time", "", clock()));
    if (p) li.append(el("span", "id", shortId(p.id)));
    li.append(el("span", `ev ${tone}`, detail ? `${event} · ${detail}` : event));
    ui.log.append(li);
    while (ui.log.children.length > 60) ui.log.firstChild.remove();
    ui.log.scrollTop = ui.log.scrollHeight;
  };
  const sys = (text, tone = "sys") => log(null, text, "", tone);
  const lights = () => {
    const on = new Set();
    for (const p of s.packets) if (p.live) on.add(p.at);
    s.nodes.forEach((li, i) => {
      li.classList.toggle("on", on.has(i));
    });
    const blocks = new Set([...on].map((i) => s.recipe.steps[i].block));
    for (const line of s.lines) line.classList.toggle("on", blocks.has(line.dataset.block));
  };
  const flashBad = (i) => {
    const li = s.nodes[i];
    li.classList.add("bad");
    const lines = s.lines.filter((l) => l.dataset.block === s.recipe.steps[i].block);
    for (const l of lines) l.classList.add("bad");
    setTimeout(() => {
      li.classList.remove("bad");
      for (const l of lines) l.classList.remove("bad");
    }, 1400);
  };
  const place = (p) => {
    const li = s.nodes[p.at];
    p.dot.style.left = `${li.offsetLeft + li.offsetWidth / 2}px`;
  };
  const later = (p, ms, fn) => {
    const t = setTimeout(() => {
      p.timers.delete(t);
      fn();
    }, ms);
    p.timers.add(t);
  };
  const empty = () => {
    if (!ui.dest.children.length) ui.dest.append(el("p", "empty", s.recipe.empty));
  };
  const clearEmpty = () => ui.dest.querySelector(".empty")?.remove();

  const writeIndex = () => s.recipe.steps.length - 2;
  function step(p, i) {
    const r = s.recipe;
    const st = r.steps[i];
    p.at = i;
    place(p);
    lights();
    const dur = reduced.matches ? 120 : (st.dur ?? 700);
    if (i < writeIndex()) {
      later(p, dur, () => {
        p.committed = i;
        log(p, st.name, st.done ? st.done(p) : "committed");
        step(p, i + 1);
      });
    } else if (i === writeIndex()) {
      later(p, dur / 2, () => {
        if (s.broken) return fail(p, i);
        clearEmpty();
        if (p.wrote && r.idempotent) log(p, "write", `same key ${shortId(p.id)}, no duplicate`, "warn");
        else {
          r.write(p, ui.dest, p.wrote);
          log(p, "write", p.wrote ? "sent again (at-least-once)" : `ok · key ${shortId(p.id)}`, p.wrote ? "warn" : "");
        }
        ui.dest.scrollTop = ui.dest.scrollHeight;
        p.wrote = true;
        later(p, dur / 2, () => {
          p.committed = i;
          step(p, i + 1);
        });
      });
    } else {
      later(p, dur, () => {
        p.live = false;
        delivered += 1;
        log(p, st.name === "ack" ? "ack" : `verify ${st.name}`, "✓ delivered", "good");
        p.dot.classList.add("done");
        setTimeout(() => p.dot.remove(), 500);
        s.packets.delete(p);
        lights();
        status();
      });
    }
  }
  function fail(p, i) {
    p.live = false;
    flashBad(i);
    log(p, "write failed", s.recipe.broken, "bad");
    log(p, "on_error", "retry 0 → dead_lettered", "bad");
    p.dot.classList.add("dead");
    setTimeout(() => p.dot.remove(), 650);
    s.packets.delete(p);
    s.dlq.push(p);
    lights();
    status();
  }
  function spawn(p) {
    p.dot = el("span", "packet");
    p.timers = new Set();
    p.live = true;
    ui.graph.append(p.dot);
    s.packets.add(p);
    p.at = 0;
    place(p);
    lights();
  }
  function accept(data) {
    const p = { id: ulid(), data, committed: -1, wrote: false };
    spawn(p);
    later(p, reduced.matches ? 50 : 350, () => {
      p.committed = 0;
      log(p, "accepted", "journaled, then ack · v1", "good");
      step(p, 1);
    });
  }

  function send(raw) {
    const r = s.recipe;
    const text = raw.trim() || ui.input.placeholder;
    if (r.before) {
      clearEmpty();
      r.before(text, ui.dest);
    }
    if (!s.running) {
      if (r.hold) {
        s.held.push(text);
        sys(r.hold, "warn");
      } else sys(r.down, "warn");
      return;
    }
    accept(r.data(text));
  }

  function crash() {
    s.running = false;
    for (const p of s.packets) {
      for (const t of p.timers) clearTimeout(t);
      p.timers.clear();
      p.dot.classList.add("frozen");
    }
    sys("runner killed (SIGKILL)", "bad");
    ui.crash.textContent = "↺ Restart runner";
    ui.crash.setAttribute("aria-pressed", "true");
    status();
    lights();
  }
  function restart() {
    s.running = true;
    ui.crash.textContent = "⚡ Pull the plug";
    ui.crash.setAttribute("aria-pressed", "false");
    const flying = [...s.packets];
    sys(`runner started · journal.db: ${flying.length} in flight`);
    status();
    for (const p of flying) {
      p.dot.classList.remove("frozen");
      const from = Math.max(p.committed, 0);
      const resumeAt = from + 1;
      log(p, "resume", `from ${s.recipe.steps[from].name} (last commit)`, "warn");
      if (p.at > from && p.at < writeIndex()) {
        log(p, "note", `${s.recipe.steps[p.at].name} runs again: it hadn't committed`, "warn");
      }
      p.at = from;
      place(p);
      later(p, reduced.matches ? 50 : 450, () => step(p, resumeAt));
    }
    const held = s.held.splice(0);
    if (held.length) sys(`${held.length} waiting at the source, picked up now`);
    for (const text of held) accept(s.recipe.data(text));
    lights();
  }

  function scheduleTick() {
    clearTimeout(tickTimer);
    if (!s.recipe.tick) return;
    const tick = () => {
      if (visible && !document.hidden && s.running) accept(s.recipe.data());
      nextTick = Date.now() + s.recipe.tick;
      tickTimer = setTimeout(tick, s.recipe.tick);
    };
    nextTick = Date.now() + 1200;
    tickTimer = setTimeout(tick, 1200);
  }
  setInterval(() => {
    if (!s.recipe?.tick) return;
    const left = Math.max(0, Math.ceil((nextTick - Date.now()) / 1000));
    ui.button.textContent = s.running ? `next tick in ${left}s` : "no ticks: runner down";
  }, 250);

  function load(recipe) {
    for (const p of [...s.packets, ...s.dlq]) for (const t of p.timers ?? []) clearTimeout(t);
    s.recipe = recipe;
    s.packets.clear();
    s.dlq = [];
    s.held = [];
    s.running = true;
    s.broken = false;
    delivered = 0;
    for (const b of tabs.children) b.setAttribute("aria-selected", String(b.dataset.id === recipe.id));
    ui.file.textContent = `${recipe.id}.pipo`;
    ui.note.textContent = recipe.note;
    s.lines = renderYaml(ui.yaml, recipe.source);
    ui.graph.replaceChildren();
    s.nodes = recipe.steps.map((st) => {
      const li = el("li", st.end ? "end" : "");
      li.append(el("span", "node", st.icon), el("strong", "", st.name), el("small", "", st.kind));
      ui.graph.append(li);
      return li;
    });
    ui.destTitle.textContent = recipe.dest;
    ui.dest.replaceChildren();
    empty();
    ui.log.replaceChildren();
    sys(`pipo check ${recipe.id}.pipo · ok`);
    sys("runner started · v1");
    ui.crash.textContent = "⚡ Pull the plug";
    ui.crash.setAttribute("aria-pressed", "false");
    ui.brk.setAttribute("aria-pressed", "false");
    ui.brk.textContent = "✂︎ Break the destination";
    const ticks = Boolean(recipe.tick);
    ui.form.classList.toggle("ticker", ticks);
    ui.input.hidden = ticks;
    ui.button.disabled = ticks;
    ui.button.classList.toggle("primary", !ticks);
    if (!ticks) {
      ui.label.textContent = recipe.input.label;
      ui.input.placeholder = recipe.input.placeholder;
      ui.input.value = "";
      ui.button.textContent = "Send";
    }
    status();
    scheduleTick();
  }

  for (const r of RECIPES) {
    const b = el("button");
    b.type = "button";
    b.setAttribute("role", "tab");
    b.dataset.id = r.id;
    b.append(r.id, el("small", "", r.hint));
    b.addEventListener("click", () => load(r));
    tabs.append(b);
  }
  tabs.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = RECIPES.indexOf(s.recipe);
    const next = (i + (e.key === "ArrowRight" ? 1 : RECIPES.length - 1)) % RECIPES.length;
    load(RECIPES[next]);
    tabs.children[next].focus();
  });
  ui.form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (s.recipe.tick) return;
    send(ui.input.value);
    ui.input.value = "";
    ui.input.placeholder = pick(s.recipe.input.samples);
  });
  ui.crash.addEventListener("click", () => (s.running ? crash() : restart()));
  ui.brk.addEventListener("click", () => {
    s.broken = !s.broken;
    ui.brk.setAttribute("aria-pressed", String(s.broken));
    ui.brk.textContent = s.broken ? "✓ Fix the destination" : "✂︎ Break the destination";
    sys(s.broken ? `destination broken: ${s.recipe.broken}` : "destination fixed", s.broken ? "bad" : "sys");
    status();
  });
  ui.replay.addEventListener("click", () => {
    const list = s.dlq.splice(0);
    log(null, "dlq.replayed", `${list.length} packet${list.length === 1 ? "" : "s"} back at the output`, "warn");
    for (const p of list) {
      spawn(p);
      p.at = writeIndex() - 1;
      place(p);
      later(p, 300, () => step(p, writeIndex()));
    }
    status();
  });
  window.addEventListener("resize", () => {
    for (const p of s.packets) place(p);
  });
  onVisible(ui.pane, (v) => {
    visible = v;
  });
  load(RECIPES[0]);
}

// --- Agent session ---
const INVOICE = `pipo: 1
name: invoice-ping
input:
  via: watch
  with: {path: ./invoices/*.pdf, events: [create], read: path}
nodes:
  note:
    from: input
    transform: map
    with:
      data: {text: "New invoice: \${data.name}"}
output:
  from: note
  to: telegram
  with: {chat_id: 123456789, text: "\${data.text}"}
agent:
  control: true
  actions: [pause, resume]`;

function agentSession() {
  const body = $("term-body");
  if (!body) return;
  const card = $("approval");
  const badge = $("approval-state");
  const approve = $("approve-button");
  const reject = $("reject-button");
  renderYaml($("approval-yaml"), INVOICE);
  let run = 0;
  let started = false;
  const pause = (ms) => new Promise((r) => setTimeout(r, reduced.matches ? 0 : ms));
  const add = (li) => {
    body.append(li);
    body.scrollTop = body.scrollHeight;
    return li;
  };
  const say = (text) => add(el("li", "say", text));
  const tool = (name, result, tone = "") => {
    const li = el("li", "tool");
    li.append(el("b", "", `pipo · ${name}`), el("span", tone, result));
    return add(li);
  };
  const state = (cls, text) => {
    card.className = `approval ${cls}`;
    badge.textContent = text;
  };

  async function play() {
    const id = ++run;
    started = true;
    body.replaceChildren();
    state("", "nothing yet");
    approve.disabled = true;
    reject.disabled = true;
    const you = add(el("li", "you caret"));
    const ask = "ping me on Telegram whenever a new invoice PDF lands in ./invoices";
    for (let i = 1; i <= ask.length; i++) {
      if (id !== run) return;
      you.textContent = ask.slice(0, i);
      if (!reduced.matches) await pause(22);
    }
    you.classList.remove("caret");
    const script = [
      [700, () => say("I'll build that as a Pipo pipeline: watch the folder, shape a message, send it to your chat.")],
      [900, () => tool("check_pipo", "ok · 0 errors", "good")],
      [
        800,
        () => {
          tool("create_pipeline", "invoice-ping → pending approval");
          state("has", "pending");
        },
      ],
      [900, () => tool("test_pipeline", "2 fixtures → 2 delivered · dry run, nothing sent", "good")],
      [800, () => say("invoice-ping is written and tested. It runs once you approve it on the dashboard.")],
      [
        600,
        () => {
          add(el("li", "wait", "waiting for your approval…"));
          state("has ready", "pending · your call");
          approve.disabled = false;
          reject.disabled = false;
        },
      ],
    ];
    for (const [ms, fn] of script) {
      await pause(ms);
      if (id !== run) return;
      fn();
    }
  }
  async function decide(ok) {
    const id = run;
    approve.disabled = true;
    reject.disabled = true;
    body.querySelector(".wait")?.remove();
    state(ok ? "has ok" : "has no", ok ? "approved · running" : "rejected");
    tool("list_approvals", ok ? "invoice-ping · approved" : "invoice-ping · rejected", ok ? "good" : "bad");
    await pause(700);
    if (id !== run) return;
    if (ok) {
      tool("start_pipeline", "invoice-ping · running", "good");
      await pause(600);
      if (id !== run) return;
      say("Live. Drop a PDF in ./invoices and you'll get a ping. If it gets noisy, I can pause it.");
    } else say("Nothing runs. Tell me what to change and I'll send a new version for approval.");
  }
  approve.addEventListener("click", () => decide(true));
  reject.addEventListener("click", () => decide(false));
  $("term-replay").addEventListener("click", play);
  onVisible($("term"), (v) => {
    if (v && !started) play();
  });
}

// --- Copy buttons ---
function copyButtons() {
  const status = $("copy-status");
  for (const button of document.querySelectorAll("[data-copy]")) {
    const target = $(button.dataset.copy);
    button.hidden = false;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(target.textContent.replace(/ +#.*$/gm, ""));
        button.textContent = "copied";
        status.textContent = "Copied to the clipboard.";
      } catch {
        window.getSelection().selectAllChildren(target);
        button.textContent = "select + copy";
        status.textContent = "Selected. Copy it with your keyboard.";
      }
      setTimeout(() => {
        button.textContent = "copy";
      }, 1600);
    });
  }
}

manifold();
playground();
agentSession();
copyButtons();
