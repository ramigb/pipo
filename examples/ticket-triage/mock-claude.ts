// A stand-in for the Anthropic Messages API, so the ticket-triage example runs end to end with no API key and no cost.
// It answers `POST /v1/messages` the way the `claude` provider expects (one forced tool call, docs/spec.md D36),
// classifying by keywords, and reports fixed token counts (400 in, 100 out), so each call costs the same small amount
// against `agent_budget` and `engine.agent_budget`. Point `agents.claude_api.base_url` in config.yaml at it.
//   bun examples/ticket-triage/mock-claude.ts [port]     (default 8790)

const RULES: [RegExp, string, string][] = [
  [/\b(down|outage|unreachable|fails?|500|error)\b/i, "outage", "high"],
  [/\b(invoice|refund|charged?|billing|payment)\b/i, "billing", "normal"],
  [/\b(password|login|sign ?in|account|2fa)\b/i, "account", "normal"],
];

/** Usage every answer reports: what the budgets count. */
export const MOCK_USAGE = { input_tokens: 400, output_tokens: 100 };

/** Answer one Messages API request. */
export async function mockClaude(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== "POST" || url.pathname !== "/v1/messages") {
    return Response.json(
      { type: "error", error: { type: "not_found_error", message: "only POST /v1/messages" } },
      {
        status: 404,
      },
    );
  }
  const body = (await req.json()) as {
    model: string;
    messages: { content: string }[];
    tool_choice?: { name?: string };
  };
  const prompt = String(body.messages?.[0]?.content ?? "");
  const [, category, priority] = RULES.find(([re]) => re.test(prompt)) ?? [null, "other", "low"];
  const subject = /Subject: (.*)/.exec(prompt)?.[1]?.trim() ?? "a ticket";
  return Response.json({
    id: "msg_mock",
    type: "message",
    role: "assistant",
    model: body.model,
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: "toolu_mock",
        name: body.tool_choice?.name ?? "pipo_output",
        input: { category, priority, summary: `${category} ticket: ${subject}`.slice(0, 200) },
      },
    ],
    usage: MOCK_USAGE,
  });
}

if (import.meta.main) {
  const port = Number(process.argv[2] ?? 8790);
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: mockClaude });
  console.log(`mock Claude API on http://127.0.0.1:${server.port} (POST /v1/messages)`);
}
