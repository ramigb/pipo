// Versions remember their files (docs/spec.md §9.3, D60), against the Rust runner: each version records the sha256
// of the `fn` module and schema files it runs with; a rollback to a version whose files changed since warns (in the
// reply and the log) and still applies; a journal from before D60 gains the column with no hashes and no warnings; a
// failed live apply returns the `pipo check` diagnostics as objects. Kill-and-restart lives in
// version-files-recovery.test.ts.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ControlError } from "../src";
import { offlineRead } from "./control-helpers";
import { sandbox, waitFor } from "./helpers";
import { RustRunner } from "./rust";

// A runner start compiles through Bun, which can hang once in a while under WSL and is then retried (compile.rs).
setDefaultTimeout(60_000);

let cleanups: (() => Promise<unknown> | unknown)[] = [];
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

async function open(box: ReturnType<typeof setup>, file: string, name: string) {
  const r = await RustRunner.start(box, file, name, { listen: null });
  cleanups.push(() => (r.proc.exitCode === null ? r.kill() : undefined));
  return r;
}

/** The file hashes a version recorded (D60), or null. */
const versionFiles = (r: RustRunner, v: number) => {
  const [row] = r.query<{ files: string | null }>("SELECT files FROM versions WHERE version = ?", v);
  return row?.files ? JSON.parse(row.files) : null;
};

const err = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e) => e as ControlError,
  );

