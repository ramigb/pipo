// The output key (docs/spec.md §3.2 `meta.key`, §3.5, D22, D44): what the output writes a packet under, so a delivery
// check can look it up. One place computes it; the write and `meta.key` both use it.
import { type Pipeline, render } from "@pipo/spec";

type Output = Pipeline["output"];

/**
 * The key of a write: the unit id (`packet_id`, or `packet_id:<branch>` for a fan-out copy), unless the output sets
 * one explicitly: the sqlite key column in `columns`, or an `Idempotency-Key` header on http.
 */
export function outputKey(to: string, w: Record<string, unknown>, unitId: string): string {
  if (to === "sqlite") {
    const columns = w.columns as Record<string, unknown> | undefined;
    const key = (w.key as string | undefined) ?? "packet_id";
    if (columns && columns[key] !== undefined && columns[key] !== null) return String(columns[key]);
  } else if (to === "http") {
    const headers = w.headers as Record<string, unknown> | undefined;
    for (const [h, v] of Object.entries(headers ?? {})) if (h.toLowerCase() === "idempotency-key") return String(v);
  }
  return unitId;
}

/**
 * `meta.key` for a unit: the output's key rendered with `meta.key` set to the unit id (a `key` expression can't read
 * its own result), so a `columns` or header template that names `meta.key` sees the default. Falls back to the unit id
 * when the output's `with:` can't be rendered yet.
 */
export function resolveKey(out: Output, unitId: string, ctx: Record<string, unknown>): string {
  const w = out.with as Record<string, unknown> | undefined;
  if (!w || (out.to !== "sqlite" && out.to !== "http")) return unitId;
  try {
    const meta = { ...(ctx.meta as Record<string, unknown>), key: unitId };
    return outputKey(out.to, render(w, { ...ctx, meta }) as Record<string, unknown>, unitId);
  } catch {
    return unitId;
  }
}
