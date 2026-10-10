// End-to-end runs of the pipelines in examples/ (copied into a sandbox so they write under /tmp), on the Rust runner
// binary.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeAgentBudget } from "../src";
import { copyExampleDir, rows, sandbox, waitFor } from "./helpers";
import { RustRunner } from "./rust";

setDefaultTimeout(30_000);

const EXAMPLES = join(import.meta.dir, "../../../examples");

let running: RustRunner[] = [];
let cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const r of running) if (r.proc.exitCode === null) await r.kill();
  for (const c of cleanups.reverse()) c();
  running = [];
  cleanups = [];
});

function copyExample(name: string) {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  const dir = join(box.root, name);
  copyExampleDir(join(EXAMPLES, name), dir);
  return { box, dir, file: join(dir, `${name}.pipo`) };
}

async function open(box: { root: string; home: string }, file: string, name: string, env: Record<string, string> = {}) {
  const r = await RustRunner.start(box, file, name, { env });
  running.push(r);
  return r;
}

function jsonl(path: string, n: number, what: string) {
  return waitFor(
    () => {
      try {
        const l = readFileSync(path, "utf8").trim().split("\n");
        return l.length >= n ? l.map((x) => JSON.parse(x)) : null;
      } catch {
        return null;
      }
    },
    10_000,
    what,
  );
}

