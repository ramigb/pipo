// Versions remember their files (docs/spec.md §9.3, D60), in-process: each version records the sha256 of the `fn`
// module and schema files it runs with; a rollback to a version whose files changed since warns (in the reply and the
// log) and still applies; a journal from before D60 gains the column with no hashes and no warnings; a failed live
// apply returns the `pipo check` diagnostics as objects. Kill-and-restart lives in version-files-recovery.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, type ControlError, Journal, offlineRead, Runner } from "../src";
import { sandbox } from "./helpers";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const sha = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

const FNS = `export const one = (d) => ({ ...d, v: "one" });
export const two = (d) => ({ ...d, v: "two" });
`;
const SCHEMA = (required: string[]) => JSON.stringify({ type: "object", required });

function setup() {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  box.write("fns.ts", FNS);
  box.write("in.schema.json", SCHEMA([]));
  return box;
}

const SRC = (name: string, tag: "one" | "two", extra = "") => `pipo: 1
name: ${name}
fn: ./fns.ts
input: { via: push, schema: ./in.schema.json }
nodes:
  tag: { from: input, transform: fn.${tag} }
output: { from: tag, to: file, with: { path: ./${name}.jsonl, format: jsonl } }
${extra}`;

async function open(box: ReturnType<typeof setup>, file: string) {
  const lines: string[] = [];
  const runner = await Runner.open({ file, home: box.home, log: (l) => lines.push(l) });
  await runner.start();
  cleanups.push(() => (runner.state === "stopped" || runner.state === "failed" ? undefined : runner.stop()));
  return { runner, lines };
}

async function client(box: { home: string }, name: string) {
  const c = await ControlClient.forPipeline(box.home, name);
  cleanups.push(() => c.close());
  return c;
}

const err = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e) => e as ControlError,
  );

