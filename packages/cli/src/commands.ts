// Command table for `pipo help` and `<cmd> --help` (docs/spec.md §6). Register a command here to give it help.
export interface CommandHelp {
  name: string;
  summary: string;
  usage: string;
  flags?: [flag: string, description: string][];
}

const JSON_FLAG: [string, string] = ["--json", "Machine-readable output for scripts and agents"];
export const COMMANDS: CommandHelp[] = [
  {
    name: "check",
    summary: "Validate .pipo files (default: every .pipo under the current directory)",
    usage: "pipo check [file|dir …] [--json]",
    flags: [JSON_FLAG],
  },
  {
    name: "run",
    summary: "Run a pipeline in the foreground until Ctrl-C (drains; twice stops)",
    usage: "pipo run <file> [--listen <port>] [--home <dir>] [--env-allow A,B]",
    flags: [
      ["--listen <port>", "Serve the HTTP input on this port"],
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--env-allow A,B", "Environment variables exposed to expressions as env (engine.env_allow)"],
    ],
  },
  {
    name: "schema",
    summary: "Print the .pipo JSON Schema",
    usage: "pipo schema",
  },
  {
    name: "help",
    summary: "Show help for pipo or one command",
    usage: "pipo help [command]",
  },
  {
    name: "new",
    summary: "Create a pipeline folder from a template (default: blank)",
    usage: "pipo new <name> [--template <t>] [--set key=value …] [--dir <path>] [--json]",
    flags: [
      ["--template <t>", "Template name (see 'pipo templates'); default blank"],
      ["--set key=value", "Template variable; repeatable. Without it the template's default is used"],
      ["--dir <path>", "Folder to create (default ./<name>); must be missing or empty"],
      ["--home <dir>", "Pipo home, where ~/.pipo/templates is looked up (default ~/.pipo, or PIPO_HOME)"],
      JSON_FLAG,
    ],
  },
  {
    name: "generate",
    summary: "Insert a node into a pipeline, before its output",
    usage: "pipo generate node <pipeline> <id> --kind <kind> [--from <node>] [--json]",
    flags: [
      ["--kind <kind>", "tap, transform, filter, route or agent"],
      ["--from <node>", "Upstream: input, a node, or a route branch (default: whatever feeds the output)"],
      ["--use <value>", "Which tap/transform/agent, e.g. http, or fn.<name> (default log / map / claude_api)"],
      JSON_FLAG,
    ],
  },
  {
    name: "templates",
    summary: "List templates for 'pipo new' (project, home and built-in)",
    usage: "pipo templates [--json]",
    flags: [["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"], JSON_FLAG],
  },
  {
    name: "fmt",
    summary: "Rewrite .pipo files in the canonical format (default: every .pipo under the current directory)",
    usage: "pipo fmt [file|dir …] [--check] [--json]",
    flags: [["--check", "Change nothing; exit 1 and list the files that would change"], JSON_FLAG],
  },
  {
    name: "trust",
    summary: "Trust a template's fn modules (by content hash), or re-accept a scaffolded project you edited",
    usage: "pipo trust <template|project-folder> [--home <dir>] [--json]",
    flags: [["--home <dir>", "Pipo home, where trust.json is kept (default ~/.pipo, or PIPO_HOME)"], JSON_FLAG],
  },
  {
    name: "start",
    summary: "Start a pipeline (starts the engine on demand)",
    usage: "pipo start <file|name> [--ttl 30m] [--detached] [--listen <port>]",
    flags: [
      [
        "--ttl <duration>",
        "Lifetime for this start, e.g. 30m: replaces lifetime.ttl and outlives crash restarts (a later start without it uses the file's)",
      ],
      ["--detached", "Keep running if the engine dies"],
      ["--listen <port>", "HTTP input port, 1 to 65535 (saved in the runner registry)"],
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--no-engine", "Do not use the engine: start and restart refuse (they need it), with a hint"],
      JSON_FLAG,
    ],
  },
  {
    name: "stop",
    summary: "Stop a pipeline (drains unless --now)",
    usage: "pipo stop <name> [--now]",
    flags: [
      ["--now", "Stop at once"],
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--no-engine", "Do not use the engine: talk to the runners' control sockets; output says engine: down"],
      JSON_FLAG,
    ],
  },
  {
    name: "pause",
    summary: "Pause a pipeline (it keeps accepting packets into the journal)",
    usage: "pipo pause <name>",
    flags: [
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--no-engine", "Do not use the engine: talk to the runners' control sockets; output says engine: down"],
      JSON_FLAG,
    ],
  },
  {
    name: "resume",
    summary: "Resume a paused pipeline",
    usage: "pipo resume <name>",
    flags: [
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--no-engine", "Do not use the engine: talk to the runners' control sockets; output says engine: down"],
      JSON_FLAG,
    ],
  },
  {
    name: "restart",
    summary: "Stop a pipeline, then start the same file again",
    usage: "pipo restart <name> [--ttl 30m] [--detached] [--listen <port>]",
    flags: [
      [
        "--ttl <duration>",
        "Lifetime for the new start, e.g. 30m: replaces lifetime.ttl and counts from the restart (without it, the file's)",
      ],
      ["--detached", "Keep running if the engine dies"],
      ["--listen <port>", "HTTP input port, 1 to 65535"],
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--no-engine", "Do not use the engine: start and restart refuse (they need it), with a hint"],
      JSON_FLAG,
    ],
  },
  {
    name: "status",
    summary:
      "Show pipeline status (a dash means the runner does not report it); with a name, also the oldest pending packet's age and latency per node",
    usage: "pipo status [name] [--watch]",
    flags: [
      ["--watch", "Keep updating every 2 s"],
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--no-engine", "Do not use the engine: talk to the runners' control sockets; output says engine: down"],
      JSON_FLAG,
    ],
  },
  {
    name: "logs",
    summary: "Show a pipeline's log from <home>/logs/<name>.log",
    usage: "pipo logs <name> [-f] [--node id]",
    flags: [
      ["-f", "Follow: keep printing new lines"],
      ["--node <id>", "Only lines that mention this node id as a whole word"],
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--no-engine", "Do not use the engine: talk to the runners' control sockets; output says engine: down"],
      JSON_FLAG,
    ],
  },
  {
    name: "test",
    summary: "Run a pipeline's fixtures in-process (outputs mocked, agents stubbed) and compare with snapshots",
    usage: "pipo test <file|dir> [--fixtures dir] [--update-snapshots] [--json]",
    flags: [
      ["--fixtures <dir>", "Fixtures folder (default <pipeline folder>/fixtures; run-wide stubs in its stubs.json)"],
      ["--update-snapshots", "Rewrite snapshots that differ (a missing one is always written)"],
      ["--home <dir>", "Pipo home, for fn trust (default ~/.pipo, or PIPO_HOME)"],
      JSON_FLAG,
    ],
  },
  {
    name: "runners",
    summary:
      "List every runner found in <home>/run: pid, port, version and whether it is attached (works without the engine)",
    usage: "pipo runners",
    flags: [
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--no-engine", "Do not ask the engine which runners it supervises; output says engine: down"],
      JSON_FLAG,
    ],
  },
  {
    name: "attach",
    summary: "Scan again and reattach: adopt live runners, restart dead ones, clean stale entries (starts the engine)",
    usage: "pipo attach [name]",
    flags: [["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"], JSON_FLAG],
  },
  {
    name: "packets",
    summary: "List a pipeline's packets, newest first (from its journal when it isn't running)",
    usage: "pipo packets <name> [--state s] [--limit n] [--after id]",
    flags: [
      [
        "--state <s>",
        "Only packets in this state: accepted, processing, writing, verifying, delivered, filtered, dead_lettered, rejected, escalated, branched",
      ],
      ["--limit <n>", "Packets per page, 1 to 1000 (default 50)"],
      ["--after <id>", "The next page: the id the previous page ended with"],
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--no-engine", "Do not use the engine: ask the runner's control socket, or read the journal"],
      JSON_FLAG,
    ],
  },
  {
    name: "inspect",
    summary: "Trace one packet through every node: data after each step, timings, attempts, errors",
    usage: "pipo inspect <name> <packet_id>",
    flags: [
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--no-engine", "Do not use the engine: ask the runner's control socket, or read the journal"],
      JSON_FLAG,
    ],
  },
  {
    name: "dlq",
    summary: "Show the dead-letter queue; replay packets at the step they failed on, or purge them",
    usage: "pipo dlq [list] <name> | pipo dlq replay|purge <name> [ids…|--all]",
    flags: [
      ["--all", "Replay or purge every dead-lettered packet"],
      ["--limit <n>", "Dead letters per page, 1 to 1000 (default 50)"],
      ["--after <id>", "The next page: the id the previous page ended with"],
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--no-engine", "Do not use the engine: talk to the runner's control socket (listing also reads the journal)"],
      JSON_FLAG,
    ],
  },
  {
    name: "rerun",
    summary: "Run settled packets again from a node to the output, with the data they had there",
    usage: "pipo rerun <name> --from <node> [ids…|--last n|--since 1h|--all] [--current] [--yes]",
    flags: [
      ["--from <node>", "The node to run again from, or output (required)"],
      ["--last <n>", "The newest n packets that passed the node"],
      ["--since <duration>", "Packets received in this window (30m, 1h, 7d); with --last, the newest n of them"],
      ["--all", "Every delivered or filtered packet that passed the node"],
      ["--current", "Run them on the version in force instead of their own (re-pins them)"],
      ["--yes, -y", "Run the plan; without it, only print what would run"],
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--no-engine", "Do not use the engine: talk to the runner's control socket"],
      JSON_FLAG,
    ],
  },
  {
    name: "push",
    summary: "Push one packet into a running pipeline; prints its packet id once it is journaled",
    usage: "pipo push <name> --data '{…}'|--file f [--source s] [--input i]",
    flags: [
      ["--data <json>", "The packet's data, inline JSON"],
      ["--file <f>", "Read the packet's data (JSON) from a file"],
      ["--source <s>", "meta.source for the packet (default cli)"],
      ["--input <i>", "The input the packet is for, when the pipeline has several (spec §3.3.1)"],
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--no-engine", "Do not use the engine: talk to the runner's control socket"],
      JSON_FLAG,
    ],
  },
  {
    name: "ack",
    summary: "Acknowledge a packet waiting on delivered.check: external",
    usage: "pipo ack <name> <packet_id>",
    flags: [
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--no-engine", "Do not use the engine: talk to the runner's control socket"],
      JSON_FLAG,
    ],
  },
  {
    name: "history",
    summary: "List a pipeline's versions: who made each, why, and packets still pinned to it (journal when stopped)",
    usage: "pipo history <name>",
    flags: [
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--no-engine", "Do not use the engine: ask the runner's control socket, or read the journal"],
      JSON_FLAG,
    ],
  },
  {
    name: "diff",
    summary: "Unified diff of two versions of a pipeline",
    usage: "pipo diff <name> <v1> <v2>",
    flags: [
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--no-engine", "Do not use the engine: ask the runner's control socket, or read the journal"],
      JSON_FLAG,
    ],
  },
  {
    name: "rollback",
    summary: "Run an earlier version again, as a new version for new packets (in-flight packets keep theirs)",
    usage: "pipo rollback <name> <v>",
    flags: [
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--no-engine", "Do not use the engine: talk to the runner's control socket"],
      JSON_FLAG,
    ],
  },
  {
    name: "proposals",
    summary: "List, show, make, apply or reject change proposals (validated, dry-run, applied at the safe point)",
    usage: 'pipo proposals <name> [show <id> | propose <file> | apply <id> | reject <id>] [--reason "…"]',
    flags: [
      ["--state <s>", "List only proposals in this state: validated, verified, applied, rejected"],
      ["--limit <n>", "List at most this many proposals, newest first (default 50, at most 1000)"],
      ["--reason <text>", "Why (propose, reject)"],
      ["--base <n>", "propose: the version the file was written against (default the current one)"],
      ["--hold", "propose: validate and store it, but apply it later with `apply`"],
      ["--by <who>", "Who is acting (default the OS user)"],
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--no-engine", "Do not use the engine: ask the runner's control socket, or read the journal"],
      JSON_FLAG,
    ],
  },
  {
    name: "resolve",
    summary: "Settle packets handed to the agent (then: agent, on_stall: handle): retry, dead-letter or drop them",
    usage: 'pipo resolve <name> <id…> --action retry|dead_letter|drop [--reason "…"]',
    flags: [
      ["--action <a>", "retry, dead_letter or drop"],
      ["--reason <text>", "Why, kept in the journal"],
      ["--by <who>", "Who is acting (default the OS user)"],
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      ["--no-engine", "Do not use the engine: talk to the runner's control socket"],
      JSON_FLAG,
    ],
  },
  {
    name: "engine",
    summary: "Start, stop or inspect the engine (detached runners keep running when it stops)",
    usage: "pipo engine start|stop|status [--ttl 8h] [--listen <port>]",
    flags: [
      ["--ttl <duration>", "start: the engine drains its pipelines and stops after this long, e.g. 8h"],
      ["--listen <port>", "start: gateway port on 127.0.0.1 (0 picks a free one; default engine.listen, else 0)"],
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      JSON_FLAG,
    ],
  },
  {
    name: "ui",
    summary: "Open the dashboard, starting the engine if needed",
    usage: "pipo ui [--no-open] [--workspace <dir>]",
    flags: [
      ["--no-open", "Print the URL without opening a browser"],
      ["--workspace <dir>", "Where the builder saves new pipelines when it starts the engine (default: here)"],
      ["--home <dir>", "Pipo home (default ~/.pipo, or PIPO_HOME)"],
      JSON_FLAG,
    ],
  },
  {
    name: "compile",
    summary:
      "Advanced, used by the runner: check a pipeline and print its compiled form as JSON (diagnostics, definition, bundled fn module, schemas, file hashes)",
    usage: "pipo compile <file.pipo> [--home <dir>] [--stdin]",
    flags: [
      ["--home <dir>", "Pipo home: trust.json and config.yaml (default ~/.pipo, or PIPO_HOME)"],
      ["--stdin", "Read the source from stdin; <file.pipo> only names it and anchors relative paths"],
    ],
  },
];

export function commandHelp(name: string): CommandHelp | undefined {
  return COMMANDS.find((c) => c.name === name);
}

export function renderCommandHelp(c: CommandHelp): string {
  const lines = [`pipo ${c.name} — ${c.summary}`, "", `Usage:`, `  ${c.usage}`];
  if (c.flags?.length) {
    const w = Math.max(...c.flags.map(([f]) => f.length));
    lines.push("", "Flags:", ...c.flags.map(([f, d]) => `  ${f.padEnd(w)}  ${d}`));
  }
  lines.push("", "Also: -h, --help");
  return lines.join("\n");
}

/** Words wrapped to `width` columns, so top-level help rows stay readable in a narrow terminal. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return line ? [...lines, line] : lines;
}

export function renderHelp(): string {
  return [
    "pipo — simple, agent-first pipelines",
    "",
    "Usage:",
    ...COMMANDS.flatMap((c) => [`  ${c.usage}`, ...wrap(c.summary, 94).map((l) => `      ${l}`)]),
    "",
    "Run 'pipo help <command>' or 'pipo <command> --help' for details.",
    "On a terminal, output has colour and spinners; --plain (or PIPO_PLAIN=1, NO_COLOR) turns them off.",
  ].join("\n");
}
