// Taps and transforms (docs/spec.md §3.4): http, file and emit through the Rust runner. A file tap skipping a repeat
// of the same packet and node is unit-tested in crates/pipo-runner (connectors/steps.rs).
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { post, suite } from "./core";

setDefaultTimeout(30_000);
const { box, start } = suite();

const servers: { stop: (force?: boolean) => unknown }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function server(status = 200) {
  const calls: { method: string; body: string; headers: Headers }[] = [];
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      calls.push({ method: req.method, body: await req.text(), headers: req.headers });
      if (status !== 200) return new Response("nope", { status });
      return Response.json({ enriched: true });
    },
  });
  servers.push(srv);
  return { url: `http://127.0.0.1:${srv.port}/x`, calls };
}

let n = 0;
async function run(node: string, extra = "") {
  const name = `taps${++n}`;
  const r = await start(
    name,
    `pipo: 1\nname: ${name}\ninput: { via: http }\nnodes:\n${node}\noutput: { from: n, to: stdout }\n${extra}`,
  );
  const id = await post(r, { a: 1 });
  return { r, id, row: await r.settled(id) };
}

describe("taps and transforms", () => {
  test("tap http passes data through and sends an idempotency key", async () => {
    const s = server();
    const { row, id } = await run(
      `  n:\n    from: input\n    tap: http\n    with: { url: "${s.url}", body: { got: "\${data.a}" } }`,
    );
    expect(row.state).toBe("delivered");
    expect(row.data).toEqual({ a: 1 });
    expect(s.calls).toHaveLength(1);
    expect(JSON.parse(s.calls[0]?.body ?? "")).toEqual({ got: 1 });
    expect(s.calls[0]?.headers.get("idempotency-key")).toBe(`${id}:n`);
  });

  test("transform http replaces data with the JSON response", async () => {
    const s = server();
    const { row } = await run(`  n:\n    from: input\n    transform: http\n    with: { url: "${s.url}" }`);
    expect(row.state).toBe("delivered");
    expect(row.data).toEqual({ enriched: true });
  });

  test("tap file writes the packet under its node's key", async () => {
    const { row, id } = await run(`  n:\n    from: input\n    tap: file\n    with: { path: out/log.jsonl }`);
    expect(row.state).toBe("delivered");
    const lines = readFileSync(join(box.root, "out/log.jsonl"), "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ packet_id: `${id}:n`, data: { a: 1 } }]);
  });

  test("tap emit records the event in the trail", async () => {
    const { r, id, row } = await run(
      `  n:\n    from: input\n    tap: emit\n    with: { event: enriched, detail: { v: "\${data.a}" } }`,
    );
    expect(row.data).toEqual({ a: 1 });
    const ev = r.events(id);
    const i = ev.findIndex((e) => e.type === "enriched");
    expect(i).toBeGreaterThan(-1);
    expect(ev[i]?.detail).toEqual({ v: 1 });
    expect(ev[i]?.node).toBe("n");
    expect(ev[i + 1]?.type).toBe("node.done");
  });

  test("failing http tap retries then dead-letters", async () => {
    const s = server(500);
    const { row, r } = await run(
      `  n:\n    from: input\n    tap: http\n    with: { url: "${s.url}" }\n    on_error: { retry: 2, delay: 10ms }`,
    );
    expect(row.state).toBe("dead_lettered");
    expect(s.calls).toHaveLength(3);
    expect(r.events(row.id).filter((e) => e.type === "step.retry")).toHaveLength(2);
  });
});
