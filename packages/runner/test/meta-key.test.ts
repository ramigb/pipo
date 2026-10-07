// `meta.key` (docs/spec.md §3.2, D22, D44, D55): the packet's output key, so a `delivered.with` lookup finds each
// fan-out copy. The write and `meta.key` use one function (`outputKey`), in the runner, the dry run and `pipo test`.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { testPipeline } from "../src";
import { outputKey } from "../src/output-key";
import { rows, sandbox, settled, startRunner } from "./helpers";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function box() {
  const b = sandbox();
  cleanups.push(() => b.cleanup());
  return b;
}

const CHECK = (cols: string) => `  to: sqlite
  with: { path: ./out.db, table: items, create: true, key: id, columns: ${cols} }
delivered:
  check: row_count
  with: { query: "SELECT 1 FROM items WHERE id = ?", params: ["\${meta.key}"] }
  within: 2s
`;

async function run(b: ReturnType<typeof box>, body: string) {
  const file = b.write("mk.pipo", `pipo: 1\nname: mk\ninput: { via: http }\n${body}`);
  const r = await startRunner(file, b.home);
  cleanups.push(() => (r.runner.state === "stopped" ? undefined : r.runner.stop()));
  const res = await r.post("", { n: 1 });
  const id = ((await res.json()) as { packet_id: string }).packet_id;
  return { r, id, root: await settled(r.runner, id) };
}

describe("meta.key", () => {
  test("a fan-out pipeline's delivered lookup by meta.key finds every copy", async () => {
    const b = box();
    const { r, id, root } = await run(
      b,
      `nodes:
  a: { from: input, transform: map, with: { data: { n: "\${data.n}" } } }
  b: { from: input, transform: map, with: { data: { n: "\${data.n}" } } }
output:
  from: [a, b]
${CHECK(`{ id: "\${meta.key}", n: "\${data.n}" }`)}`,
    );
    expect(root.state).toBe("delivered");
    for (const c of r.runner.journal.copies(id)) expect(c.state).toBe("delivered");
    expect(rows(join(b.root, "out.db"), "SELECT id FROM items ORDER BY id")).toEqual([
      { id: `${id}:a` },
      { id: `${id}:b` },
    ]);
  });

  test("unbranched: meta.key is the packet id", async () => {
    const b = box();
    const { id, root } = await run(
      b,
      `output:
  from: input
${CHECK(`{ id: "\${meta.key}", n: "\${data.n}" }`)}`,
    );
    expect(root.state).toBe("delivered");
    expect(rows(join(b.root, "out.db"), "SELECT id FROM items")).toEqual([{ id }]);
  });

  test("an explicit key column is what meta.key holds, so the lookup matches what was written", async () => {
    const b = box();
    const { id, root } = await run(
      b,
      `output:
  from: input
${CHECK(`{ id: "k-\${meta.packet_id}", n: "\${data.n}" }`)}`,
    );
    expect(root.state).toBe("delivered");
    expect(rows(join(b.root, "out.db"), "SELECT id FROM items")).toEqual([{ id: `k-${id}` }]);
  });

  test("outputKey: the unit id unless sqlite columns or an http Idempotency-Key header set one", () => {
    expect(outputKey("file", {}, "p:a")).toBe("p:a");
    expect(outputKey("sqlite", { key: "id", columns: { id: "x" } }, "p")).toBe("x");
    expect(outputKey("sqlite", { columns: { n: 1 } }, "p")).toBe("p");
    expect(outputKey("http", { headers: { "idempotency-key": "h" } }, "p")).toBe("h");
    expect(outputKey("http", {}, "p:b")).toBe("p:b");
  });

  test("pipo test and its mocked write use the same key", async () => {
    const b = box();
    mkdirSync(b.home, { recursive: true });
    const file = b.write(
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
    const report = await testPipeline({ file, home: b.home, fixtures: [{ name: "fx", data: { n: 1 } }] });
    const writes = (report.fixtures[0]?.units ?? []).flatMap((u) => (u.write ? [u.write] : []));
    expect(writes.map((w) => [w.key, w.with.path])).toEqual([
      ["fx:a", "./fx:a.jsonl"],
      ["fx:b", "./fx:b.jsonl"],
    ]);
  });
});
