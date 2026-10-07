// Chat bots over /api/bots (docs/spec.md §3.13, §8, D69): add, list without tokens, rename, default, test, delete.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Supervisor } from "../src";
import { sandbox, testConfig } from "./helpers";

const box = sandbox();
const engines: Supervisor[] = [];
afterAll(async () => {
  for (const e of engines) await Promise.race([e.shutdown({ now: true }), Bun.sleep(10_000)]);
  box.cleanup();
});

const TOKEN = "555:very-secret-token";

describe("/api/bots", () => {
  test("tokens go in and never come out", async () => {
    const fake = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === `/bot${TOKEN}/getMe`
          ? Response.json({ ok: true, result: { id: 555, username: "pipo_bot", first_name: "Pipo" } })
          : Response.json({ ok: false, description: "Unauthorized" }, { status: 401 }),
    });
    const home = join(box.root, "home");
    const engine = await Supervisor.open({ home, config: { ...testConfig(), listen: 0 }, log: () => {} });
    engines.push(engine);
    const base = `${engine.gateway?.url}/api`;
    const post = async (path: string, body: unknown = {}) => {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as any };
    };

    expect((await post("/bots/telegram/main", { allow: [1] })).body.error).toContain("token is missing");
    const added = await post("/bots/telegram/main", {
      token: TOKEN,
      allow: [42],
      api: `http://127.0.0.1:${fake.port}`,
    });
    expect(added.status).toBe(200);
    expect(JSON.stringify(added.body)).not.toContain("very-secret");
    expect(added.body.telegram).toMatchObject({
      default: "main",
      bots: [{ name: "main", bot_id: "555", token: null, allow: [42] }],
    });
    expect(statSync(join(home, "bots.json")).mode & 0o777).toBe(0o600);

    expect((await post("/bots/telegram/main/test")).body).toMatchObject({ ok: true, username: "pipo_bot" });

    await post("/bots/telegram/alerts", { token: "env:PIPO_TEST_ALERTS" });
    const renamed = await post("/bots/telegram/main", { rename: "home", poll_every: "5s" });
    expect(renamed.body.telegram.default).toBe("home");
    expect(renamed.body.telegram.bots.find((b: any) => b.name === "alerts").token).toBe("env:PIPO_TEST_ALERTS");
    expect(JSON.parse(readFileSync(join(home, "bots.json"), "utf8")).telegram.bots.home).toMatchObject({
      token: TOKEN,
      poll_every: "5s",
    });

    expect((await post("/bots/telegram/home", { poll_every: "10ms" })).status).toBe(400);
    const left = await post("/bots/telegram/home/delete");
    expect(left.body.telegram).toMatchObject({ default: "alerts", bots: [{ name: "alerts" }] });
    expect((await post("/bots/telegram/nope/delete")).status).toBe(404);
    fake.stop(true);
  });
});