describe("version files (D60)", () => {
  test("a start and an apply record the sha256 of the fn module and schema files; history returns them", async () => {
    const box = setup();
    const file = box.write("rec.pipo", SRC("rec", "one"));
    const { runner } = await open(box, file);
    const files = {
      "./fns.ts": sha(join(box.root, "fns.ts")),
      "./in.schema.json": sha(join(box.root, "in.schema.json")),
    };
    expect(runner.journal.versionFiles(1)).toEqual(files);

    // An apply records what it runs with: here a schema edited before the apply.
    writeFileSync(join(box.root, "in.schema.json"), SCHEMA(["id"]));
    const c = await client(box, "rec");
    const applied = await c.request("apply", { source: SRC("rec", "two"), by: "test" });
    expect(applied).toMatchObject({ version: 2, changed: true });
    expect(applied.warnings).toBeUndefined();
    expect(runner.journal.versionFiles(2)).toEqual({
      ...files,
      "./in.schema.json": sha(join(box.root, "in.schema.json")),
    });

    const history = await c.request("versions");
    expect(history.versions.map((v: any) => v.files)).toEqual([runner.journal.versionFiles(2), files]);
    expect((await c.request("version", { version: 1 })).files).toEqual(files);
  });

  test("a rollback after editing a schema file warns, names the file, version and hint, and still applies", async () => {
    const box = setup();
    const file = box.write("rb.pipo", SRC("rb", "one"));
    const { runner, lines } = await open(box, file);
    const c = await client(box, "rb");
    const before = sha(join(box.root, "in.schema.json"));
    await c.request("apply", { source: SRC("rb", "two"), by: "test" });
    writeFileSync(join(box.root, "in.schema.json"), SCHEMA(["id"]));
    const after = sha(join(box.root, "in.schema.json"));

    const r = await c.request("rollback", { version: 1, by: "test" });
    expect(r).toMatchObject({ version: 3, previous: 2, changed: true, rolled_back_to: 1 });
    expect(r.warnings).toEqual([
      {
        code: "file_changed",
        file: "./in.schema.json",
        version: 1,
        recorded: before,
        current: after,
        message: expect.stringContaining("so v3 (rollback to v1) runs the file as it is now, not v1's"),
        hint: expect.stringContaining("pipo restart rb"),
      },
    ]);
    expect(r.warnings[0].message).toContain("./in.schema.json has changed since v1 was recorded");
    // v3 records the schema it runs with; the warning is in the log too.
    expect(runner.journal.versionFiles(3)?.["./in.schema.json"]).toBe(after);
    expect(lines.some((l) => l.includes("./in.schema.json has changed since v1 was recorded"))).toBe(true);

    // Rolling back to v1 again compares with what v3 recorded: still different. Back to v3's own files: no warning.
    const again = await c.request("rollback", { version: 1, by: "test" });
    expect(again).toMatchObject({ version: 3, changed: false });
    expect(again.warnings?.map((w: any) => w.code)).toEqual(["file_changed"]);
    expect(again.warnings[0].message).toContain("so v3 (running) runs");
    writeFileSync(join(box.root, "in.schema.json"), SCHEMA([]));
    expect((await c.request("rollback", { version: 2, by: "test" })).warnings).toBeUndefined();
  });

  test("a rollback after editing the fn module warns that the running process keeps the module it loaded", async () => {
    const box = setup();
    const file = box.write("fnm.pipo", SRC("fnm", "one"));
    const { runner } = await open(box, file);
    const c = await client(box, "fnm");
    const loaded = sha(join(box.root, "fns.ts"));
    await c.request("apply", { source: SRC("fnm", "two"), by: "test" });
    writeFileSync(join(box.root, "fns.ts"), `${FNS}export const three = (d) => d;\n`);

    // A process imports its fn module once, so v3 runs the loaded module (v1's): it records that one, and says so.
    const r = await c.request("rollback", { version: 1, by: "test" });
    expect(r).toMatchObject({ version: 3, changed: true });
    expect(r.warnings).toEqual([
      expect.objectContaining({
        code: "module_not_reloaded",
        file: "./fns.ts",
        version: 3,
        recorded: loaded,
        current: sha(join(box.root, "fns.ts")),
        hint: "restart to load the file as it is now (pipo restart fnm)",
      }),
    ]);
    expect(runner.journal.versionFiles(3)?.["./fns.ts"]).toBe(loaded);
  });

  test("a journal from before D60 gains the column; its versions have no hashes and never warn", async () => {
    const box = setup();
    const file = box.write("old.pipo", SRC("old", "one"));
    let { runner } = await open(box, file);
    await runner.applyVersion(SRC("old", "two"), { author: "test", reason: "two" });
    await runner.stop();
    // Make it a journal from before D60: no `files` column.
    const path = join(box.home, "pipelines", "old", "journal.db");
    const raw = new Journal(path);
    raw.db.exec("ALTER TABLE versions DROP COLUMN files");
    raw.close();
    // Read-only reads of the unmigrated journal still answer, with `files: null`.
    const off = (await offlineRead(path, "versions", {}, "old")) as any;
    expect(off.result.versions.map((v: any) => v.files)).toEqual([null, null]);

    writeFileSync(join(box.root, "in.schema.json"), SCHEMA(["id"]));
    const reopened = await open(box, file);
    runner = reopened.runner;
    const lines = reopened.lines;
    expect(runner.version).toBe(2);
    const cols = (runner.journal.db.query("PRAGMA table_info(versions)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("files");
    expect(runner.journal.versionFiles(1)).toBeNull();
    expect(lines.some((l) => l.includes("has changed since"))).toBe(false);

    const c = await client(box, "old");
    const r = await c.request("rollback", { version: 1, by: "test" });
    expect(r).toMatchObject({ version: 3, changed: true });
    expect(r.warnings).toBeUndefined();
    expect(runner.journal.versionFiles(3)).toEqual({
      "./fns.ts": sha(join(box.root, "fns.ts")),
      "./in.schema.json": sha(join(box.root, "in.schema.json")),
    });
    // Opening it again (the column exists now) changes nothing.
    await runner.stop();
    new Journal(path).close();
  });

  test("a failed live apply returns the pipo check diagnostics as objects, and keeps the message", async () => {
    const box = setup();
    const file = box.write("bad.pipo", SRC("bad", "one"));
    const { runner } = await open(box, file);
    const c = await client(box, "bad");
    const broken = await err(
      c.request("apply", { source: SRC("bad", "one").replace("from: input", "from: nowhere"), by: "test" }),
    );
    expect(broken?.code).toBe("invalid_pipeline");
    expect(broken?.message).toContain("fails pipo check with 3 error(s)");
    expect(broken?.diagnostics?.map((d) => d.code).sort()).toEqual(["P010", "P020", "P020"]);
    for (const d of broken?.diagnostics ?? []) expect(broken?.message).toContain(d.message);
    expect(broken?.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "P010",
        severity: "error",
        line: expect.any(Number),
        col: expect.any(Number),
        message: expect.any(String),
        path: ["nodes", "tag", "from"],
      }),
    );
    // A missing fn export is one too, with its hint; nothing was written.
    const missing = await err(c.request("apply", { source: SRC("bad", "one").replace("fn.one", "fn.nope") }));
    expect(missing?.diagnostics?.map((d) => d.code)).toContain("P012");
    expect(missing?.diagnostics?.find((d) => d.code === "P012")?.hint).toContain("exports:");
    expect(runner.journal.latestVersion()?.version).toBe(1);
    // A refusal that is not a check failure carries none.
    const bound = await err(c.request("apply", { source: SRC("bad", "two", "concurrency: 2") }));
    expect(bound?.code).toBe("invalid_state");
    expect(bound?.diagnostics).toBeUndefined();
  });
});
