// Several inputs (docs/spec.md §3.3.1, D76): each input is its own edge with its own rules, http inputs share the
// runner's listener, every packet keeps its input (meta.input, packets.input), and push names the input.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { out, suite } from "./core";

setDefaultTimeout(30_000);
const { box: b, start } = suite();

const MULTI = (name: string) => `pipo: 1
name: ${name}
inputs:
  people:
    via: http
    with: { path: /people }
    validate: [data.age >= 18]
  notes:
    via: http
    format: text
    with: { path: /notes }
  manual:
    via: push
nodes:
  stamp:
    from: [people, notes, manual]
    transform: map
    with: { data: { body: "\${json(data)}", input: "\${meta.input}", trigger: "\${meta.trigger}" } }
output:
  from: stamp
  to: sqlite
  with: { path: ./${name}.db, table: items, create: true }
`;

describe("several inputs", () => {
  test("http inputs share one listener; each packet carries its input; push picks its input", async () => {
    const r = await start("multi", MULTI("multi"));
    expect(r.lines().join("\n")).toContain("inputs: people: POST http://");
    const adult = await r.post("/people", { age: 30 });
    expect(adult.status).toBe(202);
    const note = await fetch(r.url("/notes"), { method: "POST", body: "hello" });
    expect(note.status).toBe(202);
    const pushed = await r.push({ age: 5 });
    const idOf = async (res: Response) => ((await res.json()) as { packet_id: string }).packet_id;
    for (const id of [await idOf(adult), await idOf(note), pushed.packet_id])
      expect((await r.settled(id)).state).toBe("delivered");
    const rows = out(b.root, "multi.db", "SELECT input, trigger FROM items ORDER BY input");
    expect(rows).toEqual([
      { input: "manual", trigger: "push" },
      { input: "notes", trigger: "http" },
      { input: "people", trigger: "http" },
    ]);
    expect(r.query("SELECT input, count(*) AS n FROM packets GROUP BY input ORDER BY input")).toEqual([
      { input: "manual", n: 1 },
      { input: "notes", n: 1 },
      { input: "people", n: 1 },
    ]);
    // The accepted event names the input, so a trace shows where the packet came in.
    expect(r.events(pushed.packet_id)[0]).toMatchObject({ type: "packet.accepted", node: "manual" });
    const unknown = await r.request("push", { data: {}, input: "nope" }).catch((e) => e);
    expect(unknown).toMatchObject({ code: "bad_request" });
    expect(String(unknown.hint)).toContain("people, notes, manual");
    const nowhere = await fetch(r.url("/other"), { method: "POST", body: "{}" });
    expect(nowhere.status).toBe(404);
    expect(((await nowhere.json()) as { hint: string }).hint).toContain("/in/multi/notes");
  });

  test("each input applies its own rules; a rejection names the input", async () => {
    const r = await start("rules", MULTI("rules"));
    const young = await r.post("/people", { age: 12 });
    expect(young.status).toBe(422);
    const id = ((await young.json()) as { packet_id: string }).packet_id;
    expect(r.packet(id)).toMatchObject({ state: "rejected", input: "people" });
    expect(r.packet(id)?.error).toMatchObject({ node: "people", code: "input.invalid" });
    // The same data through the push input has no such rule.
    const ok = await r.request("push", { data: { age: 12 }, input: "manual" });
    expect((await r.settled(ok.packet_id)).state).toBe("delivered");
  });

  test("push without input is refused when it can't tell which one", async () => {
    const r = await start(
      "two-push",
      `pipo: 1
name: two-push
inputs:
  a: { via: push }
  b: { via: push }
output: { from: [a, b], to: stdout }
`,
      { listen: null },
    );
    const e = await r.push({}).catch((x) => x);
    expect(e).toMatchObject({ code: "bad_request" });
    expect(String(e.hint)).toContain("a, b");
    const ok = await r.request("push", { data: {}, input: "b" });
    expect((await r.settled(ok.packet_id)).input).toBe("b");
  });

  test("live apply: an input's rules may change; adding an input needs a restart", async () => {
    const r = await start("live", MULTI("live"));
    const changed = MULTI("live").replace("data.age >= 18", "data.age >= 21");
    const applied = await r.request("apply", { source: changed, reason: "older", by: "test" });
    expect(applied).toMatchObject({ changed: true });
    const refused = await r
      .request("apply", {
        source: changed
          .replace("  manual:\n", "  extra:\n    via: push\n  manual:\n")
          .replace("[people, notes, manual]", "[people, notes, manual, extra]"),
        by: "test",
      })
      .catch((e) => e);
    expect(refused).toMatchObject({ code: "invalid_state" });
    expect(String(refused.message)).toContain("inputs.extra");
  });
});
