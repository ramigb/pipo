// Change proposals and `resolve` over /api (docs/spec.md §9.3, D50, D51) with a real runner process: propose (applied
// at once, or held), list, show, apply, reject, strict bodies and hints; reads from the journal once the pipeline
// stopped, while writes say to start it.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Supervisor } from "../src";
import { isAlive, sandbox, testConfig } from "./helpers";

const box = sandbox();
const engines: Supervisor[] = [];
const pids: number[] = [];
afterAll(async () => {
  for (const e of engines) {
    for (const r of e.list()) if (r.pid) pids.push(r.pid);
    await Promise.race([e.shutdown({ now: true }), Bun.sleep(10_000)]);
  }
  for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  box.cleanup();
});

const NAME = "propapi";
box.write(
  "fns.ts",
  `export const one = (d) => ({ ...d, v: "one" });\nexport const two = (d) => ({ ...d, v: "two" });\nexport const three = (d) => ({ ...d, v: "three" });\n`,
);
const SRC = (tag: string, to = `./${NAME}.jsonl`) => `pipo: 1
name: ${NAME}
fn: ./fns.ts
input: { via: push }
nodes:
  tag: { from: input, transform: fn.${tag} }
output: { from: tag, to: file, with: { path: ${to}, format: jsonl } }
agent:
  control: true
  edit: [nodes.tag]
`;
const file = box.write(`${NAME}.pipo`, SRC("one"));

const post = async (url: string, body: unknown = {}) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const get = async (url: string) => {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as any };
};

describe("proposals over /api", () => {
  const home = join(box.root, "home");
  let engine: Supervisor;
  let api: string;

  test("propose applies, holds, lists, shows, applies and rejects", async () => {
    engine = await Supervisor.open({ home, config: { ...testConfig(), listen: 0 }, log: () => {} });
    engines.push(engine);
    const base = engine.gateway?.url;
    api = `${base}/api/pipelines/${NAME}`;
    expect((await post(`${base}/api/pipelines`, { file })).status).toBe(201);

    const done = await post(`${api}/proposals`, { source: SRC("two"), base_version: 1, reason: "use two", by: "ada" });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ state: "applied", applied_version: 2, author: "ada", author_kind: "human" });

    // An agent's change to `output` is stored rejected: a normal 200, with its problems.
    const bad = await post(`${api}/proposals`, {
      source: SRC("two", "./elsewhere.jsonl"),
      base_version: 2,
      reason: "move output",
      by: "agent-ops",
      by_kind: "agent",
    });
    expect(bad.status).toBe(200);
    expect(bad.body.state).toBe("rejected");
    expect(bad.body.problems.map((p: any) => p.code)).toContain("forbidden_path");

    const held = await post(`${api}/proposals`, {
      source: SRC("three"),
      base_version: 2,
      reason: "use three",
      by: "agent-ops",
      by_kind: "agent",
      apply: false,
    });
    expect(held.body).toMatchObject({ state: "validated", author_kind: "agent" });
    const id = held.body.id;

    const list = await get(`${api}/proposals`);
    expect(list.status).toBe(200);
    expect(list.body.source).toBe("runner");
    expect(list.body.proposals).toHaveLength(3);
    expect((await get(`${api}/proposals?state=validated`)).body.proposals.map((p: any) => p.id)).toEqual([id]);
    const badState = await get(`${api}/proposals?state=bogus`);
    expect(badState.status).toBe(400);
    expect(badState.body.code).toBe("bad_request");
    const one = await get(`${api}/proposals/${id}`);
    expect(one.body).toMatchObject({ id, state: "validated", reason: "use three" });
    expect(one.body.diff).toContain("+  tag: { from: input, transform: fn.three }");
    const missing = await get(`${api}/proposals/pr_nope`);
    expect(missing.status).toBe(404);
    expect(missing.body.hint).toContain(`pipo proposals ${NAME}`);

    // Strict bodies and clear errors.
    const extra = await post(`${api}/proposals`, { source: "x", base_version: 1, reason: "x", dry: true });
    expect(extra.status).toBe(400);
    expect(extra.body.error).toBe("unknown key `dry`");
    const noSource = await post(`${api}/proposals`, { base_version: 2, reason: "x" });
    expect(noSource.status).toBe(400);
    expect(noSource.body.hint).toBeTruthy();
    expect((await post(`${api}/proposals/${id}/apply`, { force: true })).body.error).toBe("unknown key `force`");
    expect((await post(`${api}/proposals/${id}/reject`, {})).status).toBe(400);
    expect((await post(`${api}/proposals/${id}/explode`, {})).status).toBe(404);
    expect((await fetch(`${api}/proposals`, { method: "DELETE" })).status).toBe(405);

    const applied = await post(`${api}/proposals/${id}/apply`, { by: "ada" });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ version: 3, previous: 2, proposal: id });
    const again = await post(`${api}/proposals/${id}/apply`, {});
    expect(again.status).toBe(409);
    expect(again.body.hint).toBeTruthy();

    const held2 = await post(`${api}/proposals`, {
      source: SRC("one"),
      base_version: 3,
      reason: "back",
      apply: false,
    });
    const rej = await post(`${api}/proposals/${held2.body.id}/reject`, { reason: "no thanks", by: "ada" });
    expect(rej.status).toBe(200);
    expect(rej.body).toMatchObject({ state: "rejected", decision: "no thanks", decided_by: "ada" });
    const late = await post(`${api}/proposals/${id}/reject`, { reason: "too late" });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("invalid_state");
  }, 60_000);

  test("resolve validates its body and the runner answers for unknown packets", async () => {
    const noAction = await post(`${api}/resolve`, { ids: ["01X"] });
    expect(noAction.status).toBe(400);
    expect(noAction.body.error).toContain("`action`");
    const extra = await post(`${api}/resolve`, { ids: ["01X"], action: "retry", now: true });
    expect(extra.body.error).toBe("unknown key `now`");
    const badAction = await post(`${api}/resolve`, { ids: ["01X"], action: "explode" });
    expect(badAction.status).toBe(400);
    const unknown = await post(`${api}/resolve`, { ids: ["01NOPE"], action: "retry", by: "ada" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toContain("no packet '01NOPE'");
    expect(
      (await post(`${engine.gateway?.url}/api/pipelines/ghost/resolve`, { ids: ["a"], action: "drop" })).status,
    ).toBe(404);
  }, 30_000);

  test("once stopped, proposals are read from the journal and writes say to start the pipeline", async () => {
    await engine.stop(NAME, { now: true });
    const list = await get(`${api}/proposals`);
    expect(list.body.source).toBe("journal");
    expect(list.body.proposals).toHaveLength(4);
    const id = list.body.proposals[0].id;
    expect((await get(`${api}/proposals/${id}`)).body.source).toBe("journal");
    const write = await post(`${api}/proposals`, { source: SRC("two"), base_version: 3, reason: "x" });
    expect(write.status).toBe(409);
    expect(write.body.hint).toContain("start it");
    expect((await post(`${api}/proposals/${id}/reject`, { reason: "x" })).status).toBe(409);
    expect((await get(`${engine.gateway?.url}/api/pipelines/ghost/proposals`)).status).toBe(404);
  }, 30_000);
});
