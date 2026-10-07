import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "@pipo/spec";
import { gaps } from "../src";
import { inputs, outputs } from "../src/connectors";
import { FileOutput } from "../src/connectors/file-output";
import { HttpOutput, statusMatcher } from "../src/connectors/http-output";
import { sandbox, settled, startRunner } from "./helpers";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});
function setup() {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  return box;
}
const item = (id: string, data: unknown, w: Record<string, unknown>) => ({ packetId: id, data, with: w });

describe("registry", () => {
  test("support derives from registry; file and http outputs have no gaps", () => {
    expect(Object.keys(outputs).sort()).toEqual(["file", "http", "sqlite", "stdout", "telegram"]);
    expect(Object.keys(inputs).sort()).toEqual(["http", "push", "schedule", "system", "telegram", "watch"]);
    for (const to of ["file", "http"]) {
      const p = load(
        `pipo: 1\nname: x\ninput: { via: http }\noutput: { from: input, to: ${to}, with: { path: a, url: "http://x" } }\n`,
        "x.pipo",
      ).value as any;
      expect(gaps(p)).toEqual([]);
    }
  });
});

describe("file output", () => {
  test("jsonl append skips a repeated packet_id, even with a fresh adapter", async () => {
    const box = setup();
    const w = { path: "out/a.jsonl" };
    const out = new FileOutput(box.root);
    await out.write([item("p1", { n: 1 }, w), item("p2", { n: 2 }, w), item("p1", { n: 1 }, w)]);
    await new FileOutput(box.root).write([item("p2", { n: 2 }, w), item("p3", { n: 3 }, w)]);
    const lines = readFileSync(join(box.root, "out/a.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { packet_id: "p1", data: { n: 1 } },
      { packet_id: "p2", data: { n: 2 } },
      { packet_id: "p3", data: { n: 3 } },
    ]);
  });

  test("json append keeps an array and dedupes; json write replaces", async () => {
    const box = setup();
    const out = new FileOutput(box.root);
    const w = { path: "a.json", format: "json" };
    await out.write([item("p1", 1, w), item("p1", 1, w), item("p2", 2, w)]);
    expect(JSON.parse(readFileSync(join(box.root, "a.json"), "utf8"))).toEqual([
      { packet_id: "p1", data: 1 },
      { packet_id: "p2", data: 2 },
    ]);
    const ww = { path: "b.json", format: "json", mode: "write" };
    await out.write([item("p1", { a: 1 }, ww), item("p2", { a: 2 }, ww)]);
    expect(JSON.parse(readFileSync(join(box.root, "b.json"), "utf8"))).toEqual({ a: 2 });
  });

  test("csv append writes one header, quotes cells, dedupes", async () => {
    const box = setup();
    const out = new FileOutput(box.root);
    const w = { path: "a.csv", format: "csv" };
    await out.write([item("p1", { name: 'A "x", y', n: 1 }, w), item("p2", { name: "B", n: 2 }, w), item("p1", {}, w)]);
    expect(readFileSync(join(box.root, "a.csv"), "utf8")).toBe('name,n\n"A ""x"", y",1\nB,2\n');
    await out.write([item("p3", { n: 3, name: "C" }, w)]);
    expect(readFileSync(join(box.root, "a.csv"), "utf8")).toBe('name,n\n"A ""x"", y",1\nB,2\nC,3\n');
  });

  test("text append and write", async () => {
    const box = setup();
    const out = new FileOutput(box.root);
    await out.write([
      item("p1", "hello", { path: "a.txt", format: "text" }),
      item("p2", "world", { path: "a.txt", format: "text" }),
    ]);
    expect(readFileSync(join(box.root, "a.txt"), "utf8")).toBe("hello\nworld\n");
    await out.write([item("p3", "only", { path: "w.txt", format: "text", mode: "write" })]);
    await out.write([item("p4", "last", { path: "w.txt", format: "text", mode: "write" })]);
    expect(readFileSync(join(box.root, "w.txt"), "utf8")).toBe("last\n");
  });

  test("text append recovers from a crash between file write and key log", async () => {
    const box = setup();
    const path = join(box.root, "c.txt");
    const w = { path: "c.txt", format: "text" };
    await new FileOutput(box.root).write([item("p1", "one", w)]);
    // crash after the data landed, before "done" was logged
    writeFileSync(`${path}.pipo-keys`, `${readFileSync(`${path}.pipo-keys`, "utf8").split("\n")[0]}\n`);
    await new FileOutput(box.root).write([item("p1", "one", w)]);
    expect(readFileSync(path, "utf8")).toBe("one\n");
    // crash mid-append: partial data, begin logged
    appendFileSync(`${path}.pipo-keys`, `${JSON.stringify(["begin", "p2", 4, 4])}\n`);
    appendFileSync(path, "tw");
    await new FileOutput(box.root).write([item("p2", "two", w)]);
    expect(readFileSync(path, "utf8")).toBe("one\ntwo\n");
  });

  test("path is templated by the runner and empty path is an error", async () => {
    const box = setup();
    await expect(new FileOutput(box.root).write([item("p", 1, { path: "" })])).rejects.toThrow("path is empty");
  });
});

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
    cleanups.push(() => srv.stop(true));
    return { calls, url: `http://127.0.0.1:${srv.port}/hook` };
  }

  test("sends Idempotency-Key, headers and data as JSON by default", async () => {
    const s = server(() => new Response("ok"));
    await new HttpOutput().write([item("pk1", { a: 1 }, { url: s.url, headers: { "X-Auth": "t" } })]);
    const c = s.calls[0];
    expect(c?.method).toBe("POST");
    expect(c?.headers.get("idempotency-key")).toBe("pk1");
    expect(c?.headers.get("x-auth")).toBe("t");
    expect(c?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(c?.body ?? "")).toEqual({ a: 1 });
  });

  test("non-success throws; custom success list is honoured", async () => {
    const s = server(() => new Response("nope", { status: 202 }));
    await expect(new HttpOutput().write([item("p", 1, { url: s.url })])).resolves.toBeDefined();
    await expect(new HttpOutput().write([item("p", 1, { url: s.url, success: [200] })])).rejects.toThrow("202");
    await expect(new HttpOutput().write([item("p", 1, { url: s.url, success: ["2xx"] })])).resolves.toBeDefined();
    const e = server(() => new Response("bad", { status: 500 }));
    await expect(new HttpOutput().write([item("p", 1, { url: e.url })])).rejects.toThrow("500");
    await expect(new HttpOutput().write([item("p", 1, { url: e.url, success: [500] })])).resolves.toBeDefined();
  });

  test("statusMatcher", () => {
    expect(statusMatcher(undefined)(204)).toBe(true);
    expect(statusMatcher(undefined)(301)).toBe(false);
    expect(statusMatcher([201, "3xx", "400-404"])(403)).toBe(true);
    expect(() => statusMatcher(["abc"])).toThrow("invalid success status");
  });

  test("runner retries a failing endpoint per policy and keeps the secret out of logs", async () => {
    const box = setup();
    let n = 0;
    const s = server(() => (++n < 3 ? new Response("down", { status: 503 }) : new Response("ok")));
    process.env.PIPO_TEST_HOOK_TOKEN = "s3cret-token-value";
    cleanups.push(() => void delete process.env.PIPO_TEST_HOOK_TOKEN);
    const file = box.write(
      "h.pipo",
      `pipo: 1
name: hookout
secrets: { tok: env:PIPO_TEST_HOOK_TOKEN }
input: { via: http }
output:
  from: input
  to: http
  with:
    url: ${s.url}
    headers: { Authorization: "Bearer \${secrets.tok}" }
  on_error: { retry: 3, delay: 10ms }
`,
    );
    const lines: string[] = [];
    const r = await startRunner(file, box.home, lines);
    cleanups.push(() => r.runner.stop());
    const res = await r.post("/", { x: 1 });
    const id = ((await res.json()) as any).packet_id;
    const row = await settled(r.runner, id);
    expect(row.state).toBe("delivered");
    expect(s.calls).toHaveLength(3);
    expect(s.calls.every((c) => c.headers.get("idempotency-key") === id)).toBe(true);
    expect(s.calls[2]?.headers.get("authorization")).toBe("Bearer s3cret-token-value");
    expect(lines.join("\n")).not.toContain("s3cret-token-value");
  });
});

describe("runner: http input to file output", () => {
  test("delivers jsonl with a templated path", async () => {
    const box = setup();
    const file = box.write(
      "f.pipo",
      `pipo: 1
name: tofile
input: { via: http }
output:
  from: input
  to: file
  with: { path: "./out/\${data.kind}.jsonl" }
`,
    );
    const r = await startRunner(file, box.home);
    cleanups.push(() => r.runner.stop());
    const ids: string[] = [];
    for (const kind of ["a", "b", "a"]) {
      const res = await r.post("/", { kind });
      ids.push(((await res.json()) as any).packet_id);
    }
    for (const id of ids) await settled(r.runner, id);
    const read = (k: string) =>
      readFileSync(join(box.root, `out/${k}.jsonl`), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
    expect(read("a").map((x) => x.packet_id)).toEqual([ids[0], ids[2]]);
    expect(read("b")).toHaveLength(1);
    expect(existsSync(join(box.root, "out/a.jsonl.pipo-keys"))).toBe(false);
  });
});
