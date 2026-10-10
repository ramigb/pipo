// The builder's City view (docs/spec.md §8, D75): the same pipeline as the graph, drawn as a small isometric town on a
// canvas. Each block is a building whose shape says what it does, each wire is a coloured data lane along the roads,
// and packets ride the lanes as little vans (dry runs and, for a running pipeline, live events). Everything edits the
// pipeline through the builder: selecting, wiring, the inspector, undo. Lots are kept per file in the browser, like
// the graph's positions. Grey roads, cars and trees are scenery; only coloured lanes carry data.

import {
  along,
  CELL,
  cellAt,
  cellKey,
  centre,
  decorFor,
  hash,
  placeLots,
  planLanes,
  portsOf,
  regionOf,
  rng,
} from "./city-plan.js";
import { clean, h } from "./dom.js";
import { connectorEmoji, kindEmoji } from "./look.js";
import { blocks as blocksOf, diagnosticsByBlock, edges as edgesOf, outPorts, refOf } from "./model.js";

const HW = 32;
const HH = 16;
const LOT_Z = 3;
const LANE_Z = 5;
/** Pipeline buildings are drawn a little larger than the scenery. */
const GROW = 1.14;
const iso = (u, v, z = 0) => [(u - v) * HW, (u + v) * HH - z];
const EMOJI = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

