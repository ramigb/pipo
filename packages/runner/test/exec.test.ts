// exec steps end to end (docs/spec.md §3.5): the Rust runner binary running programs as a transform and a tap. The
// step itself (args with no shell, stdin, env, cwd, result formats, timeouts, listed outputs, redaction) is
// unit-tested in crates/pipo-runner/src/connectors/exec.rs.
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./helpers";
import { RustRunner } from "./rust";

setDefaultTimeout(30_000);

const box = sandbox();
let running: RustRunner[] = [];
afterEach(async () => {
  for (const r of running) if (r.proc.exitCode === null) await r.kill();
  running = [];
});
afterAll(() => box.cleanup());

async function start(name: string, nodes: string, env: Record<string, string> = {}, head = "") {
  const file = box.write(
    `${name}.pipo`,
    `pipo: 1\nname: ${name}\n${head}input: { via: push }\nnodes:\n${nodes}\noutput: { from: n, to: stdout }\n`,
  );
  const r = await RustRunner.start(box, file, name, { listen: null, env });
  running.push(r);
  return r;
}

describe("exec in a pipeline", () => {
  test("transform exec turns a packet into the program's result", async () => {
    const r = await start(
      "ex",
      `  n:\n    from: input\n    transform: exec\n    with: { command: sh, args: ["-c", "echo \${data.a} > out/\${meta.packet_id}.txt; echo done"], outputs: ["out/\${meta.packet_id}.txt"] }`,
    );
    const { packet_id: id } = await r.push({ a: 7 });
    const row = await r.settled(id);
    expect(row.state).toBe("delivered");
    expect(row.data).toMatchObject({ exit_code: 0, stdout: "done\n", files: [join(box.root, `out/${id}.txt`)] });
  });

  test("a failing program dead-letters with its exit code and stderr, and secrets are redacted", async () => {
    const r = await start(
      "exfail",
      `  n:\n    from: input\n    transform: exec\n    with: { command: sh, args: ["-c", "echo \\"bad \${secrets.key}\\" >&2; exit 3"] }`,
      { PIPO_TEST_EXEC_KEY: "exec-s3cret" },
      "secrets: { key: env:PIPO_TEST_EXEC_KEY }\n",
    );
    const { packet_id: id } = await r.push({});
    const row = await r.settled(id);
    expect(row.state).toBe("dead_lettered");
    expect(row.error?.message).toContain("sh exited with code 3: bad ***");
    expect(JSON.stringify(r.query("SELECT detail FROM events"))).not.toContain("exec-s3cret");
  });

  test("a program that isn't installed refuses the start; a path to a program in the folder starts", async () => {
    const file = box.write(
      "missing.pipo",
      "pipo: 1\nname: missing\ninput: { via: push }\nnodes:\n  n: { from: input, tap: exec, with: { command: pipo-no-such-program } }\noutput: { from: n, to: stdout }\n",
    );
    const res = await RustRunner.refuse(box, file);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("'pipo-no-such-program' is not installed or not on PATH");
    writeFileSync(join(box.root, "tool.sh"), "#!/bin/sh\necho tapped\n", { mode: 0o755 });
    const r = await start("ok", "  n: { from: input, tap: exec, with: { command: ./tool.sh } }");
    const { packet_id: id } = await r.push({ keep: true });
    const row = await r.settled(id);
    // A tap leaves the packet's data as it was.
    expect(row.data).toEqual({ keep: true });
  });
});
