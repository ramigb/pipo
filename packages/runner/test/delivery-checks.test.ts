// Delivery checks (docs/spec.md §3.10) through the Rust runner. The checks on each output adapter (sqlite
// record_exists/row_count/query, file exists/nonempty/line_contains/checksum, http status/follow_up, stdout's refusal)
// are unit-tested in crates/pipo-runner (connectors/sqlite_out.rs, file_out.rs, http_out.rs).
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { post, suite } from "./core";

setDefaultTimeout(30_000);
const { start } = suite();

const servers: { stop: (force?: boolean) => unknown }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const head = (name: string) => `pipo: 1\nname: ${name}\ninput: { via: http }\n`;

describe("through the runner", () => {
  test("sqlite row_count delivers", async () => {
    const r = await start(
      "rc",
      `${head("rc")}output:
  from: input
  to: sqlite
  with: { path: ./rc.db, table: t, create: true, key: id, columns: { id: "\${meta.packet_id}", n: "\${data.n}" } }
delivered:
  check: row_count
  with: { query: "SELECT 1 FROM t WHERE id = ?", params: ["\${meta.packet_id}"] }
  within: 2s
`,
    );
    const id = await post(r, { n: 1 });
    expect((await r.settled(id)).state).toBe("delivered");
  });

  test("file line_contains that fails applies on_fail", async () => {
    const r = await start(
      "lc",
      `${head("lc")}output: { from: input, to: file, with: { path: ./lc.jsonl } }
delivered:
  check: line_contains
  with: { value: "never-written" }
  within: 500ms
  on_fail: { then: dead_letter }
`,
    );
    const id = await post(r, { n: 1 });
    const row = await r.settled(id);
    expect(row.state).toBe("dead_lettered");
    expect(row.error?.code).toBe("delivery.unverified");
    expect(JSON.stringify(r.events(id))).toContain("delivery.unverified");
  });

  test("http status check", async () => {
    const srv = Bun.serve({ port: 0, fetch: () => new Response("ok", { status: 201 }) });
    servers.push(srv);
    const src = (name: string, success: string) => `${head(name)}output:
  from: input
  to: http
  with: { url: "http://127.0.0.1:${srv.port}/x", success: ["2xx"] }
delivered:
  check: status
  with: { success: [${success}] }
  within: 500ms
  on_fail: { then: dead_letter }
`;
    const good = await start("st1", src("st1", "201"));
    expect((await good.settled(await post(good, { n: 1 }))).state).toBe("delivered");

    const bad = await start("st2", src("st2", "200"));
    const row = await bad.settled(await post(bad, { n: 1 }));
    expect(row.state).toBe("dead_lettered");
    expect(row.error?.code).toBe("delivery.unverified");
  });
});
