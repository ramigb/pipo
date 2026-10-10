# Expressions and templates

Pipo has one small expression language, used everywhere a pipeline makes a decision or builds a value. It's a safe subset of JavaScript expression syntax: it reads like JavaScript, but it can't loop, assign, call methods or reach anything outside the packet.

```yaml
input:
  via: http
  with: { path: /people }
  validate:
    - exists(data.email) && matches(data.email, "^[^@\\s]+@[^@\\s]+$")
    - data.age >= 18
nodes:
  adults:
    from: input
    filter: default(data.country, "SE") in ["SE", "NO", "DK"]
  stamp:
    from: adults
    transform: map
    with:
      data:
        email: "${lower(trim(data.email))}"
        age: "${data.age}"
        seen: "${iso(meta.received_at)}"
```

## Where they appear

**Expressions** are plain strings evaluated for a value:

| Position | Variables | Meaning |
|---|---|---|
| `input.validate` (each rule) | `data`, `meta`, `env` | Every rule must be true, or the packet is rejected. |
| `nodes.<id>.filter` | `data`, `meta`, `env` | False drops the packet as `filtered`. |
| `nodes.<id>.route.<branch>` | `data`, `meta`, `env` | The first true branch takes the packet. |
| `nodes.<id>.loop.until` | `data`, `meta`, `env` | True ends the loop. |
| `output.validate` (each rule) | `data`, `meta`, `env`, `output` | Every rule must be true, or the packet isn't written. |
| `lifetime.until` | `stats`, `env` | True ends the pipeline. |

**Templates** are strings containing `${expr}`. They appear in every `with:` block and every `message`:

| Position | Variables |
|---|---|
| `input.with` | `env`, `secrets` |
| `nodes.<id>.with` | `data`, `meta`, `env`, `secrets` |
| `output.with` | `data`, `meta`, `env`, `secrets` |
| `delivered.with` | `data`, `meta`, `env`, `secrets`, `output`, `result` |
| `input.on_invalid.message` | `data`, `meta`, `env`, `error` |
| `nodes.<id>.on_error.message`, `errors.message` | `data`, `meta`, `env`, `error` |
| `output.on_invalid.message`, `output.on_error.message` | `data`, `meta`, `env`, `output`, `error` |
| `delivered.on_fail.message` | `data`, `meta`, `env`, `output`, `result`, `error` |
| `delivered.stall.message` | `meta`, `env`, `stats`, `stall` |

Using a variable where it isn't available is an error with its exact position: P041 (`'result' is not available here`, with the list of what is). `secrets` outside a `with:` block is P051.

## Context variables

| Variable | Contents |
|---|---|
| `data` | The packet payload as this step sees it. After a transform, it's the transform's result. |
| `meta` | Facts about the packet. See below. |
| `env` | Environment variables the engine lets through (`engine.env_allow` in `config.yaml`, or `pipo run --env-allow A,B`). Others are absent. |
| `secrets` | Resolved [secrets](secrets.md), only inside `with:` blocks. Never in messages or logs. |
| `output` | The output block as written, e.g. `output.with.table`. |
| `result` | What the output's write returned: `{rowid, changes}` for sqlite, `{status}` for http, `{chat_id, message_id}` for telegram, `{pipeline, packet_id, duplicate}` for pipeline. |
| `error` | `message`, `code`, `rule` (the failed validate rule), `node`, `attempts`, `elapsed` (a readable duration such as `12s`). |
| `stats` | `accepted`, `delivered`, `pending`, `escalated`, `dead_lettered`, `uptime` (seconds since this run started), `in_per_min`, `last_delivery_at`. |
| `stall` | `pending`, `duration`, `oldest.{packet_id, node, age, attempt, last_error}`. |

**`meta` fields:**