describe("version files (D60)", () => {
  test("a start and an apply record the sha256 of the fn module and schema files; history returns them", async () => {
    const box = setup();
    const file = box.write("rec.pipo", SRC("rec", "one"));
    const r = await open(box, file, "rec");
    const files = {
      "./fns.ts": sha(join(box.root, "fns.ts")),
      "./in.schema.json": sha(join(box.root, "in.schema.json")),
    };
    expect(versionFiles(r, 1)).toEqual(files);

    // An apply records what it runs with: here a schema edited before the apply.
    writeFileSync(join(box.root, "in.schema.json"), SCHEMA(["id"]));
    const applied = await r.request("apply", { source: SRC("rec", "two"), by: "test" });
    expect(applied).toMatchObject({ version: 2, changed: true });
    expect(applied.warnings).toBeUndefined();
    expect(versionFiles(r, 2)).toEqual({
      ...files,
      "./in.schema.json": sha(join(box.root, "in.schema.json")),
    });

    const history = await r.request("versions");
    expect(history.versions.map((v: any) => v.files)).toEqual([versionFiles(r, 2), files]);
    expect((await r.request("version", { version: 1 })).files).toEqual(files);
  });

  test("a rollback after editing a schema file warns, names the file, version and hint, and still applies", async () => {
    const box = setup();
    const file = box.write("rb.pipo", SRC("rb", "one"));
    const r = await open(box, file, "rb");
    const before = sha(join(box.root, "in.schema.json"));
    await r.request("apply", { source: SRC("rb", "two"), by: "test" });
    writeFileSync(join(box.root, "in.schema.json"), SCHEMA(["id"]));
    const after = sha(join(box.root, "in.schema.json"));

    const res = await r.request("rollback", { version: 1, by: "test" });
    expect(res).toMatchObject({ version: 3, previous: 2, changed: true, rolled_back_to: 1 });
    expect(res.warnings).toEqual([
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
    expect(res.warnings[0].message).toContain("./in.schema.json has changed since v1 was recorded");
    // v3 records the schema it runs with; the warning is in the log too.
    expect(versionFiles(r, 3)?.["./in.schema.json"]).toBe(after);
    await waitFor(
      () => r.lines().some((l) => l.includes("./in.schema.json has changed since v1 was recorded")),
      5000,
      "the warning in the log",
    );

    // Rolling back to v1 again compares with what v3 recorded: still different. Back to v3's own files: no warning.
    const again = await r.request("rollback", { version: 1, by: "test" });
    expect(again).toMatchObject({ version: 3, changed: false });
    expect(again.warnings?.map((w: any) => w.code)).toEqual(["file_changed"]);
    expect(again.warnings[0].message).toContain("so v3 (running) runs");
    writeFileSync(join(box.root, "in.schema.json"), SCHEMA([]));
    expect((await r.request("rollback", { version: 2, by: "test" })).warnings).toBeUndefined();
  });

  test("a rollback after editing the fn module compiles it as it is now and warns; the running code is kept until then", async () => {
    const box = setup();
    const file = box.write("fnm.pipo", SRC("fnm", "one"));
    const r = await open(box, file, "fnm");
    const loaded = sha(join(box.root, "fns.ts"));
    await r.request("apply", { source: SRC("fnm", "two"), by: "test" });
    writeFileSync(join(box.root, "fns.ts"), `${FNS}export const three = (d) => d;\n`);
    const edited = sha(join(box.root, "fns.ts"));

    // A rollback compiles v1's source with the module as it is now (each version stores its compiled form), so v3
    // records the edited module and the reply says v1's has changed.
    const res = await r.request("rollback", { version: 1, by: "test" });
    expect(res).toMatchObject({ version: 3, changed: true });
    expect(res.warnings).toEqual([
      expect.objectContaining({
        code: "file_changed",
        file: "./fns.ts",
        version: 1,
        recorded: loaded,
        current: edited,
      }),
    ]);
    expect(versionFiles(r, 3)?.["./fns.ts"]).toBe(edited);

    // An apply that changes nothing compiles nothing: the running version keeps the code it was compiled with.
    writeFileSync(join(box.root, "fns.ts"), `${FNS}export const four = (d) => d;\n`);
    const same = await r.request("apply", { source: SRC("fnm", "one"), by: "test" });
    expect(same).toMatchObject({ version: 3, changed: false });
    expect(same.warnings).toEqual([
      expect.objectContaining({
        code: "module_not_reloaded",
        file: "./fns.ts",
        version: 3,
        recorded: edited,
        current: sha(join(box.root, "fns.ts")),
        hint: "restart to compile the file as it is now (pipo restart fnm)",
      }),
    ]);
  });

  test("a journal from before D60 gains the column; its versions have no hashes and never warn", async () => {
    const box = setup();
    const file = box.write("old.pipo", SRC("old", "one"));
    let r = await open(box, file, "old");
    await r.request("apply", { source: SRC("old", "two"), by: "test", reason: "two" });
    expect(await r.stop()).toBe(0);
    // Make it a journal from before D60: no `files` column.
    const path = join(box.home, "pipelines", "old", "journal.db");
    const db = new Database(path);
    db.exec("ALTER TABLE versions DROP COLUMN files");
    db.close();
    // Read-only reads of the unmigrated journal still answer, with `files: null`.
    const off = (await offlineRead(box, "old", "versions")).out;
    expect(off.result.versions.map((v: any) => v.files)).toEqual([null, null]);

    writeFileSync(join(box.root, "in.schema.json"), SCHEMA(["id"]));
    r = await open(box, file, "old");
    expect((await r.request("hello")).version).toBe(2);
    const cols = r.query<{ name: string }>("PRAGMA table_info(versions)").map((c) => c.name);
    expect(cols).toContain("files");
    expect(versionFiles(r, 1)).toBeNull();
    expect(r.lines().some((l) => l.includes("has changed since"))).toBe(false);

    const res = await r.request("rollback", { version: 1, by: "test" });
    expect(res).toMatchObject({ version: 3, changed: true });
    expect(res.warnings).toBeUndefined();
    expect(versionFiles(r, 3)).toEqual({
      "./fns.ts": sha(join(box.root, "fns.ts")),
      "./in.schema.json": sha(join(box.root, "in.schema.json")),
    });
    expect(r.lines().some((l) => l.includes("has changed since"))).toBe(false);
  });

  test("a failed live apply returns the pipo check diagnostics as objects, and keeps the message", async () => {
    const box = setup();
    const file = box.write("bad.pipo", SRC("bad", "one"));
    const r = await open(box, file, "bad");
    const broken = await err(
      r.request("apply", { source: SRC("bad", "one").replace("from: input", "from: nowhere"), by: "test" }),
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
    const missing = await err(r.request("apply", { source: SRC("bad", "one").replace("fn.one", "fn.nope") }));
    expect(missing?.diagnostics?.map((d) => d.code)).toContain("P012");
    expect(missing?.diagnostics?.find((d) => d.code === "P012")?.hint).toContain("exports:");
    expect(r.query("SELECT MAX(version) AS v FROM versions")[0]?.v).toBe(1);
    // A refusal that is not a check failure carries none.
    const bound = await err(r.request("apply", { source: SRC("bad", "two", "concurrency: 2") }));
    expect(bound?.code).toBe("invalid_state");
    expect(bound?.diagnostics).toBeUndefined();
  });
});
