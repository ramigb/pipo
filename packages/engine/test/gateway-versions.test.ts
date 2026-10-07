// Version endpoints of the engine API (docs/spec.md §6, §9.3, D38) with a real runner process: the version list, one
// version's source, a diff, and a rollback (strict body keys, unknown versions, the live version in the pipeline's
// info); once the pipeline stopped, reads come from its journal and a rollback says to start it.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Supervisor } from "../src";
import { isAlive, query, sandbox, testConfig, waitFor } from "./helpers";

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

const NAME = "verapi";
box.write(
  "fns.ts",
  `export const one = (d) => ({ ...d, v: "one" });\nexport const two = (d) => ({ ...d, v: "two" });\n`,
);
const SRC = (tag: string) => `pipo: 1
name: ${NAME}
fn: ./fns.ts
input: { via: push }
nodes:
  tag: { from: input, transform: fn.${tag} }
output: { from: tag, to: file, with: { path: ./${NAME}.jsonl, format: jsonl } }
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

describe("versions over /api", () => {
  const home = join(box.root, "home");
  const journal = join(home, "pipelines", NAME, "journal.db");
  let engine: Supervisor;
  let api: string;

  test("lists versions, shows one, diffs two and rolls back", async () => {
    engine = await Supervisor.open({ home, config: { ...testConfig(), listen: 0 }, log: () => {} });
    engines.push(engine);
    api = `${engine.gateway?.url}/api/pipelines/${NAME}`;
    expect((await post(`${engine.gateway?.url}/api/pipelines`, { file })).status).toBe(201);
    expect(await engine.request(NAME, "apply", { source: SRC("two"), by: "test" })).toMatchObject({ version: 2 });

    const list = await get(`${api}/versions`);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ current: 2, latest: 2, source: "runner" });
    expect(list.body.versions.map((v: any) => [v.version, v.author, v.reason])).toEqual([
      [2, "test", "applied"],
      [1, "human", "first start"],
    ]);
    const one = await get(`${api}/versions/v1`);
    expect(one.body).toMatchObject({ version: 1, definition: SRC("one"), author: "human", source: "runner" });
    const missing = await get(`${api}/versions/9`);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "not_found", hint: `list them with pipo history ${NAME}` });

    const diff = await get(`${api}/diff?from=1&to=2`);
    expect(diff.status).toBe(200);
    expect(diff.body).toMatchObject({ from: 1, to: 2, identical: false, added: 1, removed: 1 });
    expect(diff.body.diff).toContain("+  tag: { from: input, transform: fn.two }");
    const badDiff = await get(`${api}/diff?from=x&to=2`);
    expect(badDiff.status).toBe(400);
    expect(badDiff.body.code).toBe("bad_request");
    expect((await get(`${api}/diff?to=2`)).status).toBe(400);

    const extra = await post(`${api}/rollback`, { version: 1, now: true });
    expect(extra.status).toBe(400);
    expect(extra.body.error).toBe("unknown key `now`");
    expect((await post(`${api}/rollback`, {})).body.error).toBe("rollback needs `version`");
    const unknown = await post(`${api}/rollback`, { version: "v9" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toContain("has no version 9");

    const rb = await post(`${api}/rollback`, { version: 1 });
    expect(rb.status).toBe(200);
    expect(rb.body).toMatchObject({ version: 3, previous: 2, changed: true, rolled_back_to: 1 });
    expect((await get(api)).body).toMatchObject({ version: 3 });
    expect(query(journal, "SELECT author, reason FROM versions WHERE version = 3")).toEqual([
      { author: "api", reason: "rollback to v1" },
    ]);
    // The rollback is in the event stream.
    await waitFor(
      async () =>
        (await get(`${engine.gateway?.url}/api/events?pipeline=${NAME}&after=0&limit=1000`)).body.events?.some(
          (e: any) => e.type === "version.applied" && e.detail.version === 3,
        ),
      10_000,
      "version.applied event",
    );
    expect((await fetch(`${api}/rollback`)).status).toBe(405);
  }, 60_000);

  test("once stopped, versions come from the journal and a rollback says to start the pipeline", async () => {
    await engine.stop(NAME, { now: true });
    const list = await get(`${api}/versions`);
    expect(list.body).toMatchObject({ source: "journal", current: null, latest: 3 });
    const rb = await post(`${api}/rollback`, { version: 2 });
    expect(rb.status).toBe(409);
    expect(rb.body.code).toBe("invalid_state");
    const ghost = await post(`${engine.gateway?.url}/api/pipelines/ghost/rollback`, { version: 1 });
    expect(ghost.status).toBe(404);
    expect((await get(`${engine.gateway?.url}/api/pipelines/ghost/versions`)).status).toBe(404);
  }, 30_000);
});
