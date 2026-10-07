// Agent budgets across SIGKILL (docs/spec.md §3.11, §7.3, D32, D37), with real runner processes found through their
// registry entry and logging to files. The runner entry here is a small wrapper around runForeground that injects a
// mock provider (no network) and a clock skewed towards the next UTC midnight, so a budget day ends in seconds.
// - a `budget` pause survives a crash: the next run comes back paused with the same resume time and the day's spend,
//   holds every packet, resumes by itself when the day ends and delivers each packet exactly once;
// - a crash during a call: the call is made again on restart, the packet is delivered once, and only calls that
//   reported usage are counted.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient } from "../src";
import { holds, sandbox, waitFor } from "./helpers";

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
const clients: ControlClient[] = [];
afterAll(() => {
  for (const c of clients) c.close();
  for (const p of spawned) p.kill("SIGKILL");
  box.cleanup();
});

const CALLS = join(box.root, "calls.log");
const SLOW = join(box.root, "slow.marker");
const FOREGROUND = join(import.meta.dir, "../src/foreground.ts");
const ENTRY = box.write(
  "entry.ts",
  `import { appendFileSync, existsSync } from "node:fs";
import { runForeground } from ${JSON.stringify(FOREGROUND)};
const [file, home, skew] = process.argv.slice(2);
const clock = {
  now: () => Date.now() + Number(skew),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};
const provider = {
  complete: async (req) => {
    appendFileSync(${JSON.stringify(CALLS)}, "start\\n");
    if (existsSync(${JSON.stringify(SLOW)})) await Bun.sleep(60_000);
    appendFileSync(${JSON.stringify(CALLS)}, "done\\n");
    return { output: { label: "ok" }, input_tokens: 1000, output_tokens: 500 };
  },
};
process.exit(
  await runForeground({
    file,
    home,
    clock,
    agents: { providers: { claude_api: provider }, pricing: { claude_api: { "mock-model": { input: 100, output: 100 } } }, timezone: "UTC" },
  }),
);
`,
);
box.write(
  "label.schema.json",
  JSON.stringify({ type: "object", properties: { label: { type: "string" } }, required: ["label"] }),
);

const pipeline = (name: string, perDay: number) => `pipo: 1
name: ${name}
agent_budget: { per_day: ${perDay}, per_packet: 100000 }
input: { via: push }
nodes:
  classify:
    from: input
    agent: claude_api
    with: { model: mock-model, prompt: "\${json(data)}", schema: ./label.schema.json }
output:
  from: classify
  to: file
  with: { path: ./${name}.jsonl, format: jsonl }
`;

/** Start the wrapper and find it through its registry entry; a process stuck loading modules (WSL) is retried. */
async function start(name: string, n: number, skew: number) {
  const registry = join(box.home, "run", `${name}.json`);
  const journal = join(box.home, "pipelines", name, "journal.db");
  for (let tries = 1; ; tries++) {
    const log = join(box.root, `${name}-${n}.${tries}.log`);
    const proc = Bun.spawn(["bun", ENTRY, join(box.root, `${name}.pipo`), box.home, String(skew)], {
      stdout: Bun.file(log),
      stderr: Bun.file(`${log}.err`),
    });
    spawned.push(proc);
    try {
      await waitFor(
        () => {
          if (proc.exitCode !== null)
            throw new Error(`runner exited (${proc.exitCode}):\n${readFileSync(`${log}.err`, "utf8")}`);
          return existsSync(registry) && JSON.parse(readFileSync(registry, "utf8")).pid === proc.pid;
        },
        15_000,
        `${name} runner ${n}`,
      );
      const client = await ControlClient.forPipeline(box.home, name);
      clients.push(client);
      return { proc, client };
    } catch (e) {
      proc.kill("SIGKILL");
      await proc.exited;
      if (proc.exitCode !== null && !String(e).includes("timed out")) throw e;
      if (holds(proc.pid, journal) || tries === 3) throw e;
    }
  }
}

async function kill(r: { proc: ReturnType<typeof Bun.spawn>; client: ControlClient }) {
  r.client.close();
  r.proc.kill("SIGKILL");
  await r.proc.exited;
}

function query(name: string, sql: string, ...params: any[]): any[] {
  const path = join(box.home, "pipelines", name, "journal.db");
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    return db.query(sql).all(...params);
  } finally {
    db.close();
  }
}

