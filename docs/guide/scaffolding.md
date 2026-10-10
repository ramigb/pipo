# Templates and generators

You can start a pipeline from a template, grow it a node at a time, and keep it tidy, all from the CLI. Every command here is non-interactive and takes `--json`, so agents use them exactly as you do.

```sh
pipo templates                                    # what's available
pipo new orders --template webhook-to-sqlite --set table=orders
pipo generate node orders notify --kind tap --use http
pipo check orders && pipo test orders
pipo fmt orders
```

## `pipo new`

```sh
pipo new <name> [--template <t>] [--set key=value …] [--dir <path>]
```

Creates a pipeline folder from a template. `<name>` becomes the pipeline's `name` and must match `[a-z0-9][a-z0-9-]*` (`engine` is reserved). The folder is `./<name>` unless `--dir` names another, and it must be missing or empty. The default template is `blank`.

```text
$ pipo new orders --template webhook-to-sqlite --set table=orders
Created orders/ from template 'webhook-to-sqlite':
  fixtures/sample.json
  schemas/input.schema.json
  orders.fn.test.ts
  orders.fn.ts
  orders.pipo

Next: pipo check orders/orders.pipo
```

Every scaffold passes `pipo check` and `pipo test` as it comes: it has a `fixtures/` folder with a sample packet (and stubs, for agent templates), and the templates with an `fn` module include a `bun test` file for it.

`--set key=value` (repeatable) fills a template variable. A variable you don't set takes its default. An unknown key, or a required value with no default, is an error with a hint listing the template's variables. `pipo new` never prompts.

### Built-in templates

| Template | What it makes | Variables (default) |
|---|---|---|
| `blank` | An empty pipeline: HTTP in (`/<name>`), stdout out. Add nodes with `pipo generate node`. | none |
| `webhook-to-sqlite` | A token-protected webhook, a tidying `fn`, and an SQLite upsert with a `record_exists` delivery check. Files: the `.pipo`, `<name>.fn.ts` and its test, `schemas/input.schema.json`, `fixtures/sample.json`. | `path` (`/events`), `table` (`events`), `port` (`8787`), `token_env` (`PIPO_TOKEN`) |
| `cron-to-file` | On a schedule, a function builds a record that's appended to a JSONL file. Files: the `.pipo`, `<name>.fn.ts` and its test, `fixtures/sample.json`. | `every` (`1m`), `out` (`./out/<name>.jsonl`) |
| `watch-to-http` | Watches a folder and POSTs each new file's content to an HTTP endpoint whose URL comes from an environment variable. Files: the `.pipo`, `<name>.fn.ts` and its test, `fixtures/sample.json`. | `glob` (`./inbox/*.txt`), `url_env` (`DESTINATION_URL`) |
| `agent-classifier` | Classifies incoming JSON with an agent, schema-checked and budget-capped, and writes the result to a file. Files: the `.pipo`, `schemas/classification.schema.json` and a test for it, `fixtures/sample.json`, `fixtures/expected.json` and `fixtures/stubs.json`. | `labels` (`urgent\|normal\|spam`), `model` (`claude-sonnet-5-5`), `per_day` (`2.00`) |

## `pipo templates`

Lists every template `pipo new` can use, with where it comes from:

```text
$ pipo templates
agent-classifier   built-in  Classify incoming JSON with an agent (schema-checked, budget-capped) and write the result to a file.
blank              built-in  An empty pipeline, HTTP in, stdout out. Start here and add nodes with `pipo generate node`.
cron-to-file       built-in  On a schedule, build a record with a function and append it to a JSONL file.
watch-to-http      built-in  Watch a folder for new files and POST each one's content to an HTTP endpoint.
webhook-to-sqlite  built-in  Receive JSON on a webhook, tidy it with a function and store it in SQLite.
```

Templates are looked up in this order, and the first one with a name wins:

1. **project**: `./.pipo/templates/<name>/`, in the folder you run the command from,
2. **home**: `<home>/templates/<name>/` (`~/.pipo/templates` by default),
3. **built-in**.

`--template` also takes a path to a template folder (anything with a `/`, or starting with `.`).

## Writing your own template

A template is a folder with a `template.yaml` and the files to copy:

```text
.pipo/templates/csv-import/
├── template.yaml
├── {{name}}.pipo.tmpl
├── {{name}}.fn.ts
└── fixtures/
    └── sample.json
```

