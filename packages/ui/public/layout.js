// Layered auto-layout for pipeline graphs (docs/spec.md §8), shared by the dashboard graph and the builder canvas.
// Pure: no DOM. A node's layer is one more than its deepest parent; loops (a `from` back up the graph) are ignored.

/**
 * @param {{id: string, from: {node: string}[]}[]} nodes in definition order
 * @param {{w?: number, h?: number, gx?: number, gy?: number, pad?: number, stacked?: boolean}} [o]
 * @returns {{pos: Map<string, {x: number, y: number, w: number, h: number}>, width: number, height: number}}
 */
export function autoLayout(nodes, o = {}) {
  const W = o.w ?? 190;
  const H = o.h ?? 72;
  const GX = o.gx ?? 70;
  const GY = o.gy ?? 26;
  const PAD = o.pad ?? 12;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const layer = new Map();
  const depth = (n, seen) => {
    if (layer.has(n.id)) return layer.get(n.id);
    if (seen.has(n.id)) return 0;
    seen.add(n.id);
    let d = 0;
    for (const f of n.from ?? []) {
      const p = byId.get(f.node);
      if (p && p !== n) d = Math.max(d, depth(p, seen) + 1);
    }
    seen.delete(n.id);
    layer.set(n.id, d);
    return d;
  };
  for (const n of nodes) depth(n, new Set());
  const cols = [];
  for (const n of nodes) {
    const l = layer.get(n.id);
    if (!cols[l]) cols[l] = [];
    cols[l].push(n);
  }
  const pos = new Map();
  if (o.stacked) {
    // Narrow screens: one column, layers stacked top to bottom.
    let row = 0;
    for (const col of cols) for (const n of col ?? []) pos.set(n.id, { x: PAD, y: PAD + row++ * (H + GY), w: W, h: H });
    return { pos, width: PAD * 2 + W + 60, height: Math.max(PAD * 2, PAD * 2 + row * (H + GY) - GY) };
  }
  const tallest = Math.max(1, ...cols.map((c) => c?.length ?? 0));
  for (let x = 0; x < cols.length; x++) {
    const col = cols[x] ?? [];
    // Centre short columns against the tallest one, so a chain reads as a straight line.
    const offset = ((tallest - col.length) * (H + GY)) / 2;
    for (const [y, n] of col.entries())
      pos.set(n.id, { x: PAD + x * (W + GX), y: PAD + offset + y * (H + GY), w: W, h: H });
  }
  return {
    pos,
    width: Math.max(PAD * 2, PAD * 2 + cols.length * (W + GX) - GX),
    height: PAD * 2 + tallest * (H + GY) - GY,
  };
}

/** A smooth left-to-right edge from the right side of `a` to the left side of `b` (or a loop-back curve). */
export function edgePath(a, b, fromY = a.y + a.h / 2) {
  const x1 = a.x + a.w;
  const y1 = fromY;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  if (x2 > x1 + 10) {
    const mx = (x1 + x2) / 2;
    return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
  }
  // Backwards (a loop, or a node dragged behind its parent): swing out below both boxes.
  const drop = Math.max(a.y + a.h, b.y + b.h) + 40;
  return `M${x1},${y1} C${x1 + 60},${y1} ${x1 + 60},${drop} ${(x1 + x2) / 2},${drop} S${x2 - 60},${y2} ${x2},${y2}`;
}
