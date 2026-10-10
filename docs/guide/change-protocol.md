# Live changes and proposals

A running pipeline can be changed without stopping it. The change is a **proposal**: a whole new `.pipo` source, written against the version in force. Pipo validates it, optionally dry-runs it on recent packets, and applies it at a safe point as the next version. New packets use the new version. Packets already in flight finish on the version that accepted them.

The same protocol serves humans (the CLI, REST, the builder's **🚀 Apply live**) and agents (MCP). For agents, the pipeline's `agent.edit` policy says what they may change.

```text
propose ──► validate ──► dry run (optional) ──► apply at a safe point ──► version N+1
               │                 │
               └──► rejected ◄───┘
```

## Proposing a change from the CLI

Edit a copy of the file, then propose it:

```sh
cp people-intake.pipo /tmp/people-intake.next.pipo
$EDITOR /tmp/people-intake.next.pipo
pipo proposals people-intake propose /tmp/people-intake.next.pipo --reason "Retry telemetry 5 times"
```

If it passes, it is applied right away and the command prints the new version. Check the result:

```sh
pipo history people-intake       # who made each version, why, and packets still pinned to it
pipo diff people-intake 3 4      # unified diff between two versions
```

> [!NOTE]
> A proposal changes the running pipeline, not the file on disk. The next `pipo start` with a **changed** file runs the file as a new version. With an unchanged file, it keeps the latest version, so an applied proposal or a rollback survives restarts. Copy the change into the file too (the builder's Apply live does that for you).

## The steps

### 1. Propose

A proposal is:

| Field | Meaning |
|---|---|
| `source` | The whole proposed `.pipo` file. At most 1 MiB. |
| `base_version` | The version it was written against. It must be the latest version, or the proposal is rejected as `stale_base`. |
| `reason` | Why, in a sentence. At most 2000 characters. |
| `author`, `author_kind` | Who made it: a name, and `human` or `agent`. |
| `apply` | `false` holds it after validation instead of applying it. |

### 2. Validate

Every proposal is refused when:

- it fails `pipo check` (the problems carry the diagnostics);
- its base isn't the latest version (`stale_base`);
- it changes something the runner binds at start (see [What can't change live](#what-cant-change-live));
- it uses a feature the runner can't run yet;
- it's identical to the version in force.

An **agent's** proposal is also checked against the policy of the version in force:

- `agent.control` must be `true` and `agent.edit` non-empty;
- every changed path must be covered by an `agent.edit` pattern;
- changes under `output`, `delivered`, `secrets`, `agent` and `agent_budget` are always refused (`forbidden_path`), even when `agent.edit` lists them or `*` covers them.

All problems are reported together, each with a `message` and a `hint`. A rejected proposal is stored with its state and problems, so it can be inspected later.

### 3. Dry run (optional)

When the version in force sets `agent.verify: last N`, an agent's proposal is replayed on the newest *N* delivered packets before it can apply. Each packet runs again, in memory, through the proposed version:

- filters, routes, `map` and `fn` transforms run;
- taps and the output are mocked: their `with:` is rendered, but nothing is called, sent or written;
- agent nodes and `transform: http` return what they returned when that packet was delivered, checked again against the proposed schema;
- the delivery check isn't run, and secrets render as `***`.

The proposal is **rejected** if any packet diverges:

- the proposed input `schema` or `validate` rejects it;
- a step fails (a tap with `then: continue` is only a warning);
- a replayed agent answer no longer matches the proposed schema;
- a node with no recorded result would have to be called (a new agent node, a new path): `unverifiable`;
- it fails `output.validate`, or `output.with` can't be rendered.

Different values, added or removed fields, and packets the new version filters out are not divergence: they're reported for you to read. Otherwise the proposal is `verified`. Nothing is written to the journal during the dry run, only its report at the end. The report has counts and, per packet, the outcome, the would-be output keys, the mocked taps and up to 5 reasons. It never contains payloads.

If fewer than *N* delivered packets exist, it replays what there is. With none, it doesn't pass. Packets whose payload retention already cleared are skipped.

### 4. Apply at a safe point

A proposal that passed is applied at once. `agent.edit` is the grant, so there is no separate human approval step. Applying is one transaction: version *N+1* and the proposal's `applied` state are committed together, so a crash leaves one or the other, never half. New packets switch to *N+1* immediately. Packets already accepted finish on *N*.

### Holding a proposal

To review a change before it applies, hold it:

```sh
pipo proposals people-intake propose next.pipo --reason "New prompt" --hold
pipo proposals people-intake                    # list, newest first
pipo proposals people-intake show <id>          # diff, problems, dry-run summary
pipo proposals people-intake apply <id>
pipo proposals people-intake reject <id> --reason "Too aggressive"
```

A held proposal stays `validated` (or `verified`) until someone with control applies or rejects it. Agents hold with `apply: false` on `propose_change`. Applying a `validated` proposal that still needs its dry run runs the dry run first.

A held proposal whose base is no longer the latest version (because something else was applied in between) is rejected when you try to apply it. Propose it again against the new version.

### Proposal states

| State | Meaning |
|---|---|
| `validated` | Passed validation; waiting for its dry run or to be applied. |
| `verified` | Passed the dry run. |
| `applied` | Became a version (`applied_version`). |
| `rejected` | Failed validation or the dry run, was rejected by hand, or went stale. |

`pipo proposals <name> --state rejected` lists one state.

## What an agent may change

`agent.edit` lists dotted paths. `*` matches exactly one segment, and a path covers everything under it.

```yaml
agent:
  control: true
  edit:
    - nodes.*.with.prompt      # any node's prompt
    - nodes.normalize          # everything about the normalize node
    - errors                   # the default error policy
  verify: last 20
```

| Pattern | Covers | Doesn't cover |
|---|---|---|
| `nodes.normalize` | `nodes.normalize.transform`, `nodes.normalize.with.x` | `nodes.telemetry` |
| `nodes.*.with.prompt` | `nodes.draft.with.prompt`, `nodes.review.with.prompt` | `nodes.draft.with.model` |
| `nodes.*` | adding, removing or changing any node | `output`, `errors` |

Changed paths come from a structural comparison of the two files: maps key by key, and a list or a scalar as one path. Key order, formatting and comments are never a change.

## What can't change live

Some settings are bound when the runner starts, so no proposal (from anyone) can change them. The hint says to put the change in the file and restart instead:

- `name`;
- the inputs, except their `schema`, `validate` and `on_invalid`;
- `output.to` (other output settings can change);
- `secrets`, `concurrency`, `lifetime` and `delivered.stall`;
- an agent provider, or a model without a price, that the runner didn't set up at start.

## From REST and the builder

REST mirrors the CLI (see [REST, SSE and MCP](api.md#versions-and-proposals)):

| Method | Path | Body |
|---|---|---|
| `GET` | `/api/pipelines/<name>/proposals?state=&limit=` | |
| `GET` | `/api/pipelines/<name>/proposals/<id>` | |
| `POST` | `/api/pipelines/<name>/proposals` | `{source, base_version, reason, by?, by_kind?, apply?}` |
| `POST` | `/api/pipelines/<name>/proposals/<id>/apply` | `{by?}` |
| `POST` | `/api/pipelines/<name>/proposals/<id>/reject` | `{reason, by?}` |

`by` defaults to `api` and `by_kind` to `human`. These local channels are trusted to say who they are. Only `/mcp` fixes them, as `agent` with the token's name. Reads work from the journal even when the pipeline isn't running; propose, apply and reject need the runner.

In the [builder](builder.md), **🚀 Apply live** on a running pipeline sends the draft as a human proposal (`by: ui`, applied at once) and, once it's applied, saves the file too, so the next start runs the same version. A refused proposal leaves the file as it was and shows the problems.

## Rollback

`pipo rollback <name> <v>` makes version *v*'s definition the next version, for new packets only:

```sh
pipo history people-intake
pipo rollback people-intake 3
```

Its `fn` module and schema files are read as they are now. Each version records the hashes of its files, so a file that changed since *v* was recorded is reported as a warning. Restoring old code is version control's job. Rollback needs the running pipeline.

An agent's rollback (the MCP `rollback` tool) is a proposal of *v*'s source against the version in force, so `agent.edit`, the forbidden paths and `agent.verify` apply to it, and the audit names the agent.

## Audit

Every version records who made it (`author`, and `author_kind`: `human` or `agent`), the reason, the proposal it came from, the diff from the version before it, and the content hashes of its `fn` module and schema files. Every packet records the version that processed it, so any result can be traced back to the exact definition that produced it.

```sh
pipo history people-intake --json
```

## See also

- [Agents as operators](agent-operators.md)
- [Versions and rollback](versions.md)
- [CLI: `pipo proposals`](../reference/cli.md#pipo-proposals)
- The spec: [§9.3 Change protocol](../spec.md#93-change-protocol-propose--validate--apply)
