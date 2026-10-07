// The engine gateway (docs/spec.md §7.1, §7.2, §7.6, D28) with real runner processes, found through registry files:
// /in/* proxied byte for byte (HMAC over the raw body, `respond: delivered`, the runner's own errors), a runner killed
// with SIGKILL answered with 503 and then followed to its new port, the REST API round trip, SSE with ids and
// replay, errors with hints, loopback-only binding, and a pipod SIGKILL after which the next engine's gateway
// reaches the adopted runner and replays its events from the journal, every packet delivered once.
import { afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { readRegistryEntry } from "@pipo/runner";
import { EngineError, type GatewayEvent, type RunnerInfo, readEngineEntry, Supervisor } from "../src";
import { isRunning } from "../src/registry";
import { isAlive, query, sandbox, spawnPipod, testConfig, waitFor } from "./helpers";

const sign = (body: string) => createHmac("sha256", "gw-test-signing-key").update(body).digest("hex");

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
const engines: Supervisor[] = [];
const runnerPids: number[] = [];
afterAll(async () => {
  for (const e of engines) {
    for (const r of e.list()) if (r.pid) runnerPids.push(r.pid);
    await Promise.race([e.shutdown({ now: true }), Bun.sleep(10_000)]);
  }
  for (const p of spawned) p.kill("SIGKILL");
  for (const pid of runnerPids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  box.cleanup();
});

box.write("fns.ts", "export const slow = async (d) => { await Bun.sleep(d.sleep ?? 0); return d; };\n");
const hooksFile = (name: string) =>
  box.write(
    `${name}.pipo`,
    `pipo: 1
name: ${name}
fn: ./fns.ts
input:
  via: http
  with: { path: /hook, respond: delivered, timeout: 10s, auth: { hmac: { header: X-Signature, secret: gw-test-signing-key } } }
nodes:
  n: { from: input, transform: fn.slow }
output: { from: n, to: file, with: { path: ./${name}.jsonl, format: jsonl } }
`,
  );
const pushFile = (name: string) =>
  box.write(
    `${name}.pipo`,
    `pipo: 1\nname: ${name}\ninput: { via: push }\noutput: { from: input, to: file, with: { path: ./${name}.jsonl } }\n`,
  );

async function open(home: string) {
  const lines: string[] = [];
  const engine = await Supervisor.open({
    home,
    config: { ...testConfig({ backoff: 1000 }), listen: 0 },
    log: (l) => lines.push(l),
  });
  engines.push(engine);
  const base = engine.gateway?.url as string;
  return { engine, lines, base };
}

const post = (url: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const signed = (url: string, data: unknown) => {
  const body = JSON.stringify(data);
  return fetch(url, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "X-Signature": sign(body) },
  });
};

const lines = (path: string) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

interface Frame {
  id?: string;
  event?: string;
  data?: any;
}

/** Read an SSE stream into frames in the background. */
async function sse(url: string, headers: Record<string, string> = {}) {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers, signal: ctrl.signal });
  const frames: Frame[] = [];
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
          const frame: Frame = {};
          for (const line of buf.slice(0, i).split("\n")) {
            if (line.startsWith("id: ")) frame.id = line.slice(4);
            else if (line.startsWith("event: ")) frame.event = line.slice(7);
            else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6));
          }
          buf = buf.slice(i + 2);
          if (frame.id || frame.event || frame.data) frames.push(frame);
        }
      }
    } catch {}
  })();
  return { res, frames, close: () => ctrl.abort() };
}

