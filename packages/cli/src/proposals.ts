// proposals and resolve (docs/spec.md §6, §9.3, D50, D51). `pipo proposals <name>` lists change proposals and `show`s
// one; `propose`, `apply` and `reject` need the running runner. Reads go through the engine API, else the runner's
// socket, else the journal read-only, like versions.ts. A human proposes as themselves; the proposal is validated,
// dry-run when the base version asks for it, and applied at the safe point, unless `--hold` keeps it for `apply`.
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import type { Proposal, ProposalSummary, VersionList } from "@pipo/runner";
import { CliError } from "./errors";
import { COMMON, context, out, usage } from "./lifecycle";
import { readOp, table, writeOp } from "./packets";
import { formatAgo } from "./status";

const enc = encodeURIComponent;
const USAGE = [
  "pipo proposals <name> [--state s] [--limit n]",
  "pipo proposals <name> show <id>",
  'pipo proposals <name> propose <file.pipo> --reason "…" [--base n] [--hold] [--by who]',
  'pipo proposals <name> apply <id> | reject <id> --reason "…"',
].join("\n       ");
const STATES = ["validated", "verified", "applied", "rejected"];

function who(by: string | undefined): string {
  if (by) return by;
  try {
    return userInfo().username || "cli";
  } catch {
    return "cli";
  }
}

export function renderProposals(list: ProposalSummary[], name: string, now = Date.now()): string {
  if (!list.length) return `${name} has no change proposals`;
  const rows = list.map((p) => [
    p.id,
    p.state,
    `v${p.base_version}${p.applied_version ? ` → v${p.applied_version}` : ""}`,
    `${p.author_kind}:${p.author}`,
    formatAgo(p.created_at, now),
    p.reason,
  ]);
  return table(["ID", "STATE", "VERSION", "AUTHOR", "CREATED", "REASON"], rows);
}

export function renderProposal(p: Proposal & { apply_error?: { message: string; hint?: string } }): string {
  const lines = [
    `${p.id}  ${p.state}  against v${p.base_version}${p.applied_version ? `, applied as v${p.applied_version}` : ""}`,
    `by ${p.author_kind} ${p.author}: ${p.reason}`,
  ];
  if (p.changed_paths.length) lines.push(`changes: ${p.changed_paths.join(", ")}`);
  if (p.verify) lines.push(`dry run required: agent.verify ${p.verify}`);
  if (p.decision) lines.push(`${p.state === "rejected" ? "rejected" : "decision"}: ${p.decision}`);
  for (const x of p.problems) lines.push(`problem [${x.code}]: ${x.message}\n  hint: ${x.hint}`);
  const v = p.verification as { replayed?: number; passed?: number; filtered?: number; diverged?: number } | null;
  if (v && typeof v.replayed === "number") {
    lines.push(`dry run: ${v.replayed} replayed, ${v.passed} passed, ${v.filtered} filtered, ${v.diverged} diverged`);
  }
  if (p.apply_error) {
    lines.push(`not applied: ${p.apply_error.message}${p.apply_error.hint ? `\n  hint: ${p.apply_error.hint}` : ""}`);
  }
  if (p.diff) lines.push("", p.diff.trimEnd());
  return lines.join("\n");
}

/** A proposal that ended `rejected`, or validated but not applied, is a failed command (exit 1, like any error). */
function proposalFailure(p: Proposal & { apply_error?: { message: string; hint?: string } }, name: string) {
  const show = `pipo proposals ${name} show ${p.id}`;
  if (p.apply_error) {
    return new CliError(
      `proposal ${p.id} was stored but not applied: ${p.apply_error.message}`,
      p.apply_error.hint ?? `see ${show}, then fix it and propose again`,
    );
  }
  if (p.state !== "rejected") return undefined;
  const errors = (p.diagnostics ?? []).filter((d) => d.severity === "error");
  const why = [...p.problems.map((x) => `[${x.code}] ${x.message}`), ...errors.map((d) => `[${d.code}] ${d.message}`)];
  return new CliError(
    `proposal ${p.id} was rejected: ${why.join("; ") || p.decision || "no reason recorded"}`,
    errors[0]?.hint ?? p.problems[0]?.hint ?? `see ${show}, then fix the file and propose again`,
  );
}

