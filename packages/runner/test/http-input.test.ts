// http input extras (docs/spec.md §3.3): csv and bytes bodies, HMAC auth, respond: delivered.
import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { load } from "@pipo/spec";
import { deliveredTimeout, HttpInput } from "../src/connectors/http-input";
import { gaps } from "../src/support";
import { rows, sandbox, startRunner, waitFor } from "./helpers";

process.env.PIPO_TEST_SIG = "shh-test";
let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const FNS = `export const slow = async (d) => { await Bun.sleep(d.sleep ?? 0); return d; };
export const boom = () => { throw new Error("boom"); };
`;

async function start(inputExtra: string, withBlock = "", node = "") {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  box.write("fns.ts", FNS);
  const file = box.write(
    "p.pipo",
    `pipo: 1
name: hin
fn: ./fns.ts
secrets: { sig: env:PIPO_TEST_SIG }
input:
  via: http
${inputExtra}
${node || "nodes: {}"}
output:
  from: ${node ? "n" : "input"}
  to: file
  with: { path: ./out.jsonl, format: jsonl }
${withBlock}`,
  );
  const r = await startRunner(file, box.home);
  cleanups.push(() => (r.runner.state === "stopped" ? undefined : r.runner.stop()));
  const count = () => rows(join(box.home, "pipelines", "hin", "journal.db"), "SELECT id FROM packets").length;
  return { ...r, box, count };
}

describe("csv", () => {
  const fmt = "  format: csv";
  test("each record becomes a packet", async () => {
    const t = await start(fmt);
    const res = await fetch(t.url(""), { method: "POST", body: 'name,note\nAda,hi\nBob,"a, ""b"""\r\nCy,\n' });
    expect(res.status).toBe(202);
    const { packets } = (await res.json()) as { packets: { packet_id: string }[] };
    expect(packets).toHaveLength(3);
    await waitFor(() => packets.every((p) => t.runner.journal.get(p.packet_id)?.state === "delivered"));
    expect(packets.map((p) => t.runner.journal.get(p.packet_id)?.data as unknown)).toEqual([
      { name: "Ada", note: "hi" },
      { name: "Bob", note: 'a, "b"' },
      { name: "Cy", note: "" },
    ]);
  });

  test("malformed csv is a 400 with a hint and creates no packet", async () => {
    const t = await start(fmt);
    for (const body of ["a,b\n1,2,3\n", "a,b\n", 'a,b\n"1,2\n', ""]) {
      const res = await fetch(t.url(""), { method: "POST", body });
      expect(res.status).toBe(400);
      const j = (await res.json()) as { error: string; hint: string };
      expect(j.error).toBeTruthy();
      expect(j.hint).toBeTruthy();
    }
    expect(t.count()).toBe(0);
  });
});

describe("bytes", () => {
  test("body is carried as base64 with its content type", async () => {
    const t = await start("  format: bytes");
    const bin = new Uint8Array([0, 1, 2, 250, 255]);
    const res = await fetch(t.url(""), { method: "POST", body: bin, headers: { "content-type": "image/png" } });
    const { packet_id } = (await res.json()) as { packet_id: string };
    await waitFor(() => t.runner.journal.get(packet_id)?.state === "delivered");
    const data = t.runner.journal.get(packet_id)?.data as unknown as {
      base64: string;
      content_type: string;
      size: number;
    };
    expect(data).toEqual({ base64: Buffer.from(bin).toString("base64"), content_type: "image/png", size: 5 });
    expect([...Buffer.from(data.base64, "base64")]).toEqual([...bin]);
  });
});

