// packets, inspect, dlq (list, replay, purge), rerun, push and ack (docs/spec.md §6 Observe and Recover, §8, D33,
// D34, D79).
// Through the engine API, started on demand like lifecycle.ts; with --no-engine (or no engine) through the runner's
// control socket. Reads of a pipeline with no runner come from its journal, read-only and redacted; writes need its
// runner and say how to start it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ControlError, offlineRead, type PacketPage, type ReadOp, type TraceStep, type UnitTrace } from "@pipo/runner";
import { CliError } from "./errors";
import { alive, COMMON, type Ctx, context, direct, out, readEntries, usage } from "./lifecycle";
import { formatAgo } from "./status";

const enc = encodeURIComponent;

/** A read: the engine API, else the live runner's socket, else the journal (read-only). */
export async function readOp(
  ctx: Ctx,
  name: string,
  op: ReadOp,
  args: Record<string, unknown>,
  path: string,
): Promise<Record<string, any>> {
  if (ctx.api) return ctx.api.call("GET", `/api/pipelines/${enc(name)}${path}`);
  if (liveRunner(ctx, name)) {
    return { ...(await direct(ctx.home, name, (c) => c.request(op, args, 10_000))), source: "runner" };
  }
  const journal = join(ctx.home, "pipelines", name, "journal.db");
  let off: Awaited<ReturnType<typeof offlineRead>>;
  try {
    off = await offlineRead(ctx.home, op, args, name);
  } catch (e) {
    if (e instanceof ControlError) throw new CliError(e.message, e.hint);
    throw new CliError(`could not read ${journal}: ${(e as Error).message}`, "check the file, or start the pipeline");
  }
  if (!off) {
    throw new CliError(
      `no pipeline named '${name}' (no runner, and no journal at ${journal})`,
      "check the name with 'pipo status', or pass the --home it runs under",
    );
  }
  return {
    ...(off.result as Record<string, unknown>),
    source: "journal",
    ...(off.withheld && { withheld: off.withheld }),
  };
}

/** A write: the engine API, else the live runner's socket; a pipeline with no runner gets a hint to start it. */
export async function writeOp(
  ctx: Ctx,
  name: string,
  op: string,
  args: Record<string, unknown>,
  path: string,
  what: string,
): Promise<any> {
  if (ctx.api) return ctx.api.call("POST", `/api/pipelines/${enc(name)}${path}`, args);
  if (!liveRunner(ctx, name)) {
    throw new CliError(`'${name}' is not running, so it can't ${what}`, `start it first: pipo start <file|${name}>`);
  }
  return direct(ctx.home, name, (c) => c.request(op, args, 120_000));
}

function liveRunner(ctx: Ctx, name: string): boolean {
  const entry = readEntries(ctx.home).find((e) => e.pipeline === name);
  return !!entry && alive(entry);
}

// ── formatting ───────────────────────────────────────────────────────────────

