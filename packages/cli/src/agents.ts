// approvals and mcp (docs/spec.md §6, §9.2, §9.4, D81, D82): what agents wrote with create_pipeline and a human's
// approve or reject (`--start` approves and starts it in one go), and the agents connected over OAuth. They go through
// the engine's REST API, which owns approvals.json and mcp-grants.json.
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import { COMMON, context, needEngine, out, usage } from "./lifecycle";
import { table } from "./packets";
import { formatAgo } from "./status";
import { done } from "./tty";

const enc = encodeURIComponent;

function who(by: string | undefined): string {
  if (by) return by;
  try {
    return userInfo().username || "cli";
  } catch {
    return "cli";
  }
}

interface ApprovalRow {
  name: string;
  file: string;
  by: string;
  reason: string | null;
  effective: string;
  changed: boolean;
  requested_at: string;
  decided_by: string | null;
  pipeline_state: string | null;
}

export function renderApprovals(list: ApprovalRow[], autoApprove: boolean, now = Date.now()): string {
  const head = autoApprove ? "auto-approve is on: pipelines agents write run without approval\n" : "";
  if (!list.length) return `${head}no pipelines written by agents`;
  const rows = list.map((a) => [
    a.name,
    `${a.effective}${a.changed && a.effective === "pending" && a.decided_by ? " (changed since approval)" : ""}`,
    a.by,
    formatAgo(Date.parse(a.requested_at), now),
    a.pipeline_state ?? "never started",
    a.reason ?? "",
  ]);
  return head + table(["PIPELINE", "APPROVAL", "AGENT", "WRITTEN", "STATE", "REASON"], rows);
}

export async function cmdApprovals(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...COMMON, start: { type: "boolean" }, reason: { type: "string" }, by: { type: "string" } },
  });
  const [verb, name] = positionals;
  const USAGE = 'pipo approvals [approve <name> [--start] | reject <name> [--reason "…"]]';
  if (verb !== undefined && ((verb !== "approve" && verb !== "reject") || !name)) return usage(USAGE);
  const ctx = await context(values);
  const api = needEngine(ctx, "read or decide approvals");
  if (verb === undefined) {
    const r = await api.call("GET", "/api/approvals");
    out(ctx, r, renderApprovals(r.approvals, r.auto_approve));
    return 0;
  }
  const by = who(values.by);
  if (verb === "approve") {
    const r = await api.call("POST", `/api/approvals/${enc(name as string)}/approve`, {
      by,
      ...(values.start && { start: true }),
    });
    out(ctx, r, done(`approved ${name}${r.pipeline ? ` and started it (pid ${r.pipeline.pid})` : ""}`));
    return 0;
  }
  const r = await api.call("POST", `/api/approvals/${enc(name as string)}/reject`, {
    by,
    ...(values.reason !== undefined && { reason: values.reason }),
  });
  out(ctx, r, done(`rejected ${name}`));
  return 0;
}

interface GrantRow {
  id: string;
  name: string;
  client_name: string;
  scope: string;
  pipelines: string[] | null;
  created_at: string;
  last_used_at: string | null;
}

export function renderGrants(
  grants: GrantRow[],
  tokens: { name: string; scope: string; pipelines: string[] | null }[],
  now = Date.now(),
): string {
  const rows = [
    ...grants.map((g) => [
      g.id,
      g.name,
      g.scope,
      g.pipelines ? g.pipelines.join(", ") : "all",
      `OAuth: ${g.client_name}`,
      g.last_used_at ? formatAgo(Date.parse(g.last_used_at), now) : "never",
    ]),
    ...tokens.map((t) => ["-", t.name, t.scope, t.pipelines ? t.pipelines.join(", ") : "all", "config.yaml", "-"]),
  ];
  if (!rows.length) return "no agents connected: add the engine to an MCP client (see 'pipo help mcp')";
  return table(["ID", "NAME", "SCOPE", "PIPELINES", "FROM", "LAST USED"], rows);
}

/** `pipo mcp grants [revoke <id>]` (§9.2, D82): the agents connected over OAuth, and the config tokens. */
export async function cmdMcp(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: COMMON });
  const [what, verb, id] = positionals;
  const USAGE = "pipo mcp grants [revoke <id>]";
  if (what !== "grants" || (verb !== undefined && (verb !== "revoke" || !id))) return usage(USAGE);
  const ctx = await context(values);
  const api = needEngine(ctx, "list or revoke MCP grants");
  if (verb === undefined) {
    const r = await api.call("GET", "/api/mcp/grants");
    out(ctx, r, renderGrants(r.grants, r.tokens));
    return 0;
  }
  const r = await api.call("POST", `/api/mcp/grants/${enc(id as string)}/revoke`, {});
  out(ctx, r, done(`revoked ${id}: its tokens stop working now`));
  return 0;
}
