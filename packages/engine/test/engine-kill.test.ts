// Engine SIGKILL with a detached runner mid-stream (docs/spec.md §7.2, §7.3, D27, D30), with real processes found
// through registry files and engine.json, never stdout. Packets stream through the gateway and straight to the
// runner's own port; pipod is SIGKILLed mid-stream; the runner keeps accepting and delivering on its port; the next
// pipod adopts the same pid, replays the events written while it was down, and the gateway works again. A second
// variant SIGKILLs the next engine during its discovery scan, and a third one still ends correct. Every packet
// whose request got a 2xx is in the sqlite output exactly once, and no packet is there twice or unasked for.
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readRegistryEntry } from "@pipo/runner";
import { type EngineEntry, readCursor, readEngineEntry } from "../src";
import { isRunning } from "../src/registry";
import { query, sandbox, spawnPipod, waitFor } from "./helpers";

type Proc = ReturnType<typeof Bun.spawn>;
const box = sandbox();
const spawned: Proc[] = [];
const runnerPids: number[] = [];
const closers: (() => void)[] = [];
afterAll(() => {
  for (const c of closers) c();
  for (const p of spawned) p.kill("SIGKILL");
  for (const pid of runnerPids) if (isRunning(pid)) process.kill(pid, "SIGKILL");
  box.cleanup();
});

/** Packets per scenario, at least: phases of unbounded length (an engine starting) may stretch it a little. */
const N = 200;
const NAME = "hooks";

function freePort(): number {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = s.port as number;
  s.stop(true);
  return port;
}

const pipelineFile = (dir: string) =>
  box.write(
    `${dir}.pipo`,
    `pipo: 1
name: ${NAME}
input:
  via: http
  with: { path: /hook }
output:
  from: input
  to: sqlite
  with: { path: ./${dir}.db, table: items, create: true, columns: { packet_id: "\${meta.packet_id}", n: "\${data.n}" } }
`,
  );

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

const getJson = async (url: string) => (await fetch(url, { signal: AbortSignal.timeout(10_000) })).json() as any;

/** The gateway of the live engine of `home`, or null while none runs. */
function gateway(home: string): string | null {
  const e = readEngineEntry(home);
  return e?.listen && isRunning(e.pid) ? `http://127.0.0.1:${e.listen}` : null;
}

/** Start pipod with a gateway on a free port; resolves once engine.json names it and its port. */
async function startEngine(home: string, n: string) {
  const { proc, log, value } = await spawnPipod(
    box.root,
    spawned,
    home,
    ["--listen", "0"],
    (p) => {
      const e = readEngineEntry(home);
      return e?.pid === p.pid && e.listen ? e : null;
    },
    n,
    50_000,
  );
  return { proc, log, entry: value as EngineEntry, base: `http://127.0.0.1:${value.listen}` };
}

async function ready(base: string) {
  await waitFor(
    async () => ((await getJson(`${base}/api/engine`).catch(() => null)) as { ready?: boolean } | null)?.ready,
    30_000,
    "engine ready",
  );
}

async function sigkill(proc: Proc) {
  proc.kill("SIGKILL");
  await proc.exited;
}

/**
 * Two senders, one through the gateway (whichever engine is up) and one to the runner's own port, each sending one
 * request at a time with a distinct `n` until `limit`. A 2xx is an accepted packet; a 503 or 4xx never reached the
 * runner, so that `n` is sent again; no answer (or 502) may or may not have been accepted, and is resolved at the end
 * from the output before anything is sent again.
 */
class Stream {
  next = 0;
  limit = 0;
  stopped = false;
  readonly acked = new Map<number, string>();
  readonly ambiguous = new Set<number>();
  readonly again: number[] = [];
  /** Accepted requests per path, with the time they were answered. */
  readonly answered: { via: "gateway" | "direct"; at: number; n: number }[] = [];
  private loops: Promise<void>[] = [];

  constructor(
    readonly home: string,
    readonly port: number,
  ) {}

  start() {
    this.loops = [
      this.loop("gateway", () => {
        const gw = gateway(this.home);
        return gw && `${gw}/in/${NAME}/hook`;
      }),
      this.loop("direct", () => `http://127.0.0.1:${this.port}/in/${NAME}/hook`),
    ];
  }

  get sent() {
    return this.acked.size + this.ambiguous.size;
  }

  /**
   * Make `k` numbers no sender has taken yet available. A fixed limit set before a phase of unbounded length (an
   * engine starting) can be used up by the direct sender during it, leaving none for a later phase that waits for a
   * number of acks.
   */
  extend(k: number) {
    this.limit = Math.max(this.limit, this.next + k);
  }

