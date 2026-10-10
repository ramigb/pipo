// Untrusted fn modules (docs/spec.md §11, D29): the Rust runner checks through `pipo compile`, so P052 stops the start.
import { afterAll, afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ORIGIN_FILE, sha256 } from "@pipo/spec";
import { sandbox } from "./helpers";
import { RustRunner } from "./rust";

setDefaultTimeout(30_000);

const sb = sandbox();
let running: RustRunner[] = [];
afterEach(async () => {
  for (const r of running) if (r.proc.exitCode === null) await r.kill();
  running = [];
});
afterAll(() => sb.cleanup());

test("the runner refuses an fn module from an untrusted template, and starts once it is trusted", async () => {
  const dir = join(sb.root, "proj");
  mkdirSync(dir, { recursive: true });
  const module = "export function make(d: any) { return d; }\n";
  writeFileSync(join(dir, "p.fn.ts"), module);
  const file = join(dir, "p.pipo");
  writeFileSync(
    file,
    "pipo: 1\nname: gated\nfn: ./p.fn.ts\ninput: { via: http }\nnodes:\n  x: { from: input, transform: fn.make }\noutput: { from: x, to: stdout }\n",
  );
  writeFileSync(
    join(dir, ORIGIN_FILE),
    JSON.stringify({ template: "shared", template_hash: "abc123", modules: { "p.fn.ts": sha256(module) } }),
  );
  const refused = await RustRunner.refuse(sb, file, { args: ["--listen", "0"] });
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("P052");

  mkdirSync(sb.home, { recursive: true });
  writeFileSync(
    join(sb.home, "trust.json"),
    JSON.stringify({ version: 1, templates: { abc123: { template: "shared", trusted_at: "now" } } }),
  );
  const r = await RustRunner.start(sb, file, "gated");
  running.push(r);
  const res = await r.post("/", { a: 1 });
  expect(res.status).toBe(202);
  const { packet_id } = (await res.json()) as { packet_id: string };
  expect((await r.settled(packet_id)).data).toEqual({ a: 1 });
  expect(await r.stop()).toBe(0);
});
