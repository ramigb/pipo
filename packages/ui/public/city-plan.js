// The City view's plan (docs/spec.md §8, D75): where each block's building stands, the data lanes between them and the
// neighbourhood around them. Pure: no DOM, no canvas. The ground is a grid of tiles; every CELL tiles there is a road,
// and each cell between roads is one lot. A block owns a lot. The pipeline reads left to right on screen: each layer
// is one lot along u and one back along v, so nothing stands in front of the lane coming into it; a lower row is a lot
// further down and to the side, so a tall building doesn't hide the one in the row above. A lane leaves its
// building on the front-right side, runs along road centres, and comes in on the front-left side of the building it
// feeds, so it never crosses a building and both of its ends stay in view. Other lots get seeded scenery.
import { autoLayout } from "./layout.js";

export const CELL = 4;
/** A lot's centre, in tiles. */
export const centre = (lot) => ({ u: lot.cx * CELL + 2.5, v: lot.cy * CELL + 2.5 });
export const cellKey = (cx, cy) => `${cx},${cy}`;
/** The lot under a ground point (tiles). */
export const cellAt = (u, v) => ({ cx: Math.floor(u / CELL), cy: Math.floor(v / CELL) });
/** The lot for a layer (left to right on screen) and a row (top to bottom). */
export const lotAt = (layer, row) => ({ cx: layer + row, cy: 2 * row - layer });
/** A lot's layer: how far right on screen it is. */
export const layerOf = (lot) => (2 * lot.cx - lot.cy) / 3;

/**
 * Lots for every block: kept where they were, else placed. With none known, the layered auto-layout's layers and rows
 * become lots. A new block goes where it was dropped, else one layer past its first parent; when that lot is taken,
 * every block from that layer on moves one layer further right, so a chain stays a straight street.
 * @param {{id: string, from: {node: string}[]}[]} blocks
 * @param {Map<string, {cx: number, cy: number}>} lots remembered lots (ids no longer present are ignored, not lost)
 * @param {{cx: number, cy: number} | null} [drop]
 * @returns {Map<string, {cx: number, cy: number}>} a new map
 */
export function placeLots(blocks, lots, drop = null) {
  const out = new Map(lots);
  const ids = new Set(blocks.map((b) => b.id));
  const live = () => [...out].filter(([id]) => ids.has(id));
  const taken = (cx, cy) => live().some(([, l]) => l.cx === cx && l.cy === cy);
  const missing = blocks.filter((b) => !out.has(b.id));
  if (!missing.length) return out;
  if (missing.length === blocks.length) {
    const { pos } = autoLayout(blocks, { w: 1, h: 1, gx: 0, gy: 0, pad: 0 });
    for (const [id, p] of pos) out.set(id, lotAt(Math.round(p.x), Math.round(p.y)));
    return out;
  }
  let dropped = drop;
  for (const b of missing) {
    if (dropped) {
      out.set(b.id, nearestFree(dropped, taken));
      dropped = null;
      continue;
    }
    const parent = b.from.map((f) => (ids.has(f.node) ? out.get(f.node) : null)).find(Boolean);
    const at = parent ? { cx: parent.cx + 1, cy: parent.cy - 1 } : { cx: 0, cy: 0 };
    if (taken(at.cx, at.cy)) {
      for (const [id, l] of live()) if (layerOf(l) >= layerOf(at)) out.set(id, { cx: l.cx + 1, cy: l.cy - 1 });
    }
    out.set(b.id, taken(at.cx, at.cy) ? nearestFree(at, taken) : at);
  }
  return out;
}

/** The free lot closest to `at` (ring by ring; to the right on screen first, then lower). */
export function nearestFree(at, taken) {
  for (let r = 0; r < 64; r++) {
    const ring = [];
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r) ring.push([dx, dy]);
    ring.sort(
      (a, b) => Math.hypot(...a) - Math.hypot(...b) || b[0] - b[1] - (a[0] - a[1]) || b[0] + b[1] - (a[0] + a[1]),
    );
    for (const [dx, dy] of ring) if (!taken(at.cx + dx, at.cy + dy)) return { cx: at.cx + dx, cy: at.cy + dy };
  }
  return { ...at };
}