| Field | Meaning |
|---|---|
| `packet_id` | The packet's id (a ULID). The same for every fan-out copy of a packet. |
| `branch` | The fan-out path of this copy (`a`, `a/c`), empty when unbranched. |
| `key` | What the output writes the packet under: `packet_id`, `packet_id:<branch>` for a copy, or an explicit key at the output (see [Outputs](outputs.md#idempotency-keys)). |
| `pipeline`, `version` | The pipeline's name and the version the packet is pinned to. |
| `node` | The step running now. |
| `input` | The name of the input the packet came from (`input` when the file has one `input:`). |
| `trigger` | The input's kind: `http`, `schedule`, `watch`, `push`, `system`, `telegram`, `pipeline`. |
| `source` | Where it came from, per input: a schedule's tick time, a chat id, a sending pipeline's name, … |
| `received_at` | When it was accepted, in epoch milliseconds. |
| `attempt` | The current attempt of this step, from 1. |
| `hops` | How many steps the packet has taken. |
| `iteration` | How many times a [loop](nodes.md) has sent it back. |
| `upstream` | For a packet from another pipeline: `{pipeline, packet_id, key, depth}`. Otherwise `null`. |

## Syntax

**Allowed:**

- Literals: strings in single or double quotes (`'a'`, `"b"`, with `\n`, `\'` escapes), numbers (`1`, `1.5`, `.5`, `1e3`), `true`, `false`, `null`, arrays (`[1, 2]`), objects (`{a: 1, "b c": 2}`, and shorthand `{data}`).
- Member and index access: `data.a.b`, `data.items[0]`, `data["first name"]`, optional chaining `data?.a?.b`.
- Arithmetic: `+ - * / %`, unary `-` and `+`.
- Comparison: `== != === !== < <= > >=`.
- Logic: `&& || !`, and `??` (use the right side when the left is `null` or missing).
- Membership: `x in y`.
- The ternary `cond ? a : b`, and parentheses.
- Calls to the [helper functions](#helper-functions).

**Not allowed** (each is a P040 error at check time):

- Assignment (`=`, `+=`), `++`/`--`, statements and `;`, the comma operator.
- Arrow functions, `new`, `this`, `typeof`, bitwise operators (`| & ^ ~ << >>`).
- Method calls on values: write `len(x)`, not `x.length` or `x.toUpperCase()`.
- Any name other than the context variables: `undefined`, `Math`, `JSON`, `eval` and so on are unknown.
- `__proto__`, `constructor` and `prototype` as members or object keys, and computed object keys (`{[k]: 1}`).

## Semantics

- **Missing is safe.** Member access on a missing or `null` value gives `undefined` and never throws, so `data.a.b.c` is fine when `a` is missing. In a template, `undefined` and `null` render as an empty string.
- **Equality is strict and deep.** `==` and `===` mean the same thing: no type coercion, and arrays and objects compare by content.

  | Expression | Result |
  |---|---|
  | `36 == "36"` | `false` |
  | `true == 1` | `false` |
  | `[1, 2] == [1, 2]` | `true` |
  | `{a: 1, b: 2} == {b: 2, a: 1}` | `true` |
  | `null == data.missing` | `false` (`null` and `undefined` differ) |

- **`in` tests membership.** An array containing the value (compared deeply), a string containing the substring, or an object having the key:

  | Expression | Result |
  |---|---|
  | `"a" in ["a", "b"]` | `true` |
  | `{a: 1} in [{a: 1}]` | `true` |
  | `"da" in "Ada"` | `true` |
  | `"x" in {x: 1}` | `true` |
  | `"toString" in {}` | `false` (only own keys count) |
  | `"a" in null` | `false` |

- **Arithmetic and ordering follow JavaScript.** `"5" + 2` is `"52"`, `"5" * 2` is `10`, `data.missing + 1` is `NaN`, `"10" < "9"` is `true` (string comparison), `"2" < 10` is `true`. Convert explicitly when types matter.
- **Truthiness follows JavaScript.** `false`, `0`, `""`, `null`, `undefined` and `NaN` are false; everything else (including `"0"`, `[]` and `{}`) is true. Validate rules, filters, routes and `until` use it.
- **Only own properties are visible.** Prototype members such as `toString` or `length` on an array are `undefined`. Use `len()`.

## Limits

- An expression is at most 2,000 characters, its syntax tree at most 32 levels deep and 256 nodes. Expressions can't loop, so evaluation time is bounded by their size.
- `matches()` patterns are at most 200 characters.

## Templates

A template is a string with `${expr}` parts:

```yaml
message: "Received ${meta.packet_id} from ${meta.source} at ${iso(meta.received_at)}"
```

- **Type preservation.** When the whole value is a single `${expr}`, the result keeps its type: a number stays a number, an object stays an object. Mixed text always gives a string.

  ```yaml
  with:
    data:
      age: "${data.age}"           # 36, a number
      tags: "${data.tags}"         # ["a", "b"], an array
      label: "age ${data.age}"     # "age 36", a string
      list: "tags=${data.tags}"    # 'tags=["a","b"]': objects and arrays become JSON
  ```

- **Nested values.** Templates are rendered inside every string of a `with:` block, at any depth in maps and lists.
- **Escaping.** `$${` writes a literal `${`: `"cost: $${data.age}"` renders as `cost: ${data.age}`.
- **Errors.** An unclosed `${` is a P040 error at check time. An expression that fails at run time (a helper given the wrong type, say) is a step error under that step's `on_error`.

> [!TIP]
> In YAML, quote any value that starts with `${`, `!`, `{`, `[` or a quote, or that contains `: ` or ` #`. `"${data.age}"` is a template; `${data.age}` unquoted happens to work, but quoting is the habit that never surprises you.

## Helper functions

| Helper | Returns | Example | Result |
|---|---|---|---|
| `exists(x)` | Whether `x` is neither `null` nor missing | `exists(data.email)` | `true` |
| `len(x)` | Length of a string or array, number of keys of an object; `0` for `null`/missing. Other types are an error. | `len([1, 2, 3])` | `3` |
| `size(x)` | Size in bytes: UTF-8 bytes of a string, of the JSON text otherwise; `0` for missing | `size("é")` | `2` |
| `type(x)` | `"string"`, `"number"`, `"boolean"`, `"null"`, `"undefined"`, `"array"` or `"object"` | `type([])` | `"array"` |
| `lower(s)`, `upper(s)` | Case-converted string (Unicode-aware). Not a string: error. | `upper("ß")` | `"SS"` |
| `trim(s)` | String without leading and trailing whitespace. Not a string: error. | `trim("  Ada ")` | `"Ada"` |
| `matches(s, re)` | Whether the regular expression `re` matches somewhere in `s`. Both must be strings. | `matches("ABC", "^[A-Z]+$")` | `true` |
| `default(x, y)` | `x`, or `y` when `x` is `null` or missing | `default(data.country, "SE")` | `"SE"` |
| `json(x)` | JSON text of `x` | `json({a: 1})` | `"{\"a\":1}"` |
| `now()` | The current time, epoch milliseconds | `now() - meta.received_at` | `152` |
| `iso(ms)` | ISO 8601 UTC text of epoch milliseconds; with no number, the current time | `iso(0)` | `"1970-01-01T00:00:00.000Z"` |
| `duration(s)` | A duration string in milliseconds (`ms`, `s`, `m`, `h`, `d`) | `duration("2m")` | `120000` |

Notes:

- **`matches()`** runs on the runner's regular-expression engine (Rust's `regex` crate). It has no lookaround (`(?=…)`, `(?<!…)`) and no backreferences (`\1`): such a pattern is an error ("Invalid regular expression…"). `\d`, `\w` and `\s` match ASCII digits and word characters, and Unicode whitespace. `.` doesn't match a newline. `pipo check` doesn't run patterns, so test a new one with `pipo test`. In YAML, a backslash inside double quotes needs doubling: `"^\\d+$"`.
- **`len()`** counts UTF-16 code units, like JavaScript: `len("😀")` is `2`.
- **`json()`** of a missing value is missing (renders as empty text). `NaN` and infinities become `null`.

## Recipes

```yaml
# Required, non-empty string
- type(data.name) == "string" && len(trim(data.name)) > 0

# One of a fixed set
- data.status in ["new", "open", "closed"]

# A number in range
- type(data.age) == "number" && data.age >= 0 && data.age < 150

# An optional field, if present, must be a list (quoted: a leading ! is a YAML tag)
- "!exists(data.tags) || type(data.tags) == 'array'"

# Route by a header-like field with a fallback
route:
  urgent: lower(default(data.priority, "")) == "high"
  normal: else

# Drop packets older than an hour
filter: now() - meta.received_at < duration("1h")

# Stop a pipeline after 1,000 deliveries or 30 minutes of uptime
lifetime:
  until: stats.delivered >= 1000 || stats.uptime > 1800

# A file name per packet and day
path: "./out/${iso(meta.received_at)}-${meta.packet_id}.json"

# Pass a whole object into a prompt
prompt: |
  Classify this ticket:
  ${json(data)}
```

## How it's checked and run

`pipo check` parses every expression and template, and reports unknown helpers, unknown or unavailable variables, and syntax errors with their exact line and column (P040, P041, P051, P013 for an undeclared `${secrets.x}`). The runner evaluates them with its own evaluator, which accepts only the syntax above. JavaScript's `eval` and `Function` are never used. The checker (TypeScript) and the runner (Rust) share a conformance suite of several hundred cases, so they agree on every result.

## See also

- [Nodes and the graph](nodes.md): filters, routes and loops
- [Inputs](inputs.md): `validate` and `on_invalid`
- Spec: [§3.2 expressions and templates](../spec.md#32-expressions-and-templates)