// ── colour ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const rgbOf = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mixed = new Map();
function mix(a, b, f) {
  const key = `${a}${b}${f}`;
  let out = mixed.get(key);
  if (!out) {
    const x = rgbOf(a);
    const y = rgbOf(b);
    const [r, g, bl] = x.map((c, i) => Math.round(c + (y[i] - c) * f));
    out = `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
    mixed.set(key, out);
  }
  return out;
}
const light = (c, f) => mix(c, "#ffffff", f);
const dark = (c, f) => mix(c, "#3b2a4d", f);
const alpha = (c, a) => `rgba(${rgbOf(c).join(",")},${a})`;
const tone = (c) => ({ top: light(c, 0.22), left: c, right: dark(c, 0.2) });

// Buildings that do something are saturated; the scenery around them is soft, so the pipeline stands out.
const LOOK = {
  input: { main: "#4f9fe6", wall: "#eef5fc", lane: "#3f97f2" },
  transform: { main: "#ff9147", wall: "#ffd6b3", lane: "#ff8236" },
  filter: { main: "#f2b92e", wall: "#fff0c4", lane: "#eaa91a" },
  route: { main: "#3dbd96", wall: "#d2f2e6", lane: "#1fae86" },
  tap: { main: "#f07aa2", wall: "#ffdde9", lane: "#ec6893" },
  agent: { main: "#9677f4", wall: "#e9e2ff", lane: "#8761ef" },
  output: { main: "#8a66df", wall: "#e3dfea", lane: "#7853d8" },
  node: { main: "#a69bbd", wall: "#ebe6f2", lane: "#9488ab" },
};
const HTTP_LOOK = { main: "#4c8ce6", wall: "#e5eefb", lane: "#3a82ea" };
const EXEC_LOOK = { main: "#4f9d90", wall: "#dde8e3", lane: "#36978a" };
const lookOf = (b) =>
  b.kind === "transform" && b.connector === "http"
    ? HTTP_LOOK
    : b.kind === "transform" && b.connector === "exec"
      ? EXEC_LOOK
      : (LOOK[b.kind] ?? LOOK.node);
// A route's branches each get their own lane colour, matched by the boards on its signpost.
const BRANCH = ["#1fae86", "#eaa91a", "#ec6893", "#3f97f2", "#8761ef", "#ff8236"];

const GROUND = {
  road: "#bdaea9",
  slab: { top: "#bdaea9", left: "#d0a785", right: "#b08765" },
  grass: "#9ccf7c",
  walk: { top: "#f5e8d7", left: "#e4cfb8", right: "#cdb59c" },
};
const EDGE = "rgba(74,52,92,0.2)";
const RING = { sel: "#ff9a3c", bad: "#ef4f6b", warn: "#f5b83d", ok: "#38c98a", stop: "#a49cb5" };
const SOFT_GLASS = { l: "#d3e6ee", r: "#b4cbd8" };
const CARS = ["#ff8fa3", "#ffd166", "#8cc8ff", "#b9a4ff", "#7fe0bd", "#ffffff", "#f7a072"];

// ── drawing primitives ──────────────────────────────────────────────────────────────────────────────────────────────

function poly(c, pts, fill, stroke) {
  c.beginPath();
  c.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
  c.closePath();
  if (fill) {
    c.fillStyle = fill;
    c.fill();
  }
  if (stroke) {
    c.strokeStyle = stroke;
    c.stroke();
  }
}

/** An upright box; `col` is a colour or {top, left, right}. The left face is the lit one. */
function box(c, u0, v0, u1, v1, z0, z1, col) {
  const t = typeof col === "string" ? tone(col) : col;
  c.lineWidth = 0.8;
  poly(c, [iso(u0, v1, z0), iso(u1, v1, z0), iso(u1, v1, z1), iso(u0, v1, z1)], t.left, EDGE);
  poly(c, [iso(u1, v1, z0), iso(u1, v0, z0), iso(u1, v0, z1), iso(u1, v1, z1)], t.right, EDGE);
  poly(c, [iso(u0, v0, z1), iso(u1, v0, z1), iso(u1, v1, z1), iso(u0, v1, z1)], t.top, EDGE);
}
const flat = (c, u0, v0, u1, v1, z, fill) =>
  poly(c, [iso(u0, v0, z), iso(u1, v0, z), iso(u1, v1, z), iso(u0, v1, z)], fill);

// A face is the lit front-left (v = v1) or the shaded front-right (u = u1) side of a box; s runs along it, t up it.
const faceL = (u0, _v0, u1, v1, z0, z1) => ({ a: [u0, v1], b: [u1, v1], z0, z1, side: "l" });
const faceR = (_u0, v0, u1, v1, z0, z1) => ({ a: [u1, v1], b: [u1, v0], z0, z1, side: "r" });
const fp = (f, s, t) => iso(f.a[0] + (f.b[0] - f.a[0]) * s, f.a[1] + (f.b[1] - f.a[1]) * s, f.z0 + (f.z1 - f.z0) * t);
const onFace = (c, f, s0, s1, t0, t1, fill) =>
  poly(c, [fp(f, s0, t0), fp(f, s1, t0), fp(f, s1, t1), fp(f, s0, t1)], fill);

function windows(c, f, o = {}) {
  const width = Math.hypot(f.b[0] - f.a[0], f.b[1] - f.a[1]);
  const from = o.from ?? 0.14;
  const to = o.to ?? 0.88;
  const cols = o.cols ?? Math.max(1, Math.round(width * 2.2));
  const rows = o.rows ?? Math.max(1, Math.round(((f.z1 - f.z0) * (to - from)) / 13));
  const glass = o.glass ?? (f.side === "l" ? "#acd8ef" : "#80b3d4");
  const ws = o.ws ?? 0.56;
  const wt = o.wt ?? 0.58;
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      const s0 = 0.08 + (i + (1 - ws) / 2) * (0.84 / cols);
      const t0 = from + (j + (1 - wt) / 2) * ((to - from) / rows);
      onFace(c, f, s0, s0 + (0.84 / cols) * ws, t0, t0 + ((to - from) / rows) * wt, glass);
    }
}

/** A round sign mounted flat on a face, with an emoji on it: tells what a building does without a word. */
function plate(c, f, s, t, r, emoji, ring) {
  const [ox, oy] = fp(f, s, t);
  const [ax, ay] = iso(f.a[0], f.a[1]);
  const [bx, by] = iso(f.b[0], f.b[1]);
  const len = Math.hypot(bx - ax, by - ay) || 1;
  c.save();
  c.transform((bx - ax) / len, (by - ay) / len, 0, 1, ox, oy);
  c.beginPath();
  c.arc(0, 0, r, 0, Math.PI * 2);
  c.fillStyle = "#ffffff";
  c.fill();
  c.lineWidth = 2.4;
  c.strokeStyle = ring;
  c.stroke();
  c.font = `${Math.round(r * 1.2)}px ${EMOJI}`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillStyle = "#000000";
  c.fillText(emoji, 0, r * 0.1);
  c.restore();
}

function roofFlat(c, u0, v0, u1, v1, z, wall) {
  const i = 0.09;
  flat(c, u0 + i, v0 + i, u1 - i, v1 - i, z, mix(light(wall, 0.1), "#9a8a99", 0.22));
}

function roofGable(c, u0, v0, u1, v1, z, rise, roof, wall, ridge) {
  const o = 0.07;
  c.lineWidth = 0.8;
  if (ridge === "u") {
    const vm = (v0 + v1) / 2;
    poly(
      c,
      [iso(u0 - o, v0 - o, z), iso(u1 + o, v0 - o, z), iso(u1 + o, vm, z + rise), iso(u0 - o, vm, z + rise)],
      dark(roof, 0.12),
      EDGE,
    );
    poly(c, [iso(u1, v0, z), iso(u1, v1, z), iso(u1, vm, z + rise)], dark(wall, 0.2), EDGE);
    poly(
      c,
      [iso(u0 - o, v1 + o, z), iso(u1 + o, v1 + o, z), iso(u1 + o, vm, z + rise), iso(u0 - o, vm, z + rise)],
      light(roof, 0.1),
      EDGE,
    );
  } else {
    const um = (u0 + u1) / 2;
    poly(
      c,
      [iso(u0 - o, v0 - o, z), iso(u0 - o, v1 + o, z), iso(um, v1 + o, z + rise), iso(um, v0 - o, z + rise)],
      light(roof, 0.04),
      EDGE,
    );
    poly(c, [iso(u0, v1, z), iso(u1, v1, z), iso(um, v1, z + rise)], wall, EDGE);
    poly(
      c,
      [iso(u1 + o, v0 - o, z), iso(u1 + o, v1 + o, z), iso(um, v1 + o, z + rise), iso(um, v0 - o, z + rise)],
      dark(roof, 0.16),
      EDGE,
    );
  }
}

function pyramid(c, u0, v0, u1, v1, z, rise, roof) {
  const top = iso((u0 + u1) / 2, (v0 + v1) / 2, z + rise);
  c.lineWidth = 0.8;
  poly(c, [iso(u0, v1, z), iso(u1, v1, z), top], light(roof, 0.08), EDGE);
  poly(c, [iso(u1, v1, z), iso(u1, v0, z), top], dark(roof, 0.18), EDGE);
}

function cylinder(c, u, v, r, z0, z1, color) {
  const [x, y0] = iso(u, v, z0);
  const y1 = y0 - (z1 - z0);
  const rx = r * HW * Math.SQRT2;
  const ry = r * HH * Math.SQRT2;
  const g = c.createLinearGradient(x - rx, 0, x + rx, 0);
  g.addColorStop(0, light(color, 0.18));
  g.addColorStop(0.45, color);
  g.addColorStop(1, dark(color, 0.3));
  c.beginPath();
  c.moveTo(x + rx, y1);
  c.lineTo(x + rx, y0);
  c.ellipse(x, y0, rx, ry, 0, 0, Math.PI);
  c.lineTo(x - rx, y1);
  c.ellipse(x, y1, rx, ry, 0, Math.PI, Math.PI * 2);
  c.closePath();
  c.fillStyle = g;
  c.fill();
  c.strokeStyle = EDGE;
  c.lineWidth = 0.8;
  c.stroke();
  c.beginPath();
  c.ellipse(x, y1, rx, ry, 0, 0, Math.PI * 2);
  c.fillStyle = light(color, 0.28);
  c.fill();
  c.stroke();
}

function dome(c, u, v, r, z, color) {
  const [x, y] = iso(u, v, z);
  const rx = r * HW * Math.SQRT2;
  const ry = r * HH * Math.SQRT2;
  const g = c.createRadialGradient(x - rx * 0.35, y - rx * 0.6, rx * 0.08, x, y - rx * 0.2, rx * 1.15);
  g.addColorStop(0, light(color, 0.6));
  g.addColorStop(0.55, color);
  g.addColorStop(1, dark(color, 0.28));
  c.beginPath();
  c.ellipse(x, y, rx, ry, 0, 0, Math.PI);
  c.arc(x, y, rx, Math.PI, Math.PI * 2);
  c.closePath();
  c.fillStyle = g;
  c.fill();
  c.strokeStyle = EDGE;
  c.stroke();
  // the observatory's slit
  c.beginPath();
  c.moveTo(x - rx * 0.12, y - rx * 0.98);
  c.lineTo(x + rx * 0.12, y - rx * 0.98);
  c.lineTo(x + rx * 0.2, y + ry * 0.7);
  c.lineTo(x - rx * 0.06, y + ry * 0.75);
  c.closePath();
  c.fillStyle = alpha(dark(color, 0.5), 0.75);
  c.fill();
}

function hexagon(c, x, y, r, color) {
  const at = (deg) => [x + r * Math.cos((deg * Math.PI) / 180), y + r * Math.sin((deg * Math.PI) / 180)];
  poly(c, [at(-90), at(210), at(150), at(90), [x, y]], light(color, 0.12));
  poly(c, [at(-90), at(-30), at(30), at(90), [x, y]], dark(color, 0.16));
  poly(c, [at(-90), at(-30), [x + r * 0.1, y - r * 0.05], at(210)], light(color, 0.3));
}

function tree(c, it) {
  const [x, y] = iso(it.u, it.v, LOT_Z);
  const s = it.s;
  c.fillStyle = "rgba(70,90,50,0.18)";
  c.beginPath();
  c.ellipse(x + 5 * s, y + 1, 9 * s, 4 * s, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#9b6b4e";
  c.fillRect(x - 1.5 * s, y - 9 * s, 3 * s, 9 * s);
  if (it.t === "pine") {
    for (let i = 0; i < 3; i++) {
      const base = y - (6 + i * 7) * s;
      const w = (11 - i * 3) * s;
      poly(
        c,
        [
          [x, base - 13 * s],
          [x - w, base],
          [x, base + 1.5 * s],
        ],
        light(it.color, 0.05),
      );
      poly(
        c,
        [
          [x, base - 13 * s],
          [x + w, base],
          [x, base + 1.5 * s],
        ],
        dark(it.color, 0.22),
      );
    }
  } else hexagon(c, x, y - 17 * s, 10 * s, it.color);
}

function vehicle(c, u, v, du, dv, color, kind = "car") {
  const alongU = Math.abs(du) >= Math.abs(dv);
  const len = kind === "bus" ? 0.95 : kind === "truck" ? 0.72 : 0.44;
  const wid = kind === "car" ? 0.24 : 0.28;
  const [hu, hv] = alongU ? [len / 2, wid / 2] : [wid / 2, len / 2];
  const fwd = alongU ? Math.sign(du) || 1 : Math.sign(dv) || 1;
  if (kind === "truck") {
    // cab in front, container behind
    const cab = 0.2;
    const [cu0, cv0, cu1, cv1] = alongU
      ? fwd > 0
        ? [u + hu - cab, v - hv, u + hu, v + hv]
        : [u - hu, v - hv, u - hu + cab, v + hv]
      : fwd > 0
        ? [u - hu, v + hv - cab, u + hu, v + hv]
        : [u - hu, v - hv, u + hu, v - hv + cab];
    const [ku0, kv0, ku1, kv1] = alongU
      ? fwd > 0
        ? [u - hu, v - hv, u + hu - cab - 0.02, v + hv]
        : [u - hu + cab + 0.02, v - hv, u + hu, v + hv]
      : fwd > 0
        ? [u - hu, v - hv, u + hu, v + hv - cab - 0.02]
        : [u - hu, v - hv + cab + 0.02, u + hu, v + hv];
    const parts = [
      [cu0, cv0, cu1, cv1, 9, color],
      [ku0, kv0, ku1, kv1, 13, "#f4f1f7"],
    ].sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
    for (const [a, b, c2, d, hgt, col] of parts) box(c, a, b, c2, d, 1.5, 1.5 + hgt, col);
    return;
  }
  const hgt = kind === "bus" ? 11 : 5;
  box(c, u - hu, v - hv, u + hu, v + hv, 1.5, 1.5 + hgt, color);
  if (kind === "bus") {
    windows(c, faceL(u - hu, v - hv, u + hu, v + hv, 1.5, 1.5 + hgt), { rows: 1, from: 0.5, to: 0.9, cols: 5 });
    windows(c, faceR(u - hu, v - hv, u + hu, v + hv, 1.5, 1.5 + hgt), { rows: 1, from: 0.5, to: 0.9, cols: 5 });
  } else
    box(c, u - hu * 0.62, v - hv * 0.8, u + hu * 0.55, v + hv * 0.8, 6.5, 10, {
      top: light(color, 0.35),
      left: "#d9edf7",
      right: "#a9cde0",
    });
}

function lamp(c, u, v) {
  const [x, y] = iso(u, v, LOT_Z);
  c.strokeStyle = "#6f6782";
  c.lineWidth = 1.2;
  c.beginPath();
  c.moveTo(x, y);
  c.lineTo(x, y - 20);
  c.stroke();
  c.fillStyle = "#fff4c2";
  c.beginPath();
  c.arc(x, y - 21, 2.4, 0, Math.PI * 2);
  c.fill();
}

const bench = (c, u, v) => box(c, u - 0.18, v - 0.05, u + 0.18, v + 0.05, LOT_Z, LOT_Z + 3, "#b8835e");

function fountain(c, u, v) {
  const [x, y] = iso(u, v, LOT_Z);
  const rx = 0.55 * HW * Math.SQRT2;
  const ry = 0.55 * HH * Math.SQRT2;
  c.fillStyle = "#d8cfc8";
  c.beginPath();
  c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#c7bcb4";
  c.fillRect(x - rx, y - 4, rx * 2, 4);
  c.beginPath();
  c.ellipse(x, y - 4, rx, ry, 0, 0, Math.PI * 2);
  c.fillStyle = "#e7e0da";
  c.fill();
  c.beginPath();
  c.ellipse(x, y - 4, rx * 0.8, ry * 0.8, 0, 0, Math.PI * 2);
  c.fillStyle = "#8fd3ea";
  c.fill();
  c.fillStyle = "#e7e0da";
  c.fillRect(x - 2, y - 14, 4, 10);
  c.strokeStyle = "rgba(255,255,255,0.85)";
  c.lineWidth = 1.4;
  for (const d of [-1, 1]) {
    c.beginPath();
    c.moveTo(x, y - 14);
    c.quadraticCurveTo(x + d * 8, y - 20, x + d * 11, y - 6);
    c.stroke();
  }
}

function barrier(c, u0, v0, u1, v1, z = LOT_Z) {
  const n = 5;
  const alongU = u1 - u0 > v1 - v0;
  for (let i = 0; i < n; i++) {
    const a = i / n;
    const b = (i + 1) / n;
    const [p0, q0, p1, q1] = alongU
      ? [u0 + (u1 - u0) * a, v0, u0 + (u1 - u0) * b, v1]
      : [u0, v0 + (v1 - v0) * a, u1, v0 + (v1 - v0) * b];
    box(c, p0, q0, p1, q1, z + 6, z + 9, i % 2 ? "#ffffff" : "#ef5a4f");
  }
}

function shadow(c, pts, lift) {
  const dx = lift * 0.6;
  const dy = lift * 0.08;
  const all = [...pts, ...pts.map(([x, y]) => [x + dx, y + dy])];
  poly(c, hull(all), "rgba(78,58,98,0.16)");
}

/** Convex hull (monotone chain) of screen points. */
function hull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function inside(pt, poly) {
  let yes = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) yes = !yes;
  }
  return yes;
}

function segDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

const corners = (u0, v0, u1, v1, z) => [iso(u0, v0, z), iso(u1, v0, z), iso(u1, v1, z), iso(u0, v1, z)];
function bboxOf(pts, pad = 2) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
}
const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
/** A point of a pipeline building, scaled about its base like the drawing is. */
const grow = ([ox, oy], [x, y]) => [ox + (x - ox) * GROW, oy + (y - oy) * GROW];

// ── scenery ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A scenery item ready to draw: its painter's depth, screen bounds and draw function. */
function decorItem(it) {
  if (it.t === "tree" || it.t === "pine") {
    const [x, y] = iso(it.u, it.v, LOT_Z);
    return { depth: it.u + it.v, box: [x - 12 * it.s, y - 32 * it.s, x + 16 * it.s, y + 6], draw: (c) => tree(c, it) };
  }
  if (it.t === "lamp") {
    const [x, y] = iso(it.u, it.v, LOT_Z);
    return { depth: it.u + it.v, box: [x - 4, y - 25, x + 4, y + 1], draw: (c) => lamp(c, it.u, it.v) };
  }
  if (it.t === "bench") {
    const [x, y] = iso(it.u, it.v, LOT_Z);
    return { depth: it.u + it.v, box: [x - 9, y - 8, x + 9, y + 6], draw: (c) => bench(c, it.u, it.v) };
  }
  if (it.t === "fountain") {
    const [x, y] = iso(it.u, it.v, LOT_Z);
    return { depth: it.u + it.v, box: [x - 27, y - 22, x + 27, y + 14], draw: (c) => fountain(c, it.u, it.v) };
  }
  const roof = it.t === "house" || it.top === "gable" ? it.h * 0.5 + 6 : 6;
  const pts = [
    ...corners(it.u0, it.v0, it.u1, it.v1, LOT_Z),
    ...corners(it.u0, it.v0, it.u1, it.v1, LOT_Z + it.h + roof),
  ];
  return {
    depth: (it.u0 + it.u1) / 2 + (it.v0 + it.v1) / 2,
    box: bboxOf(pts, 4),
    shadow: { pts: corners(it.u0, it.v0, it.u1, it.v1, LOT_Z), lift: it.h },
    draw: (c) => (it.t === "house" ? house(c, it) : flats(c, it)),
  };
}

function house(c, it) {
  const z1 = LOT_Z + it.h;
  box(c, it.u0, it.v0, it.u1, it.v1, LOT_Z, z1, it.wall);
  const fl = faceL(it.u0, it.v0, it.u1, it.v1, LOT_Z, z1);
  const fr = faceR(it.u0, it.v0, it.u1, it.v1, LOT_Z, z1);
  onFace(c, fl, 0.42, 0.6, 0, 0.62, dark(it.roof, 0.15));
  windows(c, fl, { cols: 2, rows: 1, from: 0.3, to: 0.82, ws: 0.4, glass: SOFT_GLASS.l });
  windows(c, fr, { cols: 2, rows: 1, from: 0.3, to: 0.82, ws: 0.4, glass: SOFT_GLASS.r });
  roofGable(c, it.u0, it.v0, it.u1, it.v1, z1, 13, it.roof, it.wall, it.ridge);
}

function flats(c, it) {
  const z1 = LOT_Z + it.h;
  box(c, it.u0, it.v0, it.u1, it.v1, LOT_Z, z1, it.wall);
  const fl = faceL(it.u0, it.v0, it.u1, it.v1, LOT_Z, z1);
  const fr = faceR(it.u0, it.v0, it.u1, it.v1, LOT_Z, z1);
  windows(c, fl, { from: 0.1, to: 0.92, glass: SOFT_GLASS.l });
  windows(c, fr, { from: 0.1, to: 0.92, glass: SOFT_GLASS.r });
  if (it.top === "gable")
    roofGable(
      c,
      it.u0,
      it.v0,
      it.u1,
      it.v1,
      z1,
      Math.min(22, it.h * 0.35),
      it.roof,
      it.wall,
      it.u1 - it.u0 > it.v1 - it.v0 ? "u" : "v",
    );
  else {
    roofFlat(c, it.u0, it.v0, it.u1, it.v1, z1, it.wall);
    const r = rng(hash(`${it.u0},${it.v0}`));
    if (r() < 0.7) {
      const u = it.u0 + 0.25 + r() * (it.u1 - it.u0 - 0.7);
      const v = it.v0 + 0.25 + r() * (it.v1 - it.v0 - 0.7);
      box(c, u, v, u + 0.32, v + 0.28, z1, z1 + 6, "#d9d3dd");
    }
  }
}

function groundOf(c, it) {
  if (it.t === "lawn") flat(c, it.u0, it.v0, it.u1, it.v1, LOT_Z, GROUND.grass);
  else if (it.t === "paving") flat(c, it.u0, it.v0, it.u1, it.v1, LOT_Z, "#efdcc8");
  else if (it.t === "path") flat(c, it.u0, it.v0, it.u1, it.v1, LOT_Z + 0.1, "#ecd9bf");
  else if (it.t === "water") {
    flat(c, it.u0 - 0.08, it.v0 - 0.08, it.u1 + 0.08, it.v1 + 0.08, LOT_Z, "#e3d6c8");
    flat(c, it.u0, it.v0, it.u1, it.v1, LOT_Z, "#7fcbe6");
    flat(c, it.u0 + 0.15, it.v0 + 0.15, it.u1 - 0.5, it.v1 - 0.6, LOT_Z, "#a3dcef");
  }
}

// ── pipeline buildings ──────────────────────────────────────────────────────────────────────────────────────────────

/** Each kind of block gets its own building, so a glance says what it does. `top` is the body's height. */
const DESIGNS = {
  input: { top: 34, height: 104, draw: drawInput },
  transform: { top: 72, height: 80, draw: drawWorkshop },
  http: { top: 98, height: 122, draw: drawTower },
  exec: { top: 32, height: 92, draw: drawFactory },
  filter: { top: 30, height: 68, draw: drawCheckpoint },
  route: { top: 20, height: 72, draw: drawJunction },
  tap: { top: 26, height: 52, draw: drawKiosk },
  agent: { top: 36, height: 96, draw: drawLab },
  output: { top: 38, height: 70, draw: drawDepot },
  node: { top: 44, height: 52, draw: drawWorkshop },
};
const designOf = (b) =>
  b.kind === "transform" && (b.connector === "http" || b.connector === "exec")
    ? DESIGNS[b.connector]
    : (DESIGNS[b.kind] ?? DESIGNS.node);

function drawInput(c, b) {
  const { u, v } = b.c;
  const L = b.look;
  const [u0, v0, u1, v1] = [u - 1.1, v - 1.0, u + 1.05, v + 1.1];
  const z = LOT_Z + 32;
  box(c, u0, v0, u1, v1, LOT_Z, z, L.wall);
  const fl = faceL(u0, v0, u1, v1, LOT_Z, z);
  const fr = faceR(u0, v0, u1, v1, LOT_Z, z);
  onFace(c, fl, 0, 1, 0.78, 1, L.main);
  onFace(c, fr, 0, 1, 0.78, 1, dark(L.main, 0.18));
  windows(c, fl, { cols: 4, rows: 1, from: 0.12, to: 0.66, ws: 0.62, wt: 0.85 });
  onFace(c, fl, 0.42, 0.58, 0, 0.6, dark(L.main, 0.25));
  windows(c, fr, { cols: 3, rows: 1, from: 0.12, to: 0.66, ws: 0.5, wt: 0.85 });
  plate(c, fr, 0.5, 0.42, 10, b.emoji, L.main);
  roofFlat(c, u0, v0, u1, v1, z, L.wall);
  // the radio tower at the back corner: packets arrive here
  const T = [u0 + 0.08, v0 + 0.06, u0 + 0.78, v0 + 0.76];
  box(c, ...T, z, z + 48, L.main);
  windows(c, faceL(...T, z, z + 48), { cols: 2, rows: 3, glass: "#d9ecfb" });
  windows(c, faceR(...T, z, z + 48), { cols: 2, rows: 3, glass: "#b6d2ea" });
  pyramid(c, ...T, z + 48, 14, dark(L.main, 0.2));
  const [ax, ay] = iso((T[0] + T[2]) / 2, (T[1] + T[3]) / 2, z + 62);
  c.strokeStyle = "#5d5470";
  c.lineWidth = 1.4;
  c.beginPath();
  c.moveTo(ax, ay);
  c.lineTo(ax, ay - 16);
  c.stroke();
  // a dish on the roof
  const [dx, dy] = iso(u + 0.45, v + 0.35, z + 4);
  c.fillStyle = "#f4f4f8";
  c.beginPath();
  c.ellipse(dx, dy, 9, 6, -0.5, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = "#9b93ad";
  c.stroke();
}

function drawWorkshop(c, b) {
  const { u, v } = b.c;
  const L = b.look;
  const [u0, v0, u1, v1] = [u - 1.05, v - 1.05, u + 1.05, v + 1.05];
  const z = LOT_Z + 40;
  box(c, u0, v0, u1, v1, LOT_Z, z, L.wall);
  const fl = faceL(u0, v0, u1, v1, LOT_Z, z);
  const fr = faceR(u0, v0, u1, v1, LOT_Z, z);
  windows(c, fl, { rows: 2, from: 0.12, to: 0.9, glass: "#fff3c4" });
  windows(c, fr, { rows: 2, from: 0.12, to: 0.9, glass: "#ffe39a" });
  onFace(c, fl, 0, 1, 0.92, 1, L.main);
  onFace(c, fr, 0, 1, 0.92, 1, dark(L.main, 0.15));
  roofFlat(c, u0, v0, u1, v1, z, L.wall);
  const U = [u0 + 0.12, v0 + 0.12, u1 - 0.5, v1 - 0.5];
  const z2 = z + 30;
  box(c, ...U, z, z2, L.main);
  windows(c, faceL(...U, z, z2), { rows: 2, glass: "#fff3c4" });
  windows(c, faceR(...U, z, z2), { rows: 2, glass: "#ffd98a" });
  roofFlat(c, ...U, z2, L.main);
  box(c, U[0] + 0.2, U[1] + 0.2, U[0] + 0.55, U[1] + 0.5, z2, z2 + 6, "#e9e1ec");
  plate(c, fr, 0.55, 0.5, 11, b.emoji, L.main);
}

function drawTower(c, b) {
  const { u, v } = b.c;
  const L = b.look;
  const [u0, v0, u1, v1] = [u - 0.85, v - 0.85, u + 0.85, v + 0.85];
  const z = LOT_Z + 94;
  box(c, u0, v0, u1, v1, LOT_Z, z, L.wall);
  const fl = faceL(u0, v0, u1, v1, LOT_Z, z);
  const fr = faceR(u0, v0, u1, v1, LOT_Z, z);
  windows(c, fl, { cols: 4, from: 0.06, to: 0.95, ws: 0.78, wt: 0.7, glass: "#8fc4ee" });
  windows(c, fr, { cols: 4, from: 0.06, to: 0.95, ws: 0.78, wt: 0.7, glass: "#5f97cc" });
  for (const [f, col] of [
    [fl, L.main],
    [fr, dark(L.main, 0.18)],
  ]) {
    onFace(c, f, 0, 0.06, 0, 1, col);
    onFace(c, f, 0.94, 1, 0, 1, col);
  }
  roofFlat(c, u0, v0, u1, v1, z, L.wall);
  // a big dish: it talks to other servers
  const [dx, dy] = iso(u - 0.1, v - 0.1, z + 10);
  c.strokeStyle = "#7d7590";
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(dx, dy + 10);
  c.lineTo(dx, dy);
  c.stroke();
  c.fillStyle = "#f7f7fb";
  c.beginPath();
  c.ellipse(dx, dy - 3, 14, 9, -0.6, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = "#a59dba";
  c.lineWidth = 1;
  c.stroke();
  c.fillStyle = "#d8d3e2";
  c.beginPath();
  c.ellipse(dx + 1, dy - 3, 7, 4.5, -0.6, 0, Math.PI * 2);
  c.fill();
  const [ax, ay] = iso(u + 0.5, v + 0.5, z);
  c.strokeStyle = "#5d5470";
  c.lineWidth = 1.4;
  c.beginPath();
  c.moveTo(ax, ay);
  c.lineTo(ax, ay - 22);
  c.stroke();
  plate(c, fr, 0.5, 0.86, 10, b.emoji, L.main);
}

function drawFactory(c, b) {
  const { u, v } = b.c;
  const L = b.look;
  const [u0, v0, u1, v1] = [u - 1.1, v - 0.95, u + 1.05, v + 1.05];
  const z = LOT_Z + 30;
  box(c, u0, v0, u1, v1, LOT_Z, z, L.wall);
  const fl = faceL(u0, v0, u1, v1, LOT_Z, z);
  const fr = faceR(u0, v0, u1, v1, LOT_Z, z);
  windows(c, fl, { cols: 5, rows: 1, from: 0.35, to: 0.8, ws: 0.6 });
  onFace(c, fl, 0.08, 0.32, 0, 0.62, "#b9c4c0");
  plate(c, fr, 0.5, 0.5, 10, b.emoji, L.main);
  // the chimney stands at the back, so it goes before the saw-tooth roof
  cylinder(c, u0 + 0.35, v0 + 0.32, 0.2, z, z + 56, "#d07a6c");
  cylinder(c, u0 + 0.35, v0 + 0.32, 0.21, z + 46, z + 54, "#f3efe9");
  const teeth = 3;
  const w = (u1 - u0) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = u0 + i * w;
    const top = z + 15;
    poly(c, [iso(a, v0, z), iso(a + w, v0, top), iso(a + w, v1, top), iso(a, v1, z)], light(L.main, 0.15), EDGE);
    poly(c, [iso(a + w, v1, z), iso(a + w, v0, z), iso(a + w, v0, top), iso(a + w, v1, top)], "#9cc9e4", EDGE);
    poly(c, [iso(a, v1, z), iso(a + w, v1, z), iso(a + w, v1, top)], L.wall, EDGE);
  }
}

function drawCheckpoint(c, b) {
  const { u, v } = b.c;
  const L = b.look;
  const [u0, v0, u1, v1] = [u - 0.85, v - 0.85, u + 0.6, v + 0.85];
  const z = LOT_Z + 26;
  box(c, u0, v0, u1, v1, LOT_Z, z, L.wall);
  const fl = faceL(u0, v0, u1, v1, LOT_Z, z);
  const fr = faceR(u0, v0, u1, v1, LOT_Z, z);
  windows(c, fl, { cols: 3, rows: 1, from: 0.3, to: 0.8 });
  windows(c, fr, { cols: 2, rows: 1, from: 0.3, to: 0.8 });
  onFace(c, fl, 0, 1, 0.85, 1, L.main);
  onFace(c, fr, 0, 1, 0.85, 1, dark(L.main, 0.15));
  roofFlat(c, u0, v0, u1, v1, z, L.wall);
  // a funnel on the roof: only some packets get through
  const [x, y] = iso((u0 + u1) / 2, v, z);
  const rb = 0.2 * HW * Math.SQRT2;
  const rt = 0.72 * HW * Math.SQRT2;
  const yt = y - 34;
  c.fillStyle = dark(L.main, 0.15);
  c.fillRect(x - rb, y - 8, rb * 2, 8);
  const g = c.createLinearGradient(x - rt, 0, x + rt, 0);
  g.addColorStop(0, light(L.main, 0.25));
  g.addColorStop(1, dark(L.main, 0.25));
  c.beginPath();
  c.moveTo(x - rb, y - 8);
  c.lineTo(x - rt, yt);
  c.ellipse(x, yt, rt, rt / 2, 0, Math.PI, 0, true);
  c.lineTo(x + rb, y - 8);
  c.ellipse(x, y - 8, rb, rb / 2, 0, 0, Math.PI);
  c.closePath();
  c.fillStyle = g;
  c.fill();
  c.strokeStyle = EDGE;
  c.stroke();
  c.beginPath();
  c.ellipse(x, yt, rt, rt / 2, 0, 0, Math.PI * 2);
  c.fillStyle = light(L.main, 0.35);
  c.fill();
  c.beginPath();
  c.ellipse(x, yt + 1, rt * 0.8, rt * 0.4, 0, 0, Math.PI * 2);
  c.fillStyle = dark(L.main, 0.35);
  c.fill();
  plate(c, fl, 0.5, 0.55, 8, "🧹", L.main);
  // the gate across its way out
  const gu = u + 1.22;
  box(c, gu - 0.06, v - 0.86, gu + 0.06, v - 0.74, LOT_Z, LOT_Z + 13, "#6f6782");
  barrier(c, gu - 0.04, v - 0.74, gu + 0.04, v + 0.55, LOT_Z + 3);
}

function drawJunction(c, b) {
  const { u, v } = b.c;
  const L = b.look;
  const [x, y] = iso(u, v, LOT_Z);
  const ring = (r, fill) => {
    c.beginPath();
    c.ellipse(x, y, r * HW * Math.SQRT2, r * HH * Math.SQRT2, 0, 0, Math.PI * 2);
    c.fillStyle = fill;
    c.fill();
  };
  ring(1.3, "#e9dccd");
  ring(1.18, GROUND.road);
  c.setLineDash([5, 6]);
  c.strokeStyle = "rgba(255,255,255,0.75)";
  c.lineWidth = 1.2;
  c.beginPath();
  c.ellipse(x, y, 0.9 * HW * Math.SQRT2, 0.9 * HH * Math.SQRT2, 0, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([]);
  ring(0.62, "#f1e3d2");
  ring(0.54, "#a6d98c");
  flat(c, u + 1.1, v - 0.5, u + 1.5, v + 0.5, LOT_Z + 0.1, GROUND.road);
  // the signpost: one board per branch, coloured like its lane
  const n = Math.max(1, b.ports.length);
  box(c, u - 0.05, v - 0.05, u + 0.05, v + 0.05, LOT_Z, LOT_Z + 60, "#7c7390");
  for (let i = 0; i < n; i++) {
    const z = LOT_Z + 24 + i * 11;
    const col = BRANCH[i % BRANCH.length];
    const dir = i % 2 ? -1 : 1;
    const [a0, a1] = dir > 0 ? [u + 0.06, u + 0.62] : [u - 0.62, u - 0.06];
    box(c, a0, v - 0.03, a1, v + 0.03, z, z + 8, col);
    const tip = dir > 0 ? a1 : a0;
    poly(c, [iso(tip, v + 0.03, z - 2), iso(tip + dir * 0.22, v + 0.03, z + 4), iso(tip, v + 0.03, z + 10)], col);
  }
  const [px, py] = iso(u, v, LOT_Z + 64);
  c.fillStyle = L.main;
  c.beginPath();
  c.arc(px, py, 4.5, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = "#ffffff";
  c.lineWidth = 1.5;
  c.stroke();
}

function drawKiosk(c, b) {
  const { u, v } = b.c;
  const L = b.look;
  const [u0, v0, u1, v1] = [u - 0.8, v - 0.9, u + 0.6, v + 0.4];
  const z = LOT_Z + 24;
  box(c, u0, v0, u1, v1, LOT_Z, z, L.wall);
  const fl = faceL(u0, v0, u1, v1, LOT_Z, z);
  const fr = faceR(u0, v0, u1, v1, LOT_Z, z);
  onFace(c, fl, 0.1, 0.62, 0.1, 0.62, "#bfe3f4");
  onFace(c, fl, 0.7, 0.88, 0, 0.62, dark(L.main, 0.25));
  windows(c, fr, { cols: 2, rows: 1, from: 0.25, to: 0.7 });
  roofFlat(c, u0, v0, u1, v1, z, L.wall);
  // a striped awning over the shop window: a tap does something on the side
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a = u0 + ((u1 - u0) * i) / n;
    const e = u0 + ((u1 - u0) * (i + 1)) / n;
    poly(
      c,
      [iso(a, v1, z - 3), iso(e, v1, z - 3), iso(e, v1 + 0.35, z - 9), iso(a, v1 + 0.35, z - 9)],
      i % 2 ? "#ffffff" : L.main,
      EDGE,
    );
  }
  const B = [u - 0.45, v - 0.62, u + 0.35, v - 0.56];
  box(c, B[0], B[1], B[2], B[3], z, z + 20, L.main);
  plate(c, faceL(...B, z, z + 20), 0.5, 0.5, 8, b.emoji, dark(L.main, 0.2));
  // a parasol out front
  const [px, py] = iso(u + 1.0, v + 0.95, LOT_Z);
  c.strokeStyle = "#7c7390";
  c.lineWidth = 1.2;
  c.beginPath();
  c.moveTo(px, py);
  c.lineTo(px, py - 17);
  c.stroke();
  poly(
    c,
    [
      [px - 12, py - 13],
      [px, py - 22],
      [px + 12, py - 13],
    ],
    light(L.main, 0.2),
    EDGE,
  );
}

function drawLab(c, b) {
  const { u, v } = b.c;
  const L = b.look;
  const [u0, v0, u1, v1] = [u - 1.0, v - 1.0, u + 1.0, v + 1.0];
  const z = LOT_Z + 34;
  box(c, u0, v0, u1, v1, LOT_Z, z, L.wall);
  const fl = faceL(u0, v0, u1, v1, LOT_Z, z);
  const fr = faceR(u0, v0, u1, v1, LOT_Z, z);
  windows(c, fl, { rows: 2, glass: "#d5ccff" });
  windows(c, fr, { rows: 2, glass: "#b3a6f0" });
  onFace(c, fl, 0, 1, 0.88, 1, L.main);
  onFace(c, fr, 0, 1, 0.88, 1, dark(L.main, 0.15));
  roofFlat(c, u0, v0, u1, v1, z, L.wall);
  // the antenna goes first: it stands behind the dome
  const [ax, ay] = iso(u - 0.6, v - 0.6, z);
  c.strokeStyle = "#5d5470";
  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(ax, ay);
  c.lineTo(ax, ay - 52);
  c.moveTo(ax - 5, ay - 40);
  c.lineTo(ax + 5, ay - 40);
  c.moveTo(ax - 3, ay - 47);
  c.lineTo(ax + 3, ay - 47);
  c.stroke();
  dome(c, u + 0.05, v + 0.05, 0.78, z, L.main);
  plate(c, fr, 0.5, 0.45, 10, b.emoji, L.main);
}

function drawDepot(c, b) {
  const { u, v } = b.c;
  const L = b.look;
  const [u0, v0, u1, v1] = [u - 1.15, v - 1.1, u + 0.95, v + 1.1];
  const z = LOT_Z + 36;
  box(c, u0, v0, u1, v1, LOT_Z, z, L.wall);
  const fl = faceL(u0, v0, u1, v1, LOT_Z, z);
  const fr = faceR(u0, v0, u1, v1, LOT_Z, z);
  onFace(c, fl, 0, 1, 0.8, 1, L.main);
  onFace(c, fr, 0, 1, 0.8, 1, dark(L.main, 0.15));
  // roll-up doors: packets end up here
  for (const [s0, s1] of [
    [0.1, 0.4],
    [0.55, 0.85],
  ]) {
    onFace(c, fl, s0, s1, 0, 0.6, "#b8b1c6");
    for (let k = 1; k < 5; k++) onFace(c, fl, s0, s1, k * 0.12 - 0.012, k * 0.12, "#a39bb4");
  }
  windows(c, fr, { cols: 3, rows: 1, from: 0.12, to: 0.55 });
  plate(c, fr, 0.5, 0.66, 9, b.emoji, L.main);
  roofFlat(c, u0, v0, u1, v1, z, L.wall);
  if (b.connector === "sqlite") {
    cylinder(c, u0 + 0.5, v0 + 0.5, 0.3, z, z + 26, "#cfd6e4");
    cylinder(c, u0 + 1.25, v0 + 0.45, 0.26, z, z + 20, "#d7dceb");
  } else {
    box(c, u0 + 0.3, v0 + 0.3, u0 + 0.75, v0 + 0.7, z, z + 7, "#d9d3dd");
    box(c, u0 + 1.1, v0 + 0.3, u0 + 1.45, v0 + 0.62, z, z + 7, "#d9d3dd");
  }
  vehicle(c, u + 1.18, v - 0.05, 0, 1, L.main, "truck");
  if (b.connector === "file") {
    box(c, u + 1.05, v + 0.7, u + 1.3, v + 0.98, LOT_Z, LOT_Z + 8, "#d9a66b");
    box(c, u + 1.08, v + 0.74, u + 1.28, v + 0.95, LOT_Z + 8, LOT_Z + 15, "#e6b77f");
  }
}

// ── the city ────────────────────────────────────────────────────────────────────────────────────────────────────────

const load = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
};
const keep = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};

/**
 * The City view. `o.state()` returns what to draw ({p, selected, diagnostics, trace}); `o.select`, `o.wire(ref, to)`,
 * `o.hint(text)` and `o.focus()` hand interaction back to the builder.
 */
export function createCity(o) {
  const canvas = h("canvas", {
    class: "city-canvas",
    role: "img",
    "aria-label": "Pipeline city: each block is a building and each wire a coloured lane",
  });
  const overlay = h("div", { class: "city-overlay" });
  const root = h("div", { class: "city", hidden: true }, canvas, overlay);
  const c = canvas.getContext("2d");
  const still = document.createElement("canvas");
  const sc = still.getContext("2d");
  const storeKey = `pipo-city:${o.key}`;
  let lots = new Map(Object.entries(load(storeKey) ?? {}));
  let view = { x: 0, y: 0, k: 1 };
  let scene = null;
  let stale = true;
  let fitted = false;
  let drop = null;
  let hover = null;
  let ghost = null;
  let wire = null;
  let trace = null;
  let raf = 0;
  let lastFrame = 0;
  let laidOut = "";
  const packets = [];
  const fx = [];
  const flashes = new Map();
  const labels = new Map();
  const decorCache = new Map();

  new ResizeObserver(() => {
    stale = true;
    if (!fitted && canvas.clientWidth) fit();
    kick();
  }).observe(root);

  // ── scene ──

  function build() {
    const st = o.state();
    const p = st.p;
    const bs = blocksOf(p);
    const next = placeLots(bs, lots, drop);
    drop = null;
    if (bs.some((b) => JSON.stringify(next.get(b.id)) !== JSON.stringify(lots.get(b.id)))) {
      lots = next;
      keep(storeKey, Object.fromEntries(lots));
    }
    const live = new Map(bs.map((b) => [b.id, lots.get(b.id)]));
    const owned = new Map([...live].map(([id, l]) => [cellKey(l.cx, l.cy), id]));
    const diag = diagnosticsByBlock(st.diagnostics);
    const region = regionOf(live.values(), 3);
    const lanes = planLanes(edgesOf(p), live, (id) => outPorts(p, id));
    const sel = st.selected;
    const buildings = bs.map((b) => {
      const lot = live.get(b.id);
      const problems = diag.get(b.id) ?? [];
      const bad = problems.filter((d) => d.severity === "error").length;
      const t = st.trace.get(b.id);
      const design = designOf(b);
      const ports = portsOf(lot, outPorts(p, b.id));
      const look = lookOf(b);
      const isSel = sel?.type === "block" && sel.id === b.id;
      const ring = isSel ? "sel" : bad ? "bad" : t ? t.status : problems.length ? "warn" : null;
      const cc = centre(lot);
      const foot = [cc.u - 1.12, cc.v - 1.12, cc.u + 1.12, cc.v + 1.12];
      const base = iso(cc.u, cc.v, LOT_Z);
      const hullPts = hull(
        [...corners(...foot, LOT_Z), ...corners(...foot, LOT_Z + design.top)].map((q) => grow(base, q)),
      );
      return {
        ...b,
        lot,
        c: cc,
        look,
        design,
        ports: ports.map((q, i) => ({ ...q, color: b.kind === "route" ? BRANCH[i % BRANCH.length] : look.lane })),
        emoji:
          b.kind === "filter" || b.kind === "route" || !b.connector ? kindEmoji(b.kind) : connectorEmoji(b.connector),
        sub:
          b.kind === "route"
            ? `${ports.length} path${ports.length === 1 ? "" : "s"}`
            : b.kind === "filter"
              ? "filter"
              : b.kind === "transform" && b.connector === "http"
                ? "http call"
                : (b.connector ?? b.kind),
        problems,
        bad,
        trace: t ?? null,
        ring,
        sel: isSel,
        hull: hullPts,
        depth: cc.u + cc.v,
        base,
        box: bboxOf([...hullPts, grow(base, iso(cc.u, cc.v, LOT_Z + design.height))], 6),
      };
    });
    const byId = new Map(buildings.map((b) => [b.id, b]));
    for (const lane of lanes) {
      const from = byId.get(lane.from);
      lane.color = from?.ports.find((q) => q.branch === lane.branch)?.color ?? from?.look.lane ?? LOOK.node.lane;
      lane.screen = lane.pts.map(([u, v]) => iso(u, v, LANE_Z));
      lane.sel = sel?.type === "edge" && sel.ref === lane.ref && sel.to === lane.to;
      lane.traced = !!st.trace.get(lane.to)?.via?.has(lane.ref);
    }
    const ground = [];
    const items = [];
    const shadows = [];
    for (let cx = region.c0; cx <= region.c1; cx++)
      for (let cy = region.r0; cy <= region.r1; cy++) {
        if (owned.has(cellKey(cx, cy))) continue;
        const has = (a, b) => owned.has(cellKey(cx + a, cy + b));
        const near =
          has(-1, 0) || has(0, -1) || has(-1, -1)
            ? "front"
            : has(1, 0) || has(0, 1) || has(1, 1) || has(1, -1) || has(-1, 1)
              ? "near"
              : "far";
        const key = `${cx},${cy},${near}`;
        let d = decorCache.get(key);
        if (!d) {
          d = decorFor(cx, cy, o.key, near);
          decorCache.set(key, d);
        }
        for (const it of d.items) {
          if (it.t === "lawn" || it.t === "paving" || it.t === "water" || it.t === "path") ground.push(it);
          else {
            const item = decorItem(it);
            items.push(item);
            if (item.shadow) shadows.push(item.shadow);
          }
        }
      }
    for (const b of buildings) {
      items.push({ depth: b.depth, box: b.box, draw: (cx) => drawBuilding(cx, b) });
      if (b.kind !== "route")
        shadows.push({
          pts: corners(b.c.u - 1.1, b.c.v - 1.1, b.c.u + 1.1, b.c.v + 1.1, LOT_Z),
          lift: b.design.top * GROW,
        });
    }
    items.sort((a, b) => a.depth - b.depth);
    const front = [...buildings].sort((a, b) => b.depth - a.depth);
    scene = { region, owned, buildings, byId, front, lanes, ground, items, shadows, cars: traffic(region, lanes) };
    stale = true;
    if (st.trace !== trace) {
      trace = st.trace;
      if (trace?.size) playTrace(trace);
    }
    syncOverlay();
  }

  /** Scenery traffic, only on roads no lane uses: anything moving on a lane is a packet. */
  function traffic(region, lanes) {
    const used = new Set();
    for (const lane of lanes)
      for (let i = 1; i < lane.pts.length; i++) {
        const [u0, v0] = lane.pts[i - 1];
        const [u1, v1] = lane.pts[i];
        const road = (x) =>
          Math.abs(x - 0.5 - Math.round((x - 0.5) / CELL) * CELL) < 0.4 ? Math.round((x - 0.5) / CELL) : null;
        if (Math.abs(u0 - u1) < 1e-6 && road(u0) !== null) used.add(`u${road(u0)}`);
        if (Math.abs(v0 - v1) < 1e-6 && road(v0) !== null) used.add(`v${road(v0)}`);
      }
    const roads = [];
    for (let k = region.c0 + 1; k <= region.c1; k++) if (!used.has(`u${k}`)) roads.push(["u", k]);
    for (let k = region.r0 + 1; k <= region.r1; k++) if (!used.has(`v${k}`)) roads.push(["v", k]);
    const r = rng(hash(`${o.key}:traffic:${roads.length}`));
    const cars = [];
    const from = { u: region.r0 * CELL + 0.5, v: region.c0 * CELL + 0.5 };
    const span = { u: (region.r1 - region.r0 + 1) * CELL, v: (region.c1 - region.c0 + 1) * CELL };
    for (const [axis, k] of roads) {
      if (r() < 0.35) continue;
      const dir = r() < 0.5 ? 1 : -1;
      const roll = r();
      cars.push({
        axis,
        fixed: k * CELL + 0.5 + dir * 0.2,
        dir,
        start: from[axis],
        span: span[axis],
        phase: r() * span[axis],
        speed: 0.45 + r() * 0.5,
        color: CARS[Math.floor(r() * CARS.length)],
        kind: roll < 0.1 ? "bus" : roll < 0.25 ? "truck" : "car",
      });
    }
    return cars;
  }

  // ── drawing ──

  function drawBuilding(cx, b) {
    const [ox, oy] = b.base;
    cx.save();
    cx.translate(ox, oy);
    cx.scale(GROW, GROW);
    cx.translate(-ox, -oy);
    b.design.draw(cx, b);
    cx.restore();
    if (b.bad) barrier(cx, b.c.u - 1.4, b.c.v + 1.32, b.c.u - 0.3, b.c.v + 1.4);
    if (b.sel) {
      cx.save();
      cx.shadowColor = RING.sel;
      cx.shadowBlur = 14;
      cx.lineWidth = 3;
      cx.lineJoin = "round";
      poly(cx, b.hull, null, alpha("#ffb067", 0.95));
      cx.restore();
    }
  }

  function drawStatic(cx) {
    const { region, buildings, lanes, ground, items, shadows } = scene;
    const U0 = region.c0 * CELL;
    const V0 = region.r0 * CELL;
    const U1 = (region.c1 + 1) * CELL + 1;
    const V1 = (region.r1 + 1) * CELL + 1;
    // the board everything stands on: a slab of earth, its top the road
    box(cx, U0, V0, U1, V1, -34, 0, GROUND.slab);
    box(cx, U0, V0, U1, V1, -6, 0, { top: GROUND.road, left: "#8fc46f", right: "#79ad5c" });
    // only what's on screen is drawn
    const vis = [
      -view.x / view.k,
      -view.y / view.k,
      (canvas.clientWidth - view.x) / view.k,
      (canvas.clientHeight - view.y) / view.k,
    ];
    const seen = (bb) => overlaps(bb, vis);
    const lotSeen = (a, b) => seen(bboxOf(corners(a * CELL, b * CELL, a * CELL + 5, b * CELL + 5, 0), 40));
    for (let a = region.c0; a <= region.c1; a++)
      for (let b = region.r0; b <= region.r1; b++) {
        if (!lotSeen(a, b)) continue;
        const u0 = a * CELL + 1;
        const v0 = b * CELL + 1;
        box(cx, u0, v0, u0 + 3, v0 + 3, 0, LOT_Z, GROUND.walk);
      }
    cx.lineWidth = 1.2;
    cx.setLineDash([7, 8]);
    cx.strokeStyle = "rgba(255,255,255,0.6)";
    cx.beginPath();
    for (let a = region.c0; a <= region.c1 + 1; a++) {
      cx.moveTo(...iso(a * CELL + 0.5, V0 + 0.2));
      cx.lineTo(...iso(a * CELL + 0.5, V1 - 0.2));
    }
    for (let b = region.r0; b <= region.r1 + 1; b++) {
      cx.moveTo(...iso(U0 + 0.2, b * CELL + 0.5));
      cx.lineTo(...iso(U1 - 0.2, b * CELL + 0.5));
    }
    cx.stroke();
    cx.setLineDash([]);
    // zebra crossings where a road meets the next lot row
    cx.fillStyle = "rgba(255,255,255,0.75)";
    for (let a = region.c0; a <= region.c1 + 1; a++)
      for (let b = region.r0; b <= region.r1 + 1; b++) {
        if ((a + b) % 2 || !lotSeen(a, b)) continue;
        for (let i = 0; i < 4; i++) {
          const s = a * CELL + 0.12 + i * 0.21;
          poly(
            cx,
            [
              iso(s, b * CELL + 1.08),
              iso(s + 0.11, b * CELL + 1.08),
              iso(s + 0.11, b * CELL + 1.36),
              iso(s, b * CELL + 1.36),
            ],
            "rgba(255,255,255,0.75)",
          );
        }
      }
    for (const it of ground) if (lotSeen(Math.floor(it.u0 / CELL), Math.floor(it.v0 / CELL))) groundOf(cx, it);
    for (const b of buildings) {
      const [u0, v0] = [b.lot.cx * CELL + 1, b.lot.cy * CELL + 1];
      flat(cx, u0 + 0.14, v0 + 0.14, u0 + 2.86, v0 + 2.86, LOT_Z, light(b.look.main, 0.78));
      if (b.ring) {
        cx.save();
        cx.shadowColor = RING[b.ring];
        cx.shadowBlur = 12;
        cx.lineWidth = b.ring === "sel" ? 3.5 : 2.5;
        cx.lineJoin = "round";
        poly(cx, corners(u0 + 0.1, v0 + 0.1, u0 + 2.9, v0 + 2.9, LOT_Z), null, RING[b.ring]);
        cx.restore();
      }
    }
    for (const s of shadows) if (seen(bboxOf(s.pts, s.lift))) shadow(cx, s.pts, s.lift);
    for (const lane of lanes) drawLane(cx, lane);
    for (const b of buildings) for (const q of b.ports) portPad(cx, q);
    for (const it of items) if (seen(it.box)) it.draw(cx);
  }

  function drawLane(cx, lane) {
    const pts = lane.screen;
    const path = () => {
      cx.beginPath();
      cx.moveTo(...pts[0]);
      for (const p of pts.slice(1)) cx.lineTo(...p);
    };
    cx.lineJoin = "round";
    cx.lineCap = "round";
    cx.save();
    if (lane.sel || lane.traced) {
      cx.shadowColor = lane.sel ? "#ffffff" : lane.color;
      cx.shadowBlur = 16;
    }
    path();
    cx.strokeStyle = alpha(lane.color, lane.sel ? 0.6 : 0.3);
    cx.lineWidth = lane.sel ? 30 : 24;
    cx.stroke();
    cx.restore();
    // its shadow on the road: the lane floats a little above it
    cx.save();
    cx.translate(0, LANE_Z);
    path();
    cx.strokeStyle = "rgba(60,40,80,0.18)";
    cx.lineWidth = 15;
    cx.stroke();
    cx.restore();
    path();
    cx.strokeStyle = dark(lane.color, 0.3);
    cx.lineWidth = 15;
    cx.stroke();
    path();
    cx.strokeStyle = lane.color;
    cx.lineWidth = 11.5;
    cx.stroke();
    path();
    cx.strokeStyle = alpha(light(lane.color, 0.55), 0.9);
    cx.lineWidth = 2.5;
    cx.stroke();
    // chevrons show which way packets go
    cx.strokeStyle = "rgba(255,255,255,0.95)";
    cx.lineWidth = 2.4;
    const step = 0.8;
    for (let d = 0.6; d < lane.length - 0.4; d += step) {
      const a = along(lane.pts, d / lane.length, lane.length);
      const [x, y] = iso(a.u, a.v, LANE_Z);
      const [tx, ty] = iso(a.u + a.du * 0.12, a.v + a.dv * 0.12, LANE_Z);
      const ux = tx - x;
      const uy = ty - y;
      const l = Math.hypot(ux, uy) || 1;
      const [nx, ny] = [ux / l, uy / l];
      cx.beginPath();
      cx.moveTo(x - nx * 3.5 - ny * 4, y - ny * 3.5 + nx * 4);
      cx.lineTo(x + nx * 3, y + ny * 3);
      cx.lineTo(x - nx * 3.5 + ny * 4, y - ny * 3.5 - nx * 4);
      cx.stroke();
    }
    const [ex, ey] = pts.at(-1);
    cx.beginPath();
    cx.arc(ex, ey, 7, 0, Math.PI * 2);
    cx.fillStyle = lane.color;
    cx.fill();
    cx.lineWidth = 3;
    cx.strokeStyle = "#ffffff";
    cx.stroke();
  }

  function portPad(cx, q) {
    const [x, y] = iso(q.u, q.v, LANE_Z);
    cx.beginPath();
    cx.ellipse(x, y, 9, 4.5, 0, 0, Math.PI * 2);
    cx.fillStyle = alpha(q.color, 0.3);
    cx.fill();
  }

  function sky(cx, w, hgt) {
    const g = cx.createLinearGradient(0, 0, w, hgt);
    g.addColorStop(0, "#86cdf3");
    g.addColorStop(0.5, "#cdeef0");
    g.addColorStop(1, "#f6e9a9");
    cx.fillStyle = g;
    cx.fillRect(0, 0, w, hgt);
  }

  function clouds(cx, now, w) {
    const t = reduced.matches ? 0 : now / 1000;
    for (const [i, base, y, s] of [
      [0, 0.12, 0.1, 1],
      [1, 0.58, 0.06, 0.8],
      [2, 0.86, 0.2, 1.15],
    ]) {
      const x = ((base * w + t * (6 + i * 2)) % (w + 160)) - 80;
      const yy = (y * cx.canvas.height) / (devicePixelRatio || 1);
      cx.fillStyle = "rgba(255,255,255,0.88)";
      for (const [dx, dy, r] of [
        [0, 0, 18],
        [18, -8, 22],
        [40, 0, 17],
        [20, 6, 16],
      ]) {
        cx.beginPath();
        cx.arc(x + dx * s, yy + dy * s, r * s, 0, Math.PI * 2);
        cx.fill();
      }
    }
  }

  function render(now) {
    if (!scene) return;
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (!w || !hgt) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
      still.width = canvas.width;
      still.height = canvas.height;
      stale = true;
    }
    const world = [dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y];
    if (stale) {
      sc.setTransform(dpr, 0, 0, dpr, 0, 0);
      sky(sc, w, hgt);
      sc.setTransform(...world);
      drawStatic(sc);
      stale = false;
      placeOverlay();
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(still, 0, 0);
    c.setTransform(...world);
    moving(now);
    effects(now);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    clouds(c, now, w);
  }

  /** Cars and packets, drawn over the cached town; whatever stands in front of one is drawn again over it. */
  function moving(now) {
    const objs = [];
    const t = reduced.matches ? 0 : now / 1000;
    for (const car of scene.cars) {
      const s = (((car.phase + car.dir * car.speed * t) % car.span) + car.span) % car.span;
      const pos = car.start + s;
      const [u, v] = car.axis === "u" ? [car.fixed, pos] : [pos, car.fixed];
      const [du, dv] = car.axis === "u" ? [0, car.dir] : [car.dir, 0];
      objs.push({ u, v, draw: () => vehicle(c, u, v, du, dv, car.color, car.kind) });
    }
    for (let i = packets.length - 1; i >= 0; i--) {
      const pk = packets[i];
      const f = (now - pk.t0) / pk.dur;
      if (f > 1) {
        packets.splice(i, 1);
        continue;
      }
      if (f < 0) continue;
      const a = along(pk.lane.pts, f, pk.lane.length);
      objs.push({
        u: a.u,
        v: a.v,
        draw: () => {
          // a packet: a little white van with a glowing crate, so it never blends into its lane
          const [x, y] = iso(a.u, a.v, LANE_Z + 6);
          const g = c.createRadialGradient(x, y, 2, x, y, 34);
          g.addColorStop(0, "rgba(255,255,240,1)");
          g.addColorStop(0.4, alpha(light(pk.color, 0.35), 0.75));
          g.addColorStop(1, alpha(pk.color, 0));
          c.fillStyle = g;
          c.beginPath();
          c.arc(x, y, 34, 0, Math.PI * 2);
          c.fill();
          c.save();
          c.translate(x, y);
          c.scale(1.8, 1.8);
          c.translate(-x, -y - LANE_Z);
          vehicle(c, a.u, a.v, a.du, a.dv, "#ffffff", "car");
          c.restore();
          const [cx2, cy2] = [x, y - 21];
          c.fillStyle = pk.color;
          c.strokeStyle = "#ffffff";
          c.lineWidth = 1.5;
          c.beginPath();
          c.moveTo(cx2, cy2 - 6);
          c.lineTo(cx2 + 6, cy2);
          c.lineTo(cx2, cy2 + 6);
          c.lineTo(cx2 - 6, cy2);
          c.closePath();
          c.fill();
          c.stroke();
        },
      });
    }
    objs.sort((a, b) => a.u + a.v - (b.u + b.v));
    for (const ob of objs) {
      ob.draw();
      const [x, y] = iso(ob.u, ob.v, 0);
      const bb = [x - 36, y - 40, x + 36, y + 16];
      const front = scene.items.filter((it) => it.depth > ob.u + ob.v + 0.35 && overlaps(it.box, bb));
      if (!front.length) continue;
      c.save();
      c.beginPath();
      c.rect(bb[0], bb[1], bb[2] - bb[0], bb[3] - bb[1]);
      c.clip();
      for (const it of front) it.draw(c);
      c.restore();
    }
  }

  function effects(now) {
    const t = now / 1000;
    const calm = reduced.matches;
    for (const b of scene.buildings) {
      const top = grow(b.base, iso(b.c.u, b.c.v, LOT_Z + b.design.height));
      // blinking beacons on masts
      if (b.kind === "input" || b.kind === "agent" || b.connector === "http") {
        const on = calm || Math.sin(t * 3 + b.depth) > 0;
        const at = grow(
          b.base,
          b.kind === "input"
            ? iso(b.c.u - 0.65, b.c.v - 0.6, LOT_Z + 32 + 78)
            : b.kind === "agent"
              ? iso(b.c.u - 0.6, b.c.v - 0.6, LOT_Z + 34 + 52)
              : iso(b.c.u + 0.5, b.c.v + 0.5, LOT_Z + 94 + 22),
        );
        c.fillStyle = on ? "#ff5d6c" : "#a8505a";
        c.beginPath();
        c.arc(at[0], at[1], on ? 2.8 : 2, 0, Math.PI * 2);
        c.fill();
      }
      if (b.connector === "exec" && b.kind === "transform")
        smoke(grow(b.base, iso(b.c.u - 0.75, b.c.v - 0.63, LOT_Z + 88)), t, "#ffffff", calm);
      if (b.trace?.status === "bad")
        smoke(grow(b.base, iso(b.c.u, b.c.v, LOT_Z + b.design.top + 6)), t, "#5b5266", calm);
      if (b.bad) {
        const bob = calm ? 0 : Math.sin(t * 2.4 + b.depth) * 2.5;
        c.font = `18px ${EMOJI}`;
        c.textAlign = "center";
        c.textBaseline = "bottom";
        c.fillText("🚧", top[0] + 34, top[1] + 30 + bob);
      }
      const fl = flashes.get(b.id);
      if (fl) {
        const f = (now - fl.t0) / 900;
        if (f > 1) flashes.delete(b.id);
        else {
          c.save();
          c.globalAlpha = 1 - f;
          c.shadowColor = fl.color;
          c.shadowBlur = 18;
          c.lineWidth = 4;
          poly(c, b.hull, alpha(fl.color, 0.18), fl.color);
          c.restore();
        }
      }
    }
    for (let i = fx.length - 1; i >= 0; i--) {
      const e = fx[i];
      const f = (now - e.t0) / 1600;
      if (f > 1) {
        fx.splice(i, 1);
        continue;
      }
      if (f < 0) continue;
      const b = scene.byId.get(e.id);
      if (!b) continue;
      const [x, y] = grow(b.base, iso(b.c.u, b.c.v, LOT_Z + b.design.height + 8));
      c.save();
      c.globalAlpha = Math.min(1, (1 - f) * 2);
      c.font = `${22}px ${EMOJI}`;
      c.textAlign = "center";
      c.textBaseline = "bottom";
      c.fillText(e.text, x + 28, y - (calm ? 0 : f * 26));
      c.restore();
    }
    if (ghost) {
      const u0 = ghost.cx * CELL + 1;
      const v0 = ghost.cy * CELL + 1;
      c.save();
      c.setLineDash([6, 5]);
      c.lineWidth = 3;
      poly(c, corners(u0 + 0.1, v0 + 0.1, u0 + 2.9, v0 + 2.9, LOT_Z), "rgba(255,255,255,0.35)", "#ffffff");
      c.restore();
    }
    if (wire) {
      const [x0, y0] = iso(wire.from.u, wire.from.v, LANE_Z);
      const [x1, y1] = iso(wire.to.u, wire.to.v, LANE_Z);
      const target = wire.onto ? scene.byId.get(wire.onto) : null;
      if (target) {
        c.save();
        c.lineWidth = 3;
        c.shadowColor = wire.color;
        c.shadowBlur = 14;
        poly(c, target.hull, alpha(wire.color, 0.15), wire.color);
        c.restore();
      }
      c.save();
      c.lineCap = "round";
      c.setLineDash([2, 10]);
      c.lineWidth = 7;
      c.strokeStyle = wire.color;
      c.beginPath();
      c.moveTo(x0, y0);
      c.lineTo(x1, y1);
      c.stroke();
      c.restore();
    }
  }

  function smoke([x, y], t, color, calm) {
    for (let i = 0; i < 4; i++) {
      const f = calm ? i / 4 : (t * 0.45 + i / 4) % 1;
      c.fillStyle = alpha(color, 0.55 * (1 - f));
      c.beginPath();
      c.arc(x + f * 10 + Math.sin(f * 6 + i) * 2, y - f * 30, 3.5 + f * 7, 0, Math.PI * 2);
      c.fill();
    }
  }

  // ── animation ──

  const busy = () => !reduced.matches || packets.length || fx.length || flashes.size;
  function kick() {
    if (!raf && !root.hidden) raf = requestAnimationFrame(frame);
  }
  function frame(now) {
    raf = 0;
    if (!root.isConnected || root.hidden || document.hidden) return;
    // the town idles at ~30 fps; it moves at full speed when packets or the view do
    if (now - lastFrame >= 30 || stale || packets.length || wire || ghost) {
      lastFrame = now;
      render(now);
    }
    if (busy() || stale) kick();
  }
  document.addEventListener("visibilitychange", () => kick());

  const travel = (lane) => Math.max(500, lane.length * 220);
  function send(fromId, branch, at = performance.now(), color) {
    for (const lane of scene?.lanes ?? []) {
      if (lane.from !== fromId) continue;
      if (branch && lane.branch && lane.branch !== branch) continue;
      packets.push({ lane, t0: at, dur: travel(lane), color: color ?? lane.color });
    }
  }
  function note(id, text, at = performance.now()) {
    fx.push({ id, text, t0: at });
  }

  /** A dry run's path: packets leave the input and hop block to block the way the fixture went. */
  function playTrace(tr) {
    if (reduced.matches) return;
    const now = performance.now();
    const at = new Map([["input", now]]);
    const queue = ["input"];
    const seen = new Set();
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const lane of scene.lanes) {
        if (lane.from !== id || !tr.get(lane.to)?.via?.has(lane.ref)) continue;
        const start = at.get(id) + 250;
        packets.push({ lane, t0: start, dur: travel(lane), color: lane.color });
        if (!at.has(lane.to)) {
          at.set(lane.to, start + travel(lane));
          queue.push(lane.to);
        }
      }
    }
    for (const [id, t] of tr) {
      const when = (at.get(id) ?? now) + 150;
      if (t.status === "bad") note(id, "💥", when);
      else if (t.status === "stop") note(id, "🧹", when);
      else if (id === "output") note(id, "✅", when);
    }
    kick();
  }

  // ── overlay: labels and ports ──

  function syncOverlay() {
    const seen = new Set();
    for (const b of scene.buildings) {
      seen.add(b.id);
      let entry = labels.get(b.id);
      if (!entry) {
        const label = h("button", {
          type: "button",
          onpointerdown: (ev) => startMove(ev, entry.id),
          onclick: (ev) => {
            if (ev.detail === 0) o.select({ type: "block", id: entry.id });
          },
        });
        entry = { id: b.id, label, ports: [] };
        labels.set(b.id, entry);
        overlay.append(label);
      }
      entry.id = b.id;
      const { label } = entry;
      label.className = `city-label k-${b.kind}${b.sel ? " sel" : ""}${b.bad ? " bad" : b.problems.length ? " warn" : ""}`;
      label.setAttribute(
        "aria-label",
        `${b.kind} ${b.id}${b.bad ? `, ${b.bad} problem${b.bad > 1 ? "s" : ""}` : ""}${b.trace ? `, dry run: ${b.trace.status}` : ""}`,
      );
      label.title =
        b.problems.map((d) => `${d.code} ${d.message}`).join("\n") || `${b.id}: drag to move, click to edit`;
      label.replaceChildren(
        ...clean([
          h("span", { class: "city-emoji", "aria-hidden": "true" }, b.emoji),
          h("span", { class: "city-text" }, h("b", null, b.id), h("small", null, `${kindEmoji(b.kind)} ${b.sub}`)),
          b.problems.length ? h("span", { class: "city-badge" }, b.bad ? String(b.bad) : "!") : null,
          b.trace
            ? h("span", { class: "city-mark" }, b.trace.status === "ok" ? "✅" : b.trace.status === "bad" ? "💥" : "🫥")
            : null,
        ]),
      );
      while (entry.ports.length > b.ports.length) entry.ports.pop().remove();
      b.ports.forEach((q, i) => {
        let el = entry.ports[i];
        if (!el) {
          el = h("button", { type: "button", class: "city-port" });
          entry.ports.push(el);
          overlay.append(el);
        }
        el.style.setProperty("--lane", q.color);
        el.title = `Drag onto a building to send ${q.branch ? `the ${q.branch} branch` : "packets"} there`;
        el.setAttribute("aria-label", `out-port ${refOf(b.id, q.branch)}`);
        el.onpointerdown = (ev) => startWire(ev, b.id, q);
        el.replaceChildren(...clean([q.branch ? h("span", { class: "city-branch" }, q.branch) : null]));
      });
    }
    for (const [id, entry] of labels) {
      if (seen.has(id)) continue;
      entry.label.remove();
      for (const el of entry.ports) el.remove();
      labels.delete(id);
    }
    laidOut = "";
  }

  function placeOverlay() {
    const key = `${view.x},${view.y},${view.k},${canvas.clientWidth}`;
    if (key === laidOut) return;
    laidOut = key;
    const toScreen = ([x, y]) => [x * view.k + view.x, y * view.k + view.y];
    overlay.classList.toggle("far", view.k < 0.5);
    overlay.classList.toggle("mid", view.k < 0.85);
    // Labels go above their buildings; one that would cover another (front ones first) moves up until it doesn't.
    const placed = [];
    const order = [...scene.buildings].sort((a, b) => b.depth - a.depth);
    for (const b of order) {
      const entry = labels.get(b.id);
      if (!entry) continue;
      const [x, y0] = toScreen(grow(b.base, iso(b.c.u, b.c.v, LOT_Z + b.design.height + 6)));
      const w = entry.label.offsetWidth + 6;
      const hh = entry.label.offsetHeight + 4;
      let y = y0;
      for (let tries = 0; tries < 8; tries++) {
        const hit = placed.find((r) => Math.abs(r.x - x) < (r.w + w) / 2 && y > r.y - r.h && y - hh < r.y);
        if (!hit) break;
        y = hit.y - hit.h;
      }
      placed.push({ x, y, w, h: hh });
      entry.label.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
    }
    for (const b of scene.buildings) {
      const entry = labels.get(b.id);
      if (!entry) continue;
      b.ports.forEach((q, i) => {
        const [px, py] = toScreen(iso(q.u, q.v, LANE_Z));
        entry.ports[i].style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px)`;
      });
    }
  }

  // ── interaction ──

  const local = (ev) => {
    const r = canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  };
  const toWorld = (ev) => {
    const [x, y] = local(ev);
    return [(x - view.x) / view.k, (y - view.y) / view.k];
  };
  const toGround = ([x, y]) => {
    const a = x / HW;
    const b = (y + LOT_Z) / HH;
    return { u: (a + b) / 2, v: (b - a) / 2 };
  };
  function buildingAt(w) {
    for (const b of scene.front) if (inside(w, b.hull)) return b;
    const g = toGround(w);
    const cell = cellAt(g.u, g.v);
    const id = scene.owned.get(cellKey(cell.cx, cell.cy));
    return id ? scene.byId.get(id) : null;
  }
  function laneAt(w) {
    let best = null;
    let dist = 9;
    for (const lane of scene.lanes) {
      for (let i = 1; i < lane.screen.length; i++) {
        const d = segDist(w, lane.screen[i - 1], lane.screen[i]);
        if (d < dist) {
          dist = d;
          best = lane;
        }
      }
    }
    return best;
  }

  canvas.onpointerdown = (ev) => {
    if (ev.button !== 0 || !scene) return;
    const w = toWorld(ev);
    const b = buildingAt(w);
    if (b) return startMove(ev, b.id);
    const lane = laneAt(w);
    if (lane) {
      o.select({ type: "edge", ref: lane.ref, to: lane.to });
      return o.focus();
    }
    const start = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
    let moved = false;
    canvas.setPointerCapture(ev.pointerId);
    canvas.classList.add("panning");
    canvas.onpointermove = (m) => {
      if (Math.abs(m.clientX - start.x) + Math.abs(m.clientY - start.y) > 3) moved = true;
      setView({ ...view, x: start.vx + m.clientX - start.x, y: start.vy + m.clientY - start.y });
    };
    canvas.onpointerup = () => {
      canvas.onpointermove = hovering;
      canvas.onpointerup = null;
      canvas.classList.remove("panning");
      if (!moved) o.select(null);
    };
  };

  function hovering(ev) {
    if (!scene || ev.buttons) return;
    const w = toWorld(ev);
    const b = buildingAt(w);
    const next = b?.id ?? null;
    canvas.style.cursor = b ? "move" : laneAt(w) ? "pointer" : "";
    if (next !== hover) {
      for (const [id, entry] of labels) entry.label.classList.toggle("hover", id === next);
      hover = next;
    }
  }
  canvas.onpointermove = hovering;

  canvas.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const [x, y] = local(ev);
      zoomBy(Math.exp(-ev.deltaY * 0.0015), x, y);
    },
    { passive: false },
  );

  function startMove(ev, id) {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    const start = { x: ev.clientX, y: ev.clientY };
    let moved = false;
    canvas.setPointerCapture(ev.pointerId);
    canvas.onpointermove = (m) => {
      if (Math.abs(m.clientX - start.x) + Math.abs(m.clientY - start.y) > 5) moved = true;
      if (!moved) return;
      const g = toGround(toWorld(m));
      const cell = cellAt(g.u, g.v);
      ghost = cell;
      o.hint("🏗️ Drop it on a lot · a lot that's taken swaps buildings");
      kick();
    };
    canvas.onpointerup = () => {
      canvas.onpointermove = hovering;
      canvas.onpointerup = null;
      const to = ghost;
      ghost = null;
      o.hint(null);
      if (moved && to) {
        const from = lots.get(id);
        const other = scene.owned.get(cellKey(to.cx, to.cy));
        if (other && other !== id) lots.set(other, { ...from });
        lots.set(id, { cx: to.cx, cy: to.cy });
        keep(storeKey, Object.fromEntries(lots));
      }
      o.select({ type: "block", id });
      o.focus();
    };
  }

  function startWire(ev, id, port) {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    const ref = refOf(id, port.branch);
    wire = { ref, from: { u: port.u, v: port.v }, to: { u: port.u, v: port.v }, color: port.color, onto: null };
    o.hint("🎯 Drop the lane on the building it should feed");
    canvas.setPointerCapture(ev.pointerId);
    canvas.onpointermove = (m) => {
      const w = toWorld(m);
      wire.to = toGround(w);
      const b = buildingAt(w);
      wire.onto = b && b.id !== id ? b.id : null;
      kick();
    };
    canvas.onpointerup = () => {
      canvas.onpointermove = hovering;
      canvas.onpointerup = null;
      const onto = wire?.onto;
      wire = null;
      o.hint(null);
      kick();
      if (onto) o.wire(ref, onto);
    };
    kick();
  }

  function setView(next) {
    view = next;
    stale = true;
    kick();
  }

  function zoomBy(f, cx, cy) {
    const px = cx ?? canvas.clientWidth / 2;
    const py = cy ?? canvas.clientHeight / 2;
    const k = Math.min(2.2, Math.max(0.3, view.k * f));
    setView({ k, x: px - ((px - view.x) * k) / view.k, y: py - ((py - view.y) * k) / view.k });
  }

  function fit() {
    if (!scene) build();
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (!w || !hgt || !scene.buildings.length) return;
    fitted = true;
    const pts = [];
    for (const b of scene.buildings) {
      const u0 = b.lot.cx * CELL + 0.5;
      const v0 = b.lot.cy * CELL + 0.5;
      pts.push(...corners(u0, v0, u0 + 4, v0 + 4, 0), grow(b.base, iso(b.c.u, b.c.v, b.design.height + 40)));
    }
    const [x0, y0, x1, y1] = bboxOf(pts, 0);
    const k = Math.min(1.35, Math.max(0.3, Math.min((w - 120) / (x1 - x0 || 1), (hgt - 90) / (y1 - y0 || 1))));
    setView({ k, x: (w - (x1 - x0) * k) / 2 - x0 * k, y: (hgt - (y1 - y0) * k) / 2 - y0 * k + 10 });
  }

  return {
    el: root,
    /** Rebuild from the builder's state (after any edit, selection or check). */
    draw() {
      build();
      kick();
    },
    show(on) {
      root.hidden = !on;
      if (on) {
        build();
        if (!fitted) fit();
        stale = true;
        kick();
      }
    },
    fit,
    zoomBy,
    /** Lay the town out again from the graph's layers. */
    tidy() {
      lots = new Map();
      build();
      fit();
    },
    /** Where a palette item dropped: the lot it should take, and the building it landed on, if any. */
    dropAt(ev) {
      const w = toWorld(ev);
      const b = buildingAt(w);
      if (!b) {
        const g = toGround(w);
        drop = cellAt(g.u, g.v);
      }
      return { onto: b?.id ?? null };
    },
    rename(old, next) {
      if (!lots.has(old)) return;
      lots.set(next, lots.get(old));
      lots.delete(old);
      keep(storeKey, Object.fromEntries(lots));
    },
    /** A live journal event of this pipeline: packets set off, and failures and deliveries show where they happen. */
    event(e) {
      if (!scene || root.hidden) return;
      if (e.type === "packet.accepted") send("input", null);
      else if (e.type === "node.done" || e.type === "node.looped") send(e.node, e.detail?.branch ?? null);
      else if (e.type === "node.failed") {
        flashes.set(e.node, { t0: performance.now(), color: "#f5a623" });
        note(e.node, "🔁");
      } else if (e.type === "packet.dead_lettered") {
        flashes.set(e.node ?? "output", { t0: performance.now(), color: "#ef4f6b" });
        note(e.node ?? "output", "💥");
      } else if (e.type === "packet.delivered") note("output", "✅");
      else if (e.type === "packet.filtered" && e.node) note(e.node, "🧹");
      else if (e.type === "packet.escalated" && e.node) note(e.node, "🙋");
      else if (e.type === "packet.rejected") note("input", "⛔");
      kick();
    },
  };
}
