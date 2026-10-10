// Graceful stop (docs/spec.md §2.2): SIGTERM at any moment after the registry entry exists
// drains and exits 0, never a bare 143. `pipo run` (runForeground) forwards SIGINT/SIGTERM to the runner binary
// and exits with its code.
import { Database } from "bun:sqlite";
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runnerEnv } from "../src/binary";
import { sandbox, spawnRunner as spawn, waitFor } from "./helpers";

setDefaultTimeout(60_000);

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
const runnerPids: number[] = [];
afterAll(() => {
  for (const p of spawned) p.kill("SIGKILL");
  for (const pid of runnerPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  box.cleanup();
});

const spawnRunner = (file: string, n: number) => spawn(box, spawned, "term", file, n, ["--listen", "0"], 15_000);
const REGISTRY = join(box.home, "run", "term.json");

function assertDrained(name: string) {
  const db = new Database(join(box.home, "pipelines", name, "journal.db"), { readonly: true });
  try {
    const open = db
      .query("SELECT COUNT(*) AS n FROM packets WHERE state NOT IN ('delivered','filtered','dead_lettered')")
      .get() as { n: number };
    expect(open.n).toBe(0);
    const last = db.query("SELECT type FROM events ORDER BY rowid DESC LIMIT 1").get() as { type: string };
    expect(last.type).toBe("pipeline.stopped");
  } finally {
    db.close();
  }
}

test("SIGTERM right after the registry entry appears drains and exits 0", async () => {
  const file = box.write(
    "term.pipo",
    "pipo: 1\nname: term\ninput: { via: http }\noutput: { from: input, to: stdout }\n",
  );
  for (let n = 0; n < 4; n++) {
    const { proc, log } = await spawnRunner(file, n);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    expect(existsSync(REGISTRY)).toBe(false);
    expect(readFileSync(log, "utf8")).toContain("stopped");
    assertDrained("term");
  }
});

const FOREGROUND = join(import.meta.dir, "../src/foreground.ts");
const ENTRY = box.write(
  "entry.ts",
  `import { runForeground } from ${JSON.stringify(FOREGROUND)};
const [file, home] = process.argv.slice(2);
process.exit(await runForeground({ file, home, listen: 0 }));
`,
);

/** `pipo run` as the CLI does it: a Bun process around runForeground, output to a log file. */
async function foreground(name: string, source: string) {
  const file = box.write(`${name}.pipo`, source);
  const log = join(box.root, `${name}-fg.log`);
  const proc = Bun.spawn([process.execPath, ENTRY, file, box.home], {
    stdout: Bun.file(log),
    stderr: Bun.file(`${log}.err`),
    env: runnerEnv(),
  });
  spawned.push(proc);
  return { proc, log, registry: join(box.home, "run", `${name}.json`) };
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  test(`runForeground forwards ${sig}: the runner drains, delivers what it accepted and exits 0`, async () => {
    const name = `fg${sig.toLowerCase()}`;
    const { proc, log, registry } = await foreground(
      name,
      `pipo: 1\nname: ${name}\ninput: { via: http }\noutput: { from: input, to: stdout }\n`,
    );
    const entry = await waitFor(
      () => {
        if (proc.exitCode !== null) throw new Error(`exited ${proc.exitCode}: ${readFileSync(`${log}.err`, "utf8")}`);
        return existsSync(registry)
          ? (JSON.parse(readFileSync(registry, "utf8")) as { pid: number; listen: number })
          : null;
      },
      30_000,
      "registry entry",
    );
    runnerPids.push(entry.pid);
    // The runner is a child of the Bun process, in its own process group.
    expect(entry.pid).not.toBe(proc.pid);
    const res = await fetch(`http://127.0.0.1:${entry.listen}/in/${name}`, { method: "POST", body: '{"hello":1}' });
    expect(res.status).toBe(202);
    proc.kill(sig);
    expect(await proc.exited).toBe(0);
    expect(existsSync(registry)).toBe(false);
    const out = readFileSync(log, "utf8");
    expect(out).toContain('"hello":1');
    expect(out).toContain("stopped");
    assertDrained(name);
  });
}

test("runForeground exits with the runner's code: 1 when the pipeline can't start", async () => {
  const { proc, log } = await foreground(
    "fgbad",
    "pipo: 1\nname: fgbad\ninput: { via: http }\noutput: { from: nowhere, to: stdout }\n",
  );
  expect(await proc.exited).toBe(1);
  expect(readFileSync(`${log}.err`, "utf8")).toContain("P010");
});
