// Delivery checks (docs/spec.md §3.10), tested on the adapters directly.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileOutput } from "../src/connectors/file-output";
import { HttpOutput } from "../src/connectors/http-output";
import { SqliteOutput } from "../src/connectors/sqlite-output";
import { StdoutOutput } from "../src/connectors/stdout-output";
import type { WriteItem } from "../src/connectors/types";
import { sandbox, settled, startRunner } from "./helpers";

const boxes: ReturnType<typeof sandbox>[] = [];
const box = () => {
  const b = sandbox();
  boxes.push(b);
  return b;
};
afterEach(() => {
  for (const b of boxes.splice(0)) b.cleanup();
});

const item = (w: Record<string, unknown>, data: unknown = { name: "Ada" }, packetId = "p1"): WriteItem => ({
  packetId,
  data,
  with: w,
});

describe("sqlite", () => {
  async function setup() {
    const b = box();
    const out = new SqliteOutput(b.root);
    const it = item({ path: "o.db", table: "people", create: true, key: "id", columns: { id: "p1", name: "Ada" } });
    await out.write([it]);
    return { out, it };
  }

  test("record_exists", async () => {
    const { out, it } = await setup();
    expect(await out.verify("record_exists", { where: { id: "p1" } }, it, null)).toBe(true);
    expect(await out.verify("record_exists", { where: { id: "nope" } }, it, null)).toBe(false);
    out.close();
  });

  test("row_count", async () => {
    const { out, it } = await setup();
    const w = { query: "SELECT * FROM people WHERE name = ?", params: ["Ada"] };
    expect(await out.verify("row_count", w, it, null)).toBe(true);
    expect(await out.verify("row_count", { ...w, min: 2 }, it, null)).toBe(false);
    expect(
      await out.verify("row_count", { query: "SELECT * FROM people WHERE name = ?", params: ["x"] }, it, null),
    ).toBe(false);
    out.close();
  });

  test("query", async () => {
    const { out, it } = await setup();
    expect(await out.verify("query", { sql: "SELECT count(*) = 1 FROM people" }, it, null)).toBe(true);
    expect(await out.verify("query", { sql: "SELECT count(*) > 5 FROM people" }, it, null)).toBe(false);
    expect(await out.verify("query", { sql: "SELECT 1 FROM people WHERE id = ?", params: ["zz"] }, it, null)).toBe(
      false,
    );
    out.close();
  });

  test("query is read-only and bad SQL throws", async () => {
    const { out, it } = await setup();
    await expect(out.verify("query", { sql: "DELETE FROM people" }, it, null)).rejects.toThrow();
    expect(await out.verify("record_exists", { where: { id: "p1" } }, it, null)).toBe(true);
    await expect(out.verify("query", { sql: "SELEC nonsense" }, it, null)).rejects.toThrow();
    await expect(out.verify("query", { sql: "" }, it, null)).rejects.toThrow("empty");
    out.close();
  });
});

describe("file", () => {
  test("file_exists, file_nonempty, line_contains, checksum", async () => {
    const b = box();
    const out = new FileOutput(b.root);
    const it = item({ path: "out/a.txt" });
    const none = (c: string, w: Record<string, unknown> = {}) => out.verify(c, w, it, null);

    expect(await none("file_exists")).toBe(false);
    expect(await none("file_nonempty")).toBe(false);
    expect(await none("line_contains", { value: "x" })).toBe(false);
    expect(await none("checksum", { sha256: "0".repeat(64) })).toBe(false);

    await out.write([item({ path: "out/a.txt", format: "text" }, "hello world")]);
    expect(await none("file_exists")).toBe(true);
    expect(await none("file_nonempty")).toBe(true);
    expect(await none("line_contains", { value: "hello" })).toBe(true);
    expect(await none("line_contains", { value: "absent" })).toBe(false);
    const sha = createHash("sha256").update("hello world\n").digest("hex");
    expect(await none("checksum", { sha256: sha.toUpperCase() })).toBe(true);
    expect(await none("checksum", { sha256: "0".repeat(64) })).toBe(false);
    expect(await none("file_exists", { path: "out/other.txt" })).toBe(false);

    writeFileSync(join(b.root, "out/empty.txt"), "");
    expect(await none("file_exists", { path: "out/empty.txt" })).toBe(true);
    expect(await none("file_nonempty", { path: "out/empty.txt" })).toBe(false);
  });

  test("real errors throw", async () => {
    const b = box();
    const out = new FileOutput(b.root);
    writeFileSync(join(b.root, "f"), "x");
    const it = item({ path: "f" });
    await expect(out.verify("checksum", { sha256: "abc" }, it, null)).rejects.toThrow("64 hex");
    await expect(out.verify("file_exists", { path: "" }, item({}), null)).rejects.toThrow("path");
    await expect(out.verify("record_exists", {}, it, null)).rejects.toThrow("does not support");
  });
});

