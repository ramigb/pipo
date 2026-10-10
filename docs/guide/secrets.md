# Secrets

Secret values never appear in a `.pipo` file. A pipeline declares each secret by **reference**, and the runner resolves the references when the pipeline starts. The file stays safe to commit, diff and review, and agents can read and edit it without seeing a credential.

```yaml
pipo: 1
name: intake
secrets:
  intake_token: env:PIPO_INTAKE_TOKEN          # an environment variable
  crm_token: op://Pipo/crm/api-token           # a 1Password item field
input:
  via: http
  with:
    path: /people
    auth:
      header: X-Pipo-Token
      equals: "${secrets.intake_token}"
output:
  from: input
  to: http
  with:
    url: https://crm.example.com/api/people
    headers:
      Authorization: "Bearer ${secrets.crm_token}"
```

```sh
PIPO_INTAKE_TOKEN=dev-token pipo run intake.pipo --listen 8787
```

## References

| Reference | Resolved from |
|---|---|
| `env:NAME` | The environment variable `NAME` of the runner's process |
| `op://vault/item/field` | 1Password, through the `op` CLI (`op read`) |

Nothing else is accepted: the JSON Schema only allows values starting with `op://` or `env:`. 1Password is the recommended provider for anything that matters, because the value never sits in a shell profile or an `.env` file.

Secrets are resolved **once, at start**. A missing variable or an unreadable 1Password item refuses the start, and says which secret failed and why:

```text
secret 'intake_token': environment variable PIPO_INTAKE_TOKEN is not set
```

A changed secret value takes effect on the next start (`pipo restart`).

## Using secrets

Use `${secrets.<name>}` in a template, **only inside `with:` blocks**: an input's, a node's, the output's or the delivery check's.

```yaml
nodes:
  enrich:
    from: input
    transform: http
    with:
      url: "https://api.example.com/v1/lookup?email=${data.email}"
      headers: { Authorization: "Bearer ${secrets.api_token}" }
```

`pipo check` enforces this:

| Code | Problem |
|---|---|
| P013 | `${secrets.x}` names a secret that isn't declared under `secrets:` |
| P051 | `secrets` used outside a `with:` block: in a message, a `validate` rule, a filter, a route |
| P050 | A literal value that looks like a credential (warning) |

**P050** fires on a string in a `with:` block that looks like a token (`Bearer …`, `sk-…`, `ghp_…`, `xoxb-…`, `AKIA…`), or that sits under a key named like `token`, `secret`, `password`, `api_key`, `authorization` or `credential`, and isn't a template or a reference:

```text
intake.pipo:9:15  warning  P050  'equals' looks like a literal credential
  declare it under secrets: (op://… or env:…) and use ${secrets.<name>}
```

## Redaction

Every resolved secret value is masked as `***` wherever the runner writes or answers:

- the runner's log, and log lines from `fn` modules and exec programs,
- error messages, dead letters and the journal's events,
- `pipo inspect`, `pipo logs`, the dashboard and every REST and MCP response.

Bot tokens from `bots.json` and agent API keys are redacted the same way, even though pipelines can't read them as `secrets.*`. Values shorter than 4 characters aren't masked, because masking them would garble ordinary text. Don't use secrets that short.

Redaction works on the value, wherever it appears. Still, don't put secrets into packet `data`. A transform that copies a token into `data` sends it down the pipeline, and it can reach a destination before anything masks it. Agents can be given more redaction with `agent.redact` (paths in packet data, such as `data.email`); see [Agents as operators](agent-operators.md).

## Environment variables

**Under `pipo run`**, the runner inherits the environment of your shell, so `env:` references read the variables you set there.

**Under the engine**, a runner inherits the environment of the engine process: the shell that ran `pipo engine start`, or the `pipo` command that started the engine on demand. Set the variables there, and restart the engine after changing them (`pipo engine stop`, then any command). A detached runner keeps the environment it started with.

`env:` secrets and the `env` expression variable are different things:

