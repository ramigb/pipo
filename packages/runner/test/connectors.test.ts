// File and http outputs end to end (docs/spec.md §3.6): the Rust runner binary with an http input. The adapters' own
// logic (formats, dedupe, crash recovery of the key log, status matching) is unit-tested in
// crates/pipo-runner/src/connectors/{file_out,http_out}.rs.
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./helpers";
import { RustRunner } from "./rust";

setDefaultTimeout(30_000);

const box = sandbox();
let running: RustRunner[] = [];
let servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const r of running) if (r.proc.exitCode === null) await r.kill();
  for (const s of servers) s.stop(true);
  running = [];
  servers = [];
});
afterAll(() => box.cleanup());

async function start(name: string, body: string, env: Record<string, string> = {}) {
  const file = box.write(`${name}.pipo`, `pipo: 1\nname: ${name}\ninput: { via: http }\n${body}`);
  const r = await RustRunner.start(box, file, name, { env });
  running.push(r);
  return r;
}

async function post(r: RustRunner, body: unknown): Promise<string> {
  const res = await r.post("/", body);
  expect(res.status).toBe(202);
  return ((await res.json()) as { packet_id: string }).packet_id;
}

describe("http output", () => {
  function server(handler: (req: Request) => Response | Promise<Response>) {
    const calls: { method: string; headers: Headers; body: string }[] = [];
    const srv = Bun.serve({
      port: 0,
      async fetch(req) {
        calls.push({ method: req.method, headers: req.headers, body: await req.clone().text() });
        return handler(req);
      },
    });
    servers.push(srv);
    return { calls, url: `http://127.0.0.1:${srv.port}/hook` };
  }

  test("retries a failing endpoint per policy, with one Idempotency-Key, and keeps the secret out of logs", async () => {
    let n = 0;
    const s = server(() => (++n < 3 ? new Response("down", { status: 503 }) : new Response("ok")));
    const r = await start(
      "hookout",
      `secrets: { tok: env:PIPO_TEST_HOOK_TOKEN }
output:
  from: input
  to: http
  with:
    url: ${s.url}
    headers: { Authorization: "Bearer \${secrets.tok}" }
  on_error: { retry: 3, delay: 10ms }
`,
      { PIPO_TEST_HOOK_TOKEN: "s3cret-token-value" },
    );
    const id = await post(r, { x: 1 });
    expect((await r.settled(id)).state).toBe("delivered");
    expect(s.calls).toHaveLength(3);
    expect(s.calls.every((c) => c.method === "POST" && c.headers.get("idempotency-key") === id)).toBe(true);
    expect(s.calls[2]?.headers.get("authorization")).toBe("Bearer s3cret-token-value");
    expect(s.calls[2]?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(s.calls[2]?.body ?? "")).toEqual({ x: 1 });
    expect(r.lines().join("\n") + r.stderr()).not.toContain("s3cret-token-value");
    const trail = JSON.stringify(r.query("SELECT detail FROM events WHERE packet_id = ?", id));
    expect(trail).not.toContain("s3cret-token-value");
  });

  test("a status outside the success list dead-letters with the status", async () => {
    const s = server(() => new Response("nope", { status: 202 }));
    const r = await start("strict", `output: { from: input, to: http, with: { url: "${s.url}", success: [200] } }\n`);
    const row = await r.settled(await post(r, {}));
    expect(row.state).toBe("dead_lettered");
    expect(row.error?.message).toContain("202");
  });
});

describe("file output", () => {
  test("delivers jsonl to a templated path, one line per packet", async () => {
    const r = await start(
      "tofile",
      `output:
  from: input
  to: file
  with: { path: "./out/\${data.kind}.jsonl" }
`,
    );
    const ids: string[] = [];
    for (const kind of ["a", "b", "a"]) ids.push(await post(r, { kind }));
    for (const id of ids) expect((await r.settled(id)).state).toBe("delivered");
    const read = (k: string) =>
      readFileSync(join(box.root, `out/${k}.jsonl`), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
    expect(read("a")).toEqual([
      { packet_id: ids[0], data: { kind: "a" } },
      { packet_id: ids[2], data: { kind: "a" } },
    ]);
    expect(read("b")).toHaveLength(1);
    expect(existsSync(join(box.root, "out/a.jsonl.pipo-keys"))).toBe(false);
  });
});