const delivered = (name: string) => {
  const path = join(box.root, `${name}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).packet_id as string);
};
const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, "utf8").trim().split("\n").filter(Boolean) : []);

test("a budget pause survives SIGKILL, keeps the day's spend and resumes by itself when the day ends", async () => {
  const name = "budget-crash";
  box.write(`${name}.pipo`, pipeline(name, 0.3));
  rmSync(CALLS, { force: true });
  const now = Date.now();
  const midnight = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate() + 1,
  );

  // 1. A minute before midnight (runner clock): two calls spend $0.30, the third packet pauses the pipeline.
  const first = await start(name, 1, midnight - 60_000 - Date.now());
  const ids: string[] = [];
  for (let n = 1; n <= 3; n++) ids.push((await first.client.request("push", { data: { n } })).packet_id);
  await waitFor(async () => (await first.client.request("status")).paused_reason === "budget", 10_000, "budget pause");
  const status = await first.client.request("status");
  expect(status.budget_resumes_at).toBe(new Date(midnight).toISOString());
  expect(status.stats.agent_spend_today).toBe(0.3);
  // Accepted into the journal while paused (§2.2).
  ids.push((await first.client.request("push", { data: { n: 4 } })).packet_id);
  expect(delivered(name)).toEqual(ids.slice(0, 2));
  await kill(first);

  // 2. Eight seconds before midnight (a loaded machine can take seconds to start a runner): back paused, same resume time, same spend, nothing moves.
  const second = await start(name, 2, midnight - 8_000 - Date.now());
  const restored = await second.client.request("status");
  expect(restored).toMatchObject({ state: "paused", paused_reason: "budget" });
  expect(restored.budget_resumes_at).toBe(new Date(midnight).toISOString());
  expect(restored.stats.agent_spend_today).toBe(0.3);
  expect(calls().filter((c) => c === "done")).toHaveLength(2);

  // 3. Midnight: resumes on its own, delivers the held packets exactly once, on the new day's budget.
  await waitFor(() => delivered(name).length === 4, 20_000, "held packets delivered after midnight");
  const after = await second.client.request("status");
  expect(after.state).toBe("active");
  expect(after.stats.agent_spend_today).toBe(0.3);
  expect([...delivered(name)].sort()).toEqual([...ids].sort());
  expect(calls().filter((c) => c === "done")).toHaveLength(4);
  const resumed = query(name, "SELECT detail FROM events WHERE type = 'pipeline.resumed' ORDER BY seq");
  expect(resumed.map((r) => JSON.parse(r.detail))).toEqual([{ reason: "budget_window" }]);
  const paused = query(name, "SELECT detail FROM events WHERE type = 'pipeline.paused' ORDER BY seq").map((r) =>
    JSON.parse(r.detail),
  );
  expect(paused).toMatchObject([
    { reason: "budget", resume_at: new Date(midnight).toISOString() },
    { reason: "budget", resume_at: new Date(midnight).toISOString(), restored: true },
  ]);
  await kill(second);
}, 60_000);

test("SIGKILL during an agent call: the call runs again, the packet is delivered once, only reported usage counts", async () => {
  const name = "call-crash";
  box.write(`${name}.pipo`, pipeline(name, 100));
  rmSync(CALLS, { force: true });
  writeFileSync(SLOW, "");
  const first = await start(name, 1, 0);
  const id = (await first.client.request("push", { data: { n: 1 } })).packet_id;
  await waitFor(() => calls().includes("start"), 10_000, "the call to start");
  await kill(first);
  rmSync(SLOW);
  expect(query(name, "SELECT * FROM agent_spend")).toEqual([]);

  const second = await start(name, 2, 0);
  await waitFor(() => delivered(name).length === 1, 15_000, "delivery after restart");
  expect(delivered(name)).toEqual([id]);
  expect(calls()).toEqual(["start", "start", "done"]);
  const spend = query(name, "SELECT root, input_tokens, output_tokens FROM agent_spend");
  expect(spend).toEqual([{ root: id, input_tokens: 1000, output_tokens: 500 }]);
  expect((await second.client.request("status")).stats.agent_spend_today).toBe(0.15);
  await kill(second);
}, 60_000);