/** How far from a lot's centre a building's out-ports and door are, in tiles. */
export const REACH = 1.32;

/** A block's out-ports on the front-right of its building (a route's branches spread along it), in tiles. */
export function portsOf(lot, branches) {
  const c = centre(lot);
  const n = branches.length;
  const gap = Math.min(0.75, 2.2 / Math.max(1, n));
  return branches.map((branch, i) => ({ branch, u: c.u + REACH, v: c.v + (i - (n - 1) / 2) * gap - 0.15 }));
}

/** Where a lane ends: the front-left of the fed building. */
export const doorOf = (lot) => ({ u: centre(lot).u, v: centre(lot).v + REACH });

/**
 * A lane's points (tiles), from an out-port to the fed lot's door: out to the road on its building's right, along it
 * to the road in front of the fed lot, along that to the fed building, and in. `offset` shifts it within the roads so
 * lanes that share one stay apart.
 */
export function lanePath(port, from, to, offset = 0) {
  const door = doorOf(to);
  const xr = (from.cx + 1) * CELL + 0.5 + offset;
  const yf = (to.cy + 1) * CELL + 0.5 + offset;
  const xd = door.u + offset;
  return simplify([
    [port.u, port.v],
    [xr, port.v],
    [xr, yf],
    [xd, yf],
    [xd, door.v],
  ]);
}

/** Drop repeated points and the middle of straight runs. */
export function simplify(pts) {
  const out = [];
  for (const p of pts) {
    const last = out.at(-1);
    if (last && Math.abs(last[0] - p[0]) < 1e-9 && Math.abs(last[1] - p[1]) < 1e-9) continue;
    const prev = out.at(-2);
    if (prev && last) {
      const straight =
        (Math.abs(prev[0] - last[0]) < 1e-9 && Math.abs(last[0] - p[0]) < 1e-9) ||
        (Math.abs(prev[1] - last[1]) < 1e-9 && Math.abs(last[1] - p[1]) < 1e-9);
      if (straight) out.pop();
    }
    out.push(p);
  }
  return out;
}

const OFFSETS = [0, 0.26, -0.26, 0.13, -0.13];

/**
 * Every lane: `{ref, from, branch, to, pts, length}`. Lanes that share a road out (a route's branches) or a way in
 * (several blocks feeding one) get different offsets within the road.
 * @param {{from: string, branch: string|null, to: string, ref: string}[]} edges
 * @param {Map<string, {cx: number, cy: number}>} lots
 * @param {(id: string) => (string|null)[]} branchesOf a block's out-ports
 */
export function planLanes(edges, lots, branchesOf) {
  const lanes = [];
  const out = new Map();
  const into = new Map();
  for (const e of edges) {
    const a = lots.get(e.from);
    const b = lots.get(e.to);
    if (!a || !b) continue;
    const ports = portsOf(a, branchesOf(e.from));
    const port = ports.find((p) => p.branch === e.branch) ?? ports[0];
    if (!port) continue;
    const n = Math.max(out.get(e.from) ?? 0, into.get(e.to) ?? 0);
    out.set(e.from, n + 1);
    into.set(e.to, n + 1);
    const pts = lanePath(port, a, b, OFFSETS[n % OFFSETS.length]);
    lanes.push({ ref: e.ref, from: e.from, branch: e.branch, to: e.to, pts, length: lengthOf(pts) });
  }
  return lanes;
}

export const lengthOf = (pts) =>
  pts.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

