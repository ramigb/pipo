import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, checkProject, type Diagnostic, displayPath, ORIGIN_FILE, parseVerify, sha256 } from "../src";

const BASE = `pipo: 1
name: t
input:
  via: http
  format: json
nodes:
  a:
    from: input
    transform: map
    with: { data: { n: "\${data.n}" } }
output:
  from: a
  to: sqlite
  with: { path: ./t.db, table: t }
`;

const codes = (ds: Diagnostic[]) => ds.map((d) => d.code);
const run = (source: string) => check(source, { fs: false });
const errors = (source: string) => run(source).filter((d) => d.severity === "error");

describe("check", () => {
  test("a minimal valid pipeline passes", () => {
    expect(run(BASE)).toEqual([]);
  });

  test("YAML syntax errors (P001)", () => {
    const ds = run("pipo: 1\nname: [oops\n");
    expect(codes(ds)).toContain("P001");
    expect(ds[0]?.line).toBeGreaterThan(0);
  });

  test("schema errors point at the key and suggest fixes (P002)", () => {
    const ds = run(BASE.replace("    with: { data", "    wiht: { data"));
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ code: "P002", line: 10, col: 5, hint: "did you mean 'with'?" });
  });

  test("connector with: blocks are validated per connector", () => {
    const ds = run(BASE.replace("table: t }", "table: t, colums: {} }"));
    expect(ds[0]?.message).toContain("unknown key 'colums'");
    expect(ds[0]?.hint).toBe("did you mean 'columns'?");
  });

  test("durations are checked", () => {
    expect(run(`${BASE}lifetime: { ttl: 30 minutes }\n`)[0]?.message).toContain("must be a duration");
  });

  test("unknown from target (P010)", () => {
    const ds = errors(BASE.replace("  from: a\n  to", "  from: b\n  to"));
    expect(codes(ds)).toContain("P010");
  });

  test("cycles need a bounded loop (P022)", () => {
    const src = BASE.replace("    from: input\n", "    from: [input, b]\n").replace(
      "output:",
      "  b:\n    from: a\n    filter: data.n != null\noutput:",
    );
    expect(codes(errors(src))).toContain("P022");
  });

  test("a bounded loop back upstream is fine", () => {
    const src = BASE.replace(
      "output:\n  from: a",
      "  b:\n    from: a\n    filter: 'true'\n    loop: { back_to: a, until: data.n > 3, max: 3 }\noutput:\n  from: b",
    );
    expect(errors(src)).toEqual([]);
  });

  describe("structural codes each have a test", () => {
    const find = (src: string, code: string) => run(src).find((d) => d.code === code);
    const hasHint = (d: Diagnostic | undefined) => expect(d?.hint?.length ?? 0).toBeGreaterThan(0);
    const withNode = (extra: string) => BASE.replace("output:", `${extra}output:`);

    test("reserved node id (P015)", () => {
      const d = find(withNode("  input2: { from: a, tap: log }\n").replace("input2", "output"), "P015");
      expect(d).toBeDefined();
      hasHint(d);
    });

    test("'else' not last (P017)", () => {
      const src = withNode(
        "  r: { from: a, route: { other: else, big: data.n > 1 } }\n  x: { from: r.other, tap: log }\n  y: { from: r.big, tap: log }\n",
      );
      const d = find(src, "P017");
      expect(d).toBeDefined();
      hasHint(d);
    });

    test("loop back_to not upstream (P023) and unknown (P024)", () => {
      const loop = (target: string) =>
        withNode(
          `  b: { from: a, filter: 'true' }\n  c: { from: a, filter: 'true', loop: { back_to: ${target}, until: data.n > 3, max: 3 } }\n`,
        );
      const up = find(loop("b"), "P023");
      expect(up).toBeDefined();
      hasHint(up);
      const unknown = find(loop("nope"), "P024");
      expect(unknown).toBeDefined();
      hasHint(unknown);
    });

    test("unknown action and agent provider (P030)", () => {
      const t = find(withNode("  z: { from: a, transform: nope }\n"), "P030");
      expect(t).toBeDefined();
      hasHint(t);
      const a = find(withNode("  z: { from: a, agent: nope }\n"), "P030");
      expect(a).toBeDefined();
      hasHint(a);
      // The old name of the API provider (D66) says what it is called now.
      const old = find(withNode("  z: { from: a, agent: claude }\n"), "P030");
      expect(old?.hint).toContain("claude_api");
    });

    test("on_invalid.respond outside http (P035)", () => {
      const src = BASE.replace(
        "via: http\n  format: json",
        "via: push\n  format: json\n  on_invalid: { respond: 400 }",
      );
      const d = find(src, "P035");
      expect(d).toBeDefined();
      hasHint(d);
    });

    test("node kind count (P036)", () => {
      const none = find(withNode("  z: { from: a }\n"), "P036");
      expect(none).toBeDefined();
      hasHint(none);
      const two = find(withNode("  z: { from: a, tap: log, filter: 'true' }\n"), "P036");
      expect(two).toBeDefined();
      hasHint(two);
    });
  });

  test("dead ends and unreachable nodes (P020, P021)", () => {
    const src = BASE.replace("output:", "  stray:\n    from: a\n    tap: log\noutput:");
    expect(codes(errors(src))).toEqual(["P021"]);
  });

  test("route branches must be addressed (P016, P011, P025)", () => {
    const src = `pipo: 1
name: r
input: { via: push }
nodes:
  triage:
    from: input
    route: { urgent: data.p == 'high', normal: else }
  page:
    from: triage
    tap: log
output:
  from: [triage.normal, triage.nope]
  to: stdout
`;
    const ds = run(src);
    expect(codes(ds)).toEqual(expect.arrayContaining(["P016", "P011", "P025"]));
  });

  test("delivery check must suit the output (P031)", () => {
    const ds = errors(`${BASE}delivered: { check: file_exists }\n`);
    expect(ds[0]).toMatchObject({
      code: "P031",
      hint: "supported: ack, external, none, record_exists, row_count, query",
    });
  });

  test("check `with:` is validated against the check's fields (P002)", () => {
    const ok = `${BASE}delivered: { check: query, with: { sql: "SELECT count(*) > 0 FROM t WHERE id = ?", params: [1] } }\n`;
    expect(errors(ok)).toEqual([]);
    const bad = `${BASE}delivered: { check: query, with: { sql: "SELECT 1", mystery: true } }\n`;
    expect(codes(errors(bad))).toContain("P002");
    expect(codes(errors(`${BASE}delivered: { check: row_count, with: { min: 2 } }\n`))).toContain("P002");
  });

  test("batch must suit the output (P032)", () => {
    const src = BASE.replace("  to: sqlite\n  with: { path: ./t.db, table: t }", "  to: stdout\n  batch: { size: 10 }");
    expect(codes(errors(src))).toEqual(["P032"]);
  });

  test("then: continue only on taps (P033), then: agent needs control (P034)", () => {
    const src = BASE.replace("    with: { data", "    on_error: { then: continue }\n    with: { data").replace(
      "output:",
      "  l:\n    from: a\n    tap: log\n    on_error: { then: agent }\noutput:\n  from: l\n  to: stdout\nx_output:",
    );
    // Rename trick keeps the old output block out of the way; drop it again.
    const fixed = src.slice(0, src.indexOf("x_output:"));
    expect(codes(errors(fixed))).toEqual(["P033", "P034"]);
  });

  test("a stall handed to the agent needs control too (P034, D50)", () => {
    const stall = `${BASE}delivered: { stall: { after: 5m, then: agent } }\n`;
    expect(codes(errors(stall))).toEqual(["P034"]);
    expect(codes(errors(`${BASE}agent: { on_stall: handle }\n`))).toEqual(["P034"]);
    expect(codes(errors(`${stall}agent: { control: true, on_stall: handle }\n`))).toEqual([]);
  });

  test("expressions: syntax, availability, secrets (P040, P041, P051, P013)", () => {
    const src = BASE.replace(
      "format: json\n",
      "format: json\n  validate:\n    - data.age >\n    - result.ok\n    - secrets.x\n",
    ).replace('with: { data: { n: "${data.n}" } }', 'with: { data: { n: "${secrets.missing}" } }');
    expect(codes(errors(src))).toEqual(["P040", "P041", "P051", "P013"]);
  });

  test("sqlite columns must include the key (P037)", () => {
    const src = BASE.replace("table: t }", "table: t, columns: { name: '${data.n}' } }");
    expect(codes(errors(src))).toEqual(["P037"]);
  });

  test("literal credentials are flagged (P050)", () => {
    const src = BASE.replace("    tap", "    tap")
      .replace(
        "output:",
        "  hook:\n    from: a\n    tap: http\n    with: { url: 'https://x.test', headers: { Authorization: 'Bearer abcdefghijklmnop' } }\noutput:",
      )
      .replace("  from: a\n  to", "  from: hook\n  to");
    expect(run(src).map((d) => [d.code, d.severity])).toEqual([["P050", "warning"]]);
  });
});

