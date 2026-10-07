# ticket-triage

An `http` input takes support tickets (`{subject, body}`), an agent node asks Claude for a category, a priority and a one-line summary (checked against `triage.schema.json`), and the answer is appended to `./out/triaged.jsonl`. `agent_budget` caps the cost: $0.50 a day for this pipeline and 4,000 tokens per ticket, with a warning at 80%.

## Run it with the mock provider (no API key, no cost)

`mock-claude.ts` answers like the Anthropic Messages API, classifying by keywords, and reports 400 input and 100 output tokens per call ($0.0009 at the built-in Haiku price). Use a throwaway Pipo home so nothing touches `~/.pipo`:

```sh
export PIPO_HOME=/tmp/pipo-triage MOCK_CLAUDE_KEY=unused
mkdir -p $PIPO_HOME
cat > $PIPO_HOME/config.yaml <<'EOF'
engine:
  timezone: UTC
  agent_budget: { per_day: 1.00 }   # all pipelines of this home together (spec §3.11)
agents:
  claude_api:
    base_url: http://127.0.0.1:8790
    api_key: env:MOCK_CLAUDE_KEY
EOF
bun examples/ticket-triage/mock-claude.ts &                  # the mock, on port 8790
bun pipo run examples/ticket-triage/ticket-triage.pipo
# in another terminal:
curl -s localhost:8791/in/ticket-triage/tickets -H 'content-type: application/json' \
  -d '{"subject": "Site is down", "body": "Checkout fails for everyone since 9:00"}'
```

`bun pipo status --no-engine` shows the day's agent spend against `engine.agent_budget.per_day`. Lower `per_day` in the pipeline or in `config.yaml` to see a `budget` pause: packets keep being accepted, and the pipeline resumes by itself when the next budget day starts (or at once with `pipo resume`, which goes over the cap until then).

For real calls, drop `base_url` and point `api_key` at a secret reference such as `op://vault/anthropic/key` (1Password).

## Test it

```sh
bun pipo test examples/ticket-triage
```

`fixtures/stubs.json` answers the agent node, so the test makes no calls at all.