/** The point a fraction `t` (0–1) along a polyline, and the direction it's heading there. */
export function along(pts, t, length = lengthOf(pts)) {
  let left = Math.max(0, Math.min(1, t)) * length;
  for (let i = 1; i < pts.length; i++) {
    const [u0, v0] = pts[i - 1];
    const [u1, v1] = pts[i];
    const d = Math.hypot(u1 - u0, v1 - v0);
    if (left <= d || i === pts.length - 1) {
      const f = d ? Math.min(1, left / d) : 0;
      return { u: u0 + (u1 - u0) * f, v: v0 + (v1 - v0) * f, du: d ? (u1 - u0) / d : 1, dv: d ? (v1 - v0) / d : 0 };
    }
    left -= d;
  }
  const [u, v] = pts[0];
  return { u, v, du: 1, dv: 0 };
}

/** The lots the city spreads over: the blocks' lots with `margin` lots of neighbourhood all round. */
export function regionOf(lots, margin = 3) {
  const ls = [...lots];
  const cxs = ls.map((l) => l.cx);
  const cys = ls.map((l) => l.cy);
  if (!ls.length) return { c0: -margin, c1: margin, r0: -margin, r1: margin };
  return {
    c0: Math.min(...cxs) - margin,
    c1: Math.max(...cxs) + margin,
    r0: Math.min(...cys) - margin,
    r1: Math.max(...cys) + margin,
  };
}

// ── decor ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A small seeded random generator (mulberry32): the same seed always builds the same neighbourhood. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WALLS = ["#f3dcc6", "#ecd3c3", "#f6e7d6", "#e9cdb9", "#e3d3e6", "#d6e6e3", "#f1d7cf", "#e8dcc8"];
const ROOFS = ["#c98f7a", "#b8a2c9", "#a9b9c8", "#c7a08a", "#9fb7a7", "#d4a59a"];
const TREES = ["#7cc56a", "#8fd16f", "#62b366", "#9ad37a", "#72bb73"];

/**
 * What stands on a lot no block owns: `{kind, items}`. `near` is how close the nearest block is: "front" (this lot is
 * in front of one, so only parks, ponds and plazas, which can't hide it), "near" (next to one: houses at most) or
 * "far". Item coordinates are tiles, absolute. Kinds: park, plaza, houses, flats, tower, pond.
 */