describe("docs/spec.md examples", () => {
  const spec = readFileSync(join(import.meta.dir, "../../../docs/spec.md"), "utf8");
  const examples = [...spec.matchAll(/```yaml\n(pipo: 1\n[\s\S]*?)```/g)].map((m) => m[1] as string);

  test("there are full examples to check", () => {
    expect(examples.length).toBeGreaterThanOrEqual(2);
  });

  test.each(examples.map((src) => [/name: (\S+)/.exec(src)?.[1], src]))("%s passes pipo check", (_, src) => {
    const ds = run(src as string).filter((d) => d.severity === "error");
    expect(ds).toEqual([]);
  });
});

describe("schedule input (P038)", () => {
  const sched = (withBlock: string) =>
    `pipo: 1\nname: s\ninput: { via: schedule, with: ${withBlock} }\noutput: { from: input, to: stdout }\n`;
  test("valid cron and every pass", () => {
    expect(run(sched("{ cron: '*/5 9-17 * * 1-5' }"))).toEqual([]);
    expect(run(sched("{ every: 30s, payload: { a: 1 } }"))).toEqual([]);
  });
  test("needs exactly one of cron or every", () => {
    expect(codes(errors(sched("{}")))).toEqual(["P038"]);
    expect(codes(errors(sched("{ cron: '* * * * *', every: 1m }")))).toEqual(["P038"]);
  });
  test("invalid cron is reported with what is wrong", () => {
    const d = errors(sched("{ cron: '61 * * * *' }"));
    expect(codes(d)).toEqual(["P038"]);
    expect(d[0]?.message).toContain("minute");
  });
});

