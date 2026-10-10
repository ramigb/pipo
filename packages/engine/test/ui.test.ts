// The gateway serves the dashboard at /ui (docs/spec.md §8) and the graph route it draws from.
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { serveUi } from "@pipo/ui";
import { Supervisor } from "../src";
import { isAlive, sandbox, testConfig, waitFor } from "./helpers";

const box = sandbox();
let engine: Supervisor | undefined;
afterAll(async () => {
  if (engine) {
    const pids = engine.list().flatMap((r) => (r.pid ? [r.pid] : []));
    await Promise.race([engine.shutdown({ now: true }), Bun.sleep(10_000)]);
    for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  }
  box.cleanup();
});

test("/ui serves index.html, assets with their content type, refuses traversal, falls back for routes", async () => {
  engine = await Supervisor.open({
    home: join(box.root, "home"),
    config: { ...testConfig(), listen: 0 },
    log: () => {},
  });
  const base = engine.gateway?.url as string;

  for (const p of ["/ui", "/ui/", "/ui/p/some-pipeline/abc"]) {
    const res = await fetch(`${base}${p}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>Pipo</title>");
  }
  const js = await fetch(`${base}/ui/app.js`);
  expect(js.status).toBe(200);
  expect(js.headers.get("content-type")).toContain("text/javascript");
  expect((await fetch(`${base}/ui/style.css`)).headers.get("content-type")).toContain("text/css");

  expect((await fetch(`${base}/ui/missing.js`)).status).toBe(404);
  for (const p of ["/ui/../package.json", "/ui/%2e%2e/package.json", "/ui/..%2f..%2fsrc/index.ts", "/ui/%2e%2e%5cx"]) {
    const res = await fetch(`${base}${p}`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('"name"');
  }
  // fetch normalises "../", so hand the helper un-normalised paths too
  for (const p of ["/ui/../package.json", "/ui/a/../../src/index.ts"]) {
    expect((await serveUi(p)).status).toBe(404);
  }
});

test("GET /api/pipelines/<name>/graph draws the definition with counters", async () => {
  const file = box.write(
    "ui-graph.pipo",
    "pipo: 1\nname: ui-graph\ninput: { via: push }\nnodes:\n  shout: { from: input, transform: map, with: { data: { b: '${data.a}' } } }\noutput: { from: shout, to: file, with: { path: ./ui-graph.jsonl } }\n",
  );
  const base = engine?.gateway?.url as string;
  const started = await fetch(`${base}/api/pipelines`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  });
  expect(started.status).toBe(201);
  const push = await fetch(`${base}/api/pipelines/ui-graph/push`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: { a: 1 } }),
  });
  expect(push.status).toBe(200);
  const graph = await waitFor(
    async () => {
      const g = (await (await fetch(`${base}/api/pipelines/ui-graph/graph`)).json()) as any;
      return g.nodes?.find((n: any) => n.id === "output")?.counts.ok >= 1 ? g : null;
    },
    15_000,
    "output counter",
  );
  expect(graph.nodes.map((n: any) => n.id)).toEqual(["input", "shout", "output"]);
  expect(graph.nodes[1]).toMatchObject({ kind: "transform", from: [{ node: "input", branch: null }] });
  expect(graph.nodes[1].counts.ok).toBe(1);
  // The parsed definition, for the City view (D75).
  expect(graph.definition).toMatchObject({ name: "ui-graph", nodes: { shout: { from: "input", transform: "map" } } });
  expect((await fetch(`${base}/api/pipelines/nope/graph`)).status).toBe(404);
});
