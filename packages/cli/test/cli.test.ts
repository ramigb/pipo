import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "../src/main.ts");
const ROOT = join(import.meta.dir, "../../..");
const dir = mkdtempSync(join(tmpdir(), "pipo-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Real process, output to files (never a pipe). Under full-suite load a child can be slow to load modules, so each
// attempt has a generous timeout and one retry when the child was killed; assertion failures are never retried.
let n = 0;
async function pipo(...args: string[]) {
  for (let attempt = 0; ; attempt++) {
    const out = join(dir, `out-${n}.log`);
    const err = join(dir, `err-${n++}.log`);
    const proc = Bun.spawn(["bun", MAIN, ...args], {
      cwd: ROOT,
      stdout: Bun.file(out),
      stderr: Bun.file(err),
      timeout: 25_000,
      killSignal: "SIGKILL",
    });
    const code = await proc.exited;
    if (code === 137 && attempt < 1) continue;
    return { stdout: await Bun.file(out).text(), stderr: await Bun.file(err).text(), code };
  }
}

test("check passes the bundled example", async () => {
  const r = await pipo("check", "examples");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("people-intake.pipo  ok");
}, 60_000);

test("check reports diagnostics with positions and fails", async () => {
  const file = join(dir, "bad.pipo");
  writeFileSync(
    file,
    "pipo: 1\nname: bad\ninput: { via: http }\noutput:\n  from: input\n  to: sqlite\n  with: { path: x.db, table: t }\ndelivered: { check: file_exists }\n",
  );
  const r = await pipo("check", file);
  expect(r.code).toBe(1);
  expect(r.stdout).toContain(
    "bad.pipo:8:21  error    P031  delivered.check 'file_exists' is not supported by output 'sqlite'",
  );
  expect(r.stdout).toContain("  supported: ack, external, none, record_exists, row_count, query");
}, 60_000);

test("check --json is machine-readable", async () => {
  const file = join(dir, "bad.pipo");
  const r = await pipo("check", file, "--json");
  const out = JSON.parse(r.stdout);
  expect(out.ok).toBe(false);
  expect(out.files[0].diagnostics[0]).toMatchObject({ code: "P031", line: 8, severity: "error" });
}, 60_000);

test("schema prints the JSON Schema, and the published copy is current", async () => {
  const r = await pipo("schema");
  expect(JSON.parse(r.stdout).title).toBe("Pipo pipeline");
  const published = await Bun.file(join(ROOT, "schema/pipo.schema.json")).text();
  expect(published).toBe(r.stdout); // regenerate with: bun run schema
}, 60_000);

test("unknown commands exit 2 and point at help", async () => {
  const r = await pipo("frobnicate");
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("unknown command");
}, 60_000);

test("check <dir> --json warns P039 for a shared listen port, and still exits 0", async () => {
  const proj = join(dir, "p039");
  mkdirSync(proj, { recursive: true });
  for (const n of ["a", "b"]) {
    writeFileSync(
      join(proj, `${n}.pipo`),
      `pipo: 1\nname: ${n}\ninput:\n  via: http\n  with:\n    listen: 8791\noutput:\n  from: input\n  to: stdout\n`,
    );
  }
  const r = await pipo("check", proj, "--json");
  const out = JSON.parse(r.stdout);
  expect(r.code).toBe(0);
  const warns = out.files.flatMap((f: any) => f.diagnostics).filter((d: any) => d.code === "P039");
  expect(warns).toHaveLength(1);
  expect(warns[0]).toMatchObject({ severity: "warning", line: 6 });
}, 60_000);