describe("agent.verify (P055, D48)", () => {
  const withVerify = (v: string) =>
    `pipo: 1\nname: v\ninput: { via: push }\noutput: { from: input, to: stdout }\nagent: { control: true, edit: [errors], verify: "${v}" }\n`;
  test("last N with N from 1 to 1000 passes", () => {
    for (const v of ["last 1", "last 20", "last 1000", "  last   7 "]) expect(run(withVerify(v))).toEqual([]);
    expect(parseVerify("last 20")).toBe(20);
    expect(parseVerify(" last  1000 ")).toBe(1000);
  });
  test("anything else is P055 at agent.verify, with a hint", () => {
    for (const v of ["last 0", "last 1001", "last", "20", "first 20", "last -1", "last 2.5", "last 020", "all"]) {
      const d = errors(withVerify(v));
      expect(codes(d)).toEqual(["P055"]);
      expect(d[0]?.path).toEqual(["agent", "verify"]);
      expect(d[0]?.hint).toContain("last 20");
      expect(parseVerify(v)).toBeNull();
    }
  });
});

describe("fan-out keys (P026, D22)", () => {
  const fan = (outputWith: string, extra = "") => `pipo: 1
name: f
input: { via: http }
nodes:
  a: { from: input, transform: map, with: { data: { n: "\${data.n}" } } }
  b: { from: input, tap: log }
output:
  from: [a, b]
  ${outputWith}
${extra}`;
  const warnings = (src: string) => run(src).filter((d) => d.code === "P026");

  test("the default key needs no warning", () => {
    expect(run(fan("to: sqlite\n  with: { path: ./f.db, table: t, create: true }"))).toEqual([]);
  });

  test("a key column without meta.branch is a warning", () => {
    const ds = warnings(
      fan(
        'to: sqlite\n  with: { path: ./f.db, table: t, columns: { packet_id: "${meta.packet_id}", n: "${data.n}" } }',
      ),
    );
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ severity: "warning", path: ["output", "with", "columns", "packet_id"] });
    expect(ds[0]?.message).toContain("'input' fans out to a, b");
    expect(ds[0]?.hint).toContain("meta.branch");
  });

  test("a key column using meta.branch passes", () => {
    const src = fan(
      'to: sqlite\n  with: { path: ./f.db, table: t, key: id, columns: { id: "${meta.packet_id}:${meta.branch}" } }',
    );
    expect(run(src)).toEqual([]);
  });

  test("an http Idempotency-Key header without meta.branch is a warning", () => {
    const src = fan("to: http\n  with: { url: 'https://x.test', headers: { Idempotency-Key: \"${meta.packet_id}\" } }");
    expect(warnings(src).map((d) => d.path)).toEqual([["output", "with", "headers", "Idempotency-Key"]]);
  });

  test("a delivery check that looks a copy up by meta.packet_id alone is a warning", () => {
    const src = fan(
      "to: sqlite\n  with: { path: ./f.db, table: t, create: true }",
      'delivered:\n  check: record_exists\n  with: { where: { packet_id: "${meta.packet_id}" } }\n',
    );
    expect(warnings(src).map((d) => d.path)).toEqual([["delivered", "with", "where", "packet_id"]]);
    expect(warnings(src.replace('"${meta.packet_id}"', "\"${meta.packet_id}:${meta['branch']}\""))).toEqual([]);
  });

  test("route branches are not a fan-out; a branch with two consumers is", () => {
    const routed = (consumersOfA: string) => `pipo: 1
name: r
input: { via: http }
nodes:
  r: { from: input, route: { a: "data.n > 1", else: else } }
  x: { from: ${consumersOfA}, tap: log }
  y: { from: r.else, tap: log }
output:
  from: [x, y]
  to: sqlite
  with: { path: ./f.db, table: t, columns: { packet_id: "\${meta.packet_id}" } }
`;
    expect(warnings(routed("r.a"))).toEqual([]);
    const fanned = routed("r.a")
      .replace("  y: { from: r.else", "  w: { from: r.a, tap: log }\n  y: { from: r.else")
      .replace("from: [x, y]", "from: [x, w, y]");
    expect(warnings(fanned)[0]?.message).toContain("'r.a' fans out to x, w");
  });
});

