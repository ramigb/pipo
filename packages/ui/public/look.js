// The dashboard's look (docs/spec.md §8): Pipo the mascot, emoji for states, node kinds and connectors, and small
// formatting helpers shared by every view. Pure apart from building SVG/DOM nodes.
import { h, s } from "./dom.js";

/** Pipo: a little lilac bubble. `mood` is happy, sleepy or wow; `size` in px. */
export function mascot(mood = "happy", size = 40) {
  const eyes =
    mood === "sleepy"
      ? [
          s("path", { d: "M33 46 q5 4 10 0", class: "pipo-line" }),
          s("path", { d: "M57 46 q5 4 10 0", class: "pipo-line" }),
        ]
      : mood === "wow"
        ? [
            s("circle", { cx: 38, cy: 45, r: 5.5, class: "pipo-eye" }),
            s("circle", { cx: 62, cy: 45, r: 5.5, class: "pipo-eye" }),
          ]
        : [
            s("circle", { cx: 38, cy: 45, r: 4.5, class: "pipo-eye" }),
            s("circle", { cx: 62, cy: 45, r: 4.5, class: "pipo-eye" }),
            s("circle", { cx: 39.5, cy: 43.5, r: 1.4, class: "pipo-glint" }),
            s("circle", { cx: 63.5, cy: 43.5, r: 1.4, class: "pipo-glint" }),
          ];
  const mouth =
    mood === "wow"
      ? s("ellipse", { cx: 50, cy: 60, rx: 4, ry: 5, class: "pipo-mouth" })
      : mood === "sleepy"
        ? s("path", { d: "M45 60 q5 2 10 0", class: "pipo-line" })
        : s("path", { d: "M43 57 q7 7 14 0", class: "pipo-line" });
  return s(
    "svg",
    {
      class: `pipo pipo-${mood}`,
      viewBox: "0 0 100 100",
      width: size,
      height: size,
      "aria-hidden": "true",
    },
    s(
      "defs",
      null,
      s(
        "radialGradient",
        { id: `pipo-g-${mood}`, cx: "35%", cy: "30%", r: "75%" },
        s("stop", { offset: "0%", class: "pipo-hi" }),
        s("stop", { offset: "100%", class: "pipo-lo" }),
      ),
    ),
    s("path", {
      d: "M50 12 C74 12 88 30 88 54 C88 76 72 90 50 90 C28 90 12 76 12 54 C12 30 26 12 50 12 Z",
      fill: `url(#pipo-g-${mood})`,
      class: "pipo-body",
    }),
    s("ellipse", { cx: 34, cy: 28, rx: 9, ry: 5, class: "pipo-shine", transform: "rotate(-25 34 28)" }),
    eyes,
    s("ellipse", { cx: 29, cy: 56, rx: 5, ry: 3, class: "pipo-cheek" }),
    s("ellipse", { cx: 71, cy: 56, rx: 5, ry: 3, class: "pipo-cheek" }),
    mouth,
    mood === "sleepy"
      ? [s("text", { x: 78, y: 26, class: "pipo-z" }, "z"), s("text", { x: 88, y: 14, class: "pipo-z small" }, "z")]
      : null,
  );
}

const STATE_EMOJI = {
  // pipelines
  running: "🏃",
  active: "💚",
  starting: "🌱",
  paused: "⏸️",
  draining: "🚰",
  stopping: "🛑",
  stopped: "💤",
  completed: "🎉",
  failed: "💥",
  crashed: "💥",
  backoff: "⏳",
  jammed: "🧱",
  unreachable: "📡",
  stale: "👻",
  // packets
  accepted: "📨",
  processing: "⚙️",
  writing: "✍️",
  verifying: "🔍",
  delivered: "✅",
  filtered: "🫥",
  dead_lettered: "💀",
  escalated: "🙋",
  rejected: "🚫",
  branched: "🌿",
  dropped: "🗑️",
  purged: "🧽",
  halted: "✋",
  // proposals
  validated: "👍",
  verified: "🔬",
  applied: "🚀",
};
export const stateEmoji = (v) => STATE_EMOJI[v] ?? "•";

/** A state as a little coloured badge with its emoji. */
export const badge = (v, extra = "") =>
  h(
    "span",
    { class: `badge s-${v ?? "unknown"}${extra ? ` ${extra}` : ""}` },
    h("span", { "aria-hidden": "true" }, stateEmoji(v)),
    ` ${String(v ?? "").replaceAll("_", " ")}`,
  );

export const KIND_EMOJI = {
  input: "📥",
  tap: "🪝",
  transform: "🪄",
  filter: "🧹",
  route: "🔀",
  agent: "🤖",
  output: "📤",
  loop: "🔁",
  node: "🔹",
};
export const CONNECTOR_EMOJI = {
  http: "🌐",
  schedule: "⏰",
  watch: "👀",
  push: "👉",
  system: "🖥️",
  telegram: "✈️",
  sqlite: "🗄️",
  file: "📄",
  stdout: "🖨️",
  log: "📝",
  emit: "📣",
  map: "🗺️",
  exec: "⚙️",
  claude_api: "🧠",
  claude_code: "✴️",
  codex: "🌀",
  pi: "🥧",
  opencode: "📟",
};
export const kindEmoji = (k) => KIND_EMOJI[k] ?? KIND_EMOJI.node;
export const connectorEmoji = (c) => (c?.startsWith("fn.") ? "🧩" : (CONNECTOR_EMOJI[c] ?? "🔌"));

export const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString() : "");
export const fmtJson = (v) => JSON.stringify(v, null, 2);
export const fmtAge = (ms) => {
  const sec = Math.round(ms / 1000);
  return sec < 90 ? `${sec}s` : sec < 5400 ? `${Math.round(sec / 60)}m` : `${Math.round(sec / 3600)}h`;
};
// Time left until an ISO instant, e.g. "1h 59m", "4m 05s", "over"; counted down live by app.js.
export const fmtLeft = (ms) => {
  if (ms <= 0) return "over";
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const hr = Math.floor((sec % 86400) / 3600);
  const min = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${String(min).padStart(2, "0")}m`;
  return `${min}m ${String(sec % 60).padStart(2, "0")}s`;
};
export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const dash = (v) => (v === null || v === undefined || v === "" ? "—" : v);

// Friendly words for an empty or happy moment, picked by a stable index so a live refresh doesn't flicker.
const CHEERS = ["All quiet here", "Nothing to see yet", "Squeaky clean", "Smooth sailing", "Zen mode"];
export const cheer = (seed = 0) => CHEERS[Math.abs(seed) % CHEERS.length];