  acks(via: "gateway" | "direct", since = 0) {
    return this.answered.filter((a) => a.via === via && a.at >= since).length;
  }

  private take(): number | null {
    if (this.again.length) return this.again.shift() as number;
    return this.next < this.limit ? this.next++ : null;
  }

  private async loop(via: "gateway" | "direct", target: () => string | null) {
    while (!this.stopped) {
      const url = target();
      const n = url ? this.take() : null;
      if (url === null || n === null) {
        await Bun.sleep(20);
        continue;
      }
      const outcome = await this.send(url, n);
      if (outcome === "accepted") this.answered.push({ via, at: Date.now(), n });
      else if (outcome === "not sent") await Bun.sleep(50);
      await Bun.sleep(5);
    }
  }

  async send(url: string, n: number): Promise<"accepted" | "not sent" | "unknown"> {
    let res: Response;
    try {
      res = await post(url, { n });
    } catch {
      this.ambiguous.add(n);
      return "unknown";
    }
    const body = (await res.json().catch(() => null)) as { packet_id?: string } | null;
    if (res.status >= 200 && res.status < 300 && body?.packet_id) {
      this.acked.set(n, body.packet_id);
      return "accepted";
    }
    if (res.status === 502) {
      this.ambiguous.add(n);
      return "unknown";
    }
    this.again.push(n);
    return "not sent";
  }

  /** Let the senders run until every `n` below `limit` was answered (accepted or unknown). */
  async until(limit: number, timeoutMs = 60_000) {
    this.limit = Math.max(this.limit, limit);
    await waitFor(() => this.sent >= limit && !this.again.length, timeoutMs, `${limit} packets sent`);
  }

  async stop() {
    this.stopped = true;
    await Promise.all(this.loops);
  }
}

function rows(dir: string): { packet_id: string; n: number }[] {
  return query(join(box.root, `${dir}.db`), "SELECT packet_id, n FROM items") ?? [];
}

const journal = (home: string) => join(home, "pipelines", NAME, "journal.db");

/** Every packet the journal accepted is delivered and written. */
async function drained(home: string, dir: string) {
  await waitFor(
    () => {
      const p = query(journal(home), "SELECT COUNT(*) AS total, SUM(state = 'delivered') AS delivered FROM packets");
      const total = p?.[0]?.total as number | undefined;
      return total !== undefined && total === p?.[0]?.delivered && rows(dir).length === total;
    },
    30_000,
    "every accepted packet delivered",
  );
}

/**
 * Resolve the requests that got no answer: one in the output was accepted (its packet_id is learned from there);
 * one that isn't, after every accepted packet was delivered, never reached the runner and is sent again directly.
 * Then: the output holds exactly n = 0…total-1 (every number the stream handed out), each once, under the packet_id
 * its request was answered with.
 */
async function exactlyOnce(s: Stream, home: string, dir: string) {
  const total = s.limit;
  expect(total).toBeGreaterThanOrEqual(N);
  expect(s.next).toBe(total);
  await drained(home, dir);
  const byN = new Map(rows(dir).map((r) => [r.n, r.packet_id]));
  for (const n of s.ambiguous) {
    const id = byN.get(n);
    if (id) s.acked.set(n, id);
    else expect(await s.send(`http://127.0.0.1:${s.port}/in/${NAME}/hook`, n)).toBe("accepted");
  }
  await drained(home, dir);
  const out = rows(dir);
  expect(out.length).toBe(total);
  expect(new Set(out.map((r) => r.packet_id)).size).toBe(total);
  expect(out.map((r) => r.n).sort((a, b) => a - b)).toEqual(Array.from({ length: total }, (_, i) => i));
  for (const r of out) expect(s.acked.get(r.n)).toBe(r.packet_id);
  const delivered =
    query(
      journal(home),
      "SELECT packet_id, COUNT(*) AS n FROM events WHERE type = 'packet.delivered' GROUP BY packet_id",
    ) ?? [];
  expect(delivered).toHaveLength(total);
  expect(delivered.every((r) => r.n === 1)).toBe(true);
}

/** Start `hooks` detached through the first engine's API and stream until `firstKill` packets went out. */
async function setUp(dir: string) {
  const home = join(box.root, dir);
  const port = freePort();
  const file = pipelineFile(dir);
  const first = await startEngine(home, `${dir}-1`);
  await ready(first.base);
  const started = await post(`${first.base}/api/pipelines`, { file, detached: true, listen: port });
  expect(started.status).toBe(201);
  const entry = readRegistryEntry(home, NAME);
  if (!entry) throw new Error("no registry entry for hooks");
  runnerPids.push(entry.pid);
  expect(entry).toMatchObject({ detached: true, listen: port });
  const stream = new Stream(home, port);
  stream.start();
  return { home, port, first, pid: entry.pid, stream };
}