describe("untrusted fn modules (P052)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipo-p052-"));
  const home = join(dir, "home");
  const module = "export function make(d: any) { return d; }\n";
  writeFileSync(join(dir, "p.fn.ts"), module);
  const src = `pipo: 1\nname: p\nfn: ./p.fn.ts\ninput: { via: http }\nnodes:\n  x: { from: input, transform: fn.make }\noutput: { from: x, to: stdout }\n`;
  const file = join(dir, "p.pipo");
  writeFileSync(file, src);
  const marker = (hash: string) =>
    writeFileSync(
      join(dir, ORIGIN_FILE),
      JSON.stringify({ template: "t", template_hash: hash, modules: { "p.fn.ts": sha256(module) } }),
    );

  test("no provenance marker: the user's own code", () => {
    expect(check(src, { file, home })).toEqual([]);
  });

  test("marker with a template that was never trusted", () => {
    marker("h1");
    const ds = check(src, { file, home });
    expect(ds.map((d) => [d.code, d.severity])).toEqual([["P052", "error"]]);
    expect(ds[0]?.hint).toContain("pipo trust t");
  });

  test("trusted template hash passes; edited module fails again", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "trust.json"),
      JSON.stringify({ version: 1, templates: { h1: { template: "t", trusted_at: "" } } }),
    );
    expect(check(src, { file, home })).toEqual([]);
    writeFileSync(join(dir, "p.fn.ts"), `${module}// edited\n`);
    expect(check(src, { file, home }).map((d) => d.code)).toEqual(["P052"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("exec nodes (P058, P052)", () => {
  const src = (command: string) =>
    `pipo: 1\nname: e\ninput: { via: push }\nnodes:\n  x: { from: input, transform: exec, with: { command: "${command}" } }\noutput: { from: x, to: stdout }\n`;

  test("a whole command line in command is a warning", () => {
    expect(check(src("ffmpeg"))).toEqual([]);
    expect(check(src("/opt/my tools/run"))[0]).toMatchObject({ code: "P058", severity: "warning" });
    const [d] = check(src("ffmpeg -i in.mp3 out.mp4"));
    expect(d).toMatchObject({ code: "P058", severity: "warning", path: ["nodes", "x", "with", "command"] });
    expect(d?.hint).toContain("command: ffmpeg");
    expect(check(src("${data.tool}"))).toEqual([]);
  });

  test("an exec pipeline from an untrusted template", () => {
    const dir = mkdtempSync(join(tmpdir(), "pipo-p052-exec-"));
    const home = join(dir, "home");
    const file = join(dir, "e.pipo");
    writeFileSync(file, src("ffmpeg"));
    expect(check(src("ffmpeg"), { file, home })).toEqual([]);
    writeFileSync(
      join(dir, ORIGIN_FILE),
      JSON.stringify({ template: "t", template_hash: "h1", modules: { "e.pipo": sha256(src("ffmpeg")) } }),
    );
    const [d] = check(src("ffmpeg"), { file, home });
    expect(d).toMatchObject({ code: "P052", severity: "error", path: ["nodes", "x", "transform"] });
    expect(d?.message).toContain("pipeline 'e.pipo' comes from template 't'");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("schema files (P014, P054)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipo-check-schema-"));
  const src = (schema: string) => `pipo: 1
name: s
agent_budget: { per_day: 1 }
input: { via: push }
nodes:
  a:
    from: input
    agent: claude_api
    with: { model: claude-sonnet-5-5, prompt: hi, schema: ${schema} }
output: { from: a, to: stdout }
`;
  const at = (schema: string) => check(src(schema), { file: join(dir, "s.pipo") });

  test("a missing file is P014; a file that isn't JSON or isn't a JSON Schema is P054", () => {
    writeFileSync(
      join(dir, "ok.json"),
      JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }),
    );
    writeFileSync(join(dir, "text.json"), "type: object");
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ type: "nope" }));
    expect(codes(at("./ok.json"))).toEqual([]);
    expect(codes(at("./gone.json"))).toEqual(["P014"]);
    const notJson = at("./text.json");
    expect(codes(notJson)).toEqual(["P054"]);
    expect(notJson[0]?.message).toContain("not JSON");
    expect(codes(at("./bad.json"))).toEqual(["P054"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("CLI agents (D67)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipo-check-cli-"));
  writeFileSync(join(dir, "a.json"), JSON.stringify({ type: "object" }));
  const src = (agent: string, w: string, budget = "") => `pipo: 1
name: c
${budget}input: { via: push }
nodes:
  a:
    from: input
    agent: ${agent}
    with: { ${w} }
output: { from: a, to: stdout }
`;
  const at = (s: string) => check(s, { file: join(dir, "c.pipo") });

  test("each CLI agent checks clean without agent_budget (no P053) and without a model", () => {
    for (const agent of ["claude_code", "codex", "pi", "opencode"])
      expect(at(src(agent, "prompt: hi, schema: ./a.json, cwd: ., allow_tools: true, timeout: 10m"))).toEqual([]);
    // The API agent still asks for a cap.
    expect(codes(at(src("claude_api", "model: claude-sonnet-5-5, prompt: hi, schema: ./a.json")))).toEqual(["P053"]);
  });

  test("their with: is validated: no max_tokens, prompt and schema required", () => {
    expect(at(src("codex", "prompt: hi, schema: ./a.json, max_tokens: 10"))[0]?.message).toContain(
      "unknown key 'max_tokens'",
    );
    expect(codes(at(src("pi", "schema: ./a.json")))).toEqual(["P002"]);
    expect(codes(at(src("opencode", "prompt: hi, schema: ./gone.json")))).toEqual(["P014"]);
  });
});

describe("P039 duplicate listen port across a project", () => {
  const pipe = (name: string, listen?: number) =>
    `pipo: 1\nname: ${name}\ninput:\n  via: http\n${listen ? `  with:\n    listen: ${listen}\n` : ""}output:\n  from: input\n  to: stdout\n`;
  const project = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "pipo-p039-"));
    const paths = Object.entries(files).map(([n, src]) => {
      writeFileSync(join(dir, n), src);
      return join(dir, n);
    });
    return { dir, paths };
  };

  test("two files on one port: one warning on the second, naming the first", () => {
    const { dir, paths } = project({ "a.pipo": pipe("a", 8787), "b.pipo": pipe("b", 8787) });
    const [a, b] = checkProject(paths);
    expect(a?.diagnostics.filter((d) => d.code === "P039")).toEqual([]);
    const w = (b?.diagnostics ?? []).filter((d) => d.code === "P039");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: "warning", line: 6, file: paths[1] });
    expect(w[0]!.message).toContain("8787");
    expect(w[0]!.message).toContain("a.pipo");
    expect(w[0]!.hint).toContain("/in/<pipeline>");
    rmSync(dir, { recursive: true });
  });

  test("different ports, no port, and a single file: none", () => {
    const { dir, paths } = project({ "a.pipo": pipe("a", 8787), "b.pipo": pipe("b", 8788), "c.pipo": pipe("c") });
    expect(checkProject(paths).flatMap((r) => r.diagnostics.filter((d) => d.code === "P039"))).toEqual([]);
    expect(checkProject([paths[0] as string]).flatMap((r) => r.diagnostics)).toEqual([]);
    expect(check(pipe("a", 8787), { file: paths[0] }).filter((d) => d.code === "P039")).toEqual([]);
    rmSync(dir, { recursive: true });
  });
});