export function decorFor(cx, cy, seed, near = "far") {
  const r = rng(hash(`${seed}:${cx}:${cy}`));
  const pick = (list) => list[Math.floor(r() * list.length)];
  const u0 = cx * CELL + 1;
  const v0 = cy * CELL + 1;
  const roll = r();
  const kind =
    near === "front"
      ? roll < 0.6
        ? "park"
        : roll < 0.8
          ? "plaza"
          : "pond"
      : near === "near"
        ? roll < 0.45
          ? "park"
          : roll < 0.85
            ? "houses"
            : roll < 0.93
              ? "plaza"
              : "pond"
        : roll < 0.3
          ? "park"
          : roll < 0.55
            ? "houses"
            : roll < 0.88
              ? "flats"
              : roll < 0.94
                ? "tower"
                : "pond";
  const items = [];
  // In front of a block, trees keep to the front half: at the back they would stand over its lanes.
  const clear = (u, v) => near !== "front" || (u > u0 + 1.05 && v > v0 + 1.05);
  const tree = (u, v, s = 1) =>
    clear(u, v) &&
    items.push({
      t: r() < 0.25 ? "pine" : "tree",
      u,
      v,
      s: s * (0.8 + r() * 0.45),
      color: r() < 0.1 ? pick(["#f0a04b", "#f4a6c0", "#f2c14e"]) : pick(TREES),
    });
  const rim = (n) => {
    for (let i = 0; i < n; i++) {
      const side = Math.floor(r() * 4);
      const f = 0.25 + r() * 2.5;
      const [u, v] = [
        [u0 + f, v0 + 0.22],
        [u0 + 2.78, v0 + f],
        [u0 + f, v0 + 2.78],
        [u0 + 0.22, v0 + f],
      ][side];
      tree(u, v, 0.8);
    }
  };
  if (kind === "park") {
    items.push({ t: "lawn", u0: u0 + 0.12, v0: v0 + 0.12, u1: u0 + 2.88, v1: v0 + 2.88 });
    if (r() < 0.5) items.push({ t: "fountain", u: u0 + 1.5, v: v0 + 1.5 });
    else items.push({ t: "path", u0: u0 + 1.3, v0: v0 + 0.12, u1: u0 + 1.7, v1: v0 + 2.88 });
    for (let i = 0; i < 7 + Math.floor(r() * 5); i++) {
      const u = u0 + 0.35 + r() * 2.3;
      const v = v0 + 0.35 + r() * 2.3;
      if (Math.hypot(u - u0 - 1.5, v - v0 - 1.5) < 0.6) continue;
      tree(u, v);
    }
    items.push({ t: "bench", u: u0 + 0.6 + r() * 1.6, v: v0 + 2.55 });
    if (clear(u0 + 0.25, v0 + 0.25)) items.push({ t: "lamp", u: u0 + 0.25, v: v0 + 0.25 });
  } else if (kind === "plaza") {
    items.push({ t: "paving", u0: u0 + 0.1, v0: v0 + 0.1, u1: u0 + 2.9, v1: v0 + 2.9 });
    items.push({ t: "fountain", u: u0 + 1.5, v: v0 + 1.5 });
    for (const [du, dv] of [
      [0.4, 0.4],
      [2.6, 0.4],
      [0.4, 2.6],
      [2.6, 2.6],
    ])
      tree(u0 + du, v0 + dv, 0.85);
    items.push({ t: "bench", u: u0 + 1.5, v: v0 + 2.6 }, { t: "lamp", u: u0 + 2.7, v: v0 + 1.5 });
  } else if (kind === "pond") {
    items.push({ t: "lawn", u0: u0 + 0.12, v0: v0 + 0.12, u1: u0 + 2.88, v1: v0 + 2.88 });
    items.push({ t: "water", u0: u0 + 0.6, v0: v0 + 0.7, u1: u0 + 2.4, v1: v0 + 2.3 });
    rim(6);
  } else if (kind === "houses") {
    const spots = [
      [0.2, 0.2],
      [1.6, 0.2],
      [0.2, 1.6],
      [1.6, 1.6],
    ];
    for (const [du, dv] of spots) {
      if (r() < 0.2) {
        tree(u0 + du + 0.6, v0 + dv + 0.6);
        continue;
      }
      const w = 0.9 + r() * 0.3;
      const d = 0.9 + r() * 0.3;
      items.push({
        t: "house",
        u0: u0 + du + 0.1,
        v0: v0 + dv + 0.1,
        u1: u0 + du + 0.1 + w,
        v1: v0 + dv + 0.1 + d,
        h: 18 + r() * 10,
        wall: pick(WALLS),
        roof: pick(ROOFS),
        ridge: r() < 0.5 ? "u" : "v",
      });
    }
    rim(2);
  } else {
    const tall = kind === "tower";
    const n = tall ? 1 : r() < 0.5 ? 1 : 2;
    if (n === 1) {
      const s = tall ? 1.7 : 1.9 + r() * 0.5;
      const o = (3 - s) / 2;
      items.push({
        t: "block",
        u0: u0 + o,
        v0: v0 + o,
        u1: u0 + o + s,
        v1: v0 + o + s,
        h: tall ? 78 + r() * 24 : 34 + r() * 22,
        floors: 0,
        wall: pick(WALLS),
        roof: pick(ROOFS),
        top: r() < 0.6 ? "flat" : "gable",
      });
    } else {
      for (const [a, b] of [
        [0.15, 1.35],
        [1.65, 2.85],
      ])
        items.push({
          t: "block",
          u0: u0 + a,
          v0: v0 + 0.3,
          u1: u0 + b,
          v1: v0 + 2.6,
          h: 30 + r() * 24,
          wall: pick(WALLS),
          roof: pick(ROOFS),
          top: r() < 0.6 ? "flat" : "gable",
        });
    }
    rim(tall ? 3 : 2);
  }
  return { kind, items };
}
