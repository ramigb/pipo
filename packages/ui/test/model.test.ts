// The builder's pure modules (docs/spec.md §8): pipeline model operations, diagnostics per block, undo history, and
// the shared auto-layout. They are browser ES modules without types, so they're imported dynamically.
import { describe, expect, test } from "bun:test";
import { check, load } from "@pipo/spec";
import Ajv from "ajv";

const modelPath = "../public/model.js";
const layoutPath = "../public/layout.js";
const M: any = await import(modelPath);
const L: any = await import(layoutPath);

// JSON is YAML, so the value can be checked as is. P014 (a missing file such as an agent's schema) is the user's to add.
const errors = (p: unknown) => check(JSON.stringify(p)).filter((d) => d.severity === "error" && d.code !== "P014");

describe("model", () => {
  test("a blank pipeline passes pipo check", () => {
    expect(errors(M.blankPipeline("hello"))).toEqual([]);
  });

  test("starter nodes of every kind pass pipo check once wired in", () => {
    let p = M.blankPipeline("kinds");
    const added: string[] = [];
    for (const [kind, connector] of [
      ["tap", "log"],
      ["tap", "http"],
      ["tap", "file"],
      ["tap", "emit"],
      ["tap", "exec"],
      ["transform", "map"],
      ["transform", "http"],
      ["transform", "exec"],
      ["filter", null],
      ["route", null],
    ] as const) {
      const r = M.addNode(p, kind, connector, added.at(-1) ?? "input");
      p = r.p;
      added.push(kind === "route" ? `${r.id}.yes` : r.id);
    }
    p = M.disconnect(p, "input", "output");
    p = M.connect(p, added.at(-1), "output");
    p = M.connect(p, `${added.at(-1)?.split(".")[0]}.no`, "output");
    expect(errors(p)).toEqual([]);
    expect(Object.keys(p.nodes)).toEqual([
      "log",
      "http",
      "file",
      "emit",
      "exec",
      "map",
      "http_2",
      "exec_2",
      "filter",
      "route",
    ]);
  });

  test("starter agent nodes: a model where the provider needs or knows one (D67)", () => {
    const w = (agent: string, model?: string) => {
      const { p, id } = M.addNode(M.blankPipeline("a"), "agent", agent, "input", { model });
      return p.nodes[id].with;
    };
    expect(w("claude_api").model).toBe("claude-sonnet-5-5");
    expect(w("claude_code").model).toBe("sonnet");
    expect(w("codex")).toEqual({ prompt: "Summarise this: ${data}", schema: "./summary.schema.json" });
    expect(w("codex", "gpt-5.5").model).toBe("gpt-5.5");
    expect(w("pi").model).toBeUndefined();
  });

  test("switchAgent keeps what the new provider takes, drops the rest and resets the model (D67)", () => {
    const api = { properties: { model: {}, prompt: {}, schema: {}, timeout: {}, max_tokens: {} } };
    const cli = { properties: { model: {}, prompt: {}, schema: {}, timeout: {}, cwd: {}, allow_tools: {} } };
    let p = M.addNode(M.blankPipeline("s"), "agent", "claude_api", "input").p;
    p = M.setPath(p, "nodes.claude_api.with.max_tokens", 100);
    p = M.setPath(p, "nodes.claude_api.with.timeout", "2m");
    const before = JSON.stringify(p);
    const toCodex = M.switchAgent(p, "claude_api", "codex", cli, "gpt-5.5");
    expect(JSON.stringify(p)).toBe(before);
    expect(toCodex.nodes.claude_api).toMatchObject({ agent: "codex" });
    expect(toCodex.nodes.claude_api.with).toEqual({
      model: "gpt-5.5",
      prompt: "Summarise this: ${data}",
      schema: "./summary.schema.json",
      timeout: "2m",
    });
    const toPi = M.switchAgent(M.setPath(toCodex, "nodes.claude_api.with.cwd", "./work"), "claude_api", "pi", cli);
    expect(toPi.nodes.claude_api.with).toEqual({
      prompt: "Summarise this: ${data}",
      schema: "./summary.schema.json",
      timeout: "2m",
      cwd: "./work",
    });
    const back = M.switchAgent(toPi, "claude_api", "claude_api", api);
    expect(back.nodes.claude_api.with).toEqual({
      model: "claude-sonnet-5-5",
      prompt: "Summarise this: ${data}",
      schema: "./summary.schema.json",
      timeout: "2m",
    });
    expect(M.switchAgent(p, "nope", "codex", cli)).toBe(p);
  });

  test("starter inputs and outputs pass pipo check", () => {
    for (const via of ["push", "http", "schedule", "watch", "system"]) {
      for (const to of ["stdout", "file", "sqlite", "http"]) {
        const p = M.setOutput(M.setInput(M.blankPipeline("ends"), via), to);
        expect({ via, to, errors: errors(p) }).toEqual({ via, to, errors: [] });
        expect(Object.keys(p.output)[0]).toBe("from");
      }
    }
  });

  test("operations never change their argument", () => {
    const p = M.blankPipeline("pure");
    const before = JSON.stringify(p);
    const { p: q, id } = M.addNode(p, "transform", "map");
    M.renameNode(q, id, "shape");
    M.removeNode(q, id);
    M.connect(q, id, "output");
    M.setPath(q, ["nodes", id, "with", "data"], 1);
    expect(JSON.stringify(p)).toBe(before);
  });

  test("rename keeps refs, branches and loop targets, and the node's place", () => {
    let p = M.blankPipeline("ren");
    p.nodes = {
      a: { from: "input", transform: "map", with: { data: 1 } },
      r: { from: "a", route: { big: "data > 1", small: "else" } },
      b: { from: ["r.big", "a"], transform: "map", with: { data: 2 }, loop: { back_to: "a", until: "true", max: 2 } },
    };
    p.output.from = ["r.small", "b"];
    p = M.renameNode(p, "a", "start");
    p = M.renameNode(p, "r", "split");
    expect(Object.keys(p.nodes)).toEqual(["start", "split", "b"]);
    expect(p.nodes.split.from).toBe("start");
    expect(p.nodes.b.from).toEqual(["split.big", "start"]);
    expect(p.nodes.b.loop.back_to).toBe("start");
    expect(p.output.from).toEqual(["split.small", "b"]);
    expect(M.renameProblem(p, "b", "output")).toContain("taken");
    expect(M.renameProblem(p, "b", "start")).toContain("already");
    expect(M.renameProblem(p, "b", "9x")).toContain("letters");
    expect(M.renameNode(p, "b", "start")).toBe(p);
  });

  test("remove drops every edge into and out of a node", () => {
    let p = M.blankPipeline("rm");
    p.nodes = {
      a: { from: "input", transform: "map", with: { data: 1 } },
      b: { from: ["a", "input"], transform: "map", with: { data: 2 }, loop: { back_to: "a", until: "true", max: 2 } },
    };
    p.output.from = "a";
    p = M.removeNode(p, "a");
    expect(p.nodes.b.from).toBe("input");
    expect(p.nodes.b.loop).toBeUndefined();
    expect(p.output.from).toBeUndefined();
    expect(M.removeNode(p, "input")).toBe(p);
    expect(M.removeNode(p, "b").nodes).toBeUndefined();
  });

  test("connect and disconnect keep `from` tidy and refuse nonsense", () => {
    let p = M.blankPipeline("wire");
    p = M.addNode(p, "tap", "log").p;
    expect(M.connectProblem(p, "log", "input")).toContain("input");
    expect(M.connectProblem(p, "log", "log")).toContain("itself");
    expect(M.connectProblem(p, "input", "output")).toContain("already");
    p = M.connect(p, "log", "output");
    expect(p.output.from).toEqual(["input", "log"]);
    p = M.disconnect(p, "input", "output");
    expect(p.output.from).toBe("log");
    expect(M.edges(p)).toEqual([
      { from: "input", branch: null, to: "log", ref: "input" },
      { from: "log", branch: null, to: "output", ref: "log" },
    ]);
  });

  test("route branches: ports, rename and remove carry their edges", () => {
    let p = M.addNode(M.blankPipeline("br"), "route", null).p;
    expect(M.outPorts(p, "route")).toEqual(["yes", "no"]);
    expect(M.outPorts(p, "output")).toEqual([]);
    p = M.connect(p, "route.yes", "output");
    p = M.renameBranch(p, "route", "yes", "ok");
    expect(Object.keys(p.nodes.route.route)).toEqual(["ok", "no"]);
    expect(p.output.from).toEqual(["input", "route.ok"]);
    p = M.removeBranch(p, "route", "ok");
    expect(p.output.from).toBe("input");
  });

  test("fresh ids, slugs, paths", () => {
    const p = { pipo: 1, name: "x", nodes: { map: {}, map_2: {} } };
    expect(M.freshId(p, "map")).toBe("map_3");
    expect(M.freshId(p, "output")).toBe("output_1");
    expect(M.freshId(p, "fn.clean up")).toBe("fn_clean_up");
    expect(M.slug("My Cool Pipe!")).toBe("my-cool-pipe");
    expect(M.slug("")).toBe("my-pipeline");
    const q = M.setPath({}, "a.b.c", 1);
    expect(q).toEqual({ a: { b: { c: 1 } } });
    expect(M.getPath(q, "a.b.c")).toBe(1);
    expect(M.setPath(q, "a.b.c", undefined)).toEqual({ a: { b: {} } });
  });

  test("blocks and diagnostics by block", () => {
    const src =
      "pipo: 1\nname: d\ninput: { via: push }\nnodes:\n  a: { from: nope, transform: map, with: { data: 1 } }\noutput: { from: a, to: stdout }\n";
    const p = load(src).value;
    expect(M.blocks(p).map((b: any) => `${b.kind}:${b.id}`)).toEqual(["input:input", "transform:a", "output:output"]);
    const by = M.diagnosticsByBlock(check(src));
    expect(by.get("a")?.map((d: any) => d.code)).toContain("P010");
  });

  test("history undoes and redoes, and forgets the redo branch on a new edit", () => {
    const h = new M.History(1);
    h.push(2);
    h.push(3);
    expect(h.undo()).toBe(2);
    expect(h.undo()).toBe(1);
    expect(h.canUndo).toBe(false);
    expect(h.redo()).toBe(2);
    h.push(9);
    expect(h.canRedo).toBe(false);
    expect(h.stack).toEqual([1, 2, 9]);
  });
});

