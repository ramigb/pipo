// Watch input end to end (docs/spec.md §3.3): the Rust runner binary watching a folder. Glob splitting and matching,
// debouncing, retries of an unavailable intake, `read: path` and oversized files are unit-tested in
// crates/pipo-runner/src/connectors/watch.rs; restarts are in watch-replay.test.ts.
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, waitFor } from "./helpers";
import { RustRunner } from "./rust";

setDefaultTimeout(30_000);

const box = sandbox();
let running: RustRunner[] = [];
afterEach(async () => {
  for (const r of running) if (r.proc.exitCode === null) await r.kill();
  running = [];
});
afterAll(() => box.cleanup());

describe("watch input", () => {
  test("create, change and delete become journaled packets; existing files and other globs are not", async () => {
    const drop = join(box.root, "drop");
    mkdirSync(drop);
    writeFileSync(join(drop, "old.txt"), "old");
    const file = box.write(
      "wt.pipo",
      "pipo: 1\nname: wt\ninput: { via: watch, with: { path: ./drop/*.txt, read: content, events: [create, change, delete] } }\noutput: { from: input, to: stdout }\n",
    );
    const r = await RustRunner.start(box, file, "wt", { listen: null });
    running.push(r);
    const delivered = (n: number) =>
      waitFor(
        () => {
          const got = r.query<{ id: string; data: string; trigger: string; source: string }>(
            "SELECT id, data, trigger, source FROM packets WHERE state = 'delivered' ORDER BY received_at, id",
          );
          return got.length >= n ? got.map((g) => ({ ...g, data: JSON.parse(g.data) })) : null;
        },
        10_000,
        `${n} delivered watch packets`,
      );

    const f = join(drop, "n.txt");
    writeFileSync(join(drop, "skip.json"), "{}");
    writeFileSync(f, "hello");
    const [created] = await delivered(1);
    expect(created?.trigger).toBe("watch");
    expect(created?.source).toContain(`${f}#create@`);
    expect(created?.data).toMatchObject({ event: "create", path: f, name: "n.txt", content: "hello", size: 5 });
    expect(typeof created?.data.mtime).toBe("string");

    writeFileSync(f, "hello again");
    const changed = (await delivered(2))[1];
    expect(changed?.data).toMatchObject({ event: "change", content: "hello again", size: 11 });

    rmSync(f);
    const deleted = (await delivered(3))[2];
    expect(deleted?.data).toMatchObject({ event: "delete", path: f, name: "n.txt" });
    expect(deleted?.data.content).toBeUndefined();

    await Bun.sleep(300);
    const names = r.query<{ data: string }>("SELECT data FROM packets").map((p) => JSON.parse(p.data).name);
    expect(names).toEqual(["n.txt", "n.txt", "n.txt"]);
    expect(await r.stop()).toBe(0);
  });
});
