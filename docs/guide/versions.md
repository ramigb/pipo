# Versions and rollback

Every definition a pipeline has ever run is kept in its journal as a numbered **version**, with who made it and why. Each packet is **pinned** to the version that accepted it and finishes on that version, so you can change a running pipeline without disturbing packets already in flight, and trace any result back to the exact definition that produced it.

```sh
pipo history people-intake             # every version: who, when, why, what's still pinned
pipo diff people-intake 2 3            # what changed between two versions
pipo rollback people-intake 2          # run v2's definition again, as a new version
```

## How versions are made

A new version is made in four ways:

| Way | Author | Reason recorded |
|---|---|---|
| **Starting with a changed file.** `pipo start`, `pipo restart`, `pipo run` or a crash restart runs the `.pipo` file only when its content changed since the last start. | `human` | `first start` or `file changed` |
| **Applying a proposal**, live: `pipo proposals <name> propose <file>`, the builder's **🚀 Apply live**, or an agent's `propose_change`. | whoever proposed it | the proposal's reason |
| **Rolling back**: `pipo rollback <name> <v>`, the dashboard, or an agent's `rollback`. | `cli`, `api` or the agent | `rollback to v<n>` |
| **Applying through the API**: `POST /api/pipelines/<name>/proposals`. | as declared | as given |

A start with an **unchanged** file keeps the latest version in force. So a version you applied live or rolled back to survives `pipo restart`, a crash restart and an engine reattach, even though the file on disk says something else. To make the file win again, change it (and keep it in step with what runs; the builder's Apply live saves the file for you).

An earlier definition used again is still a new version: the history is a timeline, never rewritten.

## Pinning

- A packet runs every step on the version that accepted it, with **that version's own `fn` code and schema files**, compiled when the version was stored. They are never re-read from disk.
- A new version applies only to **newly accepted** packets. In-flight packets, packets held by a pause, dead letters you replay and packets waiting for an agent all finish on their own version.
- `pipo history` shows how many pending packets are still pinned to each version.
- `pipo rerun --current` is the one way to move settled packets onto the version in force (see [Recovering packets](recovery.md#rerunning-settled-packets)).

## `pipo history`

```text
$ pipo history heartbeat
  VER  CREATED  AUTHOR  PENDING  HASH          REASON
*v1    1m ago   human         0  20082e392cfc  first start
* new packets use v1; in-flight packets finish on their own version
```

The `*` marks the version in force. `HASH` is the hash of the version's source. `PENDING` counts packets still pinned to it. `--json` gives every recorded field, the file hashes included. It works on a stopped pipeline, from its journal.

## `pipo diff`

```sh
pipo diff <name> <v1> <v2>
```

A unified diff of two versions' `.pipo` source, with three lines of context. Versions are given as `3` or `v3`. It works on a stopped pipeline too.

## `pipo rollback`

```sh
pipo rollback <name> <v>
```

Runs version *v*'s definition again **as a new version**, for new packets only. In-flight packets keep their own. The rollback is checked like a start, and refused with the diagnostics if it no longer passes `pipo check`. It needs the runner.

The `.pipo` source is restored, but the `fn` module and schema files are read and compiled as they are on disk now. Each version records the hashes of the files it was compiled with. When one of them changed since version *v* was recorded, the rollback prints a warning (`file_changed`), and the runner logs it. Restoring old code is version control's job: check out the old module, then roll back.

## Live changes and restarts

A live change (an applied proposal, a rollback, the builder's Apply live) switches new packets to the new version without stopping the pipeline. Some parts of a pipeline are bound when the runner starts, so changing them live is refused, with a hint to put the change in the file and restart:

- `name`
- `input` (or an input under `inputs`), except its `schema`, `validate` and `on_invalid`
- `output.to`
- `secrets`
- `concurrency`
- `lifetime`
- `delivered.stall`
- an agent provider, or a model without a price, that the runner didn't set up at start

Everything else can change live: nodes and their wiring, error policies, `output.with` (including the `pipeline` a chain feeds), `output.validate`, `delivered` checks, `agent_budget` and so on. A live change is also refused while the pipeline is starting (try again), draining or stopped, or while another change is being applied.

Applying the same content as the running version changes nothing (`changed: false`). If your `fn` module changed on disk since the running version was compiled, the reply warns `module_not_reloaded`: restart to compile the module as it is now.

## Proposals

A proposal is a change submitted against a version, checked before it applies:

1. **Validate.** The new definition must pass `pipo check`. An agent's proposal must also touch only the paths its pipeline's `agent.edit` allows.
2. **Dry run**, when the pipeline sets `agent.verify: last N`: the new version replays the last *N* delivered packets in memory and is rejected if any result diverges.
3. **Apply** at a safe point, as the next version. The version and the proposal's `applied` state commit together.

People use the same flow:

```sh
pipo proposals people-intake propose ./people-intake.pipo --reason "longer bio limit"
pipo proposals people-intake                  # list, newest first (--state to filter)
pipo proposals people-intake show <id>        # its diff, problems and dry-run summary
```

`--hold` stores a proposal without applying it, to be applied later with `pipo proposals <name> apply <id>` or rejected with `reject <id> --reason "…"`. `--base <n>` names the version the file was written against. See [Live changes and proposals](change-protocol.md) for the full protocol and the agent side.

## Audit

Each version records:

- **who** made it (`author`: a person, `cli`, `api`, `ui` or an agent token's name) and whether that was a human or an agent,
- **why** (`reason`) and the proposal it came from, if any,
- **when**, and the content hash of its source,
- the content hashes of the `fn` module and schema files it was compiled with.

Each applied version is also a `version.applied` event in the journal, shown on the dashboard's **🤖 Agent** feed and **🕰️ Versions** tab. Every packet records which version processed it.