describe("layout", () => {
  test("layers follow `from`, and short columns are centred", () => {
    const nodes = [
      { id: "input", from: [] },
      { id: "a", from: [{ node: "input" }] },
      { id: "b", from: [{ node: "input" }] },
      { id: "output", from: [{ node: "a" }, { node: "b" }] },
    ];
    const { pos, width, height } = L.autoLayout(nodes, { w: 100, h: 50, gx: 20, gy: 10, pad: 0 });
    expect(pos.get("input").x).toBe(0);
    expect(pos.get("a").x).toBe(120);
    expect(pos.get("b").y).toBe(60);
    expect(pos.get("output").x).toBe(240);
    expect(pos.get("input").y).toBe(30);
    expect(width).toBe(340);
    expect(height).toBe(110);
  });

  test("a loop back up the graph doesn't recurse forever", () => {
    const nodes = [
      { id: "a", from: [{ node: "b" }] },
      { id: "b", from: [{ node: "a" }] },
    ];
    expect(L.autoLayout(nodes).pos.size).toBe(2);
  });

  test("edges run right, and swing below for a backwards hop", () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 100, y: 0, w: 10, h: 10 };
    expect(L.edgePath(a, b)).toStartWith("M10,5 C");
    expect(L.edgePath(b, a)).toContain(" S");
  });
});

