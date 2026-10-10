# Editor support

A `.pipo` file is YAML with a published [JSON Schema](../reference/schema.md), so any editor with a YAML language server gives you completion, hover help and structural checks out of the box. For everything a schema can't express (references, the graph, expressions), run `pipo check`.

## VS Code

The Pipo extension lives in [`packages/vscode`](../../packages/vscode). It's declarative, with no runtime code of its own, and it:

- registers `.pipo` files as the **Pipo** language, built on YAML (`#` comments, auto-closing `${` … `}`, brackets and quotes);
- attaches the `.pipo` JSON Schema through the [Red Hat YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml), which it depends on, for completion, hover help and validation as you type;
- highlights `${…}` templates and expressions, including nested braces and strings that contain `}`.

The schema follows the connector you pick: after `via: http`, completion offers exactly the `with:` settings of the http input, and after `to: sqlite`, those of the sqlite output.

### Install

The extension isn't on the Marketplace yet. Install it from a checkout of the repository:

```sh
ln -s "$PWD/packages/vscode" ~/.vscode/extensions/pipo-vscode   # then reload VS Code
# or: code --install-extension packages/vscode   (with a VS Code that accepts folders)
```

VS Code installs the Red Hat YAML extension as its dependency if you don't have it.

### Keeping the schema current

The extension bundles a copy of the schema. After you update Pipo, refresh it from the checkout:

```sh
bun run schema                                 # writes schema/pipo.schema.json
bun packages/vscode/scripts/sync-schema.ts     # copies it into the extension
```

## Other editors

Any editor that runs the [YAML language server](https://github.com/redhat-developer/yaml-language-server) (Neovim, Helix, Zed, Emacs, JetBrains IDEs and others) can use the schema:

1. **Treat `.pipo` as YAML.** Map the `.pipo` extension to the YAML file type in your editor's settings.
2. **Attach the schema.** Either put a modeline at the top of each file:

   ```yaml
   # yaml-language-server: $schema=https://raw.githubusercontent.com/ramigb/pipo/main/schema/pipo.schema.json
   pipo: 1
   ```

   or map the schema to `*.pipo` in the language server's `yaml.schemas` setting. Use the URL above, or a local copy from `pipo schema > pipo.schema.json`, which matches the Pipo you run.

JetBrains IDEs can also map a JSON Schema to a file pattern without the language server, under their JSON Schema mappings settings.

## Checking as you go

The schema catches structure: unknown keys, wrong types, missing required settings, bad durations. `pipo check` catches the rest, with the file, line and column of each problem, and a hint:

```sh
pipo check my-pipeline.pipo          # one file
pipo check                           # every .pipo under the current folder
pipo check --json                    # for editors, scripts and agents
```

See [Diagnostics](../reference/diagnostics.md) for every code. Many editors can run `pipo check` on save as an external linter: its output is `file:line:col severity code message`, one finding per line.

`pipo fmt` puts a file in the canonical format. Run it on save, or with `--check` in CI. See [Templates and generators](scaffolding.md#pipo-fmt).

The dashboard's [builder](builder.md) runs the same check live as you edit, with badges on the blocks and quick fixes.

## Planned

A small **Pipo language server** for what a schema can't express is planned: completing node ids in `from`, going to the definition of an `fn.*` function in its module, showing `pipo check` diagnostics live, quick fixes (such as "unsupported delivery check: choose from …") and a graph preview.
