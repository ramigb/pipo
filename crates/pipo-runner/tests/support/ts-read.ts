// Answers read ops with the TypeScript implementation (packages/runner/src/control/reads.ts), so tests/reads.rs can
// compare the Rust port's results with it key for key. Usage: bun ts-read.ts <journal.db> '<json list of requests>'
// where a request is {op, args, pipeline, offline?}; prints a JSON list of {ok: result} or {error: {code, message, hint}}.
import { Database } from "bun:sqlite";
import { offlineRead, type ReadOp, read } from "../../../../packages/runner/src/control/reads";

const [path, list] = [process.argv[2] as string, JSON.parse(process.argv[3] as string)];
const out: unknown[] = [];
for (const r of list as { op: ReadOp; args: Record<string, unknown>; pipeline: string; offline?: boolean }[]) {
  try {
    if (r.offline) out.push({ ok: await offlineRead(path, r.op, r.args, r.pipeline) });
    else {
      const db = new Database(path, { readonly: true });
      try {
        out.push({ ok: read(db, r.op, r.args, r.pipeline, null) });
      } finally {
        db.close();
      }
    }
  } catch (e) {
    const x = e as { code?: string; message: string; hint?: string };
    out.push({ error: { code: x.code ?? "internal", message: x.message, hint: x.hint } });
  }
}
console.log(JSON.stringify(out));
