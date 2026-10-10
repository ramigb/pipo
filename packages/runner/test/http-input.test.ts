// http input extras (docs/spec.md §3.3): csv and bytes bodies, HMAC auth, respond: delivered, end to end against the
// Rust runner binary. Body parsing, auth and the long-wait idle timeout (D30) are unit-tested in
// crates/pipo-runner/src/connectors/http_input.rs.
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, waitFor } from "./helpers";
import { RustRunner } from "./rust";

setDefaultTimeout(30_000);

const box = sandbox();
let running: RustRunner[] = [];
afterEach(async () => {
  for (const r of running) if (r.proc.exitCode === null) await r.kill();
  running = [];
});
afterAll(() => box.cleanup());

const FNS = `export const slow = async (d) => { await new Promise((r) => setTimeout(r, d.sleep ?? 0)); return d; };
export const boom = () => { throw new Error("boom"); };
`;
box.write("fns.ts", FNS);

let n = 0;
async function start(inputExtra: string, node = "") {
  const name = `hin${++n}`;
  const file = box.write(
    `${name}.pipo`,
    `pipo: 1
name: ${name}
fn: ./fns.ts
secrets: { sig: env:PIPO_TEST_SIG }
input:
  via: http
${inputExtra}
${node || "nodes: {}"}
output:
  from: ${node ? "n" : "input"}
  to: file
  with: { path: ./${name}.jsonl, format: jsonl }
`,
  );
  const r = await RustRunner.start(box, file, name, { env: { PIPO_TEST_SIG: "shh-test" } });
  running.push(r);
  const count = () => r.query("SELECT id FROM packets").length;
  const delivered = (id: string) => r.packet(id)?.state === "delivered";
  return { r, count, delivered };
}

describe("csv", () => {
  const fmt = "  format: csv";
  test("each record becomes a packet", async () => {
    const { r, delivered } = await start(fmt);
    const res = await fetch(r.url(""), { method: "POST", body: 'name,note\nAda,hi\nBob,"a, ""b"""\r\nCy,\n' });
    expect(res.status).toBe(202);
    const { packets } = (await res.json()) as { packets: { packet_id: string }[] };
    expect(packets).toHaveLength(3);
    await waitFor(() => packets.every((p) => delivered(p.packet_id)), 5000, "three delivered");
    expect(packets.map((p) => r.packet(p.packet_id)?.data as unknown)).toEqual([
      { name: "Ada", note: "hi" },
      { name: "Bob", note: 'a, "b"' },
      { name: "Cy", note: "" },
    ]);
  });

  test("malformed csv is a 400 with a hint and creates no packet", async () => {
    const { r, count } = await start(fmt);
    for (const body of ["a,b\n1,2,3\n", "a,b\n", 'a,b\n"1,2\n', ""]) {
      const res = await fetch(r.url(""), { method: "POST", body });
      expect(res.status).toBe(400);
      const j = (await res.json()) as { error: string; hint: string };
      expect(j.error).toBeTruthy();
      expect(j.hint).toBeTruthy();
    }
    expect(count()).toBe(0);
  });
});

describe("bytes", () => {
  test("body is carried as base64 with its content type", async () => {
    const { r, delivered } = await start("  format: bytes");
    const bin = new Uint8Array([0, 1, 2, 250, 255]);
    const res = await fetch(r.url(""), { method: "POST", body: bin, headers: { "content-type": "image/png" } });
    const { packet_id } = (await res.json()) as { packet_id: string };
    await waitFor(() => delivered(packet_id), 5000, "delivered");
    const data = r.packet(packet_id)?.data as unknown as { base64: string; content_type: string; size: number };
    expect(data).toEqual({ base64: Buffer.from(bin).toString("base64"), content_type: "image/png", size: 5 });
    expect([...Buffer.from(data.base64, "base64")]).toEqual([...bin]);
  });
});

describe("hmac", () => {
  const hmac = '  with: { auth: { hmac: { header: X-Signature, secret: "${secrets.sig}" } } }';
  const sign = (body: string) => createHmac("sha256", "shh-test").update(body).digest("hex");

  test("valid signature is accepted, bad or missing is 401 with no packet", async () => {
    const { r, count } = await start(hmac);
    const url = r.url("");
    const body = JSON.stringify({ a: 1 });
    const ok = await fetch(url, { method: "POST", body, headers: { "X-Signature": `sha256=${sign(body)}` } });
    expect(ok.status).toBe(202);
    const plain = await fetch(url, { method: "POST", body, headers: { "X-Signature": sign(body) } });
    expect(plain.status).toBe(202);
    expect(count()).toBe(2);

    const bad = await fetch(url, { method: "POST", body, headers: { "X-Signature": sign("other") } });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { hint: string }).hint).toContain("X-Signature");
    expect((await fetch(url, { method: "POST", body })).status).toBe(401);
    expect((await fetch(url, { method: "POST", body, headers: { "X-Signature": "zz" } })).status).toBe(401);
    expect(count()).toBe(2);
    expect(r.lines().join("\n") + r.stderr()).not.toContain("shh-test");
  });
});

describe("respond: delivered", () => {
  const node = "nodes:\n  n:\n    from: input\n    transform: fn.slow";
  const withTimeout = (t: string) => `  with: { respond: delivered, timeout: ${t} }`;

  test("returns the final state after delivery, once the output is written", async () => {
    const { r } = await start(withTimeout("5s"), node);
    const started = Date.now();
    const res = await r.post("", { sleep: 300 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { packet_id: string; state: string };
    expect(j.state).toBe("delivered");
    expect(r.packet(j.packet_id)?.state).toBe("delivered");
    const lines = readFileSync(join(box.root, `${r.name}.jsonl`), "utf8")
      .trim()
      .split("\n");
    expect(lines.map((l) => JSON.parse(l).packet_id)).toEqual([j.packet_id]);
  });

  test("a packet that dead-letters answers 502 with the error", async () => {
    const { r } = await start(withTimeout("5s"), "nodes:\n  n:\n    from: input\n    transform: fn.boom");
    const res = await r.post("", {});
    expect(res.status).toBe(502);
    const j = (await res.json()) as { packet_id: string };
    expect(j).toMatchObject({ state: "dead_lettered", error: expect.stringContaining("boom") });
    expect(r.packet(j.packet_id)?.state).toBe("dead_lettered");
  });

  test("a slow packet answers 202 with its id when the timeout expires", async () => {
    const { r, delivered } = await start(withTimeout("100ms"), node);
    const started = Date.now();
    const res = await r.post("", { sleep: 800 });
    expect(Date.now() - started).toBeLessThan(700);
    expect(res.status).toBe(202);
    const j = (await res.json()) as { packet_id: string; state: string };
    expect(j.state).toBe("accepted");
    await waitFor(() => delivered(j.packet_id), 5000, "delivered");
  });
});
