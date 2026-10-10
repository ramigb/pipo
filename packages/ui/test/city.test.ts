// The City view's plan (docs/spec.md §8, D75): lots for blocks, lanes along the roads, seeded scenery. Pure, so it is
// tested here; the drawing itself is checked by eye.
import { describe, expect, test } from "bun:test";

const planPath = "../public/city-plan.js";
const modelPath = "../public/model.js";
const C: any = await import(planPath);
const M: any = await import(modelPath);

/** input → a → b → output, with a route on `b` when asked. */
function chain(route = false) {
  let p = M.blankPipeline("town");
  let r = M.addNode(p, "transform", "map", "input");
  p = r.p;
  const a = r.id;
  r = M.addNode(p, route ? "route" : "filter", null, a);
  p = r.p;
  const b = r.id;
  p = M.disconnect(p, "input", "output");
  p = M.connect(p, route ? `${b}.${M.outPorts(p, b)[0]}` : b, "output");
  return { p, a, b };
}

const onRoad = (x: number) => Math.abs((((x - 0.5) % C.CELL) + C.CELL) % C.CELL) < 0.3 + 1e-9;
const lotOf = (u: number, v: number) => C.cellAt(u, v);

describe("lots", () => {
  test("with none known, each layer is one lot further right on screen", () => {
    const { p, a, b } = chain();
    const lots = C.placeLots(M.blocks(p), new Map());
    const order = ["input", a, b, "output"].map((id) => lots.get(id));
    for (let i = 1; i < order.length; i++) {
      expect(C.layerOf(order[i]) - C.layerOf(order[i - 1])).toBe(1);
      // one lot along u and one back along v: straight to the right, never in front of the one before
      expect(order[i].cx - order[i - 1].cx).toBe(1);
      expect(order[i].cy - order[i - 1].cy).toBe(-1);
    }
  });

  test("every block gets its own lot", () => {
    let p = M.blankPipeline("wide");
    for (let i = 0; i < 4; i++) p = M.addNode(p, "tap", "log", "input").p;
    const lots = C.placeLots(M.blocks(p), new Map());
    const keys = [...lots.values()].map((l: any) => C.cellKey(l.cx, l.cy));
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("known lots stay; a new block goes one layer past its parent and the street makes room", () => {
    const { p, a } = chain();
    const before = C.placeLots(M.blocks(p), new Map());
    const r = M.addNode(p, "tap", "log", a);
    const after = C.placeLots(M.blocks(r.p), before);
    expect(after.get("input")).toEqual(before.get("input"));
    expect(after.get(a)).toEqual(before.get(a));
    expect(after.get(r.id)).toEqual({ cx: before.get(a).cx + 1, cy: before.get(a).cy - 1 });
    // what stood there moved one layer right
    const moved = [...after].filter(([id]) => id !== r.id && id !== "input" && id !== a);
    for (const [id, l] of moved) expect(C.layerOf(l)).toBe(C.layerOf(before.get(id)) + 1);
  });

  test("a dropped block takes the lot it was dropped on, or the nearest free one", () => {
    const { p } = chain();
    const before = C.placeLots(M.blocks(p), new Map());
    const r = M.addNode(p, "tap", "log", "input");
    expect(C.placeLots(M.blocks(r.p), before, { cx: 7, cy: 3 }).get(r.id)).toEqual({ cx: 7, cy: 3 });
    const taken = before.get("output");
    const got = C.placeLots(M.blocks(r.p), before, taken).get(r.id);
    expect(got).not.toEqual(taken);
    expect(Math.max(Math.abs(got.cx - taken.cx), Math.abs(got.cy - taken.cy))).toBe(1);
  });

  test("lots of removed blocks are kept but don't hold their lot", () => {
    const lots = new Map([["gone", { cx: 1, cy: -1 }]]);
    const { p } = chain();
    const out = C.placeLots(M.blocks(p), lots);
    expect(out.get("gone")).toEqual({ cx: 1, cy: -1 });
    expect([...out].filter(([, l]: any) => l.cx === 1 && l.cy === -1).length).toBe(2);
  });
});

describe("lanes", () => {
  test("a lane runs from the port to the door along road centres, never across a lot", () => {
    const { p, a, b } = chain(true);
    const lots = C.placeLots(M.blocks(p), new Map());
    const lanes = C.planLanes(M.edges(p), lots, (id: string) => M.outPorts(p, id));
    expect(lanes.map((l: any) => l.ref).sort()).toEqual(
      M.edges(p)
        .map((e: any) => e.ref)
        .sort(),
    );
    for (const lane of lanes) {
      const from = lots.get(lane.from);
      const to = lots.get(lane.to);
      const port = C.portsOf(from, M.outPorts(p, lane.from)).find((q: any) => q.branch === lane.branch);
      expect(lane.pts[0]).toEqual([port.u, port.v]);
      expect(lane.pts.at(-1)).toEqual([C.doorOf(to).u, C.doorOf(to).v]);
      // the first leg ends on a road, the last starts on one; every leg between runs along a road
      for (let i = 1; i < lane.pts.length - 2; i++) {
        const [[u0, v0], [u1, v1]] = [lane.pts[i], lane.pts[i + 1]];
        if (u0 === u1) expect(onRoad(u0)).toBe(true);
        else expect(onRoad(v0) && v0 === v1).toBe(true);
      }
      // the ends stay on their own lots
      expect(lotOf(...(lane.pts[0] as [number, number]))).toEqual(from);
      expect(lotOf(...(lane.pts.at(-1) as [number, number]))).toEqual(to);
    }
    expect(lanes.find((l: any) => l.from === b)?.branch).toBe(M.outPorts(p, b)[0]);
    expect(lanes.find((l: any) => l.to === a)?.from).toBe("input");
  });

  test("lanes into the same block get apart within the road", () => {
    let p = M.blankPipeline("fan-in");
    const x = M.addNode(p, "tap", "log", "input");
    p = x.p;
    const y = M.addNode(p, "tap", "log", "input");
    p = M.connect(M.connect(M.disconnect(y.p, "input", "output"), x.id, "output"), y.id, "output");
    const lots = C.placeLots(M.blocks(p), new Map());
    const lanes = C.planLanes(M.edges(p), lots, (id: string) => M.outPorts(p, id)).filter(
      (l: any) => l.to === "output",
    );
    expect(lanes.length).toBe(2);
    expect(lanes[0].pts.at(-1)).not.toEqual(lanes[1].pts.at(-1));
  });

  test("along() walks a lane and says which way it heads", () => {
    const pts = [
      [0, 0],
      [2, 0],
      [2, 2],
    ];
    expect(C.lengthOf(pts)).toBe(4);
    expect(C.along(pts, 0.25)).toEqual({ u: 1, v: 0, du: 1, dv: 0 });
    expect(C.along(pts, 0.75)).toEqual({ u: 2, v: 1, du: 0, dv: 1 });
    expect(C.along(pts, 2)).toEqual({ u: 2, v: 2, du: 0, dv: 1 });
  });

  test("simplify drops repeats and the middle of straight runs", () => {
    expect(
      C.simplify([
        [0, 0],
        [1, 0],
        [1, 0],
        [3, 0],
        [3, 2],
      ]),
    ).toEqual([
      [0, 0],
      [3, 0],
      [3, 2],
    ]);
  });
});

describe("scenery", () => {
  test("the same seed builds the same neighbourhood", () => {
    expect(C.decorFor(3, -2, "file.pipo")).toEqual(C.decorFor(3, -2, "file.pipo"));
    const kinds = new Set();
    for (let i = 0; i < 40; i++) kinds.add(C.decorFor(i, i, "x").kind);
    expect(kinds.size).toBeGreaterThan(3);
  });

  test("in front of a block it stays low and keeps trees off the back of the lot", () => {
    for (let i = 0; i < 60; i++) {
      const d = C.decorFor(i, -i, "seed", "front");
      expect(["park", "plaza", "pond"]).toContain(d.kind);
      const [u0, v0] = [i * C.CELL + 1, -i * C.CELL + 1];
      for (const it of d.items.filter((x: any) => x.t === "tree" || x.t === "pine")) {
        expect(it.u > u0 + 1 && it.v > v0 + 1).toBe(true);
      }
    }
  });

  test("everything stays on its own lot", () => {
    for (let i = 0; i < 60; i++) {
      const d = C.decorFor(i, 2 * i, "lots");
      for (const it of d.items) {
        const [u, v] = it.u0 !== undefined ? [it.u0, it.v0] : [it.u, it.v];
        expect(C.cellAt(u, v)).toEqual({ cx: i, cy: 2 * i });
      }
    }
  });
});
