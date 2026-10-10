// `meta.key` (docs/spec.md §3.2, D22, D44, D55): the packet's output key, so a `delivered.with` lookup finds each
// fan-out copy. The write and `meta.key` use one function (`output_key`, crates/pipo-runner/src/output_key.rs, unit
// tested there), in the runner, the dry run and `pipo test`.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { post, runnerTest, suite } from "./core";
import { rows } from "./helpers";

setDefaultTimeout(30_000);
const { box, start } = suite();

let n = 0;
const CHECK = (name: string, cols: string) => `  to: sqlite
  with: { path: ./${name}.db, table: items, create: true, key: id, columns: ${cols} }
delivered:
  check: row_count
  with: { query: "SELECT 1 FROM items WHERE id = ?", params: ["\${meta.key}"] }
  within: 2s
`;

async function run(body: (name: string) => string) {
  const name = `mk${++n}`;
  const r = await start(name, `pipo: 1\nname: ${name}\ninput: { via: http }\n${body(name)}`);
  const id = await post(r, { n: 1 });
  return {
    r,
    id,
    root: await r.settled(id),
    written: () => rows(join(box.root, `${name}.db`), "SELECT id FROM items ORDER BY id"),
  };
}

describe("meta.key", () => {
  test("a fan-out pipeline's delivered lookup by meta.key finds every copy", async () => {
    const { r, id, root, written } = await run(
      (name) => `nodes:
  a: { from: input, transform: map, with: { data: { n: "\${data.n}" } } }
  b: { from: input, transform: map, with: { data: { n: "\${data.n}" } } }
output:
  from: [a, b]
${CHECK(name, `{ id: "\${meta.key}", n: "\${data.n}" }`)}`,
    );
    expect(root.state).toBe("delivered");
    const copies = r.query<{ state: string }>("SELECT state FROM packets WHERE root = ?", id);
    expect(copies.map((c) => c.state)).toEqual(["delivered", "delivered"]);
    expect(written()).toEqual([{ id: `${id}:a` }, { id: `${id}:b` }]);
  });

  test("unbranched: meta.key is the packet id", async () => {
    const { id, root, written } = await run(
      (name) => `output:
  from: input
${CHECK(name, `{ id: "\${meta.key}", n: "\${data.n}" }`)}`,
    );
    expect(root.state).toBe("delivered");
    expect(written()).toEqual([{ id }]);
  });

  test("an explicit key column is what meta.key holds, so the lookup matches what was written", async () => {
    const { id, root, written } = await run(
      (name) => `output:
  from: input
${CHECK(name, `{ id: "k-\${meta.packet_id}", n: "\${data.n}" }`)}`,
    );
    expect(root.state).toBe("delivered");
    expect(written()).toEqual([{ id: `k-${id}` }]);
  });

  test("pipo test and its mocked write use the same key", async () => {
    mkdirSync(box.home, { recursive: true });
    const file = box.write(
      "t.pipo",
      `pipo: 1
name: t
input: { via: http }
nodes:
  a: { from: input, transform: map, with: { data: { n: "\${data.n}" } } }
  b: { from: input, transform: map, with: { data: { n: "\${data.n}" } } }
output:
  from: [a, b]
  to: file
  with: { path: "./\${meta.key}.jsonl" }
`,
    );
    const reply = await runnerTest(box, { file, home: box.home, fixtures: [{ name: "fx", data: { n: 1 } }] });
    expect(reply.error).toBeUndefined();
    const units: { write?: { key: string; with: { path: string } } }[] = reply.report.fixtures[0]?.units ?? [];
    const writes = units.flatMap((u) => (u.write ? [u.write] : []));
    expect(writes.map((w) => [w.key, w.with.path])).toEqual([
      ["fx:a", "./fx:a.jsonl"],
      ["fx:b", "./fx:b.jsonl"],
    ]);
  });
});
