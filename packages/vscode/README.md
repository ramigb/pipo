# Pipo for VS Code

Declarative extension (no runtime code, no dependencies). Spec §10.1.

- Registers `.pipo` as a YAML-based language (`#` comments, auto-closing `${`).
- Attaches the published JSON Schema (completion, hover, structural checks) through the Red Hat YAML extension.
- Highlights `${…}` templates and expressions, including nested braces and strings that contain `}`.

Not included yet: language server, quick-fixes, graph preview.

## Install locally

```sh
ln -s "$PWD/packages/vscode" ~/.vscode/extensions/pipo-vscode   # then reload VS Code
# or: code --install-extension packages/vscode   (with a VS Code that accepts folders)
```

After `bun run schema`, refresh the bundled copy with `bun packages/vscode/scripts/sync-schema.ts`.
