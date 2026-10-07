import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "@pipo/spec";
import { gaps } from "../src";
import { FileTap } from "../src/connectors/steps";
import { sandbox, settled, startRunner } from "./helpers";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
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
  cleanups.push(() => void srv.stop(true));
  return { url: `http://127.0.0.1:${srv.port}/x`, calls };
}

async function run(node: string, extra = "") {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  const file = box.write(
    "t.pipo",
    `pipo: 1\nname: taps\ninput: { via: http }\nnodes:\n${node}\noutput: { from: n, to: stdout }\n${extra}`,
  );
  const r = await startRunner(file, box.home);
  cleanups.push(() => r.runner.stop());
  const res = await r.post("/", { a: 1 });
  const id = ((await res.json()) as any).packet_id as string;
  return { box, r, id, row: await settled(r.runner, id) };
}

describe("taps and transforms", () => {
  test("no gaps for http, file, emit", () => {
    for (const n of ["tap: http", "tap: file", "tap: emit", "transform: http"]) {
      const p = load(
        `pipo: 1\nname: x\ninput: { via: http }\nnodes:\n  n: { from: input, ${n}, with: { url: "http://x", path: a, event: e } }\noutput: { from: n, to: stdout }\n`,
        "x.pipo",
      ).value as any;
      expect(gaps(p)).toEqual([]);
    }
  });

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

  test("tap file writes and skips a repeat of the same packet and node", async () => {
    const { box, row } = await run(`  n:\n    from: input\n    tap: file\n    with: { path: out/log.jsonl }`);
    expect(row.state).toBe("delivered");
    const path = join(box.root, "out/log.jsonl");
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
    const again = new FileTap(box.root);
    await again.run({ packetId: row.id, node: "n", data: row.data, with: { path: "out/log.jsonl" } });
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
    expect(existsSync(path)).toBe(true);
  });

  test("tap emit records the event in the trail", async () => {
    const { r, id, row } = await run(
      `  n:\n    from: input\n    tap: emit\n    with: { event: enriched, detail: { v: "\${data.a}" } }`,
    );
    expect(row.data).toEqual({ a: 1 });
    const ev = r.runner.journal.events(id);
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
    expect(r.runner.journal.events(row.id).filter((e) => e.type === "step.retry")).toHaveLength(2);
  });
});