/**
 * With no engine running: the runner is alive, keeps accepting on its own port and keeps delivering. Returns when
 * at least `more` direct requests were accepted and delivered since `since`. Called after the engine died, so the
 * `more` fresh numbers reserved here can only go to the direct sender.
 */
async function aloneFor(s: Stream, pid: number, dir: string, since: number, more: number) {
  const before = rows(dir).length;
  s.extend(more);
  await waitFor(() => s.acks("direct", since) >= more, 30_000, "direct requests accepted with no engine");
  await waitFor(() => rows(dir).length >= before + more, 30_000, "deliveries growing with no engine");
  expect(isRunning(pid)).toBe(true);
  expect(gateway(s.home)).toBeNull();
}

/** The engine at `base` adopted the same runner pid: running, adopted, never restarted. */
async function adopted(base: string, pid: number, port: number) {
  const info = await getJson(`${base}/api/pipelines/${NAME}`);
  expect(info).toMatchObject({ state: "running", adopted: true, pid, detached: true, listen: port, restarts: 0 });
  expect(info.runner).toBeTruthy();
}

/**
 * Events written while no engine ran are replayed: the new engine's own stream (its recent events, fed from its
 * cursor) carries every event after the cursor the killed engine saved, the downtime deliveries included, each once
 * and in order; SSE replay after that cursor carries them too.
 */
async function replayed(base: string, home: string, cursor: number, downtime: Set<string>) {
  const deliveredIn = (events: { type: string; packet_id: string | null }[]) =>
    new Set(events.filter((e) => e.type === "packet.delivered").map((e) => e.packet_id as string));
  const recent = await waitFor(
    async () => {
      const r = (await getJson(`${base}/api/events?limit=1000`)) as { events: any[] };
      const got = deliveredIn(r.events);
      return [...downtime].every((id) => got.has(id)) ? r.events : null;
    },
    15_000,
    "downtime deliveries in the new engine's stream",
  );
  const seqs = recent.filter((e) => e.pipeline === NAME).map((e) => e.seq as number);
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(seqs[0]).toBeGreaterThan(cursor);
  // A full ring may have dropped the first events after the cursor; otherwise replay starts right after it.
  if (recent.length < 1000) expect(seqs[0]).toBe(cursor + 1);
  expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => (seqs[0] as number) + i));

  const page = (await getJson(`${base}/api/events?pipeline=${NAME}&after=${cursor}&limit=1000`)) as { events: any[] };
  expect(page.events[0]?.seq).toBe(cursor + 1);
  expect([...downtime].every((id) => deliveredIn(page.events).has(id))).toBe(true);

  const stream = await sse(`${base}/events?pipeline=${NAME}`, `${NAME}:${cursor}`);
  try {
    await waitFor(
      () => [...downtime].every((id) => deliveredIn(stream.events).has(id)),
      15_000,
      "downtime deliveries in the SSE replay",
    );
    expect(stream.events[0]?.seq).toBe(cursor + 1);
  } finally {
    stream.close();
  }
  expect(readCursor(home, NAME)).toBeGreaterThan(cursor);
}

/** Read an SSE stream's event data in the background (never awaited per chunk, so a quiet stream can't hang). */
async function sse(url: string, lastEventId: string) {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers: { "last-event-id": lastEventId }, signal: ctrl.signal });
  const events: any[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const data = buf
            .slice(0, i)
            .split("\n")
            .find((l) => l.startsWith("data: "));
          buf = buf.slice(i + 2);
          const d = data ? JSON.parse(data.slice(6)) : null;
          if (d?.seq !== undefined) events.push(d);
        }
      }
    } catch {}
  })();
  return { events, close: () => ctrl.abort() };
}

/** Packet ids of direct requests answered between `from` and `to`. */
const answeredBetween = (s: Stream, from: number, to: number) =>
  new Set(
    s.answered.filter((a) => a.via === "direct" && a.at >= from && a.at <= to).map((a) => s.acked.get(a.n) as string),
  );

/** Stop the pipeline through the API (the runner exits, its entry goes), then stop the engine with SIGTERM. */
async function tearDown(base: string, home: string, proc: Proc, pid: number) {
  const stopped = await post(`${base}/api/pipelines/${NAME}/stop`, {});
  expect(stopped.status).toBe(200);
  await waitFor(() => !isRunning(pid), 15_000, "runner stopped");
  expect(readRegistryEntry(home, NAME)).toBeNull();
  proc.kill("SIGTERM");
  expect(await Promise.race([proc.exited, Bun.sleep(20_000).then(() => "hung")])).toBe(0);
}

