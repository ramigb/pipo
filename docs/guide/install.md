# Install

Pipo runs from a checkout of its Git repository. There is no packaged release yet. Installing takes three steps: get the prerequisites, clone and install, then put the `pipo` command on your `PATH`.

## Prerequisites

| Need | Why |
|---|---|
| **Linux or macOS** | Pipo uses Unix sockets and process sessions. Windows isn't supported. |
| **[Bun](https://bun.sh) 1.3 or newer** | The CLI, the engine, the checker and the dashboard are TypeScript, run directly by Bun with no build step. |
| **A stable [Rust](https://rustup.rs) toolchain** (`cargo`) | The runner is a Rust binary, built from `crates/pipo-runner` on your machine. |
| **Git** | To clone the repository. |

Optional, depending on what your pipelines use:

- **[1Password CLI](https://developer.1password.com/docs/cli/) (`op`)**, signed in, for `op://` secret references. See [Secrets](secrets.md).
- **A coding-agent CLI** (`claude`, `codex`, `pi` or `opencode`), installed and logged in, for CLI [agent nodes](agent-nodes.md).
- **Any program an `exec` step runs**, such as `ffmpeg` or `pandoc`. See [Running programs](exec.md).

## Clone and install

```sh
git clone https://github.com/ramigb/pipo.git
cd pipo
bun install
```

`bun install` installs the TypeScript dependencies, then builds the runner with `cargo build --release -p pipo-runner`. The binary lands in `target/release/pipo-runner`. The first build takes a few minutes. Later builds are incremental.

If `cargo` isn't installed, `bun install` still succeeds. It prints a hint instead of building the runner. Install Rust, then build it:

```sh
bun run build:runner
```

You don't need to rebuild by hand after pulling changes. Whenever `pipo` needs the runner and the binary is missing or older than the crate's sources, it builds it again first. A run that rebuilds takes longer to start.

> [!NOTE]
> Set `PIPO_RUNNER_BIN` to use a runner binary built somewhere else.

## Get the `pipo` command

From the repository root, `bun pipo …` always works, because the root `package.json` has a `pipo` script:

```sh
bun pipo --help
bun pipo check examples
```

To run `pipo` from any folder, link the CLI package. `bun link` registers it and puts a `pipo` executable in Bun's global bin folder (`~/.bun/bin`, which the Bun installer adds to your `PATH`):

```sh
cd packages/cli
bun link
cd ../..
pipo --help
```

The link points at your checkout, so `git pull` updates the command too.

If you'd rather not link, an alias works as well. Add this to your shell profile, with the path of your checkout:

```sh
alias pipo="bun $HOME/src/pipo/packages/cli/src/main.ts"
```

The rest of these docs write commands as `pipo …`. From the repository root without a link, write `bun pipo …` instead.

## Check the install

```sh
pipo check examples
```

Every example should report `ok`. Then try one in the foreground:

```sh
pipo run examples/heartbeat/heartbeat.pipo
```

It logs `started v1` and appends a line to `examples/heartbeat/out/heartbeat.jsonl` every five seconds. Press Ctrl-C to drain and stop it.

## Where Pipo keeps its state

Everything Pipo writes at runtime lives in one folder, the **Pipo home**: `~/.pipo` by default. Set `PIPO_HOME`, or pass `--home <dir>` to a command, to use another one.

```text
~/.pipo/
  config.yaml                  engine and agent settings (optional)
  bots.json                    Telegram bots (made from the dashboard)
  trust.json                   trusted templates and projects
  pipelines/<name>/journal.db  each pipeline's journal
  pipelines/<name>/files/      files downloaded by a telegram input
  run/<name>.json              runner registry entries, and their sockets
  run/engine.json              the running engine
  logs/<name>.log              each runner's log, and engine.log
```

Your `.pipo` files live wherever you like, usually in a project folder or Git repository. See [Configuration](configuration.md) for `config.yaml`.

> [!WARNING]
> Keep the Pipo home on a native Linux or macOS file system. SQLite's write-ahead log and Unix sockets don't work reliably on network drives or on Windows drives mounted in WSL (`/mnt/c/…`).

## Editor support

The VS Code extension in `packages/vscode` registers `.pipo` files, attaches the JSON Schema for completion and hover help, and highlights `${…}` templates. See [Editor support](editor.md).

## Updating

```sh
git pull
bun install
```

If an engine is running, restart it so it runs the new code: `pipo engine stop`, then any `pipo` command starts it again. The dashboard shows a banner when the running engine is older than the code on disk.

## Uninstalling

Stop everything (`pipo engine stop`, then `pipo stop <name>` for any detached runners `pipo runners` still lists). Then remove the checkout, the link (`cd packages/cli && bun unlink`) and, if you no longer need the journals, the Pipo home.

Next: [Quick start](quick-start.md).
