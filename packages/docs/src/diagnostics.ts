// Every diagnostic `pipo check` (and the CLI's `pipo compile`) can report, for the generated Diagnostics page.
// docs.test.ts fails when a code used in packages/spec/src or packages/cli/src is missing here.

export interface DiagnosticDoc {
  code: string;
  severity: "error" | "warning";
  /** One line: what's wrong. */
  title: string;
  /** When it fires, in a short paragraph of Markdown. */
  detail: string;
  /** What to do about it. */
  fix?: string;
}

export const DIAGNOSTICS: DiagnosticDoc[] = [
  {
    code: "P001",
    severity: "error",
    title: "YAML syntax error",
    detail:
      "The file isn't well-formed YAML: bad indentation, an unclosed quote or bracket, a tab, or a key repeated in one mapping. Nothing else is checked until the YAML parses.",
    fix: "Fix the YAML at the reported line and column. Quote values that contain `: ` or start with `{`, `[`, `*` or `&`.",
  },
  {
    code: "P002",
    severity: "error",
    title: "The file doesn't match the schema",
    detail:
      "A structural problem the JSON Schema catches: an unknown key (with a *did you mean* hint), a missing required key, a value outside an enum, a wrong type, a duration that isn't like `500ms`, `10s`, `5m`, `1h` or `7d`, or a name that doesn't match its pattern. Each connector's `with:` is checked against that connector's own schema. Semantic checks run only once the file has no P002.",
    fix: "Follow the hint. `pipo schema` prints the full schema, and the [Connectors](connectors.md) page lists every `with:` field.",
  },
  {
    code: "P010",
    severity: "error",
    title: "Unknown `from` target",
    detail:
      "A node's or the output's `from` names something that isn't an input or a node, or has more than one `.` (only `route.branch` is allowed).",
    fix: "Use an existing node id or input name (the hint suggests the closest one).",
  },
  {
    code: "P011",
    severity: "error",
    title: "Bad route branch",
    detail: "`from: x.branch` where `x` isn't a `route` node, or the route has no branch with that name.",
    fix: "Take packets from one of the route's branches, as listed in the hint, or drop the `.branch` part for a non-route node.",
  },
  {
    code: "P012",
    severity: "error",
    title: "Function module or export missing",
    detail:
      "A `tap` or `transform` uses `fn.<name>` but the file has no top-level `fn:` module, or the module doesn't export a function called `<name>`.",
    fix: "Add `fn: ./<module>.ts`, or export the function from it (the hint lists the module's exports).",
  },
  {
    code: "P013",
    severity: "error",
    title: "Undeclared secret",
    detail: "A `with:` block uses `${secrets.<name>}` but `<name>` isn't declared under the top-level `secrets:` map.",
    fix: "Declare it: `secrets: { <name>: env:MY_VAR }` (or an `op://` reference).",
  },
  {
    code: "P014",
    severity: "error",
    title: "Referenced file missing",
    detail:
      "The `fn` module, an input's `schema` or an agent node's `with.schema` names a file that doesn't exist. Paths are relative to the `.pipo` file; templated paths aren't checked.",
    fix: "Create the file or fix the path. In the builder, a missing schema file can be created with one click.",
  },
  {
    code: "P015",
    severity: "error",
    title: "Reserved node id",
    detail: "A node is called `input` or `output`. Those names refer to the pipeline's ends.",
    fix: "Rename the node.",
  },
  {
    code: "P016",
    severity: "error",
    title: "Route used without a branch",
    detail: "`from:` names a `route` node directly. Packets leave a route through one of its branches.",
    fix: "Use `from: <route>.<branch>` (the hint lists them).",
  },
  {
    code: "P017",
    severity: "error",
    title: "`else` isn't the last route branch",
    detail: "Branches are tried in order, so an `else` branch anywhere but last would hide the ones after it.",
    fix: "Move the `else` branch to the end of the route.",
  },
  {
    code: "P020",
    severity: "error",
    title: "Unreachable node or output",
    detail: "A node, or the output, can't be reached by following `from` links from any input.",
    fix: "Connect it: set its `from` to an input or a node that is reached, or remove it.",
  },
  {
    code: "P021",
    severity: "error",
    title: "Dead end",
    detail:
      "A node never leads to the output, or (with `inputs:`) an input that nothing takes packets from on the way to the output. Every packet must be able to end at the output.",
    fix: "Take packets from it in a later node or in `output.from`, or remove it.",
  },
  {
    code: "P022",
    severity: "error",
    title: "Undeclared cycle",
    detail: "The `from` links form a cycle. The graph may loop only through a bounded `loop: { back_to, until, max }`.",
    fix: "Break the cycle and use `loop.back_to` on the later node instead.",
  },
  {
    code: "P023",
    severity: "error",
    title: "Loop target isn't upstream",
    detail: "`loop.back_to` names a node that doesn't feed this one, directly or through other nodes.",
    fix: "Point `back_to` at this node itself or at a node before it.",
  },
  {
    code: "P024",
    severity: "error",
    title: "Loop target unknown",
    detail: "`loop.back_to` names something that isn't a node.",
    fix: "Use the id of an upstream node.",
  },
  {
    code: "P025",
    severity: "warning",
    title: "Unused route branch",
    detail:
      "No node and not the output takes packets from a route branch, so packets sent there are dropped as `filtered`.",
    fix: "Consume the branch (`from: <route>.<branch>`), or remove it if dropping is what you want.",
  },
  {
    code: "P026",
    severity: "warning",
    title: "Fan-out copies share an explicit key",
    detail:
      "A step fans out to more than one path that reaches the output, so the output writes one copy per branch. Each copy has the same `meta.packet_id`; only the default key (`packet_id:<branch>`) tells them apart. Fires when the sqlite key column, an http `Idempotency-Key` header, or a `delivered.with` lookup uses `meta.packet_id` without `meta.branch`.",
    fix: 'Add `meta.branch` to the key, e.g. `"${meta.packet_id}:${meta.branch}"`, or rely on the default key.',
  },
  {
    code: "P030",
    severity: "error",
    title: "Unknown action or provider",
    detail:
      "A `tap`, `transform` or `agent` value isn't a built-in connector or provider (or `fn.<name>` for taps and transforms). `agent: claude` is reported with a hint: the API provider is `claude_api`.",
    fix: "Use one of the names in the hint; see [Connectors](connectors.md).",
  },
  {
    code: "P031",
    severity: "error",
    title: "Delivery check not supported by the output",
    detail:
      "`delivered.check` isn't one the output connector supports, e.g. `file_exists` on `to: sqlite`, or `downstream` on anything but `to: pipeline`.",
    fix: "Pick a check from the hint's list; the matrix is on the [Connectors](connectors.md#delivery-checks) page.",
  },
  {
    code: "P032",
    severity: "error",
    title: "Batching not supported by the output",
    detail: "`output.batch` is set on an output that can't batch. Only `sqlite` and `file` batch.",
    fix: "Remove `batch`, or write to an output that supports it.",
  },
  {
    code: "P033",
    severity: "error",
    title: "`then` not allowed here",
    detail:
      "`then: continue` is set anywhere but on a `tap` node's `on_error` (a failed step that changes data can't be skipped); `then: drop` is used as the default `errors.then`, in `output` or in `delivered.on_fail`; or an input's `on_invalid` has a `then` other than `agent` (invalid input is always rejected, so it can't be dead-lettered, dropped, paused or halted).",
    fix: "Use `dead_letter`, `pause`, `halt` or (with agent control) `agent` there. In an input's `on_invalid`, remove `then`, or use `then: agent` to also tell the agent.",
  },
  {
    code: "P034",
    severity: "error",
    title: "Handing to the agent without agent control",
    detail:
      "`then: agent`, `delivered.stall.then: agent` or `agent.on_stall: handle` is used, but `agent.control` isn't `true`, so there would be no agent endpoint to hand the packet to.",
    fix: "Add `agent: { control: true }`, or choose another policy (`dead_letter`, `pause`, `notify`).",
  },
  {
    code: "P035",
    severity: "error",
    title: "`respond` outside an http input",
    detail: "`on_invalid.respond` (the HTTP status for a rejected request) is set on an input that isn't `via: http`.",
    fix: "Remove `respond`, or make the input `via: http`.",
  },
  {
    code: "P036",
    severity: "error",
    title: "Node needs exactly one kind",
    detail: "A node declares none of `tap`, `transform`, `filter`, `route` and `agent`, or more than one of them.",
    fix: "Give it one kind; split a node with two kinds into two nodes chained with `from:`.",
  },
  {
    code: "P037",
    severity: "error",
    title: "sqlite key not in `columns`",
    detail:
      "`output.with.columns` is set but doesn't include the key column (`key`, default `packet_id`), which is how a repeated write is recognised.",
    fix: "Add the key column to `columns`, or set `key:` to one of your columns.",
  },
  {
    code: "P038",
    severity: "error",
    title: "Bad schedule",
    detail:
      "A `schedule` input has both or neither of `cron` and `every`, or its `cron` doesn't parse. Cron has 5 fields (minute, hour, day of month, month, day of week) and runs in UTC.",
    fix: "Use exactly one, e.g. `every: 5m` or `cron: '0 9 * * 1-5'`.",
  },
  {
    code: "P039",
    severity: "warning",
    title: "Two pipelines share a `listen` port",
    detail:
      "In one multi-file `pipo check` (a folder or several files), two pipelines' http inputs declare the same `with.listen` port. Only one of them can bind it. A single-file check never warns.",
    fix: "Give each pipeline its own port, or drop `listen` and reach them through the engine gateway (`/in/<pipeline>`).",
  },
  {
    code: "P040",
    severity: "error",
    title: "Expression syntax error",
    detail:
      "An expression (`validate`, `filter`, `route`, `loop.until`, `lifetime.until`) or a `${…}` template doesn't parse, or uses syntax outside the allowed subset (assignment, arrow functions, `new`, method calls…). Also an unterminated `${`.",
    fix: "Fix the expression; see [Expressions and templates](../guide/expressions.md). Write `$${` for a literal `${`.",
  },
  {
    code: "P041",
    severity: "error",
    title: "Variable not available here",
    detail:
      "An expression uses a context variable that doesn't exist at that position, e.g. `result` outside `delivered`, `stats` outside `lifetime.until` and stall messages, or `error` outside a `message`.",
    fix: "Use one of the variables the hint lists.",
  },
  {
    code: "P050",
    severity: "warning",
    title: "Literal credential",
    detail:
      "A string in a `with:` block looks like a credential: its key names a token, secret, password, API key, authorization or credential and its value isn't an `op://`/`env:` reference or a template, or the value itself looks like one (`Bearer …`, `sk-…`, `ghp_…`, `xox…-`, `AKIA…`).",
    fix: "Declare it under `secrets:` (`op://…` or `env:…`) and use `${secrets.<name>}`.",
  },
  {
    code: "P051",
    severity: "error",
    title: "Secrets outside `with:`",
    detail: "`secrets` is used in an expression or message, where its value could leak into data, logs or responses.",
    fix: "Use `${secrets.<name>}` only inside `with:` blocks.",
  },
  {
    code: "P052",
    severity: "error",
    title: "Untrusted code",
    detail:
      "The `fn` module, or a pipeline file with `exec` nodes, came from a template you didn't write and that isn't trusted, or it was edited since it was trusted.",
    fix: "Read it, then run `pipo trust <template>` (or `pipo trust <project-folder>` after your own edit).",
  },
  {
    code: "P053",
    severity: "warning",
    title: "Agent node without a budget",
    detail:
      "The pipeline has an API agent node (`claude_api`) but no `agent_budget`. CLI agents (`claude_code`, `codex`, `pi`, `opencode`) don't trigger it.",
    fix: "Add `agent_budget: { per_day: 1 }` (the builder offers this as a one-click fix).",
  },
  {
    code: "P054",
    severity: "error",
    title: "Schema file isn't a valid JSON Schema",
    detail:
      "An input's `schema` or an agent's `with.schema` file isn't JSON, isn't an object (or boolean), or doesn't compile as a JSON Schema. `$schema` is ignored.",
    fix: "Fix the file: valid JSON, using draft-07 or 2020-12 keywords.",
  },
  {
    code: "P055",
    severity: "error",
    title: "Bad `agent.verify`",
    detail: "`agent.verify` must be `last N` with N from 1 to 1000.",
    fix: "E.g. `verify: last 20`.",
  },
  {
    code: "P056",
    severity: "warning",
    title: "Two pipelines poll one telegram bot",
    detail:
      "In one multi-file `pipo check`, two pipelines have telegram inputs for the same bot (or token). Telegram lets one reader take a bot's messages, so the second one refuses to start while the first runs.",
    fix: "Give each pipeline its own bot (`with.bot`), or receive with one bot and send with another.",
  },
  {
    code: "P057",
    severity: "error",
    title: "Telegram send without `chat_id`",
    detail:
      "A `tap: telegram` or `to: telegram` has no `with.chat_id`, and an input that isn't `via: telegram` reaches it. Only packets from a telegram input carry a chat to reply to.",
    fix: "Set `with.chat_id`.",
  },
  {
    code: "P058",
    severity: "warning",
    title: "exec `command` holds spaces",
    detail:
      "An exec step's `command` looks like a whole command line (`ffmpeg -i in.mp3`). Exec runs no shell, so it would look for a program with that whole name.",
    fix: "Put only the program in `command` and each argument in `args`.",
  },
  {
    code: "P059",
    severity: "error",
    title: "`fn` module can't run in the runner",
    detail:
      "The `fn` module imports `node:*`/`bun:*` or a Node built-in, uses a host global (`Bun`, `process`, `require`, `Buffer`, `fetch`, …) other than in `typeof`, fails to bundle, or throws while loading. Functions run in the runner's embedded QuickJS. Reported by the CLI's `pipo check` and `pipo compile`, once the file has no other errors.",
    fix: "Keep the module to plain functions over the packet data; do anything that needs the system in a connector or an `exec` step.",
  },
  {
    code: "P060",
    severity: "error",
    title: "Not exactly one of `input` and `inputs`, or too many inputs",
    detail: "The pipeline has neither `input:` nor `inputs:`, has both, or has more than 16 inputs.",
    fix: "Keep `input:` for one input or `inputs:` for several. Feed a pipeline with many sources from other pipelines through one `via: pipeline` input.",
  },
  {
    code: "P061",
    severity: "error",
    title: "Input name clashes",
    detail:
      "An input is called `output`, or has the name of a node. Inputs and nodes share one set of names, since `from:` refers to both.",
    fix: "Rename the input or the node.",
  },
  {
    code: "P062",
    severity: "error",
    title: "Two inputs clash",
    detail:
      "Two http inputs of one pipeline take the same method and path, or set different `listen` ports (they share one listener), or two telegram inputs poll the same bot.",
    fix: "Give each http input its own `path` or `method` and at most one port; use one telegram input per bot and route on the data.",
  },
  {
    code: "P063",
    severity: "error",
    title: "Bad chain link",
    detail:
      "A pipeline feeds itself (`to: pipeline` naming itself, or listing itself in a `via: pipeline` input's `from`), or one sender is listed in two inputs.",
    fix: "Loop inside a pipeline with `loop:` instead; list each sender in one input only.",
  },
  {
    code: "P064",
    severity: "warning",
    title: "Chain declared at one end only, or a chain cycle",
    detail:
      "In one multi-file `pipo check`: a pipeline sends `to: pipeline` a receiver whose `via: pipeline` input doesn't list it (the receiver would refuse its packets), a receiver lists a sender that doesn't send to it, or chains form a cycle. Pipelines not in the same check aren't looked at.",
    fix: "Declare the link at both ends; break a cycle, or make sure a filter ends it (a packet is refused after 16 hand-offs).",
  },
];
