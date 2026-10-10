// Terminal decoration for the human-facing CLI (docs/spec.md §6, D74): colour, symbols, a spinner for the waits and the
// `pipo ui` banner. Only on a terminal: piped output, --json, --plain, PIPO_PLAIN, NO_COLOR, CI, TERM=dumb and
// `bun test` get the plain text, byte for byte. Never used on the data plane (`pipo run`, `pipo logs`, the runner).
import { isJsonMode } from "./errors";

export interface Stream {
  isTTY?: boolean;
  write(s: string): unknown;
}
type Env = Record<string, string | undefined>;

let plainFlag = false;
/** `--plain`, set once per invocation by `runCli`. */
export function setPlain(on: boolean) {
  plainFlag = on;
}

const on = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v !== "false";

/** Whether output to `stream` may be decorated. */
export function fancy(stream: Stream = process.stderr, env: Env = process.env): boolean {
  if (plainFlag || isJsonMode() || stream.isTTY !== true) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (on(env.PIPO_PLAIN) || on(env.CI) || env.TERM === "dumb" || env.NODE_ENV === "test") return false;
  return true;
}

const sgr = (open: string, close: string) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;
const COLOURS = {
  bold: sgr("1", "22"),
  dim: sgr("2", "22"),
  red: sgr("31", "39"),
  green: sgr("32", "39"),
  yellow: sgr("33", "39"),
  cyan: sgr("36", "39"),
  underline: sgr("4", "24"),
};
export type Paint = typeof COLOURS;
const PLAIN: Paint = Object.fromEntries(Object.keys(COLOURS).map((k) => [k, (s: string) => s])) as Paint;

/** Colour functions for `stream`: identity when it isn't decorated. */
export function paint(stream: Stream = process.stderr, env: Env = process.env): Paint {
  return fancy(stream, env) ? COLOURS : PLAIN;
}

const SYMBOLS = { ok: "✔", warn: "▲", error: "✖", info: "●" } as const;
type Kind = keyof typeof SYMBOLS;
const TINT: Record<Kind, keyof Paint> = { ok: "green", warn: "yellow", error: "red", info: "cyan" };

/**
 * A message on stderr. Plain: `pipo: text`, then `  hint: …` (the CLI's long-standing format). On a terminal: a
 * coloured symbol instead of `pipo:`, and a dimmed hint.
 */
export function say(kind: Kind, text: string, hint?: string) {
  clearSpinner();
  if (!fancy()) {
    console.error(`pipo: ${text}`);
    if (hint) console.error(`  hint: ${hint}`);
    return;
  }
  // Written directly: on a terminal, Bun paints all of console.error red.
  line(`${COLOURS[TINT[kind]](SYMBOLS[kind])} ${kind === "error" ? COLOURS.bold(text) : text}`);
  if (hint) line(COLOURS.dim(`  hint: ${hint}`));
}

/** A message on stderr only on a terminal: decoration that plain output never had. */
export function flourish(kind: Kind, text: string) {
  if (!fancy()) return;
  clearSpinner();
  line(`${COLOURS[TINT[kind]](SYMBOLS[kind])} ${text}`);
}

const line = (s: string) => process.stderr.write(`${s}\n`);

/** A result line for stdout: `✔ text` on a terminal, `text` otherwise. */
export function done(text: string): string {
  return fancy(process.stdout) ? `${COLOURS.green(SYMBOLS.ok)} ${text}` : text;
}

// ---- cursor ----

let hidden = false;
const restore = () => {
  if (hidden) process.stderr.write("\x1b[?25h");
  hidden = false;
};
const interrupted = () => {
  clearSpinner();
  restore();
  process.stderr.write("\n");
  process.exit(130);
};
function hideCursor() {
  if (hidden) return;
  hidden = true;
  process.stderr.write("\x1b[?25l");
  process.once("exit", restore);
  process.once("SIGINT", interrupted);
}
function showCursor() {
  restore();
  process.off("exit", restore);
  process.off("SIGINT", interrupted);
}

// ---- spinner: a packet running along a pipeline ----