export async function cmdProposals(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...COMMON,
      state: { type: "string" },
      limit: { type: "string" },
      reason: { type: "string" },
      base: { type: "string" },
      hold: { type: "boolean" },
      by: { type: "string" },
    },
  });
  const [name, sub, ...rest] = positionals;
  if (!name) return usage(USAGE);
  if (sub === undefined) {
    if (values.state !== undefined && !STATES.includes(values.state)) {
      throw new CliError(`--state '${values.state}' is not a proposal state`, `use one of ${STATES.join(", ")}`);
    }
    const a = {
      ...(values.state !== undefined && { state: values.state }),
      ...(values.limit !== undefined && { limit: Number(values.limit) }),
    };
    const q = new URLSearchParams(Object.entries(a).map(([k, v]): [string, string] => [k, String(v)])).toString();
    const ctx = await context(values);
    const r = await readOp(ctx, name, "proposals", a, `/proposals${q ? `?${q}` : ""}`);
    out(ctx, { pipeline: name, ...r }, renderProposals(r.proposals as ProposalSummary[], name));
    return 0;
  }
  if (sub === "show" || sub === "apply" || sub === "reject") {
    const [id] = rest;
    if (!id || rest.length > 1) return usage(USAGE);
    const ctx = await context(values);
    if (sub === "show") {
      const r = await readOp(ctx, name, "proposal", { id }, `/proposals/${enc(id)}`);
      out(ctx, { pipeline: name, proposal: r }, renderProposal(r as unknown as Proposal));
      return 0;
    }
    const by = who(values.by);
    if (sub === "apply") {
      const r = await writeOp(
        ctx,
        name,
        "apply_proposal",
        { id, by },
        `/proposals/${enc(id)}/apply`,
        "apply proposals",
      );
      const text = `applied proposal ${id}: new packets use v${r.version}; ${
        r.pending_older ? `${r.pending_older} packet(s) in flight finish on their own version` : "nothing was in flight"
      }`;
      out(ctx, { pipeline: name, result: r }, text);
      return 0;
    }
    if (!values.reason?.trim()) {
      throw new CliError("reject needs --reason", `pipo proposals ${name} reject ${id} --reason "why"`);
    }
    const body = { id, reason: values.reason, by };
    const r = await writeOp(ctx, name, "reject_proposal", body, `/proposals/${enc(id)}/reject`, "reject proposals");
    out(ctx, { pipeline: name, proposal: r }, `rejected proposal ${id}: ${values.reason}`);
    return 0;
  }
  if (sub === "propose") {
    const [file] = rest;
    if (!file || rest.length > 1) return usage(USAGE);
    if (!values.reason?.trim()) {
      throw new CliError("propose needs --reason", `pipo proposals ${name} propose ${file} --reason "what and why"`);
    }
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch (e) {
      throw new CliError(`cannot read ${file}: ${(e as Error).message}`, "pass the whole proposed .pipo file");
    }
    const ctx = await context(values);
    let base: string | number | undefined = values.base;
    if (base === undefined) {
      const list = (await readOp(ctx, name, "versions", {}, "/versions")) as unknown as VersionList;
      if (list.latest === null) throw new CliError(`${name} has no versions yet`, `start it once: pipo start <file>`);
      base = list.latest;
    }
    const by = who(values.by);
    const common = { source, base_version: base, reason: values.reason, ...(values.hold && { apply: false }) };
    const body = ctx.api ? { ...common, by, by_kind: "human" } : { ...common, author: by, author_kind: "human" };
    const r = (await writeOp(ctx, name, "propose", body, "/proposals", "take proposals")) as Proposal;
    const failed = proposalFailure(r as Proposal & { apply_error?: { message: string; hint?: string } }, name);
    if (failed) throw failed;
    out(ctx, { pipeline: name, proposal: r }, renderProposal(r));
    return 0;
  }
  return usage(USAGE);
}

const RESOLVE_USAGE = 'pipo resolve <name> <id…> --action retry|dead_letter|drop [--reason "…"] [--by who]';

export async function cmdResolve(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...COMMON, action: { type: "string" }, reason: { type: "string" }, by: { type: "string" } },
  });
  const [name, ...ids] = positionals;
  if (!name || !ids.length || !values.action) return usage(RESOLVE_USAGE);
  const ctx = await context(values);
  const body = {
    ids,
    action: values.action,
    by: who(values.by),
    by_kind: "human",
    ...(values.reason !== undefined && { reason: values.reason }),
  };
  const r = await writeOp(ctx, name, "resolve", body, "/resolve", "resolve packets");
  const lines = (r.resolved as { packet_id: string; state: string }[]).map((x) => `  ${x.packet_id} → ${x.state}`);
  out(
    ctx,
    { pipeline: name, result: r },
    [`resolved ${lines.length} unit(s) of ${name} (${values.action})`, ...lines].join("\n"),
  );
  return 0;
}