test("pipod SIGKILL mid-stream: the detached runner keeps accepting and delivering; the next engine adopts the same pid, replays what it missed, and every packet lands exactly once", async () => {
  const dir = "once";
  const { home, port, first, pid, stream } = await setUp(dir);
  await stream.until(60);
  stream.limit = 110; // both senders are mid-stream when the engine dies
  expect(stream.acks("gateway")).toBeGreaterThan(0);
  await waitFor(() => stream.sent >= 70, 30_000, "stream under way");

  await sigkill(first.proc);
  const killedAt = Date.now();
  const cursor = readCursor(home, NAME);
  expect(isRunning(pid)).toBe(true);
  expect(readRegistryEntry(home, NAME)).toMatchObject({ pid, detached: true, listen: port });
  await aloneFor(stream, pid, dir, killedAt, 25);
  stream.extend(40); // and the runner's port keeps taking packets while the next engine starts

  const second = await startEngine(home, `${dir}-2`);
  await ready(second.base);
  const readyAt = Date.now();
  await adopted(second.base, pid, port);
  await replayed(second.base, home, cursor, answeredBetween(stream, killedAt, readyAt));

  await stream.until(Math.max(N, stream.next + 40));
  await stream.stop();
  // The gateway path works again, through the new engine's port.
  expect(stream.acks("gateway", readyAt)).toBeGreaterThan(0);
  expect(isRunning(pid)).toBe(true);
  await exactlyOnce(stream, home, dir);
  await tearDown(second.base, home, second.proc, pid);
}, 240_000);

test("pipod SIGKILLed again during its discovery scan: a third engine still adopts the same runner and every packet lands exactly once", async () => {
  const dir = "twice";
  const { home, port, first, pid, stream } = await setUp(dir);
  await stream.until(50);
  stream.limit = 90;
  await waitFor(() => stream.sent >= 60, 30_000, "stream under way");
  await sigkill(first.proc);
  const killedAt = Date.now();
  await aloneFor(stream, pid, dir, killedAt, 15);
  stream.extend(50);

  // A live runner that accepts the handshake connection but never answers keeps discovery busy for the handshake
  // timeout (2 s), so the next engine is reliably killed mid-scan: after it adopted hooks, before it was ready.
  const sleeper = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });
  spawned.push(sleeper);
  const muteSock = join(home, "run", "mute.sock");
  const listener = Bun.listen({ unix: muteSock, socket: { data() {} } });
  closers.push(() => listener.stop(true));
  await Bun.write(
    join(home, "run", "mute.json"),
    JSON.stringify({
      pipeline: "mute",
      version: 1,
      pid: sleeper.pid,
      socket: muteSock,
      file: join(box.root, "mute.pipo"),
      listen: null,
      detached: true,
      state: "active",
      started_at: new Date().toISOString(),
    }),
  );

  const second = await startEngine(home, `${dir}-2`);
  const note = `engine ${second.entry.engine_id} attached to runner pid ${pid}`;
  await waitFor(
    () => readFileSync(join(home, "logs", `${NAME}.log`), "utf8").includes(note),
    10_000,
    "second engine adopted hooks",
  );
  const mid = (await getJson(`${second.base}/api/engine`)) as { ready: boolean };
  expect(mid.ready).toBe(false);
  await sigkill(second.proc);
  const killed2At = Date.now();
  const secondLog = readFileSync(second.log, "utf8");
  expect(secondLog).toContain(`'${NAME}' adopted: runner pid ${pid}`);
  expect(secondLog).not.toContain("discovery:"); // killed before its scan finished
  const cursor = readCursor(home, NAME);
  expect(isRunning(pid)).toBe(true);
  expect(readRegistryEntry(home, NAME)).toMatchObject({ pid, detached: true, listen: port });
  await aloneFor(stream, pid, dir, killed2At, 10);
  stream.extend(30);

  const third = await startEngine(home, `${dir}-3`);
  await ready(third.base);
  const readyAt = Date.now();
  await adopted(third.base, pid, port);
  expect(await getJson(`${third.base}/api/pipelines/mute`)).toMatchObject({ state: "unreachable", pid: sleeper.pid });
  expect(isRunning(sleeper.pid)).toBe(true); // never killed
  await replayed(third.base, home, cursor, answeredBetween(stream, killed2At, readyAt));

  await stream.until(Math.max(N, stream.next + 40));
  await stream.stop();
  expect(stream.acks("gateway", readyAt)).toBeGreaterThan(0);
  await exactlyOnce(stream, home, dir);
  await tearDown(third.base, home, third.proc, pid);
  expect(existsSync(join(home, "run", "mute.json"))).toBe(true); // an unreachable runner's entry is left alone
}, 240_000);
