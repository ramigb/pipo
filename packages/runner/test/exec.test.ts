import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StartError } from "../src";
import { ExecStep } from "../src/connectors/exec";
import { sandbox, settled, startRunner } from "./helpers";

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

const call = (step: ExecStep, w: Record<string, unknown>) =>
  step.run({ packetId: "p1", node: "n", data: { a: 1 }, with: w });

describe("exec step", () => {
  test("result info: exit code, stdout, stderr, files", async () => {
    const b = box();
    const res = await call(new ExecStep(b.root, true), {
      command: "sh",
      args: ["-c", "echo hi; echo oops >&2; echo x > out/p1.txt"],
      outputs: ["out/p1.txt"],
    });
    expect(res.data).toMatchObject({
      exit_code: 0,
      stdout: "hi\n",
      stderr: "oops\n",
      files: [join(b.root, "out/p1.txt")],
    });
  });

  test("args are passed as they are, with no shell", async () => {
    const b = box();
    const res = await call(new ExecStep(b.root, true), {
      command: "printf",
      args: ["%s|", "a b", "$(echo no)", "'q'"],
      result: "text",
    });
    expect(res.data).toBe("a b|$(echo no)|'q'|");
  });

  test("result json, stdin, env and cwd", async () => {
    const b = box();
    mkdirSync(join(b.root, "sub"));
    const res = await call(new ExecStep(b.root, true), {
      command: "sh",
      args: ["-c", 'read x; printf \'{"in":"%s","env":"%s","cwd":"%s"}\' "$x" "$GREETING" "$(pwd -P)"'],
      stdin: "hello\n",
      env: { GREETING: "hey" },
      cwd: "sub",
      result: "json",
    });
    expect(res.data).toEqual({ in: "hello", env: "hey", cwd: join(b.root, "sub") });
  });

  test("a failing exit code is an error with stderr; success widens it", async () => {
    const b = box();
    const step = new ExecStep(b.root, true);
    const w = { command: "sh", args: ["-c", "echo broken >&2; exit 3"] };
    expect(call(step, w)).rejects.toThrow("sh exited with code 3: broken");
    expect((await call(step, { ...w, success: [0, 3] })).data).toMatchObject({ exit_code: 3 });
  });

  test("timeout kills the program", async () => {
    const b = box();
    const t0 = Date.now();
    const err = (await call(new ExecStep(b.root, false), {
      command: "sh",
      args: ["-c", "sleep 10"],
      timeout: "200ms",
    }).catch((e) => e)) as Error;
    expect(err.message).toContain("after the 200ms timeout");
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  test("a listed output the program didn't write is an error", async () => {
    const b = box();
    const err = (await call(new ExecStep(b.root, true), { command: "true", outputs: ["out/x.mp4"] }).catch(
      (e) => e,
    )) as Error;
    expect(err.message).toContain(`did not write ${join(b.root, "out/x.mp4")}`);
    expect(existsSync(join(b.root, "out"))).toBe(true);
  });

  test("a missing program, a tap and redaction", async () => {
    const b = box();
    expect(call(new ExecStep(b.root, true), { command: "pipo-no-such-program" })).rejects.toThrow(
      "could not be started",
    );
    expect(await call(new ExecStep(b.root, false), { command: "true" })).toEqual({});
    const redacted = await call(new ExecStep(b.root, true, (s) => s.replaceAll("s3cret", "***")), {
      command: "echo",
      args: ["s3cret"],
      result: "text",
    });
    expect(redacted.data).toBe("***\n");
  });
});

describe("exec in a pipeline", () => {
  test("transform exec turns a packet into the program's result", async () => {
    const b = box();
    const file = b.write(
      "t.pipo",
      `pipo: 1\nname: ex\ninput: { via: http }\nnodes:\n  n:\n    from: input\n    transform: exec\n    with: { command: sh, args: ["-c", "echo \${data.a} > out/\${meta.packet_id}.txt"], outputs: ["out/\${meta.packet_id}.txt"] }\noutput: { from: n, to: stdout }\n`,
    );
    const r = await startRunner(file, b.home);
    cleanups.push(() => r.runner.stop());
    const id = ((await (await r.post("/", { a: 7 })).json()) as any).packet_id as string;
    const row = await settled(r.runner, id);
    expect(row.state).toBe("delivered");
    expect((row.data as any).files).toEqual([join(b.root, `out/${id}.txt`)]);
  });

  test("a program that isn't installed refuses the start", async () => {
    const b = box();
    const file = b.write(
      "t.pipo",
      "pipo: 1\nname: ex\ninput: { via: push }\nnodes:\n  n: { from: input, tap: exec, with: { command: pipo-no-such-program } }\noutput: { from: n, to: stdout }\n",
    );
    const err = (await startRunner(file, b.home).catch((e) => e)) as StartError;
    expect(err).toBeInstanceOf(StartError);
    expect(err.message).toContain("'pipo-no-such-program' is not installed or not on PATH");
    writeFileSync(join(b.root, "tool.sh"), "#!/bin/sh\n", { mode: 0o755 });
    const ok = b.write(
      "ok.pipo",
      "pipo: 1\nname: ok\ninput: { via: push }\nnodes:\n  n: { from: input, tap: exec, with: { command: ./tool.sh } }\noutput: { from: n, to: stdout }\n",
    );
    const r = await startRunner(ok, b.home);
    cleanups.push(() => r.runner.stop());
  });
});