describe("one engine with a gateway on port 0", () => {
  const home = join(box.root, "gw");
  let engine: Supervisor;
  let base: string;

  test("binds 127.0.0.1 only, reports its real port in engine.json, and proxies /in to the runner's own port", async () => {
    ({ engine, base } = await open(home));
    const port = engine.gateway?.port as number;
    expect(port).toBeGreaterThan(0);
    expect(base).toBe(`http://127.0.0.1:${port}`);
    expect(readEngineEntry(home)).toMatchObject({ engine_id: engine.engineId, listen: port });

    // Listening on 127.0.0.1, not on every address (Linux: /proc/net/tcp has the local address in hex).
    if (process.platform === "linux") {
      const hex = port.toString(16).toUpperCase().padStart(4, "0");
      const listening = readFileSync("/proc/net/tcp", "utf8")
        .split("\n")
        .filter((l) => l.split(/\s+/)[4] === "0A" && l.split(/\s+/)[2]?.endsWith(`:${hex}`))
        .map((l) => l.split(/\s+/)[2]);
      expect(listening).toEqual([`0100007F:${hex}`]);
    }
    const external = Object.values(networkInterfaces())
      .flat()
      .find((a) => a && a.family === "IPv4" && !a.internal);
    if (external) {
      const reached = await fetch(`http://${external.address}:${port}/api/engine`, {
        signal: AbortSignal.timeout(3000),
      }).then(
        () => true,
        () => false,
      );
      expect(reached).toBe(false);
    }

    // An http input without a port gets a free loopback one; the registry entry says which.
    const file = hooksFile("hooks");
    const info = await engine.start(file);
    expect(info.listen).toBeGreaterThan(0);
    expect(readRegistryEntry(home, "hooks")?.listen).toBe(info.listen);

    // Through the gateway: the raw body reaches the runner unchanged (its HMAC verifies) and its reply comes back.
    const res = await signed(`${base}/in/hooks/hook?x=1`, { n: 1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { packet_id: string; state: string };
    expect(body.state).toBe("delivered");
    // The same route on the runner's own port.
    const direct = await signed(`http://127.0.0.1:${info.listen}/in/hooks/hook`, { n: 2 });
    expect(direct.status).toBe(200);

    // The runner's own errors pass through: bad signature, wrong method (with Allow), unknown path.
    const bad = await fetch(`${base}/in/hooks/hook`, {
      method: "POST",
      body: JSON.stringify({ n: 3 }),
      headers: { "X-Signature": sign("other") },
    });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { hint: string }).hint).toContain("X-Signature");
    const wrong = await fetch(`${base}/in/hooks/hook`);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
    expect((await post(`${base}/in/hooks/elsewhere`, {})).status).toBe(404);

    const out = lines(join(box.root, "hooks.jsonl"));
    expect(out.map((r) => r.data.n)).toEqual([1, 2]);
    expect(out[0].packet_id).toBe(body.packet_id);
  }, 60_000);

  test("a runner killed with SIGKILL mid-request: 502 (never retried), 503 while it is down, then the gateway follows it to its new port and the journal delivers the accepted packet once", async () => {
    const before = engine.get("hooks") as RunnerInfo;
    // A request the runner journaled (insert before ack) but did not answer yet: `respond: delivered` waits on fn.slow.
    const inflight = signed(`${base}/in/hooks/hook`, { n: 9, sleep: 4000 });
    const journal = join(home, "pipelines", "hooks", "journal.db");
    await waitFor(
      () => query(journal, "SELECT id FROM packets WHERE json_extract(data, '$.n') = 9")?.length,
      10_000,
      "in-flight packet journaled",
    );
    process.kill(before.pid as number, "SIGKILL");
    const cut = await inflight;
    expect(cut.status).toBe(502);
    expect(((await cut.json()) as { hint: string }).hint).toContain("may have been accepted");
    await waitFor(() => !isRunning(before.pid as number), 5000, "runner to die");
    // Until the engine notices the exit, a request may reach the dying process: that is a 502 with a hint, never a
    // retry. Once it has noticed, the gateway answers 503 without trying the runner.
    await waitFor(() => engine.get("hooks")?.state === "backoff", 5000, "engine to notice");
    const down = await signed(`${base}/in/hooks/hook`, { n: 10 });
    expect(down.status).toBe(503);
    expect(down.headers.get("retry-after")).toBe("1");
    const err = (await down.json()) as { error: string; hint: string };
    expect(err.error).toContain("'hooks'");
    expect(err.hint).toBeTruthy();

    const after = await waitFor(
      () => {
        const r = engine.get("hooks");
        return r?.state === "running" && r.pid !== before.pid ? r : null;
      },
      30_000,
      "hooks restarted",
    );
    expect(after.restarts).toBe(1);
    expect(after.listen).toBe(readRegistryEntry(home, "hooks")?.listen as number);
    const res = await signed(`${base}/in/hooks/hook`, { n: 11 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe("delivered");
    // The packet accepted before the kill resumed from the journal; nothing reached the dead runner; nothing twice.
    await waitFor(() => lines(join(box.root, "hooks.jsonl")).some((r) => r.data.n === 9), 15_000, "resumed packet");
    expect(
      lines(join(box.root, "hooks.jsonl"))
        .map((r) => r.data.n)
        .sort((a, b) => a - b),
    ).toEqual([1, 2, 9, 11]);
  }, 60_000);

  test("errors say what is wrong and what to do, with matching status codes", async () => {
    await engine.start(pushFile("pushy"));
    const check = async (res: Response | Promise<Response>, status: number, error: string) => {
      const r = await res;
      const j = (await r.json()) as { error: string; hint: string; code: string };
      expect({ status: r.status, error: j.error }).toEqual({ status, error: expect.stringContaining(error) });
      expect(j.hint.length).toBeGreaterThan(5);
      return j;
    };
    await check(post(`${base}/in/nope/x`), 404, "no pipeline named 'nope'");
    await check(post(`${base}/in/pushy`), 404, "'pushy' has no http input");
    await check(post(`${base}/in`), 404, "no pipeline in the path");
    expect((await check(post(`${base}/mcp`), 403, "no tokens configured")).hint).toContain("engine.mcp.tokens");
    const routes = (await check(fetch(`${base}/api/nope`), 404, "no API route")) as unknown as { routes: string[] };
    expect(routes.routes).toContain("GET  /api/pipelines");
    await check(fetch(`${base}/api/pipelines/nope`), 404, "no pipeline named 'nope'");
    await check(fetch(`${base}/api/pipelines/pushy/pause`), 405, "use POST");
    await check(
      fetch(`${base}/api/pipelines/pushy/pause`, { method: "POST", body: "{}" }),
      415,
      "the engine API takes JSON",
    );
    await check(post(`${base}/api/pipelines/pushy/pause`, { reason: "stall" }), 400, "bad pause reason");
    await check(
      fetch(`${base}/api/pipelines/pushy/pause`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{nope",
      }),
      400,
      "not valid JSON",
    );
    await check(post(`${base}/api/pipelines`, { file: "rel.pipo" }), 400, "absolute path");
    const broken = box.write(
      "broken.pipo",
      "pipo: 1\nname: broken\ninput: { via: push }\noutput: { from: nowhere, to: stdout }\n",
    );
    const invalid = await check(post(`${base}/api/pipelines`, { file: broken }), 422, "error(s)");
    expect((invalid as unknown as { diagnostics: { code: string }[] }).diagnostics.map((d) => d.code)).toContain(
      "P010",
    );
    await check(post(`${base}/api/pipelines/pushy/ack`, { packet_id: "p_nope" }), 404, "");
    // DNS rebinding: a request for another host name is refused by the API, but /in still serves webhooks.
    await check(fetch(`${base}/api/pipelines`, { headers: { host: "evil.example:80" } }), 403, "evil.example");
    expect((await fetch(`${base}/api/engine`, { headers: { host: `localhost:${engine.gateway?.port}` } })).status).toBe(
      200,
    );
  }, 60_000);

  test("REST round trip: list, get, pause, resume, push, stop, start by name, resources, restart, drain, attach", async () => {
    const list = (await (await fetch(`${base}/api/pipelines`)).json()) as { pipelines: RunnerInfo[] };
    expect(list.pipelines.map((p) => [p.name, p.state]).sort()).toEqual([
      ["hooks", "running"],
      ["pushy", "running"],
    ]);
    const eng = (await (await fetch(`${base}/api/engine`)).json()) as Record<string, unknown>;
    expect(eng).toMatchObject({ engine_id: engine.engineId, pid: process.pid, home, ready: true });

    const one = (await (await fetch(`${base}/api/pipelines/pushy`)).json()) as RunnerInfo & { runner: any };
    expect(one).toMatchObject({ name: "pushy", state: "running", status: "active" });
    expect(one.runner).toMatchObject({ pipeline: "pushy", state: "active" });

    expect(await (await post(`${base}/api/pipelines/pushy/pause`)).json()).toMatchObject({ state: "paused" });
    await waitFor(async () => {
      const r = (await (await fetch(`${base}/api/pipelines/pushy`)).json()) as RunnerInfo;
      return r.status === "paused";
    });
    expect(await (await post(`${base}/api/pipelines/pushy/resume`)).json()).toMatchObject({ state: "active" });

    const pushed = await post(`${base}/api/pipelines/pushy/push`, { data: { n: 7 }, source: "api-test" });
    expect(pushed.status).toBe(200);
    const { packet_id } = (await pushed.json()) as { packet_id: string };
    expect(packet_id).toBeTruthy();
    await waitFor(() => lines(join(box.root, "pushy.jsonl")).some((r) => r.packet_id === packet_id));

    const stopped = await post(`${base}/api/pipelines/pushy/stop`, { now: true });
    expect(stopped.status).toBe(200);
    expect(((await stopped.json()) as RunnerInfo).state).toBe("stopped");
    const pid = engine.get("pushy")?.pid;
    expect(pid).toBeNull();
    // A stopped pipeline's control ops are refused with a hint to start it.
    const refused = await post(`${base}/api/pipelines/pushy/pause`);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { hint: string }).hint).toContain("pipo start pushy");

    const started = await post(`${base}/api/pipelines/pushy/start`);
    const startedBody = await started.text();
    if (started.status !== 200) throw new Error(`start after stop answered ${started.status}: ${startedBody}`);
    expect((JSON.parse(startedBody) as RunnerInfo).state).toBe("running");
    const again = await post(`${base}/api/pipelines/pushy/start`);
    expect(again.status).toBe(409);

    const withRes = (await (await fetch(`${base}/api/pipelines`)).json()) as {
      pipelines: (RunnerInfo & { resources: { rss: number } | null })[];
    };
    expect(withRes.pipelines.find((p) => p.name === "pushy")?.resources?.rss).toBeGreaterThan(0);
    const before = engine.get("pushy")?.pid;
    const restarted = await post(`${base}/api/pipelines/pushy/restart`);
    expect(restarted.status).toBe(200);
    const after = (await restarted.json()) as RunnerInfo;
    expect(after.state).toBe("running");
    expect(after.pid).not.toBe(before);

    const drained = await post(`${base}/api/pipelines/pushy/drain`);
    expect(drained.status).toBe(200);
    await waitFor(() => engine.get("pushy")?.state === "stopped", 15_000, "pushy drained");

    const attach = await post(`${base}/api/attach`);
    expect(attach.status).toBe(200);
    const results = ((await attach.json()) as { results: { name: string; outcome: string }[] }).results;
    expect(results).toContainEqual(expect.objectContaining({ name: "hooks", outcome: "supervised" }));

    const fresh = await post(`${base}/api/pipelines`, { file: pushFile("viaapi") });
    expect(fresh.status).toBe(201);
    expect(((await fresh.json()) as RunnerInfo).state).toBe("running");
  }, 90_000);

  test("SSE: ids are <pipeline>:<seq>, ?pipeline= filters, Last-Event-ID replays from the journal, state changes stream", async () => {
    const all = await sse(`${base}/events`);
    const only = await sse(`${base}/events?pipeline=viaapi`);
    expect(all.res.headers.get("content-type")).toBe("text/event-stream");
    try {
      const pushed = (await (await post(`${base}/api/pipelines/viaapi/push`, { data: { n: 1 } })).json()) as {
        packet_id: string;
      };
      await signed(`${base}/in/hooks/hook`, { n: 20 });
      const delivered = (f: Frame[]) =>
        f.find((x) => x.data?.packet_id === pushed.packet_id && x.data?.type === "packet.delivered");
      const ev = await waitFor(() => delivered(only.frames), 10_000, "delivered event on the filtered stream");
      expect(ev.id).toBe(`viaapi:${ev.data.seq}`);
      expect((ev.data as GatewayEvent).id).toBe(ev.id as string);
      await waitFor(() => delivered(all.frames), 10_000, "delivered event on the full stream");
      await waitFor(() => all.frames.some((f) => f.data?.pipeline === "hooks"), 10_000, "hooks event");
      expect(only.frames.filter((f) => f.id).every((f) => f.data.pipeline === "viaapi")).toBe(true);
      expect(only.frames.filter((f) => f.id).map((f) => f.data.seq)).toEqual(
        [...only.frames.filter((f) => f.id).map((f) => f.data.seq)].sort((a, b) => a - b),
      );

      // Replay: reconnecting with Last-Event-ID gets exactly the journal events after it, then the live stream.
      const journal = join(home, "pipelines", "viaapi", "journal.db");
      const seqs = (query(journal, "SELECT seq FROM events ORDER BY seq") ?? []).map((r) => r.seq as number);
      const from = seqs[1] as number;
      const re = await sse(`${base}/events?pipeline=viaapi`, { "last-event-id": `viaapi:${from}` });
      try {
        await waitFor(() => re.frames.filter((f) => f.id).length >= seqs.length - 2, 10_000, "replayed events");
        expect(re.frames.filter((f) => f.id).map((f) => f.data.seq)).toEqual(seqs.slice(2));
        // Then live, without repeating anything the replay already sent.
        await post(`${base}/api/pipelines/viaapi/push`, { data: { n: 2 } });
        await waitFor(
          () => re.frames.some((f) => f.data?.type === "packet.delivered" && f.data?.seq > (seqs.at(-1) as number)),
          10_000,
          "live after replay",
        );
        const got = re.frames.filter((f) => f.id).map((f) => f.data.seq as number);
        expect(new Set(got).size).toBe(got.length);
      } finally {
        re.close();
      }

      // Reconnecting at the latest journal seq: older seqs the engine still streams live are never re-sent.
      {
        const latest = Math.max(...(query(journal, "SELECT seq FROM events") ?? []).map((r) => r.seq as number));
        const re = await sse(`${base}/events?pipeline=viaapi`, { "last-event-id": `viaapi:${latest}` });
        try {
          // The journal has nothing newer, but the engine's own stream may still deliver older seqs live: they are dropped.
          const emit = (seq: number) =>
            (engine.gateway as unknown as { onEvent(e: object): void }).onEvent({
              pipeline: "viaapi",
              seq,
              at: new Date().toISOString(),
              packet_id: null,
              type: "packet.delivered",
              node: null,
              detail: null,
            });
          emit(latest);
          emit(latest - 1);
          emit(latest + 1);
          await waitFor(() => re.frames.some((f) => f.id), 5000, "a newer event");
          await Bun.sleep(200);
          const got = re.frames.filter((f) => f.id).map((f) => f.data.seq as number);
          expect(got).toEqual([latest + 1]);
        } finally {
          re.close();
        }
      }

      // The full stream replays from the engine's recent events; an id it no longer has is a `gap` with a hint.
      const gap = await sse(`${base}/events`, { "last-event-id": "viaapi:999999" });
      try {
        const g = await waitFor(() => gap.frames.find((f) => f.event === "gap"), 5000, "gap event");
        expect(g.data.hint).toContain("/api/events?pipeline=");
      } finally {
        gap.close();
      }

      // State changes stream as `event: state` with the pipeline's info.
      await post(`${base}/api/pipelines/viaapi/stop`, { now: true });
      await waitFor(
        () => only.frames.some((f) => f.event === "state" && f.data.name === "viaapi" && f.data.state === "stopped"),
        15_000,
        "state event",
      );

      // /api/events: one pipeline's events from its journal, or recent ones from all pipelines.
      const page = (await (await fetch(`${base}/api/events?pipeline=viaapi&after=${from}&limit=2`)).json()) as {
        events: GatewayEvent[];
        more: boolean;
      };
      expect(page.events.map((e) => e.seq)).toEqual(seqs.slice(2, 4));
      expect(page.more).toBe(true);
      const recent = (await (await fetch(`${base}/api/events?limit=1000`)).json()) as { events: GatewayEvent[] };
      expect(recent.events.some((e) => e.id === ev.id)).toBe(true);
      const tail = (await (await fetch(`${base}/api/events?after=${ev.id}`)).json()) as { events: GatewayEvent[] };
      expect(tail.events[0]?.id).not.toBe(ev.id);
      expect((await fetch(`${base}/api/events?after=viaapi:999999`)).status).toBe(410);
    } finally {
      all.close();
      only.close();
    }
  }, 60_000);

  test("shutdown closes the gateway after the pipelines stop, and removes engine.json", async () => {
    const stream = await sse(`${base}/events`);
    await engine.shutdown();
    await waitFor(
      () => stream.frames.some((f) => f.data?.pipeline === "hooks" && f.data?.type === "pipeline.stopped"),
      5000,
      "pipeline.stopped seen before the gateway closed",
    );
    expect(readEngineEntry(home)).toBeNull();
    expect(
      await fetch(`${base}/api/engine`).then(
        () => "answered",
        () => "closed",
      ),
    ).toBe("closed");
    stream.close();
  }, 60_000);
});

