// Built-in metrics on the control `status` op (docs/spec.md §7.6, D54): per-node latency over the latest completed
// steps, read from the journal, and the age of the oldest pending packet. Plus: caller text never reaches the
// journal with a secret in it, and a start and a live apply check trust in the runner's own home. Percentiles, the
// latency window, oldest-pending ages and the journal migration that adds `events.ms` are unit-tested in
// crates/pipo-runner (stats.rs, journal.rs).
import { Database } from "bun:sqlite";
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ORIGIN_FILE, sha256 } from "@pipo/spec";
import { post, suite } from "./core";
import { waitFor } from "./helpers";
import { RustRunner } from "./rust";

setDefaultTimeout(30_000);
const { box: b, start, startFile } = suite();
const LATENCY_WINDOW = 100;

const PIPE = `pipo: 1
name: met
fn: ./fns.ts
input: { via: http }
nodes:
  keep: { from: input, filter: "data.n != 2" }
  slow: { from: keep, transform: fn.slow }
output:
  from: slow
  to: file
  with: { path: ./met.jsonl, format: jsonl, mode: append }
`;

test("status reports latency per node from real steps and the oldest pending packet; latency survives a restart", async () => {
  b.write("fns.ts", "export const slow = async (d) => { await new Promise((r) => setTimeout(r, 60)); return d; };");
  const file = b.write("met.pipo", PIPE);
  const r = await startFile(file, "met");
  for (const n of [1, 2, 3]) await r.settled(await post(r, { n }));
  let s = (await r.status()).stats;
  // `keep` completed 3 steps (one filtered); `slow` and the output 2 each.
  expect(s.latency.keep.count).toBe(3);
  expect(s.latency.slow.count).toBe(2);
  expect(s.latency.slow.p50_ms).toBeGreaterThanOrEqual(50);
  expect(s.latency.slow.max_ms).toBeLessThan(5000);
  expect(s.latency.slow.p95_ms).toBeGreaterThanOrEqual(s.latency.slow.p50_ms);
  expect(s.latency.output.count).toBe(2);
  expect(s.latency.output.max_ms).toBeLessThan(5000);
  expect(s.latency_window).toBe(LATENCY_WINDOW);
  expect(s.oldest_pending_age_ms).toBeNull();
  expect(s.oldest_pending_received_at).toBeNull();

  // Paused, a pushed packet stays pending and ages.
  await r.request("pause");
  const pushed = await r.push({ n: 9 });
  const row = r.packet(pushed.packet_id);
  expect(row?.state).toBe("accepted");
  s = (await r.status()).stats;
  expect(s.oldest_pending_received_at).toBe(new Date(row?.received_at as number).toISOString());
  expect(s.oldest_pending_age_ms).toBeGreaterThanOrEqual(0);
  await Bun.sleep(30);
  const later = (await r.status()).stats;
  expect(later.oldest_pending_age_ms).toBeGreaterThan(s.oldest_pending_age_ms);

  expect(await r.stop()).toBe(0);
  const again = await startFile(file, "met");
  s = (await again.status()).stats;
  expect(s.latency.slow.count).toBeGreaterThanOrEqual(2);
  expect(s.latency.keep.count).toBeGreaterThanOrEqual(3);
  await again.settled(pushed.packet_id);
  await waitFor(async () => (await again.status()).stats.oldest_pending_age_ms === null, 5000, "none pending");
  expect((await again.status()).stats.latency.slow.count).toBe(3);
});

// ── caller text is redacted before it is journaled ───────────────────────

const SECRET = "s3cr3t-value-zz9";

function allJournalText(home: string, name: string): string {
  const db = new Database(join(home, "pipelines", name, "journal.db"), { readonly: true });
  try {
    const tables = ["events", "proposals", "versions"];
    return tables.map((t) => JSON.stringify(db.query(`SELECT * FROM ${t}`).all())).join("\n");
  } finally {
    db.close();
  }
}

