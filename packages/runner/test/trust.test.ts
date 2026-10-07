// Untrusted fn modules (docs/spec.md §11, D29): Runner.open runs check, so P052 stops the start.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ORIGIN_FILE, sha256 } from "@pipo/spec";
import { Runner } from "../src";
import { sandbox } from "./helpers";

const sb = sandbox();

test("Runner.open refuses an fn module from an untrusted template, and starts once it is trusted", async () => {
  const dir = join(sb.root, "proj");
  mkdirSync(dir, { recursive: true });
  const module = "export function make(d: any) { return d; }\n";
  writeFileSync(join(dir, "p.fn.ts"), module);
  writeFileSync(
    join(dir, "p.pipo"),
    "pipo: 1\nname: gated\nfn: ./p.fn.ts\ninput: { via: http }\nnodes:\n  x: { from: input, transform: fn.make }\noutput: { from: x, to: stdout }\n",
  );
  writeFileSync(
    join(dir, ORIGIN_FILE),
    JSON.stringify({ template: "shared", template_hash: "abc123", modules: { "p.fn.ts": sha256(module) } }),
  );
  const previous = process.env.PIPO_HOME;
  process.env.PIPO_HOME = sb.home;
  try {
    await expect(Runner.open({ file: join(dir, "p.pipo"), home: sb.home, listen: 0 })).rejects.toThrow(/error/);
    mkdirSync(sb.home, { recursive: true });
    writeFileSync(
      join(sb.home, "trust.json"),
      JSON.stringify({ version: 1, templates: { abc123: { template: "shared", trusted_at: "now" } } }),
    );
    const runner = await Runner.open({ file: join(dir, "p.pipo"), home: sb.home, listen: 0 });
    await runner.stop();
  } finally {
    if (previous === undefined) delete process.env.PIPO_HOME;
    else process.env.PIPO_HOME = previous;
  }
});