/** Aligned columns, two spaces apart; `right` columns padded on the left. The last column is never padded. */
export function table(headers: string[], rows: string[][], right: number[] = []): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((v, i) => (i === cells.length - 1 ? v : right.includes(i) ? v.padStart(widths[i]!) : v.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

const STEP_NAMES: Record<string, string> = { $output: "output", $verify: "delivered", $batch: "batch" };
export const stepName = (node: string | null) => (node === null ? "(copies)" : (STEP_NAMES[node] ?? node));

const EVENT_NAMES: Record<string, string> = {
  "packet.accepted": "accepted",
  "packet.rejected": "rejected",
  "packet.branched": "branched",
  "node.done": "done",
  "node.looped": "looped",
  "node.failed_continued": "failed, continued",
  "packet.filtered": "filtered",
  "packet.dropped": "dropped",
  "packet.dead_lettered": "dead-lettered",
  "packet.delivered": "delivered",
  "packet.fanned_out": "fanned out",
  "output.batched": "batched",
  "output.written": "written",
  "dlq.replayed": "replayed",
  "packet.rerun": "rerun",
};

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 23);

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const s = Math.round(ms / 1000);
  return s < 3600
    ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`
    : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

const oneLine = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

export function renderPackets(page: PacketPage, name: string, cmd: string, now = Date.now()): string {
  if (!page.packets.length) return page.total ? "no more packets" : "no packets";
  const rows = page.packets.map((p) => [
    p.packet_id,
    p.state,
    p.node === null ? "-" : stepName(p.node),
    `v${p.version}`,
    String(p.attempt),
    formatAgo(p.received_at, now),
    formatAgo(p.updated_at, now),
    p.error ? p.error.message.split("\n")[0]! : "",
  ]);
  const text = table(["PACKET", "STATE", "NODE", "VER", "ATT", "RECEIVED", "UPDATED", "ERROR"], rows, [4]);
  const more = page.next ? `; next page: ${cmd} ${name} --after ${page.next}` : "";
  return `${text}\n${page.packets.length} of ${page.total.toLocaleString("en-US")}${more}`;
}

export function renderDlq(page: PacketPage, name: string, now = Date.now()): string {
  if (!page.packets.length) return page.total ? "no more dead letters" : `the dead-letter queue of ${name} is empty`;
  const rows = page.packets.map((p) => [
    p.packet_id,
    p.node === null ? "-" : stepName(p.node),
    String(p.error?.attempts ?? 1),
    `v${p.version}`,
    formatAgo(p.updated_at, now),
    p.error ? `${p.error.code}: ${p.error.message.split("\n")[0]}` : "",
  ]);
  const text = table(["PACKET", "FAILED AT", "ATTEMPTS", "VER", "DEAD SINCE", "ERROR"], rows, [2]);
  const more = page.next ? `; next page: pipo dlq ${name} --after ${page.next}` : "";
  return `${text}\n${page.packets.length} of ${page.total.toLocaleString("en-US")} dead-lettered${more}; replay with pipo dlq replay ${name} <id…>|--all`;
}

function renderSteps(steps: TraceStep[], indent: string): string[] {
  const lines: string[] = [];
  const nodeW = Math.max(4, ...steps.map((s) => stepName(s.node).length));
  for (const s of steps) {
    const took = s.duration_ms > 0 || s.event !== "packet.accepted" ? `+${formatMs(s.duration_ms)}` : "";
    const tries = s.attempts > 1 ? `${s.attempts} attempts` : "";
    const head = [
      clock(s.at),
      stepName(s.node).padEnd(nodeW),
      (EVENT_NAMES[s.event] ?? s.event).padEnd(14),
      took,
      tries,
    ];
    lines.push(`${indent}${head.join("  ").trimEnd()}`);
    const sub = `${indent}${" ".repeat(14 + nodeW)}`;
    for (const r of s.retries) {
      lines.push(
        `${sub}retry ${r.attempt}: ${r.error ?? "failed"}${r.wait_ms !== null ? ` (waited ${formatMs(r.wait_ms)})` : ""}`,
      );
    }
    for (const n of s.notes) {
      const d = n.detail as Record<string, unknown> | null;
      if (n.type === "log" && d) lines.push(`${sub}log ${d.level ?? "info"}: ${oneLine(d.message)}`);
      else lines.push(`${sub}${n.type}${d === null || d === undefined ? "" : ` ${oneLine(d)}`}`);
    }
    if (s.error) lines.push(`${sub}error ${s.error.code}: ${s.error.message}`);
    if ("data" in s && s.changed) lines.push(`${sub}data ${oneLine(s.data)}`);
  }
  return lines;
}

/** `pipo inspect`: the packet, then one line per step with the data wherever a step changed it, then its copies. */
export function renderTrace(t: UnitTrace, name: string, withheld?: string): string {
  const lines: string[] = [];
  if (!t.packet) {
    const d = (t.purged?.detail ?? {}) as Record<string, any>;
    lines.push(
      `packet purged from the dead-letter queue of ${name} at ${new Date(t.purged?.at ?? 0).toISOString()}${d.by ? ` by ${d.by}` : ""}`,
    );
    if (d.error) lines.push(`it was dead-lettered at ${stepName(d.error.node ?? null)}: ${d.error.message}`);
    return lines.join("\n");
  }
  const p = t.packet;
  const end = t.steps.at(-1);
  lines.push(`packet ${p.packet_id}  ${name} v${p.version}  ${p.state}`);
  lines.push(
    `received ${new Date(p.received_at).toISOString()} via ${p.trigger} (${p.source})${
      end && !t.pending ? `, ${p.state} after ${formatMs(end.at - p.received_at)}` : ""
    }`,
  );
  if (withheld) lines.push(`payloads withheld: ${withheld}`);
  lines.push("", ...renderSteps(t.steps, "  "));
  if (t.pending) {
    const retries = t.pending.retries.length;
    lines.push(
      `  ${"…".padEnd(12)}  ${stepName(t.pending.node)}  in progress since ${clock(t.pending.since)}${retries ? ` (${retries} failed attempt(s) so far: ${t.pending.retries.at(-1)?.error})` : ""}`,
    );
    for (const n of t.pending.notes) lines.push(`                ${n.type} ${oneLine(n.detail)}`);
  }
  if (p.error && !t.steps.some((s) => s.error)) lines.push(`  error ${p.error.code}: ${p.error.message}`);
  for (const c of t.copies) lines.push("", ...renderCopy(c, "  "));
  return lines.join("\n");
}

function renderCopy(t: UnitTrace, indent: string): string[] {
  const p = t.packet;
  if (!p) return [];
  const lines = [`${indent}branch ${p.branch} (${p.packet_id})  ${p.state}`, ...renderSteps(t.steps, `${indent}  `)];
  if (t.pending) lines.push(`${indent}  …  ${stepName(t.pending.node)}  in progress since ${clock(t.pending.since)}`);
  for (const c of t.copies) lines.push(...renderCopy(c, `${indent}  `));
  return lines;
}

// ── commands ─────────────────────────────────────────────────────────────────

const PAGE = { limit: { type: "string" }, after: { type: "string" } } as const;

function pageArgs(values: { limit?: string; after?: string }) {
  if (values.limit !== undefined && !/^\d+$/.test(values.limit)) {
    throw new CliError(`--limit '${values.limit}' is not a number`, "use a whole number from 1 to 1000");
  }
  return {
    ...(values.limit !== undefined && { limit: Number(values.limit) }),
    ...(values.after !== undefined && { after: values.after }),
  };
}

const query = (args: Record<string, unknown>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

export async function cmdPackets(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...COMMON, ...PAGE, state: { type: "string" } },
  });
  const name = positionals[0];
  if (!name) return usage("pipo packets <name> [--state s] [--limit n] [--after id]");
  const a = { ...(values.state !== undefined && { state: values.state }), ...pageArgs(values) };
  const ctx = await context(values);
  const r = await readOp(ctx, name, "packets", a, `/packets${query(a)}`);
  out(ctx, { pipeline: name, ...r }, renderPackets(r as unknown as PacketPage, name, "pipo packets"));
  return 0;
}

export async function cmdInspect(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: COMMON });
  const [name, id] = positionals;
  if (!name || !id) return usage("pipo inspect <name> <packet_id>");
  const ctx = await context(values);
  const r = await readOp(ctx, name, "packet", { packet_id: id }, `/packets/${enc(id)}`);
  out(ctx, { pipeline: name, ...r }, renderTrace(r as unknown as UnitTrace, name, r.withheld));
  return 0;
}

const DLQ_USAGE = "pipo dlq [list] <name> | pipo dlq replay|purge <name> [ids…|--all]";

export async function cmdDlq(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...COMMON, ...PAGE, all: { type: "boolean" } },
  });
  const sub =
    positionals[0] === "list" || positionals[0] === "replay" || positionals[0] === "purge" ? positionals[0] : null;
  const [name, ...ids] = sub ? positionals.slice(1) : positionals;
  if (!name) return usage(DLQ_USAGE);
  if (sub === null || sub === "list") {
    if (ids.length || values.all) return usage(DLQ_USAGE);
    const a = pageArgs(values);
    const ctx = await context(values);
    const r = await readOp(ctx, name, "dlq", a, `/dlq${query(a)}`);
    out(ctx, { pipeline: name, ...r }, renderDlq(r as unknown as PacketPage, name));
    return 0;
  }
  if (!ids.length && !values.all) {
    console.error(`pipo dlq ${sub}: name the packets to ${sub}, or pass --all`);
    return usage(`pipo dlq ${sub} <name> [ids…|--all]`);
  }
  if (ids.length && values.all) {
    console.error(`pipo dlq ${sub}: pass packet ids or --all, not both`);
    return usage(`pipo dlq ${sub} <name> [ids…|--all]`);
  }
  const body = { ...(values.all ? { all: true } : { ids }), by: "cli" };
  const ctx = await context(values);
  const r = await writeOp(ctx, name, sub, body, `/dlq/${sub}`, `${sub} dead letters`);
  if (sub === "replay") {
    const lines = [`replayed ${r.replayed} packet(s) from the dead-letter queue of ${name}`];
    for (const p of r.packets ?? []) {
      lines.push(
        `  ${p.packet_id}  → ${p.units.map((u: any) => `${stepName(u.node)}${u.id === p.packet_id ? "" : ` (${u.id})`}`).join(", ")}`,
      );
    }
    if (r.replayed > (r.packets?.length ?? 0)) lines.push(`  … and ${r.replayed - r.packets.length} more`);
    for (const s of r.skipped ?? []) lines.push(`  skipped ${s.packet_id}: ${s.error}`);
    lines.push(`follow them with pipo packets ${name} or pipo inspect ${name} <id>`);
    out(ctx, { pipeline: name, result: r }, lines.join("\n"));
  } else {
    out(ctx, { pipeline: name, result: r }, `purged ${r.purged} packet(s) from the dead-letter queue of ${name}`);
  }
  return 0;
}

const RERUN_USAGE = "pipo rerun <name> --from <node> [ids…|--last n|--since 1h|--all] [--current] [--yes]";

const EFFECTS: Record<string, string> = {
  spend: "▲ calls the agent again (spends)",
  external: "▲ reaches outside again",
  write: "writes again (idempotent on its key)",
};

export function renderRerun(r: Record<string, any>, name: string): string {
  const lines: string[] = [];
  const how = r.current ? "on the version in force" : "each on its own version";
  const ids = (r.packets ?? []).map((p: { packet_id: string; units: string[] }) =>
    p.units.length === 1 && p.units[0] === p.packet_id ? p.packet_id : `${p.packet_id} (${p.units.join(", ")})`,
  );
  lines.push(
    r.dry
      ? `plan: rerun ${r.rerun} packet(s) of ${name} from '${r.from}', ${how}`
      : `rerun ${r.rerun} packet(s) of ${name} from '${r.from}', ${how}`,
  );
  for (const id of ids) lines.push(`  ${id}`);
  if (r.rerun > ids.length) lines.push(`  … and ${r.rerun - ids.length} more`);
  for (const s of r.skipped ?? []) lines.push(`  skipped ${s.packet_id}: ${s.reason}`);
  if (r.skipped_count > (r.skipped?.length ?? 0))
    lines.push(`  … and ${r.skipped_count - r.skipped.length} more skipped`);
  if (r.rerun > 0) {
    lines.push("steps that run again:");
    lines.push(
      table(
        ["STEP", "KIND", "EFFECT"],
        (r.path ?? []).map((s: { step: string; kind: string | null; effect: string | null }) => [
          s.step,
          s.kind ?? "",
          s.effect ? (EFFECTS[s.effect] ?? s.effect) : "",
        ]),
      )
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
    );
  }
  if (r.dry && r.rerun > 0) lines.push("nothing ran yet: run it with --yes");
  else if (!r.dry && r.rerun > 0) lines.push(`follow them with pipo packets ${name} or pipo inspect ${name} <id>`);
  return lines.join("\n");
}

export async function cmdRerun(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...COMMON,
      from: { type: "string" },
      last: { type: "string" },
      since: { type: "string" },
      all: { type: "boolean" },
      current: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
    },
  });
  const [name, ...ids] = positionals;
  if (!name || !values.from) return usage(RERUN_USAGE);
  const ranged = values.all || values.last !== undefined || values.since !== undefined;
  if (ids.length && ranged) {
    console.error("pipo rerun: pass packet ids, or --last/--since/--all, not both");
    return usage(RERUN_USAGE);
  }
  if (!ids.length && !ranged) {
    console.error("pipo rerun: name the packets to rerun, or pass --last n, --since 1h or --all");
    return usage(RERUN_USAGE);
  }
  const last = values.last === undefined ? undefined : Number(values.last);
  if (last !== undefined && !(Number.isInteger(last) && last >= 1)) {
    throw new CliError(`--last must be a whole number from 1, got '${values.last}'`, "for example --last 5");
  }
  const body = {
    from: values.from,
    ...(ids.length ? { ids } : {}),
    ...(last !== undefined && { last }),
    ...(values.since !== undefined && { since: values.since }),
    ...(values.all && { all: true }),
    ...(values.current && { current: true }),
    ...(!values.yes && { dry: true }),
    by: "cli",
  };
  const ctx = await context(values);
  const r = await writeOp(ctx, name, "rerun", body, "/rerun", "rerun packets");
  out(ctx, { pipeline: name, result: r }, renderRerun(r, name));
  return 0;
}

export async function cmdPush(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...COMMON,
      data: { type: "string" },
      file: { type: "string" },
      source: { type: "string" },
      input: { type: "string" },
    },
  });
  const name = positionals[0];
  if (!name || (values.data === undefined) === (values.file === undefined)) {
    return usage("pipo push <name> --data '{…}'|--file f [--source s] [--input i]");
  }
  let text = values.data as string;
  if (values.file !== undefined) {
    try {
      text = readFileSync(values.file, "utf8");
    } catch (e) {
      throw new CliError(
        `cannot read ${values.file}: ${(e as Error).message}`,
        "pass a JSON file, or inline JSON with --data",
      );
    }
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new CliError(
      `${values.file ?? "--data"} is not valid JSON: ${(e as Error).message}`,
      `quote it for the shell, e.g. --data '{"name":"Ada"}'`,
    );
  }
  const ctx = await context(values);
  const pushArgs = { data, source: values.source ?? "cli", ...(values.input !== undefined && { input: values.input }) };
  const r = await writeOp(ctx, name, "push", pushArgs, "/push", "accept packets");
  out(ctx, { pipeline: name, result: r }, `pushed ${r.packet_id} into ${name} (${r.state})`);
  return 0;
}

export async function cmdAck(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: COMMON });
  const [name, id] = positionals;
  if (!name || !id) return usage("pipo ack <name> <packet_id>");
  const ctx = await context(values);
  const r = await writeOp(ctx, name, "ack", { packet_id: id }, "/ack", "take acks");
  out(
    ctx,
    { pipeline: name, result: r },
    r.already ? `${id} was already acked` : `acked ${id}; it delivers once verified`,
  );
  return 0;
}