```yaml
description: "Import a CSV file dropped in a folder into SQLite."
variables:
  - name: folder
    prompt: Folder to watch
    default: ./inbox
  - name: table
    prompt: SQLite table name
    default: "{{name}}"
```

- **Placeholders.** `{{var}}` in a file's content or name is replaced by the variable's value. `{{name}}` is always the pipeline's name. A placeholder that isn't declared is an error. A default may use `{{name}}`.
- **`.tmpl`.** A file name ending in `.tmpl` loses that suffix when it's copied. Use it for the `.pipo` file and test files, so `pipo check` and test runners don't pick up the template's own sources.
- **`prompt`** describes the variable for people and agents reading the template. `pipo new` never asks; values come from `--set`.
- Include a `fixtures/` folder that passes `pipo test`, so every scaffold starts green.

## `pipo generate node`

```sh
pipo generate node <pipeline> <id> --kind <kind> [--from <node>] [--use <value>]
```

Inserts a node into an existing file, wires it and keeps the rest of the file as it was (comments included). `<pipeline>` is a file, a folder holding one, or a pipeline name.

- **`--kind`** is `tap`, `transform`, `filter`, `route` or `agent`.
- **`--use`** picks the connector: `http`, `fn.<name>`, `codex` and so on. The defaults are `log` for a tap, `map` for a transform and `claude_api` for an agent. The node gets a starter `with:`, ready to edit.
- **Where it goes.** The node is inserted **before the output**: it takes over what fed the output, and the output now reads from it. `--from <node>` (an input, a node or a route branch) re-points only the output entries that came from that node.
- A filter starts as `exists(data)`, and a route with one branch, `main: else`, which feeds the output as `<id>.main`.
- An agent node gets a starter schema file, `schemas/<id>.schema.json`, if it's missing.

```text
$ pipo generate node orders notify --kind tap --use http
Added tap node 'notify' to orders/orders.pipo (from: "tidy", output.from: "notify")
orders/orders.pipo  ok
```

It checks the file afterwards and prints the result, so you see right away what's left to fill in.

## `pipo fmt`

```sh
pipo fmt [file|dir …] [--check]
```

Rewrites `.pipo` files in the canonical format (every `.pipo` under the current folder by default):

- Keys in the order the spec uses: top-level keys, then within inputs, nodes and the output. Keys inside `with:` blocks keep your order.
- Two-space indentation, and flow collections without padding (`[a, b]`, `{a: 1}`).
- Block scalars (`|`, `>`) kept as written, re-indented. Other lines are never re-wrapped.
- Blank lines around block sections, and the ones you wrote between scalar keys are kept.
- Comments are kept.

A file that isn't valid YAML is refused. `--check` changes nothing: it exits 1 and lists the files that would change, for CI. The builder writes new files in the same canonical form.

## Trust

`fn` modules are code, and `exec` nodes run programs as you. Pipo trusts code you wrote, and asks you to review code that came from somewhere else:

- **Trusted:** built-in templates, templates in your project (`./.pipo/templates` or a path inside the project), and any file that didn't come from a template.
- **Untrusted:** templates from your home (`~/.pipo/templates`) or from a path outside the project.

When `pipo new` scaffolds from an untrusted template, it writes a `.pipo-origin.json` marker in the new folder with the template's content hash and the hash of each `fn` module. Until you trust it, `pipo check`, `pipo test` and `pipo start` refuse its `fn` modules, and the `.pipo` file itself if it has `exec` nodes (P052):

```sh
pipo trust ~/.pipo/templates/csv-import   # after reading it: records its content hash
pipo trust ./orders                       # re-accept a scaffolded project after you edited its fn module
```

`pipo trust <template>` records the template's content hash in `<home>/trust.json`. If the template's content changes, it must be trusted again. A scaffolded module that you edit no longer matches its recorded hash, so it's untrusted again until you run `pipo trust <project-folder>`, which re-accepts it as it is now.

Trust is a review step, not a sandbox: `fn` modules run in the runner's embedded QuickJS without access to the file system, network or programs, with time and memory limits, but that isn't a reviewed security boundary. Sandboxing `fn` modules is planned. See [User functions](functions.md) and [Running programs](exec.md).
