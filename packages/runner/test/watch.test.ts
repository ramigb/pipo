import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load, type Pipeline } from "@pipo/spec";
import { gaps, Runner } from "../src";
import type { IntakeResult } from "../src/connectors/types";
import { MAX_CONTENT_BYTES, splitGlob, WatchInput } from "../src/connectors/watch-input";
import { rows, sandbox, waitFor } from "./helpers";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function setup(opts: Partial<ConstructorParameters<typeof WatchInput>[0]> & { path: string }) {
  const box = sandbox();
  const dir = join(box.root, "in");
  mkdirSync(dir);
  const got: { data: any; origin: any }[] = [];
  const input = new WatchInput({ dir, debounceMs: 10, pollMs: 50, ...opts });
  cleanups.push(
    () => input.stop(),
    () => box.cleanup(),
  );
  const start = (result: () => IntakeResult = () => ({ status: "accepted", packet_id: "p" })) =>
    input.start(async (data, origin) => {
      got.push({ data, origin });
      return result();
    });
  return { dir, got, input, start };
}

describe("watch input", () => {
  test("has no gaps", () => {
    const p = load(
      "pipo: 1\nname: w\ninput: { via: watch, with: { path: ./in/*.txt } }\noutput: { from: input, to: stdout }\n",
    ).value as Pipeline;
    expect(gaps(p)).toEqual([]);
  });

  test("splits globs into folder and pattern", () => {
    expect(splitGlob("./in/**/*.txt", "/a")).toEqual({ base: "/a/in", rest: "**/*.txt" });
    expect(splitGlob("/x/y.txt", "/a")).toEqual({ base: "/x", rest: "y.txt" });
    const s = sandbox();
    cleanups.push(() => rmSync(s.root, { recursive: true, force: true }));
    mkdirSync(join(s.root, "inbox"));
    expect(splitGlob("./inbox", s.root)).toEqual({ base: join(s.root, "inbox"), rest: "**/*" });
  });

  test("create, change and delete produce packets with content; existing files are baseline", async () => {
    const t = setup({ path: "*.txt", read: "content", events: ["create", "change", "delete"] });
    writeFileSync(join(t.dir, "old.txt"), "old");
    await t.start();
    const f = join(t.dir, "a.txt");
    writeFileSync(f, "one");
    await waitFor(() => t.got.length >= 1, 5000, "create");
    expect(t.got[0]?.data).toMatchObject({ event: "create", path: f, name: "a.txt", content: "one", size: 3 });
    expect(t.got[0]?.origin.trigger).toBe("watch");
    expect(t.got[0]?.origin.source).toContain(`${f}#create@`);
    writeFileSync(f, "two!");
    await waitFor(() => t.got.length >= 2, 5000, "change");
    expect(t.got[1]?.data).toMatchObject({ event: "change", content: "two!" });
    rmSync(f);
    await waitFor(() => t.got.length >= 3, 5000, "delete");
    expect(t.got[2]?.data).toMatchObject({ event: "delete", path: f });
    expect(t.got[2]?.data.content).toBeUndefined();
    expect(t.got.some((g) => g.data.name === "old.txt")).toBe(false);
  });

  test("read: path sends metadata only, and events filters", async () => {
    const t = setup({ path: "*.txt", read: "path", events: ["create"] });
    await t.start();
    const f = join(t.dir, "a.txt");
    writeFileSync(f, "one");
    await waitFor(() => t.got.length >= 1, 5000, "create");
    expect(t.got[0]?.data.content).toBeUndefined();
    expect(typeof t.got[0]?.data.mtime).toBe("string");
    writeFileSync(f, "changed");
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    await Bun.sleep(300);
    expect(t.got.length).toBe(1);
  });

  test("glob filtering, including subfolders", async () => {
    const t = setup({ path: "**/*.json" });
    await t.start();
    mkdirSync(join(t.dir, "sub"));
    writeFileSync(join(t.dir, "skip.txt"), "x");
    writeFileSync(join(t.dir, "sub", "deep.json"), "{}");
    writeFileSync(join(t.dir, "top.json"), "{}");
    await waitFor(() => t.got.length >= 2, 5000, "two json files");
    await Bun.sleep(200);
    expect(t.got.map((g) => g.data.name).sort()).toEqual(["sub/deep.json", "top.json"]);
  });

  test("a burst of writes to one file collapses into one event", async () => {
    const t = setup({ path: "*.txt", debounceMs: 100 });
    await t.start();
    const f = join(t.dir, "a.txt");
    for (let i = 0; i < 5; i++) {
      writeFileSync(f, `v${i}`);
      await Bun.sleep(5);
    }
    await Bun.sleep(500);
    expect(t.got.length).toBe(1);
  });

  test("an event the runner could not take is retried", async () => {
    const t = setup({ path: "*.txt" });
    let open = false;
    await t.start(() => (open ? { status: "accepted", packet_id: "p" } : { status: "unavailable", reason: "paused" }));
    writeFileSync(join(t.dir, "a.txt"), "x");
    await waitFor(() => t.got.length >= 1, 5000, "first try");
    open = true;
    await waitFor(() => t.got.length >= 2, 5000, "retry");
  });

  test("oversized files are sent without content", async () => {
    const t = setup({ path: "*.bin", read: "content" });
    await t.start();
    writeFileSync(join(t.dir, "big.bin"), Buffer.alloc(MAX_CONTENT_BYTES + 1));
    await waitFor(() => t.got.length >= 1, 5000, "big file");
    expect(t.got[0]?.data).toMatchObject({ content: null, truncated: true });
  });

  test("runs under the runner and journals packets", async () => {
    const box = sandbox();
    cleanups.push(() => box.cleanup());
    mkdirSync(join(box.root, "drop"));
    const file = box.write(
      "w.pipo",
      "pipo: 1\nname: wt\ninput: { via: watch, with: { path: ./drop/*.txt, read: content } }\noutput: { from: input, to: stdout }\n",
    );
    const runner = await Runner.open({ file, home: box.home, log: () => {} });
    await runner.start();
    cleanups.push(() => (runner.state === "stopped" ? undefined : runner.stop()));
    writeFileSync(join(box.root, "drop", "n.txt"), "hello");
    const db = `${box.home}/pipelines/wt/journal.db`;
    const r = await waitFor(
      () => rows(db, "SELECT data, trigger, state FROM packets WHERE state = 'delivered'")[0],
      10_000,
      "delivered watch packet",
    );
    expect(r.trigger).toBe("watch");
    expect(JSON.parse(r.data)).toMatchObject({ event: "create", content: "hello" });
    await runner.stop();
  });
});