describe("P002 hints", () => {
  const bad = (src: string) => errors(src).filter((d) => d.code === "P002");

  test("every P002 diagnostic carries a hint", () => {
    const sources = [
      "- a\n- b\n",
      "pipo: 1\nname: x\ninput: { via: http }\n",
      BASE.replace("pipo: 1", "pipo: 2"),
      BASE.replace("name: t", "name: 5"),
      BASE.replace("input:", "bogus: 1\ninput:"),
      `${BASE}delivered: { check: nope }\n`,
      `${BASE}stall: { after: soon }\n`,
    ];
    let n = 0;
    for (const src of sources) {
      for (const d of bad(src)) {
        n++;
        expect(d.hint, `${d.message}`).toBeTruthy();
      }
    }
    expect(n).toBeGreaterThan(4);
  });

  test("hints name the missing key and the expected type", () => {
    expect(bad("pipo: 1\nname: x\ninput: { via: http }\n").some((d) => d.hint?.includes("add 'output:'"))).toBe(true);
    expect(bad(BASE.replace("name: t", "name: 5"))[0]?.hint).toContain("string");
  });
});

describe("paths outside the working directory", () => {
  test("displayPath is relative inside cwd and absolute outside", () => {
    expect(displayPath("/work/proj/a/x.pipo", "/work/proj")).toBe("a/x.pipo");
    expect(displayPath("/work/other/x.pipo", "/work/proj")).toBe("/work/other/x.pipo");
    expect(displayPath("/work/proj", "/work/proj")).toBe("/work/proj");
    expect(displayPath("/work/proj/..hidden/x", "/work/proj")).toBe("..hidden/x");
  });
});

