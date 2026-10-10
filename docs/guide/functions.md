# User functions

When a step needs real code (reshaping a payload, parsing a format, computing a value that expressions can't express), write a function. A pipeline's `fn` key points to a TypeScript or JavaScript module, and each exported function is available as `fn.<name>`.

```yaml
fn: ./people.fn.ts
input:
  via: http
  with: { path: /people }
nodes:
  normalize:
    from: input
    transform: fn.normalize
output:
  from: normalize
  to: sqlite
  with: { path: ./data/people.db, table: people, create: true }
```

```ts
// people.fn.ts
interface Person {
  name: string;
  age: number;
  bio?: string;
}

export function normalize(data: Person) {
  return { ...data, name: data.name.trim(), bio: (data.bio ?? "").slice(0, 500) };
}
```

`pipo check` confirms that the module exists (P014), that it exports a function with that name (P012), and that it can run in the runner (P059).

## Using a function

| Kind | Example | Effect |
|---|---|---|
| `transform: fn.<name>` | `transform: fn.normalize` | `data` becomes what the function returns. |
| `tap: fn.<name>` | `tap: fn.audit` | The function runs for its side effect; whatever it returns is ignored and `data` passes on unchanged. |

Paths in `fn:` are relative to the `.pipo` file. A pipeline has at most one `fn` module, but the module can import others.

## The function signature

```ts
export function name(data, meta) {
  return newData; // or a Promise of it
}
```

- **`data`** is the packet's payload as this step sees it.
- **`meta`** is the same object expressions see as `meta` ([fields](expressions.md#context-variables)): `packet_id`, `branch`, `key`, `pipeline`, `version`, `node`, `input`, `trigger`, `source`, `received_at`, `attempt`, `hops`, `iteration` and `upstream`.
- **Return** the new data. A transform that returns `undefined` (or nothing) fails with "fn.\<name\> returned nothing; return the new data". Return `null` if you really mean null.
- **Values cross as JSON.** Arguments are JSON-parsed, and the result is JSON-serialised: `Date` objects become ISO strings, `undefined` fields disappear, `Map`, `Set` and class instances lose their behaviour. Return plain objects, arrays, strings, numbers, booleans and `null`.
- **Throwing** fails the step. The error's message becomes the step's error, and the node's `on_error` policy applies (retries, then dead-letter by default).

There is no importable `Meta` type package. Declare the fields you use:

```ts
interface Meta {
  packet_id: string;
  input: string;
  received_at: number;
  attempt: number;
}

export function stamp(data: Record<string, unknown>, meta: Meta) {
  return { ...data, id: meta.packet_id, received: new Date(meta.received_at).toISOString() };
}
```

## Async functions and timers

A function can be `async` and await timers:

```ts
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function politely(data: { url: string }, meta: { attempt: number }) {
  // Back off a little more on each retry of this step.
  await sleep(250 * meta.attempt);
  return { ...data, checked: true };
}
```

- Up to `concurrency` packets are processed at once (default 4). While one call awaits a timer, other calls run. Code that doesn't await runs to completion before anything else runs in the module.
- `setTimeout`, `clearTimeout`, `setInterval` and `clearInterval` exist. Timers belong to the call that set them and are cancelled when it ends, so nothing keeps running in the background between calls.
- A call has **30 seconds** from its start until its result, time spent waiting on timers included. A slower call is stopped and fails like any step error ("fn.\<name\> ran longer than 30s and was stopped"). So does a call whose Promise waits on nothing that could ever settle it.

## The runtime: QuickJS, not Node

Functions run in an embedded JavaScript engine (QuickJS) inside the pipeline's runner. They run as plain JavaScript, with no Bun or Node APIs.

**Available:**

- The ES built-ins QuickJS has: `JSON`, `Math`, `Date`, `RegExp`, `Promise`, `Map`, `Set`, typed arrays, and the usual string, array and object methods.
- `console.log`, `console.info`, `console.debug`, `console.warn` and `console.error`, which write to the runner's log (`pipo logs <name>`, or the terminal under `pipo run`).
- Timers, as above.

**Not available** (P059 at check time):

- Imports of `node:*` or `bun:*` modules, `bun`, or a Node built-in by its bare name (`fs`, `path`, `crypto`, `child_process`, …).
- The globals `Bun`, `Deno`, `process`, `require`, `Buffer`, `__dirname`, `__filename`, `fetch`, `WebSocket` and `XMLHttpRequest`. Using one is an error. Only `typeof x` is allowed, so feature detection still works.

```text
pipeline.pipo:3:5  error  P059  fn module ./tags.fn.ts can't run in the runner: it imports node:fs
  fn modules run in an embedded JS engine (QuickJS) without Bun or Node APIs, so keep them
  self-contained (plain functions over the packet data), or use an exec step for anything that needs the system
```

Anything that needs the system belongs in a connector or a step instead:

| You want to… | Use |
|---|---|
| Call an API | [`transform: http`](nodes.md#transform) or `tap: http` |
| Read or write files | A [`watch`](inputs.md) input, a [`file` output](outputs.md#file) or `tap: file` |
| Run a program or a script with full system access | [`exec`](exec.md) |
| Ask a model | An [agent node](agent-nodes.md) |

**Memory.** The runner's QuickJS runtime has 256 MB. A call that runs out fails with "fn.\<name\> ran out of memory".

## Imports and bundling

A module may be TypeScript, and may import local files and installed npm packages. `pipo compile` (which `pipo check`, the runner and `pipo test` all use) bundles it with `Bun.build` into one self-contained ES module for the browser target:

```ts
// tags.fn.ts
import { slugify } from "./lib/text.ts"; // a local file: bundled
import { parse } from "yaml"; // an installed package: bundled, as long as it doesn't need Node

export function frontMatter(data: { content: string }) {
  const [, head = "", body = ""] = data.content.split(/^---$/m);
  const meta = parse(head) ?? {};
  return { ...meta, slug: slugify(meta.title ?? ""), body: body.trim() };
}
```

- A package that imports Node built-ins fails to bundle for the runner (P059). Pick a browser-compatible package, or move the work to an [exec step](exec.md).
- TypeScript types are erased. Type errors don't stop a bundle; run `tsc` yourself if you want them checked.
- To list the module's exports, `pipo compile` imports the bundle once in Bun. Keep top-level code free of side effects: define functions and constants, and do the work inside the functions.

## Versions pin the code

Each [version](versions.md) of a pipeline stores the bundle it was compiled with. A packet always finishes on the version that accepted it, with that version's code, even after you edit the module. A replayed dead letter also runs its pinned version's code.

Editing the module changes nothing in a running pipeline. The new code is compiled when the pipeline starts again (`pipo restart`), or on a live apply or rollback. If the `.pipo` file itself didn't change, the restarted pipeline keeps its version number and runs the new code for new packets. The runner logs a `file_changed` warning, because the version recorded the module's old hash. To re-run settled packets through the new code, use [`pipo rerun --current`](recovery.md).

## Logging

```ts
export function parse(data: { line: string }, meta: { packet_id: string }) {
  const parts = data.line.split(",");
  if (parts.length < 3) console.warn(`short line in ${meta.packet_id}: ${parts.length} fields`);
  return { name: parts[0], email: parts[1], plan: parts[2] ?? "free" };
}
```

Log lines are [redacted](secrets.md) like everything else the runner writes.

## Testing functions

Two levels work well together:

- **Unit tests** of the module with `bun test`. The functions are plain functions, so import and call them. Use `await new Promise((r) => setTimeout(r, n))` rather than `Bun.sleep`, so the same code runs in QuickJS.
- **Pipeline tests** with [`pipo test`](testing.md), which run the module inside the runner binary against fixture packets and compare the results with snapshots.

## Trust

A function is trusted code: it runs as you, inside the pipeline's runner. Pipo isolates each pipeline in its own process, and QuickJS keeps functions away from files, the network and programs. That is not a reviewed sandbox, though.

A module that arrived through a template from outside your project (`~/.pipo/templates`, or a path outside the project) is **untrusted** until you accept it:

```sh
pipo trust ~/.pipo/templates/csv-import      # trust the template, by content hash
pipo trust ./my-import                       # re-accept a scaffolded project you edited
```

While a module is untrusted, or after it changed since you trusted it, `pipo check` reports P052, and `pipo start` and `pipo run` refuse the pipeline. Built-in templates, `./.pipo/templates` and modules you wrote yourself need no trust. See [Templates and generators](scaffolding.md).

## See also

- [Nodes and the graph](nodes.md#transform): where transforms and taps fit
- [Running programs](exec.md): when a function isn't enough
- Spec: [§3.6 user functions](../spec.md#36-user-functions), [§11 security](../spec.md#11-security)