describe("examples", () => {
  test("heartbeat appends a line per tick with distinct packet ids", async () => {
    const { box, dir, file } = copyExample("heartbeat");
    // Speed the 5s example up for the test; everything else is the shipped file.
    writeFileSync(file, readFileSync(file, "utf8").replace("every: 5s", "every: 100ms"));
    const r = await open(box, file, "heartbeat");
    const recs = await jsonl(join(dir, "out", "heartbeat.jsonl"), 2, "two heartbeat lines");
    expect(new Set(recs.map((x) => x.packet_id)).size).toBe(recs.length);
    expect(recs[0].data).toMatchObject({ service: "pipo-example", status: "alive" });
    expect(await r.stop()).toBe(0);
  });

  test("inbox-forward POSTs each dropped file once, with an Idempotency-Key", async () => {
    const { box, dir, file } = copyExample("inbox-forward");
    const inbox = join(dir, "inbox");
    mkdirSync(inbox, { recursive: true });
    const got: { key: string | null; body: any }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        got.push({ key: req.headers.get("idempotency-key"), body: await req.json() });
        return new Response("ok");
      },
    });
    cleanups.push(() => server.stop(true));
    const r = await open(box, file, "inbox-forward", { INBOX_URL: `http://127.0.0.1:${server.port}/ingest` });
    writeFileSync(join(inbox, "a.txt"), "alpha");
    writeFileSync(join(inbox, "b.txt"), "beta");
    await waitFor(() => got.length >= 2, 10_000, "two POSTs");
    await Bun.sleep(300);
    expect(got.length).toBe(2);
    const byFile = Object.fromEntries(got.map((g) => [g.body.file, g]));
    expect(byFile["a.txt"]?.body).toEqual({ file: "a.txt", text: "alpha" });
    expect(byFile["b.txt"]?.body).toEqual({ file: "b.txt", text: "beta" });
    expect(got.every((g) => g.key)).toBe(true);
    expect(new Set(got.map((g) => g.key)).size).toBe(2);
    expect(await r.stop()).toBe(0);
  });

  test("ticket-triage runs against its mock Claude API through the real provider, under the engine-wide cap", async () => {
    const { box, dir, file } = copyExample("ticket-triage");
    const { mockClaude } = await import(join(dir, "mock-claude.ts"));
    const requests: any[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        requests.push({ key: req.headers.get("x-api-key"), body: await req.clone().json() });
        return mockClaude(req);
      },
    });
    cleanups.push(() => server.stop(true));
    // One call costs $0.0009 (400 + 100 tokens at the built-in Haiku price): the cap allows two (D58, checked before
    // each call, so the second goes over it), well under the pipeline's own $0.50.
    mkdirSync(box.home, { recursive: true });
    writeFileSync(
      join(box.home, "config.yaml"),
      `engine:\n  timezone: UTC\n  agent_budget: { per_day: 0.0015 }\nagents:\n  claude_api:\n    base_url: http://127.0.0.1:${server.port}\n    api_key: env:PIPO_EXAMPLE_MOCK_KEY\n`,
    );
    const r = await open(box, file, "ticket-triage", { PIPO_EXAMPLE_MOCK_KEY: "unused" });
    const post = (ticket: unknown) => r.post("/tickets", ticket);
    expect((await post({ subject: "", body: "no subject" })).status).toBe(422);
    expect((await post({ subject: "Site is down", body: "Checkout fails for everyone" })).status).toBeLessThan(300);
    expect((await post({ subject: "Charged twice", body: "Two charges on my invoice" })).status).toBeLessThan(300);
    const lines = await jsonl(join(dir, "out", "triaged.jsonl"), 2, "two triaged tickets");
    expect(lines.map((l) => l.data).sort((a, b) => a.category.localeCompare(b.category))).toEqual([
      { category: "billing", priority: "normal", summary: "billing ticket: Charged twice" },
      { category: "outage", priority: "high", summary: "outage ticket: Site is down" },
    ]);
    expect(requests.map((x) => x.key)).toEqual(["unused", "unused"]);
    expect(requests[0].body.tool_choice).toEqual({ type: "tool", name: "pipo_output" });

    // The third ticket is accepted, then held: the home's spend reached engine.agent_budget.per_day.
    expect((await post({ subject: "Login loop", body: "Cannot sign in" })).status).toBeLessThan(300);
    await waitFor(async () => (await r.status()).state === "paused", 10_000, "engine budget pause");
    expect((await r.status()).paused_reason).toBe("budget");
    expect(requests).toHaveLength(2);
    expect(homeAgentBudget(box.home)).toMatchObject({
      per_day: 0.0015,
      spent_usd: 0.0018,
      pipelines: { "ticket-triage": 0.0018 },
    });
    expect(await r.stop()).toBe(0);
  });

  test("signup-intake hands each form sign-up to signup-store, which writes it once (a chain, D77)", async () => {
    const box = sandbox();
    cleanups.push(() => box.cleanup());
    for (const name of ["signup-intake", "signup-store"]) copyExampleDir(join(EXAMPLES, name), join(box.root, name));
    const store = await open(box, join(box.root, "signup-store", "signup-store.pipo"), "signup-store");
    const intake = await open(box, join(box.root, "signup-intake", "signup-intake.pipo"), "signup-intake");
    const res = await intake.post("/form", { email: " Ada@Example.com ", name: "Ada" });
    expect(res.status).toBe(202);
    const { packet_id } = (await res.json()) as { packet_id: string };
    expect((await intake.settled(packet_id, 15_000)).state).toBe("delivered");
    const db = join(box.root, "signup-store", "data", "signups.db");
    expect(rows(db, "SELECT email, name, via, from_pipeline FROM signups")).toEqual([
      { email: "ada@example.com", name: "Ada", via: "form", from_pipeline: "signup-intake" },
    ]);
    const fix = await store.request("push", { input: "manual", data: { email: "ada@example.com", name: "Ada L." } });
    expect((await store.settled(fix.packet_id)).state).toBe("delivered");
    expect(rows(db, "SELECT name, via FROM signups")).toEqual([{ name: "Ada L.", via: "manual" }]);
  });

  test("blog takes posts from a file, http and push, tags them, upserts by slug and rebuilds the site", async () => {
    const { box, dir, file } = copyExample("blog");
    const r = await open(box, file, "blog");
    const db = join(dir, "data", "blog.db");
    const site = join(dir, "out", "site");

    writeFileSync(join(dir, "posts", "hello-pipo.md"), readFileSync(join(dir, "samples", "hello-pipo.md"), "utf8"));
    expect((await r.post("/posts", { body: "no title" })).status).toBe(422);
    const res = await r.post("/posts", { title: "Rust  notes", author: "Grace", body: "Cargo and tokio.", tags: "ts" });
    expect(res.status).toBe(202);
    const api = (await res.json()) as { packet_id: string };
    expect((await r.settled(api.packet_id, 15_000)).state).toBe("delivered");
    const pushed = await r.request("push", { input: "manual", data: { title: "Later", body: "Soon.", draft: true } });
    expect((await r.settled(pushed.packet_id, 15_000)).state).toBe("delivered");
    await waitFor(() => rows(db, "SELECT 1 FROM posts").length === 3, 15_000, "three posts");
    expect(rows(db, "SELECT slug, tags, draft, source FROM posts ORDER BY slug")).toEqual([
      { slug: "hello-pipo", tags: '["how-to","meta","pipelines","sqlite"]', draft: 0, source: "files" },
      { slug: "later", tags: "[]", draft: 1, source: "manual" },
      { slug: "rust-notes", tags: '["rust","typescript"]', draft: 0, source: "api" },
    ]);

    // An edited file updates its row in place, and the site leaves drafts out.
    const edited = readFileSync(join(dir, "samples", "hello-pipo.md"), "utf8").replace("Hello, Pipo", "Hello again");
    writeFileSync(join(dir, "posts", "hello-pipo.md"), edited);
    await waitFor(() => rows(db, "SELECT title FROM posts WHERE slug = 'hello-pipo'")[0]?.title === "Hello again");
    const index = await waitFor(() => {
      const html = existsSync(join(site, "index.html")) ? readFileSync(join(site, "index.html"), "utf8") : "";
      return html.includes("Hello again") ? html : null;
    });
    expect(index).toContain("Rust notes");
    expect(index).not.toContain("Later");
    expect(readFileSync(join(site, "tags", "rust.html"), "utf8")).toContain("Rust notes");
    expect(rows(db, "SELECT 1 FROM posts")).toHaveLength(3);
    expect(await r.stop()).toBe(0);
  });
});