describe("schemas", () => {
  const valid = (schema: any, value: unknown) => new Ajv({ strict: false }).compile(schema)(value);

  test("a starter agent schema is named after its file, and its example matches it", () => {
    const s = M.starterSchema("./summary.schema.json");
    expect(s.required).toEqual(["summary"]);
    expect(valid(s, M.exampleOf(s))).toBe(true);
    expect(M.starterSchema("./my answer.json").required).toEqual(["answer"]);
    expect(M.starterSchema("./x.json", "input")).toEqual({ type: "object", description: expect.any(String) });
  });

  test("examples match common schema shapes", () => {
    const schema = {
      type: "object",
      properties: {
        label: { enum: ["urgent", "normal"] },
        score: { type: "number", minimum: 0.5 },
        count: { type: "integer", exclusiveMinimum: 2 },
        tags: { type: "array", items: { type: "string", minLength: 3 }, minItems: 2 },
        when: { type: "string", format: "date-time" },
        maybe: { type: ["null", "boolean"] },
        nested: { properties: { ok: { const: true } } },
        either: { oneOf: [{ type: "string" }, { type: "number" }] },
      },
      required: ["label", "score", "count", "tags", "when", "maybe", "nested", "either"],
      additionalProperties: false,
    };
    const ex = M.exampleOf(schema);
    expect(ex.label).toBe("urgent");
    expect(ex.tags).toEqual(["xxx", "xxx"]);
    expect(valid(schema, ex)).toBe(true);
    expect(M.exampleOf(null)).toBeNull();
  });
});