describe("http", () => {
  async function serve<T>(fn: (url: string) => Promise<T>): Promise<T> {
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/ok")
          return new Response('{"state":"done","id":7}', { headers: { "content-type": "application/json" } });
        if (p === "/text") return new Response("all good");
        return new Response("nope", { status: 404 });
      },
    });
    try {
      return await fn(`http://127.0.0.1:${srv.port}`);
    } finally {
      srv.stop(true);
    }
  }
  const out = new HttpOutput();
  const it = item({});

  test("status", async () => {
    expect(await out.verify("status", { success: [201, "2xx"] }, it, { status: 201 })).toBe(true);
    expect(await out.verify("status", { success: [204] }, it, { status: 200 })).toBe(false);
    expect(await out.verify("status", {}, it, { status: 200 })).toBe(true);
    await expect(out.verify("status", {}, it, null)).rejects.toThrow("status");
  });

  test("follow_up", async () => {
    await serve(async (base) => {
      expect(await out.verify("follow_up", { url: `${base}/ok` }, it, null)).toBe(true);
      expect(await out.verify("follow_up", { url: `${base}/missing` }, it, null)).toBe(false);
      expect(await out.verify("follow_up", { url: `${base}/text`, match: "good" }, it, null)).toBe(true);
      expect(await out.verify("follow_up", { url: `${base}/text`, match: "bad" }, it, null)).toBe(false);
      expect(await out.verify("follow_up", { url: `${base}/ok`, match: { state: "done" } }, it, null)).toBe(true);
      expect(await out.verify("follow_up", { url: `${base}/ok`, match: { state: "pending" } }, it, null)).toBe(false);
      expect(await out.verify("follow_up", { url: `${base}/missing`, match: "nope" }, it, null)).toBe(false);
    });
  });

  test("follow_up errors throw", async () => {
    await expect(out.verify("follow_up", { url: "" }, it, null)).rejects.toThrow("url");
    await expect(out.verify("follow_up", { url: "http://127.0.0.1:1/x" }, it, null)).rejects.toThrow("reachable");
    await expect(out.verify("query", {}, it, null)).rejects.toThrow("does not support");
  });
});

describe("stdout", () => {
  test("supports no connector-specific checks", async () => {
    await expect(new StdoutOutput(() => {}).verify("file_exists")).rejects.toThrow("does not support");
  });
});

describe("through a Runner", () => {
  const stops: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const s of stops.splice(0).reverse()) await s();
  });
  async function start(b: ReturnType<typeof sandbox>, src: string) {
    const r = await startRunner(b.write("p.pipo", src), b.home);
    stops.push(() => (r.runner.state === "stopped" ? undefined : r.runner.stop()));
    return r;
  }
  const head = (name: string) => `pipo: 1\nname: ${name}\ninput: { via: http }\n`;

  test("sqlite row_count delivers", async () => {
    const b = box();
    const { runner, post } = await start(
      b,
      `${head("rc")}output:
  from: input
  to: sqlite
  with: { path: ./o.db, table: t, create: true, key: id, columns: { id: "\${meta.packet_id}", n: "\${data.n}" } }
delivered:
  check: row_count
  with: { query: "SELECT 1 FROM t WHERE id = ?", params: ["\${meta.packet_id}"] }
  within: 2s
`,
    );
    const { packet_id } = (await (await post("/", { n: 1 })).json()) as { packet_id: string };
    expect((await settled(runner, packet_id)).state).toBe("delivered");
  });

  test("file line_contains that fails applies on_fail", async () => {
    const b = box();
    const { runner, post } = await start(
      b,
      `${head("lc")}output: { from: input, to: file, with: { path: ./o.jsonl } }
delivered:
  check: line_contains
  with: { value: "never-written" }
  within: 500ms
  on_fail: { then: dead_letter }
`,
    );
    const { packet_id } = (await (await post("/", { n: 1 })).json()) as { packet_id: string };
    expect((await settled(runner, packet_id)).state).toBe("dead_lettered");
    const ev = runner.journal.events(packet_id);
    expect(JSON.stringify(ev)).toContain("delivery.unverified");
  });

  test("http status check", async () => {
    const b = box();
    const srv = Bun.serve({ port: 0, fetch: () => new Response("ok", { status: 201 }) });
    stops.push(() => srv.stop(true));
    const src = (
      success: string,
    ) => `${head("st")}output: { from: input, to: http, with: { url: "http://127.0.0.1:${srv.port}/x", success: ["2xx"] } }
delivered:
  check: status
  with: { success: [${success}] }
  within: 500ms
  on_fail: { then: dead_letter }
`;
    const good = await start(b, src("201"));
    const id = ((await (await good.post("/", { n: 1 })).json()) as { packet_id: string }).packet_id;
    expect((await settled(good.runner, id)).state).toBe("delivered");
    await good.runner.stop();

    const b2 = box();
    const bad = await start(b2, src("200"));
    const id2 = ((await (await bad.post("/", { n: 1 })).json()) as { packet_id: string }).packet_id;
    expect((await settled(bad.runner, id2)).state).toBe("dead_lettered");
  });
});
