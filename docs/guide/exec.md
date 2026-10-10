# Running programs

`tap: exec` and `transform: exec` run a program installed on the machine, such as `ffmpeg`, ImageMagick, `pandoc` or a script of your own. The program runs as you, with no shell. Use it when a step needs the system: files, tools, the network through a CLI.

```yaml
pipo: 1
name: notes-to-html
input:
  via: watch
  with: { path: ./notes/*.md, events: [create, change], read: path }
nodes:
  render:
    from: input
    transform: exec
    with:
      command: pandoc
      args: ["${data.path}", -o, "./site/${data.name}.html", --standalone]
      outputs: ["./site/${data.name}.html"]
      timeout: 1m
output:
  from: render
  to: file
  with: { path: ./out/rendered.jsonl }
```

Each Markdown file dropped in `notes/` becomes an HTML page in `site/`. The output records what was rendered (`exit_code`, `stdout`, `stderr`, `duration_ms`, `files`) for each packet.

## Tap or transform

| Kind | `data` after the step |
|---|---|
| `tap: exec` | Unchanged. The program runs for its effect. |
| `transform: exec` | The program's result, as chosen by `result`. |

## Settings

Every string is a [template](expressions.md#templates), rendered per packet with `data`, `meta`, `env` and `secrets`.

| Field | Default | Meaning |
|---|---|---|
| `command` | required | The program: a name found on `PATH` (`ffmpeg`), or a path with a `/`, relative to the `.pipo` file (`./scripts/resize.sh`). |
| `args` | `[]` | A list. Each item goes to the program as exactly one argument. |
| `cwd` | the `.pipo` file's folder | Where the program runs, relative to the `.pipo` file. It must exist. |
| `env` | none | Variables added to the runner's environment for this program. |
| `stdin` | empty | Text fed to the program's standard input. |
| `timeout` | `5m` | How long it may run. |
| `success` | `[0]` | Exit codes that count as success. |
| `outputs` | none | Files the program must write, relative to `cwd`. |
| `result` | `info` | What a transform's `data` becomes: `info`, `text` or `json`. |

## No shell

`args` is handed to the program as it is. There is no shell, so no quoting, no globbing, no pipes and no `$VAR` expansion. A file name with spaces, quotes or a `;` in it is just one argument, and can't break the command or inject another one.

```yaml
with:
  command: convert
  args: ["${data.path}", -resize, 800x800>, "./thumbs/${data.name}"]
```

A `command` that contains spaces gets a warning (P058): it's probably a whole command line that belongs in `args`. When you really need shell features, call the shell yourself and pass data as arguments, never inside the script text:

```yaml
with:
  command: sh
  args: [-c, 'gzip -c "$1" > "$2"', sh, "${data.path}", "./archive/${data.name}.gz"]
  outputs: ["./archive/${data.name}.gz"]
```

## Results

A transform's `data` depends on `result`:

| `result` | `data` becomes |
|---|---|
| `info` (default) | `{exit_code, stdout, stderr, duration_ms, files}`: the last 64 KB of each stream, and the absolute paths of `outputs` |
| `text` | Standard output, as a string |
| `json` | Standard output, parsed as JSON. Output that isn't JSON fails the step. |

`text` and `json` take at most 1 MB of standard output. Above that the step fails, with a hint to write the result to a file listed in `outputs` and use `result: info`. Text returned from the program is [redacted](secrets.md) like everything else.

```yaml
probe:
  from: input
  transform: exec
  with:
    command: ffprobe
    args: [-v, error, -print_format, json, -show_format, "${data.path}"]
    result: json
```

## Success and failure

- **Exit codes.** An exit code outside `success` fails the step. The error carries the end of standard error (or standard output, when stderr is empty), so the dead letter says why: `ffmpeg exited with code 1: …No such file or directory`.
- **`outputs`.** Before the run, the folders of every listed file are created. After a successful exit, a missing file fails the step: `… exited with code 0 but did not write ./out/x.mp4`.
- **Timeout.** On `timeout`, the program's whole process group gets `SIGTERM`, then `SIGKILL` 2 s later, and the step fails.
- **A missing program.** When `command` is a literal name that isn't on `PATH`, or a path that doesn't exist, the pipeline refuses to start, with a hint to install it. A templated `command` is only known per packet, so it fails that packet's step instead.

Failures go to the node's [`on_error`](errors.md) policy: retries, then the dead-letter queue by default. A `tap: exec` can use `then: continue` to ignore a failure.

## How it runs

The program runs as the user that runs the pipeline, in its own process group. Standard input comes from a file, and standard output and error go to files that are read after it exits, so a chatty program can't block the runner. `env` adds to the runner's environment. The runner's environment is the one the engine (or `pipo run`) was started with.

## Idempotent file names

Pipo delivers **at least once**. If the runner crashes after the program ran but before the step committed, the program runs again after the restart. A replay or a [rerun](recovery.md) runs it again too.

So name output files after the packet or its input, never after the time or a counter. A second run then overwrites the same file instead of adding another:

```yaml
args: [-y, -i, "${data.path}", "./out/${meta.packet_id}.mp4"]   # -y: overwrite
outputs: ["./out/${meta.packet_id}.mp4"]
```

Tell programs to overwrite (`ffmpeg -y`, `cp -f`), or they may stop and wait for an answer that never comes.

> [!NOTE]
> If the runner is killed with `SIGKILL`, a program it started keeps running in its own process group until it ends or is killed.

## Example: audio to video

From [`examples/audio-to-video`](../../examples/audio-to-video): each `.mp3` dropped in a folder becomes an `.mp4` with a still cover image.

```yaml
render:
  from: input            # a watch input with read: path
  transform: exec
  with:
    command: ffmpeg
    args: [-y, -loop, "1", -i, ./cover.jpg, -i, "${data.path}", -c:v, libx264, -tune, stillimage,
           -c:a, aac, -pix_fmt, yuv420p, -shortest, "./out/${data.name}.mp4"]
    outputs: ["./out/${data.name}.mp4"]
    timeout: 10m
```

## Trust

An exec node runs a program as you, with no sandbox. A `.pipo` file with exec nodes that came from a template outside your project is untrusted, like an `fn` module, until you run `pipo trust`, and again after you edit it. While it's untrusted, `pipo check` reports P052 on each exec node and the pipeline won't start. Files you wrote yourself need no trust. See [Templates and generators](scaffolding.md).

## See also

- [User functions](functions.md): code that needs no system access
- [Nodes and the graph](nodes.md): taps and transforms
- [Connectors reference](../reference/connectors.md#tap-exec)
- Spec: [§3.4 nodes](../spec.md#34-nodes)
