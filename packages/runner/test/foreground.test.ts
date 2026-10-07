// Graceful stop (docs/spec.md §2.2): SIGTERM at any moment after the registry entry exists
// drains and exits 0, never a bare 143.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, spawnRunner as spawn } from "./helpers";

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
  for (const p of spawned) p.kill("SIGKILL");
  box.cleanup();
});

const spawnRunner = (file: string, n: number) => spawn(box, spawned, "term", file, n, ["--listen", "0"], 15_000);
const REGISTRY = join(box.home, "run", "term.json");

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
    const db = new Database(join(box.home, "pipelines", "term", "journal.db"), { readonly: true });
    try {
      const open = db
        .query("SELECT COUNT(*) AS n FROM packets WHERE state NOT IN ('delivered','filtered','dead_lettered')")
        .get() as {
        n: number;
      };
      expect(open.n).toBe(0);
      const last = db.query("SELECT type FROM events ORDER BY rowid DESC LIMIT 1").get() as { type: string };
      expect(last.type).toBe("pipeline.stopped");
    } finally {
      db.close();
    }
  }
}, 60_000);