describe("telegram (P056, P057)", () => {
  const tg = (name: string, bot?: string) =>
    `pipo: 1\nname: ${name}\ninput:\n  via: telegram\n${bot ? `  with:\n    bot: ${bot}\n` : ""}output:\n  from: input\n  to: telegram\n`;

  test("P056: two files polling one bot warn on the second", () => {
    const dir = mkdtempSync(join(tmpdir(), "pipo-p056-"));
    const paths = [tg("a"), tg("b"), tg("c", "other")].map((src, i) => {
      const p = join(dir, `${i}.pipo`);
      writeFileSync(p, src);
      return p;
    });
    const [a, b, c] = checkProject(paths);
    expect(codes(a!.diagnostics)).not.toContain("P056");
    expect(codes(c!.diagnostics)).not.toContain("P056");
    const w = b!.diagnostics.filter((d) => d.code === "P056");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: "warning" });
    expect(w[0]!.message).toContain("0.pipo");
    rmSync(dir, { recursive: true });
  });

  test("P057: a send without chat_id needs a telegram input", () => {
    expect(errors(tg("ok"))).toEqual([]);
    const http =
      "pipo: 1\nname: x\ninput: { via: http }\nnodes: { n: { from: input, tap: telegram, with: { text: hi } } }\noutput: { from: n, to: telegram }\n";
    expect(codes(errors(http))).toEqual(["P057", "P057"]);
    expect(
      errors(
        http
          .replace("text: hi", "text: hi, chat_id: 5")
          .replace("to: telegram }", "to: telegram, with: { chat_id: 5 } }"),
      ),
    ).toEqual([]);
  });
});