const PIPE_WIDTH = 9;
const NODES = new Set([0, 4, 8]);

/** One frame of the spinner: nodes `○` joined by `─`, with the packet `●` at `tick`. */
export function pipeFrame(tick: number, p: Paint = COLOURS): string {
  const at = tick % PIPE_WIDTH;
  let s = "";
  for (let x = 0; x < PIPE_WIDTH; x++) s += x === at ? p.cyan("●") : p.dim(NODES.has(x) ? "○" : "─");
  return s;
}

export interface Spinner {
  /** Change what it says it is waiting for. */
  text(t: string): void;
  /** Clear it; nothing is left on the line. */
  stop(): void;
}

const NOOP: Spinner = { text() {}, stop() {} };
let active: { stop(): void } | null = null;

/** Clear the spinner, if one is showing, so a message can be printed. */
export function clearSpinner() {
  active?.stop();
}

/**
 * A spinner on stderr while the CLI waits. It shows only after 150 ms, so a quick wait doesn't flicker, and is a no-op
 * when stderr isn't decorated.
 */
export function spinner(label: string, delayMs = 150): Spinner {
  if (!fancy()) return NOOP;
  clearSpinner();
  let text = label;
  let tick = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const draw = () => process.stderr.write(`\r\x1b[2K${pipeFrame(tick++)} ${COLOURS.dim(text)}`);
  const start = setTimeout(() => {
    hideCursor();
    draw();
    timer = setInterval(draw, 90);
  }, delayMs);
  const self = {
    text(t: string) {
      text = t;
    },
    stop() {
      clearTimeout(start);
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
        process.stderr.write("\r\x1b[2K");
        showCursor();
      }
      if (active === self) active = null;
    },
  };
  active = self;
  return self;
}

/** Run `fn` with a spinner saying `label`. */
export async function spinning<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const s = spinner(label);
  try {
    return await fn();
  } finally {
    s.stop();
  }
}

// ---- the `pipo ui` banner ----

const LOGO = ["┌─┐ ┬ ┌─┐ ┌─┐", "├─┘ │ ├─┘ │ │", "┴   ┴ ┴   └─┘"] as const;
const TAGLINE = "simple, agent-first pipelines";
const GRADIENT = [51, 45, 39, 33, 63, 99, 135, 171];

function rich(env: Env): boolean {
  return on(env.COLORTERM) || on(env.WT_SESSION) || /256|truecolor|kitty|wezterm|alacritty/.test(env.TERM ?? "");
}

/** `text` coloured from cyan to violet, column by column over `width` (plain cyan on a basic terminal). */
export function gradient(text: string, width: number, env: Env = process.env): string {
  if (!rich(env)) return COLOURS.cyan(text);
  let s = "";
  [...text].forEach((ch, x) => {
    const n = GRADIENT[Math.min(GRADIENT.length - 1, Math.floor((x / Math.max(1, width)) * GRADIENT.length))];
    s += ch === " " ? ch : `\x1b[38;5;${n}m${ch}`;
  });
  return `${s}\x1b[39m`;
}

/**
 * The `pipo` wordmark on stderr, underlined by a pipe a packet runs along once (about a quarter of a second). Nothing
 * when stderr isn't decorated.
 */
export async function banner(): Promise<void> {
  if (!fancy()) return;
  const err = process.stderr;
  const pad = "  ";
  const width = LOGO[0].length + 3 + TAGLINE.length;
  err.write(
    `\n${pad}${gradient(LOGO[0], width)}\n${pad}${gradient(LOGO[1], width)}   ${COLOURS.bold(TAGLINE)}\n${pad}${gradient(LOGO[2], width)}\n`,
  );
  hideCursor();
  try {
    for (let i = 0; i <= width; i += 2) {
      const head = Math.min(i, width);
      err.write(
        `\r${pad}${gradient("━".repeat(head), width)}${COLOURS.bold("●")}${COLOURS.dim("─".repeat(width - head))}`,
      );
      await new Promise((r) => setTimeout(r, 12));
    }
  } finally {
    showCursor();
  }
  err.write("\n\n");
}