| | `env:NAME` secret | `env.NAME` in expressions |
|---|---|---|
| Declared in | The pipeline's `secrets:` | `engine.env_allow` in `config.yaml`, or `pipo run --env-allow A,B` |
| Usable in | `with:` blocks only | Everywhere |
| Redacted | Yes | No |

Use `env` for configuration that isn't secret (a region, a base URL, a feature flag), and a secret for anything that is:

```yaml
# ~/.pipo/config.yaml
engine:
  env_allow: [DEPLOY_REGION, API_BASE_URL]
```

## 1Password

`op://` references are read with the 1Password CLI, `op read --no-newline <reference>`, run by the runner when the pipeline starts.

1. [Install the 1Password CLI](https://developer.1password.com/docs/cli/get-started/) so `op` is on the `PATH` of the engine (or your shell, for `pipo run`).
2. Sign it in where the runner runs. Any way `op read` works in that environment works for Pipo: the 1Password desktop app's CLI integration, `op signin`, or a service account token (`OP_SERVICE_ACCOUNT_TOKEN`) for unattended machines.
3. Copy the reference from 1Password (an item field's **Copy Secret Reference**), for example `op://Pipo/crm/api-token`.
4. Check it from the same environment: `op read op://Pipo/crm/api-token`.

If `op` isn't installed, the start fails with "1Password CLI 'op' is not installed; install it or use env: references". If it can't read the item, the start fails with `op`'s own message.

> [!TIP]
> Under the engine, the desktop app integration may ask to approve access the first time a runner resolves a secret. For a machine nobody watches, use a service account restricted to the vault the pipelines need.

## Other credentials

A few credentials live outside pipeline files. All of them take the same kind of reference:

| Credential | Where | Reference |
|---|---|---|
| Telegram bot tokens | `<home>/bots.json`, set from the dashboard's **🤖 Bots** page | The raw token, or `op://…` / `env:…`. The file is written with mode `0600`. See [Telegram bots](telegram.md). |
| A telegram step's own token | `with.token` in the pipeline | `${secrets.tg_token}` |
| The Anthropic API key | `agents.claude_api.api_key` in `config.yaml` | `op://…` or `env:…` (default `env:ANTHROPIC_API_KEY`). See [Agent nodes](agent-nodes.md). |
| MCP tokens | `engine.mcp.tokens[].token` in `config.yaml` | Only `op://…` or `env:…`. A literal is a config error, and the message never repeats it. See [Agents as operators](agent-operators.md). |

CLI agents (`claude_code`, `codex`, `pi`, `opencode`) use the account the CLI is logged in to on your machine; Pipo never sees those credentials.

## The security model

- **Local by default.** The engine binds to `127.0.0.1`. Exposing an http input to a network is your explicit choice (a reverse proxy, a tunnel). Protect such inputs with `auth`: a shared header token (`header` + `equals`), or an HMAC signature of the raw body (`hmac: {header, secret, algorithm}`), checked in constant time before anything is journaled. See [Inputs](inputs.md).
- **Secrets by reference.** Never in `.pipo` files, the journal, logs or agent responses.
- **Agents are scoped.** MCP access uses named bearer tokens with a scope (`read`, `operate`, `edit`) and an optional pipeline allowlist, on top of each pipeline's own `agent:` policy. Agents can never change `secrets`, `output`, `delivered`, `agent` or `agent_budget` through a proposal. Every change is versioned with its author.
- **Code is trusted.** `fn` modules, exec steps and connectors run as you. `fn` modules run in QuickJS without system APIs, and each pipeline is its own process, but neither is a reviewed sandbox. Templates from outside your project are untrusted until `pipo trust` records their content hash, and again after they change (P052). Sandboxing `fn` modules is planned.
- **Isolation.** Each pipeline runs in its own process with its own journal. A crash, or a misbehaving function, affects only that pipeline.

## See also

- [Configuration](configuration.md): `config.yaml` and the Pipo home
- [Inputs](inputs.md): http authentication
- Spec: [§3.7 secrets](../spec.md#37-secrets), [§11 security](../spec.md#11-security)