describe("hmac", () => {
  const hmac = '  with: { auth: { hmac: { header: X-Signature, secret: "${secrets.sig}" } } }';
  const sign = (body: string) => createHmac("sha256", "shh-test").update(body).digest("hex");

  test("valid signature is accepted, bad or missing is 401 with no packet", async () => {
    const t = await start(hmac);
    const body = JSON.stringify({ a: 1 });
    const ok = await fetch(t.url(""), { method: "POST", body, headers: { "X-Signature": `sha256=${sign(body)}` } });
    expect(ok.status).toBe(202);
    const plain = await fetch(t.url(""), { method: "POST", body, headers: { "X-Signature": sign(body) } });
    expect(plain.status).toBe(202);
    expect(t.count()).toBe(2);

    const bad = await fetch(t.url(""), { method: "POST", body, headers: { "X-Signature": sign("other") } });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { hint: string }).hint).toContain("X-Signature");
    expect((await fetch(t.url(""), { method: "POST", body })).status).toBe(401);
    expect((await fetch(t.url(""), { method: "POST", body, headers: { "X-Signature": "zz" } })).status).toBe(401);
    expect(t.count()).toBe(2);
    expect(t.lines.join("\n")).not.toContain("shh-test");
  });
});

describe("respond: delivered", () => {
  const node = `nodes:\n  n:\n    from: input\n    transform: fn.slow`;
  const withTimeout = (t: string) => `  with: { respond: delivered, timeout: ${t} }`;

  test("returns the final state after delivery", async () => {
    const t = await start(withTimeout("5s"), "", node);
    const res = await t.post("", { sleep: 100 });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { packet_id: string; state: string };
    expect(j.state).toBe("delivered");
    expect(t.runner.journal.get(j.packet_id)?.state).toBe("delivered");
  });

  test("a packet that dead-letters answers 502 with the error", async () => {
    const t = await start(withTimeout("5s"), "", `nodes:\n  n:\n    from: input\n    transform: fn.boom`);
    const res = await t.post("", {});
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ state: "dead_lettered", error: expect.stringContaining("boom") });
  });

  test("a slow packet answers 202 with its id when the timeout expires", async () => {
    const t = await start(withTimeout("100ms"), "", node);
    const started = Date.now();
    const res = await t.post("", { sleep: 800 });
    expect(Date.now() - started).toBeLessThan(700);
    expect(res.status).toBe(202);
    const j = (await res.json()) as { packet_id: string; state: string };
    expect(j.state).toBe("accepted");
    await waitFor(() => t.runner.journal.get(j.packet_id)?.state === "delivered");
  });
});

describe("gaps", () => {
  test("hmac, respond, csv and bytes are no longer refused", () => {
    const src = `pipo: 1
name: g
secrets: { s: env:X }
input:
  via: http
  format: csv
  with: { respond: delivered, auth: { hmac: { header: H, secret: "\${secrets.s}" } } }
output: { from: input, to: stdout }
`;
    const p = load(src, "g.pipo").value as any;
    expect(gaps(p).filter((g) => g.level === "refuse")).toEqual([]);
    p.input.format = "bytes";
    expect(gaps(p).filter((g) => g.level === "refuse")).toEqual([]);
  });
});

describe("respond: delivered and the idle timeout (D30)", () => {
  test("the connection timeout covers the wait plus 10 s, and is lifted past Bun's 255 s limit", () => {
    expect(deliveredTimeout(30_000)).toBe(40);
    expect(deliveredTimeout(1)).toBe(11);
    expect(deliveredTimeout(245_000)).toBe(255);
    expect(deliveredTimeout(245_001)).toBe(0);
  });

  test("a wait longer than the server's idle timeout still gets its answer", async () => {
    // A request without a body (a GET hook): Bun 1.3 applies its idle timeout to those while the handler waits.
    const input = new HttpInput({
      pipeline: "idle",
      path: "/",
      method: "GET",
      port: 0,
      hostname: "127.0.0.1",
      format: "text",
      respond: "delivered",
      timeout: "10s",
      // Idle connections are cut after 1 s here (Bun checks every 4 s, so about 4 s in); the wait below takes 6 s.
      idleTimeout: 1,
    });
    input.awaitTerminal = async () => {
      await Bun.sleep(6000);
      return { state: "delivered" };
    };
    await input.start(async () => ({ status: "accepted", packet_id: "p_1" }));
    cleanups.push(() => input.stop());
    const res = await fetch(`http://127.0.0.1:${input.port}/in/idle`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ packet_id: "p_1", state: "delivered" });
  }, 15_000);
});