test("a secret in resolve's by and reason, a proposal's author, by and reason, an apply's author never reaches the journal", async () => {
  b.write("boom.ts", "export const boom = () => { throw new Error('nope'); };");
  const source = (extra = "") =>
    `pipo: 1\nname: red\nfn: ./boom.ts\nsecrets: { token: "env:PIPO_TEST_R36" }\ninput: { via: http }\nagent: { control: true }\nnodes:\n  boom: { from: input, transform: fn.boom, on_error: { retry: 0, then: agent } }\noutput:\n  from: boom\n  to: http\n  with: { url: "http://127.0.0.1:9/x", headers: { authorization: "\${secrets.token}" } }\n${extra}`;
  const r = await start("red", source(), { env: { PIPO_TEST_R36: SECRET } });
  const id = await post(r, { a: 1 });
  await waitFor(() => r.packet(id)?.state === "escalated", 5000, "escalated");
  await r.request("resolve", {
    ids: [id],
    action: "drop",
    by: `ops ${SECRET}`,
    by_kind: "human",
    reason: `token is ${SECRET}`,
  });
  const p = await r.request("propose", {
    source: source("# v2\n"),
    base_version: 1,
    author: `bot ${SECRET}`,
    author_kind: "human",
    reason: `because ${SECRET}`,
    apply: false,
  });
  expect(p.author).not.toContain(SECRET);
  await r.request("apply_proposal", { id: p.id, by: `approver ${SECRET}` });
  const q = await r.request("propose", {
    source: source("# v3\n"),
    base_version: 2,
    author: "bot",
    author_kind: "human",
    reason: "r",
    apply: false,
  });
  await r.request("reject_proposal", { id: q.id, by: `critic ${SECRET}`, reason: `no ${SECRET}` });
  await r.request("apply", { source: source("# v4\n"), by: `cli ${SECRET}`, reason: `again ${SECRET}` });
  const text = allJournalText(b.home, "red");
  expect(text).toContain("packet.resolved");
  expect(text).toContain("proposal.applied");
  expect(text).toContain("proposal.rejected");
  expect(text).toContain("version.applied");
  expect(text).toContain("***");
  expect(text).not.toContain(SECRET);
  expect(r.lines().join("\n")).not.toContain(SECRET);
});

// ── check() reads trust.json from the runner's home ───────────────────────

test("a start and a live apply check fn trust in the runner's home, not $PIPO_HOME", async () => {
  const dir = join(b.root, "proj");
  mkdirSync(dir, { recursive: true });
  const module = "export function make(d: any) { return d; }\n";
  writeFileSync(join(dir, "p.fn.ts"), module);
  const src = (extra = "") =>
    `pipo: 1\nname: homed\nfn: ./p.fn.ts\ninput: { via: http }\nnodes:\n  x: { from: input, transform: fn.make }\noutput: { from: x, to: stdout }\n${extra}`;
  writeFileSync(join(dir, "p.pipo"), src());
  writeFileSync(
    join(dir, ORIGIN_FILE),
    JSON.stringify({ template: "shared", template_hash: "abc123", modules: { "p.fn.ts": sha256(module) } }),
  );
  mkdirSync(b.home, { recursive: true });
  writeFileSync(
    join(b.home, "trust.json"),
    JSON.stringify({ version: 1, templates: { abc123: { template: "shared", trusted_at: "now" } } }),
  );
  // The other way round, the start is refused: the trusting home is only $PIPO_HOME.
  const elsewhere = join(b.root, "elsewhere");
  const refused = await RustRunner.refuse({ root: b.root, home: elsewhere }, join(dir, "p.pipo"), {
    env: { PIPO_HOME: b.home },
  });
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("P052");
  // $PIPO_HOME points at a home that trusts nothing: only the runner's own home (--home) may decide.
  const r = await startFile(join(dir, "p.pipo"), "homed", { env: { PIPO_HOME: elsewhere } });
  const applied = await r.request("apply", { source: src("# v2\n"), by: "t", reason: "r39" });
  expect(applied.changed).toBe(true);
  expect((await r.settled(await post(r, { ok: 1 }))).state).toBe("delivered");
});