describe("data shapes (D70)", () => {
  const inputs = { telegram: { sample: { text: "hello", from: { id: 1, name: "Ada" } } } };
  const ctx = (schemas: Record<string, unknown> = {}) => ({ inputs, schemaOf: (rel: string) => schemas[rel] ?? null });
  const p: any = {
    input: { via: "telegram" },
    nodes: {
      log: { tap: "log", from: "input" },
      shape: {
        transform: "map",
        from: "log",
        with: { data: { who: "${data.from.name}", says: "${data.text}!", n: 1 } },
      },
      ask: { agent: "claude_code", from: "shape", with: { schema: "./a.json" } },
      call: { transform: "http", from: "input" },
    },
    output: { to: "stdout", from: ["call", "ask"] },
  };

  test("the input's sample passes through taps, and map renders its template against it", () => {
    expect(M.shapeOut(p, "input", ctx())).toEqual(inputs.telegram.sample);
    expect(M.shapeIn(p, "shape", ctx())).toEqual(inputs.telegram.sample);
    expect(M.shapeOut(p, "shape", ctx())).toEqual({ who: "Ada", says: "hello!", n: 1 });
  });

  test("an input or agent schema file wins; unknown steps fall through to the next parent", () => {
    const schemas = { "./a.json": { type: "object", properties: { label: { enum: ["ok"] } } } };
    expect(M.shapeIn(p, "output", ctx(schemas))).toEqual({ label: "ok" });
    expect(M.shapeIn(p, "output", ctx())).toBeNull();
    const withSchema = { ...p, input: { via: "http", schema: "./in.json" } };
    expect(
      M.shapeOut(withSchema, "input", ctx({ "./in.json": { properties: { email: { type: "string" } } } })),
    ).toEqual({
      email: "example",
    });
    expect(M.shapeOut({ input: { via: "schedule", with: { payload: { job: "x" } } } }, "input", ctx())).toEqual({
      job: "x",
    });
  });

  test("a cycle ends as unknown, and paths list every field", () => {
    const loop: any = { input: { via: "push" }, nodes: { a: { tap: "log", from: "b" }, b: { tap: "log", from: "a" } } };
    expect(M.shapeIn(loop, "a", ctx())).toBeNull();
    expect(M.dataPaths({ from: { id: 1 }, items: [{ x: 1 }], "odd key": 2 })).toEqual([
      "data",
      "data.from",
      "data.from.id",
      "data.items",
      "data.items[0]",
      "data.items[0].x",
      'data["odd key"]',
    ]);
  });
});