test("a taken gateway port refuses the engine before it touches any runner, and releases engine.json", async () => {
  const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") });
  try {
    const home = join(box.root, "taken");
    const opened = Supervisor.open({
      home,
      config: { ...testConfig(), listen: blocker.port as number },
      log: () => {},
    });
    const e = await opened.then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(EngineError);
    expect((e as EngineError).message).toContain(`127.0.0.1:${blocker.port}`);
    expect((e as EngineError).hint).toContain("engine.listen");
    expect(readEngineEntry(home)).toBeNull();
  } finally {
    blocker.stop(true);
  }
});

test("without a gateway, an http input with no port is refused before any runner starts", async () => {
  const home = join(box.root, "nogw");
  const engine = await Supervisor.open({ home, config: testConfig(), log: () => {} });
  engines.push(engine);
  expect(engine.gateway).toBeUndefined();
  const e = await engine.start(hooksFile("noport")).then(
    () => null,
    (err) => err,
  );
  expect(e).toBeInstanceOf(EngineError);
  expect((e as EngineError).hint).toContain("engine.listen");
  expect(readRegistryEntry(home, "noport")).toBeNull();
});

test("pipod SIGKILL: the next engine's gateway reaches the adopted runner and replays its events, each packet once", async () => {
  const home = join(box.root, "adopt");
  await Bun.write(join(home, "config.yaml"), "engine:\n  listen: 0\n");
  const file = hooksFile("adopted");
  const { proc, value } = await spawnPipod(
    box.root,
    spawned,
    home,
    [file],
    () => {
      const eng = readEngineEntry(home);
      const runner = readRegistryEntry(home, "adopted");
      return eng?.listen && runner ? { eng, runner } : null;
    },
    "gw",
    50_000,
  );
  runnerPids.push(value.runner.pid);
  const first = `http://127.0.0.1:${value.eng.listen}`;
  // The registry entry appears before pipod's start() returns; until then the gateway answers 503.
  await waitFor(
    async () => ((await (await fetch(`${first}/api/pipelines/adopted`)).json()) as RunnerInfo).state === "running",
    20_000,
    "adopted running behind pipod's gateway",
  );
  for (let n = 1; n <= 3; n++) expect((await signed(`${first}/in/adopted/hook`, { n })).status).toBe(200);

  proc.kill("SIGKILL");
  await proc.exited;
  expect(isRunning(value.runner.pid)).toBe(true);
  expect(
    await fetch(`${first}/api/engine`).then(
      () => "answered",
      () => "down",
    ),
  ).toBe("down");
  // With the engine down the runner's own port still works.
  expect((await signed(`http://127.0.0.1:${value.runner.listen}/in/adopted/hook`, { n: 4 })).status).toBe(200);

  const { engine, base } = await open(home);
  expect(engine.get("adopted")).toMatchObject({ state: "running", adopted: true, pid: value.runner.pid });
  expect(readEngineEntry(home)).toMatchObject({ engine_id: engine.engineId, listen: engine.gateway?.port });
  expect((await signed(`${base}/in/adopted/hook`, { n: 5 })).status).toBe(200);

  // Every event from the start, replayed from the journal (none missing, none twice).
  const stream = await sse(`${base}/events?pipeline=adopted&after=0`);
  try {
    const journal = join(home, "pipelines", "adopted", "journal.db");
    const seqs = await waitFor(() => {
      const all = (query(journal, "SELECT seq FROM events ORDER BY seq") ?? []).map((r) => r.seq as number);
      const got = stream.frames.filter((f) => f.id).map((f) => f.data.seq as number);
      return all.length && got.length >= all.length ? all : null;
    }, 10_000);
    const got = stream.frames.filter((f) => f.id).map((f) => f.data.seq as number);
    expect(got.slice(0, seqs.length)).toEqual(seqs);
    expect(new Set(got).size).toBe(got.length);
  } finally {
    stream.close();
  }
  const out = lines(join(box.root, "adopted.jsonl"));
  expect(out.map((r) => r.data.n).sort()).toEqual([1, 2, 3, 4, 5]);
  expect(new Set(out.map((r) => r.packet_id)).size).toBe(5);
  await engine.shutdown();
  expect(isRunning(value.runner.pid)).toBe(false);
}, 120_000);
