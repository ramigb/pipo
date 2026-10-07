// The data plane for one pipeline (docs/spec.md §7.1). Accepts packets, moves each one
// through its steps, writes and verifies it, and commits every transition to the journal.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  AGENTS,
  check,
  costOf,
  type Diagnostic,
  evaluate,
  formatDiagnostic,
  formatDuration,
  load,
  type Node,
  nodeKind,
  type Pipeline,
  parseDuration,
  priceFor,
  render,
  renderString,
} from "@pipo/spec";
import {
  AgentBudget,
  AgentCallError,
  type AgentOptions,
  type AgentRuntime,
  type AgentSettings,
  AgentSetupError,
  type BudgetCap,
  BudgetStop,
  packetStop,
  prepareAgents,
  readAgentSettings,
  round,
  systemTimeZone,
} from "./agents";
import { Batch } from "./batch";
import { type Bots, BotsError, loadBots, telegramUses } from "./bots";
import {
  type ConnectorContext,
  ConnectorError,
  inputs as inputFactories,
  outputs as outputFactories,
  taps as tapFactories,
  transforms as transformFactories,
} from "./connectors";
import { findCommand } from "./connectors/exec";
import { HttpInput, type Settled } from "./connectors/http-input";
import type { Clock } from "./connectors/schedule-input";
import type { StepAdapter } from "./connectors/steps";
import { TelegramInput } from "./connectors/telegram";
import type { InputAdapter, IntakeOptions, IntakeResult, Origin, OutputAdapter, WriteItem } from "./connectors/types";
import { controlHandler } from "./control/ops";
import { ControlError, socketPath, socketPathProblem } from "./control/protocol";
import { ControlServer } from "./control/server";
import { crashPoint } from "./crashpoint";
import { ulid } from "./ids";
import {
  BATCH_STEP,
  BRANCHED,
  type Cursor,
  ESCALATED,
  IN_FLIGHT,
  Journal,
  OUTPUT_STEP,
  type PacketRow,
  type PacketState,
  TERMINAL,
  VERIFY_STEP,
} from "./journal";
import { journaledPause, lifetimeAnchor, ttlOverrideProblem } from "./lifecycle-state";
import { entryAlive, type Liveness, procStart } from "./liveness";
import { resolveKey } from "./output-key";
import { compile, type Plan } from "./plan";
import { attempt, type ResolvedPolicy, resolvePolicy } from "./policy";
import { type AuthorKind, agentPolicyProblems, changedPaths, type Proposal, Proposals } from "./proposals";
import { retentionPolicy, startRetention } from "./retention";
import { type Resolver, Secrets } from "./secrets";
import { computeStats } from "./stats";
import { type Gap, gaps } from "./support";
import {
  boundChanges,
  fileChanges,
  planStart,
  runningFileHashes,
  sha256,
  staleModule,
  type VersionWarning,
} from "./versions";

/** `output.batch.within` when the file leaves it out (D20). */
const DEFAULT_BATCH_WITHIN = "1s";
/** The longest delay a timer takes; a longer one overflows a 32-bit int and fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export type RunnerState = "starting" | "active" | "paused" | "draining" | "stopped" | "failed";

export interface RunnerOptions {
  /** Path to the .pipo file. */
  file: string;
  /** Pipo home (journals, registry). Defaults to $PIPO_HOME or ~/.pipo. */
  home?: string;
  /** Clock for a schedule input; tests inject one. */
  clock?: Clock;
  /** Port for an http input; overrides input.with.listen. 0 picks a free port. */
  listen?: number;
  hostname?: string;
  /** Environment variables exposed to expressions as `env` (engine.env_allow in the spec). */
  envAllow?: string[];
  resolver?: Resolver;
  log?: (line: string) => void;
  /** The engine that started this runner; written to the registry entry as `engine_id` (§7.2). */
  engineId?: string;
  /**
   * Started detached (§7.2, D30): written to the registry entry as `detached`, so an engine leaves it running when
   * it shuts down. Lifetime, stall detection and schedules run here either way; the engine never re-arms them.
   */
  detached?: boolean;
  /**
   * `lifetime.ttl` for this start (`pipo start --ttl`, D57): replaces the file's, counts from the same journal anchor,
   * and is written to the registry entry as `ttl`, so the engine passes it again to a crash restart.
   */
  ttl?: string;
  /** Agent nodes (§3.4, §3.11): injected providers (tests), extra prices, the budget time zone. */
  agents?: AgentOptions;
}

/** `with.timeout` and `with.max_tokens` of an agent node when the file leaves them out (D36). */
const AGENT_TIMEOUT = "60s";
const AGENT_MAX_TOKENS = 4096;

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const withWarnings = (warnings: VersionWarning[]) => (warnings.length ? { warnings } : {});

export class StartError extends Error {
  constructor(
    message: string,
    readonly diagnostics: Diagnostic[] = [],
    readonly gaps: Gap[] = [],
  ) {
    super(message);
    this.name = "StartError";
  }
}

type Failure = { code: string; message: string; error?: Error; attempts?: number; elapsed?: number; rule?: string };

/** What a step decided for its packet. */
type Emitted = { type: string; detail?: unknown }[];
type Transition =
  | { kind: "move"; to: Cursor; data: unknown; iteration?: number; result?: unknown; event: string; extra?: Emitted }
  /** Fan-out (spec §3.4, D22): the step's result goes to several consumers, one copy each. */
  | { kind: "split"; to: Cursor[]; data: unknown; event: string; extra?: Emitted }
  | {
      kind: "end";
      state: "delivered" | "filtered" | "dead_lettered";
      error?: PacketRow["error"];
      event: string;
      extra?: Emitted;
    }
  | {
      kind: "hold";
      how: "pause" | "halt";
      error: PacketRow["error"];
      /** The pause reason when it isn't `error at <step>` (a `budget` pause, §3.11), with its detail. */
      reason?: string;
      detail?: Record<string, unknown>;
    }
  /**
   * Handed to the agent (§3.9, §9, D50): `then: agent` after the policy's retries (`error`), or `agent.on_stall:
   * handle` (`stall`, with the stall message). The unit stops and waits, durably, for a `resolve`.
   */
  | { kind: "escalate"; reason: "error" | "stall"; error: NonNullable<PacketRow["error"]>; stall?: string };

/** What `resolve` does with a unit waiting for the agent (D50). */
export type ResolveAction = "retry" | "dead_letter" | "drop";
export const RESOLVE_ACTIONS: readonly ResolveAction[] = ["retry", "dead_letter", "drop"];
/** Units per transaction when a stall hands waiting units to the agent. */
const HANDOVER_CHUNK = 500;

export class Runner {
  /** Registry paths of runners alive in this process (the pid check can't see those). */
  private static readonly active = new Set<string>();
  static isActive(registryPath: string): boolean {
    return Runner.active.has(registryPath);
  }
  state: RunnerState = "starting";
  readonly finished: Promise<number>;
  private resolveFinished!: (code: number) => void;
  private readonly plans = new Map<number, Promise<Plan>>();
  private readonly steps = new Map<string, StepAdapter>();
  private readonly queue: string[] = [];
  private readonly held: string[] = [];
  private wakers: (() => void)[] = [];
  private busy = 0;
  private stopping = false;
  private workers: Promise<void>[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private input?: InputAdapter;
  private retention?: ReturnType<typeof startRetention>;
  /** Output batches (spec §3.5.1), one per pipeline version so each packet keeps its own version's settings. */
  private readonly batches = new Map<number, Batch>();
  /** Set just before the journal closes; late batch flushes then leave their packets at `$batch`. */
  private closed = false;
  /** Why intake stopped under `lifetime` (§3.8); set once, journaled as `pipeline.lifetime`. */
  private lifetimeEnd?: "max_packets" | "until";
  private _startedAt = Date.now();
  /** Why the pipeline is paused (`manual`, `agent`, `stall`, `error at <step>`); undefined unless paused. */
  pauseReason?: string;
  /** Packets parked at `$verify` waiting for an `external` ack (§3.10, D24), with their deadline timers. */
  private readonly awaiting = new Map<string, ReturnType<typeof setTimeout>>();
  private control?: ControlServer;
  /** Stall detection (§3.10, D23): when delivery progress was last seen, and whether this episode already fired. */
  private progressAt = Date.now();
  private stalled = false;
  /** Where the flagged stall sits (D21, D23): the oldest in-flight unit's node and when it was flagged. */
  stallInfo: { node: string; since: string } | null = null;
  private untilFailed?: string;
  private readonly settleWaiters = new Map<string, ((s: Settled | null) => void)[]>();
  /**
   * Units a stall handed to the agent (`agent.on_stall: handle`, D50) that a worker or an output batch holds, with the
   * stall message: each is escalated at its next safe point, unless it moves on first. In memory only: after a crash
   * the units run again and a stall that persists hands them over again.
   */
  private readonly handOver = new Map<string, string>();
  /** Agent providers and prices (§3.4, D36); empty for a pipeline without agent nodes. */
  private agents: AgentRuntime = { providers: new Map(), pricing: {}, hidden: [] };
  /** Daily and per-packet agent budgets (§3.11, D37), read from the journal. */
  private budget!: AgentBudget;
  private readonly clock: Clock;
  /** When a `budget` pause resumes (ms) and its timer. */
  private budgetResumeAt?: number;
  /** The cap a `budget` pause came from (D58): a manual resume goes over that one only. */
  private budgetCap: BudgetCap = "pipeline";
  private budgetTimer?: unknown;

  /**
   * The active definition and its version: what newly accepted packets use. A live apply (rollback, D38) replaces
   * both at once; packets already accepted keep the version they were pinned to (§7.3).
   */
  pipeline: Pipeline;
  version = 0;
  /** Content hash of the active version. */
  private versionHash = "";
  /** Set while a new version is being applied, so two applies never interleave. */
  private applying = false;
  /** Change proposals against this pipeline (§9.3, D45): stored in its journal, applied by `applyProposal`. */
  proposals!: Proposals;
  /** Pipo home: `check` reads its trust.json (P052), as a start does. */
  private home = "";
  /** Chat bots (§3.13), tokens resolved; undefined when the pipeline uses none. */
  private bots?: Bots;
  /** The telegram bot id this runner's input polls, in its registry entry so a second poller refuses to start. */
  private pollsBot?: string;

  private constructor(
    pipeline: Pipeline,
    readonly journal: Journal,
    private readonly output: OutputAdapter,
    private readonly secrets: Secrets,
    private readonly env: Record<string, string>,
    private readonly registryPath: string,
    private readonly opts: RunnerOptions,
    private readonly dir: string,
    /** The control socket, `<home>/run/<name>.sock` (§7.2). */
    readonly socket: string,
  ) {
    this.pipeline = pipeline;
    this.finished = new Promise((r) => {
      this.resolveFinished = r;
    });
    this.clock = opts.clock ?? systemClock;
  }

  /** Check, gate and prepare a pipeline. Throws StartError with diagnostics when it can't run. */
  static async open(opts: RunnerOptions): Promise<Runner> {
    const file = resolve(opts.file);
    const home = opts.home ?? process.env.PIPO_HOME ?? join(homedir(), ".pipo");
    const badTtl = opts.ttl === undefined ? null : ttlOverrideProblem(opts.ttl);
    if (badTtl) throw new StartError(`${badTtl}; use for example --ttl 30m, 8h or 2d`);
    // The file, or the journal's latest version when the file is unchanged since the last start (D38).
    const start = planStart(home, file, readFileSync(file, "utf8"));
    const source = start.source;
    const diagnostics = check(source, { file, home });
    const errors = diagnostics.filter((d) => d.severity === "error");
    if (errors.length) {
      const j = start.fromJournal;
      throw new StartError(
        j
          ? `v${j.version} of the pipeline in ${opts.file} (${j.reason ?? "applied"} by ${j.author}; it runs instead of the file, which is unchanged since the last start, D38) has ${errors.length} error(s); edit the file to run it instead: a changed file wins on the next start`
          : `${opts.file} has ${errors.length} error(s)`,
        diagnostics,
      );
    }
    const pipeline = load(source, file).value as Pipeline;
    // Agent settings live in the engine config (§3.11, D36); read only when there are agent nodes.
    let settings: AgentSettings | undefined;
    if (Object.values(pipeline.nodes ?? {}).some((n) => n.agent !== undefined)) {
      const read = readAgentSettings(home);
      if (read.problems.length) {
        throw new StartError(
          `the agent settings in ${join(home, "config.yaml")} have ${read.problems.length} problem(s):\n${read.problems.map((p) => `  ${p}`).join("\n")}\nfix or remove those keys (docs/spec.md §3.11)`,
        );
      }
      settings = read.settings;
    }
    const found = gaps(pipeline);
    if (found.some((g) => g.level === "refuse")) {
      throw new StartError(`${pipeline.name} uses features this runner does not implement yet`, [], found);
    }

    // An exec step's program must be there before the first packet needs it (D71). A templated command is checked per call.
    for (const [id, n] of Object.entries(pipeline.nodes ?? {})) {
      const command = (n.tap === "exec" || n.transform === "exec") && n.with?.command;
      if (typeof command !== "string" || command.includes("${") || findCommand(command, dirname(file))) continue;
      throw new StartError(
        `nodes.${id}.with.command: '${command}' is not installed or not on PATH; install it (for example \`brew install ${command}\` or \`apt install ${command}\`), or set the full path to the program`,
      );
    }

    const registryPath = join(home, "run", `${pipeline.name}.json`);
    const existing = readRegistry(registryPath);
    if (Runner.active.has(registryPath) || (existing && existing.pid !== process.pid && entryAlive(existing))) {
      throw new StartError(`${pipeline.name} is already running (pid ${existing?.pid ?? process.pid})`);
    }
    const socket = socketPath(home, pipeline.name);
    const problem = socketPathProblem(socket);
    if (problem) throw new StartError(`${problem.message}; ${problem.hint}`);
    let agents: AgentRuntime | undefined;
    if (settings) {
      try {
        agents = await prepareAgents(pipeline, settings, opts.agents, opts.resolver);
      } catch (e) {
        if (e instanceof AgentSetupError) throw new StartError(`${e.message}; ${e.hint}`);
        throw e;
      }
    }

    // Chat bots come from the home's bots.json (§3.13, D69); their tokens are redacted like secrets.
    let bots: Bots | undefined;
    if (telegramUses(pipeline).length) {
      try {
        bots = await loadBots(home, pipeline, opts.resolver);
      } catch (e) {
        if (e instanceof BotsError) throw new StartError(e.message);
        throw e;
      }
    }
    const botTokens = [...(bots?.telegram.values() ?? [])].map((b) => b.token);

    const journal = new Journal(join(home, "pipelines", pipeline.name, "journal.db"));
    const secrets = await Secrets.resolve(pipeline.secrets, opts.resolver, [...(agents?.hidden ?? []), ...botTokens]);
    const env = Object.fromEntries(
      (opts.envAllow ?? []).flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k] as string]])),
    );
    const dir = dirname(file);
    const outputFactory = outputFactories[pipeline.output.to];
    if (!outputFactory) throw new StartError(`no implementation for output '${pipeline.output.to}'`);
    const output = outputFactory({
      pipeline,
      dir,
      log: () => {},
      print: opts.log,
      with: {},
      home,
      bots,
    });
    const runner = new Runner(pipeline, journal, output, secrets, env, registryPath, opts, dir, socket);
    if (agents) runner.agents = agents;
    runner.bots = bots;
    runner.proposals = new Proposals(journal, {
      pipeline: pipeline.name,
      file,
      home,
      redact: (t) => secrets.redact(t),
      env,
    });
    runner.home = home;
    // The engine-wide cap (D58) is read from the home's config.yaml, as `agents:` and the time zone are (D36).
    const engineCap = settings?.engineBudget ? { home, name: pipeline.name, ...settings.engineBudget } : null;
    runner.budget = new AgentBudget(
      journal,
      () => runner.pipeline.agent_budget,
      opts.agents?.timezone ?? settings?.timezone ?? systemTimeZone(),
      () => runner.clock.now(),
      engineCap,
    );
    try {
      runner.input = runner.makeInput();
      if (runner.input instanceof HttpInput) runner.input.awaitTerminal = (id, ms) => runner.awaitTerminal(id, ms);
      if (runner.input instanceof TelegramInput) {
        runner.pollsBot = runner.input.botId;
        const other = botPoller(home, pipeline.name, runner.pollsBot);
        if (other)
          throw new StartError(
            `telegram bot ${runner.pollsBot} is already polled by pipeline '${other.name}' (pid ${other.pid}); Telegram lets only one reader take a bot's messages. Stop that pipeline, or give this one another bot`,
          );
      }
      // Binding the socket is also the lock: a live runner still answering on it makes this one refuse.
      runner.control = await ControlServer.listen(socket, controlHandler(runner), {
        redact: (t) => secrets.redact(t),
        log: (level, message) => runner.log(level, message),
      });
      // Recorded only now that this runner holds the socket (the start lock), in one transaction (D38).
      try {
        // The files the started version runs with are recorded with it when the start appends one (D60).
        runner.version = journal.commitStart(start, start.fileHash, runningFileHashes(pipeline, dir));
      } catch (e) {
        await runner.control.close();
        throw new StartError(`${(e as Error).message}; is another runner of ${pipeline.name} starting? Try again`);
      }
      runner.versionHash = start.hash;
    } catch (e) {
      journal.close();
      if (e instanceof ControlError) throw new StartError(`${e.message}; ${e.hint}`);
      throw e;
    }
    for (const g of found) runner.log("warn", `not implemented yet, ignored: ${g.feature} (${g.path})`);
    return runner;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const p = this.pipeline;
    this.plans.set(this.version, compile(p, this.version, this.dir));
    await this.plan(this.version);

    // A pause outlives a crash (D32): taken from the journal before any worker runs, so no recovered packet moves
    // between this start and the pause taking effect. Intake still accepts into the journal while paused (§2.2).
    const restored = journaledPause(this.journal);
    if (restored) this.pauseReason = restored.reason;
    if (restored?.reason === "budget") {
      // Resumes when the window it was paused in ends, even if that passed while no runner was up (D32, D37).
      const at = Date.parse(String(restored.detail.resume_at));
      this.budgetResumeAt = Number.isFinite(at) ? at : this.budget.window().end;
      this.budgetCap = restored.detail.cap === "engine" ? "engine" : "pipeline";
    }
    const recovered = this.journal.inFlight();
    for (const row of recovered) this.queue.push(row.id);
    const concurrency = p.concurrency ?? 4;
    for (let i = 0; i < concurrency; i++) this.workers.push(this.work());

    if (!this.input) throw new StartError("runner has no input");
    Runner.active.add(this.registryPath);
    this._startedAt = Date.now();
    try {
      await this.input.start((payload, origin, o) => this.intake(payload, origin, o), {
        state: (scope) => this.journal.inputState(scope),
      });
    } catch (e) {
      // No registry entry was written yet; don't leave a socket behind that nothing will answer on.
      Runner.active.delete(this.registryPath);
      await this.control?.close();
      throw e;
    }
    // Paused when the journal said so, or when a recovered packet's `then: pause` held it while the input started.
    this.state = this.pauseReason === undefined ? "active" : "paused";
    this.writeRegistry();
    this.journal.event("pipeline.started", {
      version: this.version,
      recovered: recovered.length,
      ...(this.opts.ttl && { ttl: this.opts.ttl }),
    });
    this.retention = startRetention(this.journal.db, retentionPolicy(this.pipeline.retention));
    if (restored)
      this.journal.event("pipeline.paused", { ...restored.detail, reason: restored.reason, restored: true });
    this.log(
      "info",
      `started v${this.version}${this.opts.detached ? " (detached)" : ""}, input: ${this.input.describe()}${recovered.length ? `, ${restored ? "holding" : "resuming"} ${recovered.length} packet(s)` : ""}`,
    );
    if (restored)
      this.log(
        "warn",
        `paused (${restored.reason}), as it was when its last run ended; still accepting packets into the journal until resumed`,
      );
    for (const w of this.startFileWarnings(recovered.map((r) => r.version)))
      this.log("warn", `${w.message}; ${w.hint}`);
    const waiting = this.journal.countEscalated();
    if (waiting)
      this.log(
        "warn",
        `${waiting} packet(s) wait for the agent (then: agent or a stall); resolve them with retry, dead_letter or drop`,
      );
    if (this.state === "paused" && this.pauseReason === "budget") this.armBudgetResume();

    const lt = p.lifetime;
    if (lt?.until) this.timers.push(setInterval(() => this.checkLifetime(), 1000));
    this.checkLifetime();
    const stall = p.delivered?.stall;
    if (stall) {
      const after = parseDuration(stall.after);
      this.progressAt = Date.now();
      this.timers.push(setInterval(() => this.checkStall(), Math.min(1000, Math.max(50, Math.floor(after / 4)))));
    }
    // A start's --ttl replaces the file's (D57); either counts from the lifetime's anchor.
    const ttl = this.opts.ttl ?? lt?.ttl;
    if (this.opts.ttl)
      this.log("info", `lifetime ttl ${this.opts.ttl} from the start (the file's: ${lt?.ttl ?? "none"})`);
    if (ttl) this.armTtl(ttl, lt?.on_end);
  }

  /**
   * Arm `lifetime.ttl` (§3.8) from the lifetime's anchor in the journal, not from this run: a restart after a crash
   * gets only the time that is left, and one that finds it over ends at once. Timers are armed in steps of at most
   * MAX_TIMER_MS, since a longer delay would overflow and fire immediately.
   */
  private armTtl(ttl: string, onEnd: "drain" | "stop" | undefined): void {
    const anchor = lifetimeAnchor(this.journal) ?? this._startedAt;
    const deadline = anchor + parseDuration(ttl);
    if (anchor < this._startedAt) {
      const left = deadline - Date.now();
      this.log(
        "info",
        `lifetime ttl ${ttl} counts from ${new Date(anchor).toISOString()}, when a run that did not stop cleanly started: ${left > 0 ? `${formatDuration(left)} left` : "already over"}`,
      );
    }
    const arm = () => {
      const left = deadline - Date.now();
      if (left > MAX_TIMER_MS) {
        this.timers.push(setTimeout(arm, MAX_TIMER_MS));
        return;
      }
      this.timers.push(
        setTimeout(
          () => {
            this.log("info", `lifetime ttl ${ttl} reached`);
            void (onEnd === "stop" ? this.stop() : this.drain());
          },
          Math.max(0, left),
        ),
      );
    };
    arm();
  }

  get address(): string | undefined {
    return this.input?.describe();
  }

  get port(): number | undefined {
    return this.input instanceof HttpInput ? this.input.port : undefined;
  }

  /** When this run started (ms); `stats.uptime` counts from here. */
  get startedAt(): number {
    return this._startedAt;
  }

  /** Packets waiting for an `external` ack right now. */
  get awaitingAck(): number {
    return this.awaiting.size;
  }

  pause(reason = "manual", detail: Record<string, unknown> = {}): void {
    // While starting (a recovered packet held with `then: pause`), start() turns the recorded reason into `paused`.
    const starting = this.state === "starting" && this.pauseReason === undefined;
    if (this.state !== "active" && !starting) return;
    if (!starting) this.state = "paused";
    this.pauseReason = reason;
    this.journal.event("pipeline.paused", { ...detail, reason });
    void this.flushBatches();
    if (reason === "budget") {
      const at = Date.parse(String(detail.resume_at));
      this.budgetResumeAt = Number.isFinite(at) ? at : this.budget.window().end;
      this.budgetCap = detail.cap === "engine" ? "engine" : "pipeline";
      this.log(
        "warn",
        `paused (budget): ${detail.message ?? "agent_budget.per_day reached"}; still accepting packets into the journal. \`pipo resume\` goes over the cap until then`,
      );
      if (!starting) this.armBudgetResume();
    } else this.log("warn", `paused (${reason}); still accepting packets into the journal`);
    if (!starting) this.writeRegistry();
  }

  /**
   * Resume. `window` is the automatic resume of a `budget` pause when the next budget day opens (§3.11); any other
   * resume of a `budget` pause (`pipo resume`) goes over the daily cap until that day ends, and says so in its event.
   */
  resume(how: "manual" | "window" = "manual"): void {
    if (this.state !== "paused") return;
    const budget = this.pauseReason === "budget";
    this.state = "active";
    this.pauseReason = undefined;
    this.progressAt = Date.now();
    this.stalled = false;
    this.stallInfo = null;
    this.clearBudgetTimer();
    this.budgetResumeAt = undefined;
    this.queue.unshift(...this.held.splice(0));
    if (!budget) {
      this.journal.event("pipeline.resumed");
      this.log("info", "resumed");
    } else if (how === "window") {
      this.journal.event("pipeline.resumed", { reason: "budget_window" });
      this.log("info", "resumed: a new agent budget day started");
    } else if (this.budgetCap === "engine") {
      const w = this.budget.overrideToday("engine");
      const until = new Date(w.end).toISOString();
      this.journal.event("pipeline.resumed", { engine_budget_override: new Date(w.start).toISOString(), until });
      this.log(
        "warn",
        `resumed over engine.agent_budget.per_day: this pipeline's agent calls continue past the engine cap until ${until}`,
      );
    } else {
      const w = this.budget.overrideToday();
      const until = new Date(w.end).toISOString();
      this.journal.event("pipeline.resumed", { budget_override: new Date(w.start).toISOString(), until });
      this.log("warn", `resumed over agent_budget.per_day: agent calls continue past the cap until ${until}`);
    }
    this.writeRegistry();
    // Every worker: a backlog accepted (or recovered) while paused can be longer than one.
    this.wake(true);
  }

  /** Resume a `budget` pause once its window ends (§3.11, D37). Re-arms when the timer fires early or is capped. */
  private armBudgetResume() {
    this.clearBudgetTimer();
    const at = this.budgetResumeAt ?? this.budget.window().end;
    const wait = Math.max(0, at - this.clock.now());
    this.budgetTimer = this.clock.setTimeout(
      () => {
        this.budgetTimer = undefined;
        if (this.stopping || this.closed || this.state !== "paused" || this.pauseReason !== "budget") return;
        if (this.clock.now() < at) return this.armBudgetResume();
        this.resume("window");
      },
      Math.min(wait, 2 ** 31 - 1),
    );
  }

  private clearBudgetTimer() {
    if (this.budgetTimer !== undefined) this.clock.clearTimeout(this.budgetTimer);
    this.budgetTimer = undefined;
  }

  /** USD spent on agent calls in the current budget day (§3.11), from the journal. */
  agentSpendToday(): number {
    return round(this.budget.spentToday());
  }

  /** When a `budget` pause resumes (ISO), or null. */
  get budgetResumesAt(): string | null {
    return this.state === "paused" && this.pauseReason === "budget" && this.budgetResumeAt !== undefined
      ? new Date(this.budgetResumeAt).toISOString()
      : null;
  }

  /** No packet moves: paused, or starting with a pause taken over from the journal (D32). */
  private get holding(): boolean {
    return this.state === "paused" || (this.state === "starting" && this.pauseReason !== undefined);
  }

  /** Stop intake, let in-flight packets finish (bounded by drain_timeout), then stop. */
  async drain(): Promise<void> {
    if (this.state === "draining" || this.stopping) return this.finished.then(() => undefined);
    if (this.state === "paused") this.resume();
    this.state = "draining";
    this.journal.event("pipeline.draining");
    this.log("info", "draining");
    await this.input?.stop();
    const timeout = parseDuration(this.pipeline.lifetime?.drain_timeout ?? "2m");
    const deadline = Date.now() + timeout;
    // Packets parked for an `external` ack are in flight too: drain waits for their ack or deadline.
    const idle = () => !this.queue.length && !this.busy && !this.awaiting.size;
    void this.flushBatches();
    while ((!idle() || this.batched()) && Date.now() < deadline) {
      // Nothing upstream can join a partial batch any more, so write it now rather than after `within`.
      if (idle()) void this.flushBatches();
      await Bun.sleep(50);
    }
    if (!idle() || this.batched())
      this.log("warn", `drain timed out after ${formatDuration(timeout)}; unfinished packets resume on next start`);
    await this.stop();
  }

  /** Stop now. Packets mid-step stay in the journal and resume on the next start. */
  async stop(code = 0): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const failed = this.state === "failed";
    this.state = failed ? "failed" : "stopped";
    for (const t of this.timers) clearTimeout(t);
    this.clearBudgetTimer();
    this.retention?.stop();
    for (const t of this.awaiting.values()) clearTimeout(t);
    this.awaiting.clear();
    this.handOver.clear();
    for (const ws of [...this.settleWaiters.values()]) for (const w of ws) w(null);
    await this.input?.stop();
    this.wake(true);
    await Promise.race([Promise.all(this.workers), Bun.sleep(1000)]);
    // Write any partial batch; a flush that can't finish in time is abandoned and its packets,
    // still journaled at `$batch`, are written again (idempotently) on the next start.
    await Promise.race([this.flushBatches(), Bun.sleep(2000)]);
    for (const b of this.batches.values()) b.close();
    this.closed = true;
    this.journal.event(failed ? "pipeline.failed" : "pipeline.stopped");
    this.log("info", failed ? "stopped after halt" : "stopped");
    this.output.close();
    for (const a of this.steps.values()) a.close();
    await this.control?.close();
    this.journal.close();
    rmSync(this.registryPath, { force: true });
    Runner.active.delete(this.registryPath);
    this.resolveFinished(failed ? 2 : code);
  }

  // ── versions (spec §9.3, D38) ────────────────────────────────────────────────

  /**
   * Make `source` the active definition at a safe point: checked like a start, stored as a new version (with a
   * `version.applied` event, one transaction), then used by every packet accepted after this returns. Packets already
   * accepted finish on the version they were pinned to (§7.3). Refused, with nothing written, when it fails `pipo
   * check`, uses a feature the runner lacks, or changes what is bound at start (D38). The same content as the active
   * version changes nothing (`changed: false`), so a repeated rollback is harmless.
   */
  async applyVersion(
    source: string,
    how: {
      author: string;
      reason: string;
      author_kind?: AuthorKind | null;
      /** Set by `applyProposal`: the proposal is marked applied in the transaction that stores the version (D49). */
      proposal?: { id: string; by: string };
    },
  ): Promise<{
    version: number;
    previous: number;
    changed: boolean;
    pending_older: number;
    warnings?: VersionWarning[];
  }> {
    const name = this.pipeline.name;
    this.assertCanApply();
    const previous = this.version;
    const hash = sha256(source);
    const pendingOlder = () =>
      (
        this.journal.db
          .query(
            `SELECT COUNT(*) AS n FROM packets WHERE branch = '' AND version != ? AND state IN ('accepted', 'processing', 'writing', 'verifying', '${BRANCHED}', '${ESCALATED}')`,
          )
          .get(this.version) as { n: number }
      ).n;
    if (hash === this.versionHash) {
      if (how.proposal) {
        throw new ControlError(
          "invalid_state",
          `proposal ${how.proposal.id} changes nothing: its source is the running v${previous}'s`,
          "reject it; there is nothing to apply",
        );
      }
      const stale = this.warnAll(staleModule(this.pipeline, this.dir, previous));
      return { version: previous, previous, changed: false, pending_older: pendingOlder(), ...withWarnings(stale) };
    }

    this.applying = true;
    try {
      const file = resolve(this.opts.file);
      const diagnostics = check(source, { file, home: this.home });
      const errors = diagnostics.filter((d) => d.severity === "error");
      if (errors.length) {
        // The text for people, and the diagnostics themselves for tools, as `pipo check --json` gives them (D60).
        throw new ControlError(
          "invalid_pipeline",
          `the new version fails pipo check with ${errors.length} error(s), so nothing was applied:\n${errors.map((d) => `  ${formatDiagnostic(d).replace(/\n/g, "\n  ")}`).join("\n")}`,
          `fix those, or roll back to a version that passes (pipo history ${name})`,
          undefined,
          diagnostics,
        );
      }
      const next = load(source, file).value as Pipeline;
      const bound = boundChanges(this.pipeline, next);
      if (bound.length) {
        throw new ControlError(
          "invalid_state",
          `the new version changes ${bound.join(", ")}, which the runner binds when it starts, so it can't be applied while ${name} runs`,
          `put that definition in ${this.opts.file} and restart (pipo restart ${name}); a changed file wins on the next start (D38)`,
        );
      }
      const missing = gaps(next).filter((g) => g.level === "refuse");
      if (missing.length) {
        throw new ControlError(
          "invalid_state",
          `the new version uses features this runner does not implement yet: ${missing.map((g) => `${g.feature} (${g.path})`).join(", ")}`,
          "remove them from that version",
        );
      }
      for (const [id, node] of Object.entries(next.nodes ?? {})) {
        if (typeof node.agent !== "string") continue;
        const model = node.with?.model;
        const pricing = this.agents.pricing[node.agent] as Parameters<typeof priceFor>[0] | undefined;
        if (
          !this.agents.providers.has(node.agent) ||
          (AGENTS[node.agent]?.runs !== "cli" &&
            typeof model === "string" &&
            !model.includes("${") &&
            !(pricing && priceFor(pricing, model)))
        ) {
          throw new ControlError(
            "invalid_state",
            `agent node '${id}' needs provider '${node.agent}'${typeof model === "string" ? ` with model '${model}'` : ""}, which this runner did not set up when it started`,
            `put that definition in ${this.opts.file} and restart (pipo restart ${name}), so the provider and its price are set up`,
          );
        }
      }
      const number = (this.journal.latestVersion()?.version ?? 0) + 1;
      let plan: Plan;
      try {
        plan = await compile(next, number, this.dir);
      } catch (e) {
        throw new ControlError(
          "invalid_pipeline",
          `the new version can't be prepared: ${(e as Error).message}`,
          "check its fn module and schema files",
        );
      }
      // What the version runs with, recorded with it (D60): taken after the plan loaded its fn module.
      const files = runningFileHashes(next, this.dir);
      this.assertRunnable();
      // From here to the swap nothing awaits: the version, its event, a proposal's `applied` state and the in-memory
      // switch happen together. A crash before the commit leaves version N (and the proposal applicable); after it,
      // N+1 (and the proposal applied), which the next start runs since the file did not change (D38, D49).
      crashPoint("apply.prepared");
      let version: number;
      try {
        version = this.journal.atomically(() => {
          const v = this.journal.addVersion(
            hash,
            source,
            this.secrets.redact(how.author),
            this.secrets.redact(how.reason),
            { expect: number, previous },
            { author_kind: how.author_kind ?? null, proposal: how.proposal?.id ?? null, files },
          );
          crashPoint("apply.in_transaction");
          if (how.proposal) this.proposals.markApplied(how.proposal.id, { version: v, by: how.proposal.by });
          return v;
        });
      } catch (e) {
        if (e instanceof ControlError) throw e;
        throw new ControlError("internal", (e as Error).message, "try again");
      }
      crashPoint("apply.committed");
      this.plans.set(version, Promise.resolve(plan));
      this.pipeline = next;
      this.version = version;
      this.versionHash = hash;
      this.writeRegistry();
      const older = pendingOlder();
      this.log(
        "info",
        `applied v${version} (${how.proposal ? `proposal ${how.proposal.id}: ` : ""}${how.reason}, by ${how.author}); new packets use it${older ? `, ${older} packet(s) in flight finish on their own version` : ""}`,
      );
      const stale = this.warnAll(staleModule(next, this.dir, version));
      return { version, previous, changed: true, pending_older: older, ...withWarnings(stale) };
    } finally {
      this.applying = false;
    }
  }

  /** Refuse an apply unless the runner takes new packets (so the new version would be used). */
  private assertRunnable(): void {
    if (this.state === "active" || this.state === "paused") return;
    throw new ControlError(
      this.state === "starting" ? "unavailable" : "invalid_state",
      `cannot apply a version: pipeline is ${this.state}`,
      this.state === "starting"
        ? "try again once it runs"
        : this.state === "draining"
          ? "it accepts no new packets while draining, so a new version would never be used; start it again first"
          : `start it again first (pipo start ${this.pipeline.name})`,
    );
  }

  private assertCanApply(): void {
    this.assertRunnable();
    if (this.applying) {
      throw new ControlError("invalid_state", "another version is being applied right now", "try again in a moment");
    }
  }

  /**
   * §9.3 step 4 (D49): apply a change proposal as version N+1 at the same safe point as `applyVersion`, which checks
   * it like any apply; the version (author, `author_kind`, reason and proposal id from the proposal) and the
   * proposal's `applied` state are committed in one transaction. Refused unless the proposal is `validated` or
   * `verified` and its base is still the latest version; a stale base can never become current again, so that proposal
   * is rejected on the spot. A `validated` proposal whose base set `agent.verify` is dry-run first, on the path
   * `propose` uses (D48): it applies when that passes, and when it diverges the `rejected` proposal is the reply, not
   * an error. That is how a proposal a crash left `validated` mid dry run is recovered. An agent's proposal is held
   * again to the policy of the version in force. Any other refusal leaves the proposal as it was.
   */
  async applyProposal(
    id: string,
    by: string,
  ): Promise<
    { version: number; previous: number; changed: boolean; pending_older: number; proposal: string } | Proposal
  > {
    const name = this.pipeline.name;
    this.assertCanApply();
    let p = this.applicableProposal(id, by);
    if (p.verify && p.state === "validated") {
      // Nothing is held while it replays (as for `propose`), so everything is checked again once it is decided.
      p = await this.proposals.dryRunIfRequired(id, { by: "dry-run" });
      if (p.state === "rejected") return p;
      this.assertCanApply();
      p = this.applicableProposal(id, by);
    }
    if (p.verify && p.state !== "verified") {
      throw new ControlError(
        "invalid_state",
        `proposal ${id} needs a dry run first (agent.verify: ${p.verify}) and is ${p.state}`,
        `apply it again: pipo proposals ${name} apply ${id} runs the dry run first`,
      );
    }
    const latest = p.base_version;
    if (p.author_kind === "agent") {
      const file = resolve(this.opts.file);
      const current = load(this.journal.versionSource(latest), file).value as Pipeline;
      const proposed = load(p.source, file).value;
      const problems = agentPolicyProblems(current, changedPaths(current, proposed));
      if (problems.length) {
        throw new ControlError(
          "invalid_state",
          `proposal ${id} is not allowed by v${latest}'s agent policy: ${problems.map((x) => x.message).join("; ")}`,
          (problems[0] as { hint: string }).hint,
        );
      }
    }
    const applied = await this.applyVersion(p.source, {
      author: p.author,
      reason: p.reason,
      author_kind: p.author_kind,
      proposal: { id, by },
    });
    return { ...applied, proposal: id };
  }

  /**
   * The proposal, unless it can't be applied: `applied` or `rejected` refuse; a base that is no longer the latest is
   * marked `rejected` (`stale base`) and refused, since it can never become current again (D49).
   */
  private applicableProposal(id: string, by: string): Proposal {
    const name = this.pipeline.name;
    const p = this.proposals.get(id);
    if (p.state === "applied") {
      throw new ControlError(
        "invalid_state",
        `proposal ${id} is already applied, as v${p.applied_version}`,
        `nothing to do; pipo history ${name} shows it, and pipo rollback ${name} <version> undoes it`,
      );
    }
    if (p.state === "rejected") {
      throw new ControlError(
        "invalid_state",
        `proposal ${id} was rejected${p.decision ? ` (${p.decision})` : ""}, so it can't be applied`,
        "propose the change again against the current version if you still want it",
      );
    }
    const latest = this.journal.latestVersion()?.version ?? 0;
    if (p.base_version !== latest) {
      const reason = `stale base: the proposal is against v${p.base_version}, but ${name} was at v${latest} when it was applied; propose the change against v${latest}`;
      this.proposals.markRejected(id, { by, reason });
      throw new ControlError(
        "invalid_state",
        `stale base: proposal ${id} is against v${p.base_version}, but ${name} is at v${latest} now, so it is rejected`,
        `read v${latest} (pipo history ${name}) and propose the change against it`,
      );
    }
    return p;
  }

  /**
   * Apply an earlier version's source again, as a new version (§9.3, D38). Its `fn` module and schema files are read
   * as they are now, so each one that differs from what v<to> recorded is a warning in the reply and the log (D60).
   */
  async rollback(
    to: number,
    by: string,
  ): Promise<{
    version: number;
    previous: number;
    changed: boolean;
    pending_older: number;
    rolled_back_to: number;
    warnings?: VersionWarning[];
  }> {
    let source: string;
    try {
      source = this.journal.versionSource(to);
    } catch {
      const latest = this.journal.latestVersion()?.version ?? 0;
      throw new ControlError(
        "not_found",
        `${this.pipeline.name} has no version ${to} (versions are v1 to v${latest})`,
        `list them with pipo history ${this.pipeline.name}`,
      );
    }
    const applied = await this.applyVersion(source, { author: by, reason: `rollback to v${to}` });
    const runs = this.journal.versionFiles(applied.version) ?? runningFileHashes(this.pipeline, this.dir);
    const changed = this.warnAll(
      fileChanges(
        this.journal.versionFiles(to),
        runs,
        to,
        this.pipeline.name,
        applied.version === to
          ? undefined
          : { version: applied.version, what: applied.changed ? `rollback to v${to}` : "running" },
      ),
    );
    const warnings = [...changed, ...(applied.warnings ?? [])];
    const { warnings: _w, ...rest } = applied;
    return { ...rest, rolled_back_to: to, ...withWarnings(warnings) };
  }

  /** Log each warning, and return them. */
  private warnAll(warnings: VersionWarning[]): VersionWarning[] {
    for (const w of warnings) this.log("warn", `${w.message}; ${w.hint}`);
    return warnings;
  }

  /**
   * At start (D60): the files each version that runs now (the started one, and those of recovered packets) recorded,
   * against those it runs with. A version from before D60 recorded none.
   */
  private startFileWarnings(recovered: number[]): VersionWarning[] {
    const out: VersionWarning[] = [];
    for (const v of [...new Set([this.version, ...recovered])].sort((a, b) => a - b)) {
      try {
        const p =
          v === this.version ? this.pipeline : (load(this.journal.versionSource(v), this.opts.file).value as Pipeline);
        out.push(...fileChanges(this.journal.versionFiles(v), runningFileHashes(p, this.dir), v, this.pipeline.name));
      } catch {
        // A version that no longer loads fails its packets when its plan is compiled, with its own error.
      }
    }
    return out;
  }

  // ── intake ───────────────────────────────────────────────────────────────────

  async intake(payload: unknown, origin: Origin, opts: IntakeOptions = {}): Promise<IntakeResult> {
    // The lifetime reason first: once a limit is reached the pipeline is draining, but the limit is the cause (D21).
    if (this.lifetimeEnd) return { status: "unavailable", reason: this.lifetimeReason(this.lifetimeEnd) };
    if (this.state !== "active" && this.state !== "paused")
      return { status: "unavailable", reason: `pipeline is ${this.state}` };
    const max = this.pipeline.buffer?.max ?? 10_000;
    if (this.journal.countInFlight() >= max)
      return { status: "unavailable", reason: `buffer full (${max} packets pending)` };

    // The version is taken before the await: a version applied meanwhile (D38) is for the packets after this one.
    const version = this.version;
    const plan = await this.plan(version);
    const id = ulid();
    const receivedAt = Date.now();
    const meta = this.meta(
      plan,
      { id, trigger: origin.trigger, source: origin.source, received_at: receivedAt },
      "input",
    );
    const ctx = { data: payload, meta, env: this.env };
    const base = {
      id,
      version,
      data: payload,
      trigger: origin.trigger,
      source: origin.source,
      received_at: receivedAt,
    };

    const failed = this.firstFailedRule(plan, payload, ctx);
    if (failed) {
      const inv = plan.pipeline.input.on_invalid;
      const message = this.message(inv?.message, { ...ctx, error: { ...failed, node: "input" } }, failed.message);
      const error = { code: failed.code, message, node: "input" };
      this.journal.insert(
        { ...base, state: "rejected", cursor: null, error },
        "packet.rejected",
        { rule: failed.rule },
        () => {
          opts.commit?.();
          // Never accepted, so it can't wait: the agent is told, in the same transaction, and may push it again (D50).
          if (inv?.then === "agent")
            this.journal.event("packet.escalated", { reason: "rejected", waiting: false, error }, id, "input");
        },
      );
      return { status: "rejected", packet_id: id, rule: failed.rule, message, respond: inv?.respond };
    }
    // No await between this check and the insert, so concurrent requests can't overshoot max_packets.
    this.checkLifetime();
    if (this.lifetimeEnd) return { status: "unavailable", reason: this.lifetimeReason(this.lifetimeEnd) };
    const first = plan.next.get("input") as string[];
    if (first.length === 1) {
      this.journal.insert(
        { ...base, state: "accepted", cursor: first[0] as string, error: null },
        "packet.accepted",
        undefined,
        opts.commit,
      );
      this.queue.push(id);
      this.wake();
    } else {
      // The input fans out: the packet and all its copies are journaled together, before the ack.
      const root: PacketRow = {
        ...base,
        state: BRANCHED,
        cursor: null,
        error: null,
        attempt: 0,
        iteration: 0,
        hops: 0,
        result: null,
        root: null,
        parent: null,
        branch: "",
        updated_at: receivedAt,
      };
      const copies = this.copies(root, first, payload, 0);
      this.journal.insert({ ...base, state: BRANCHED, cursor: null, error: null }, "packet.accepted", undefined, () => {
        opts.commit?.();
        this.journal.event("packet.fanned_out", { branches: copies.map((c) => c.branch) }, id, "input");
        this.journal.insertCopies(root, copies, "input");
      });
      for (const c of copies) this.queue.push(c.id);
      this.wake(true);
    }
    this.checkLifetime();
    return { status: "accepted", packet_id: id };
  }

  private lifetimeReason(why: "max_packets" | "until"): string {
    const lt = this.pipeline.lifetime;
    return why === "max_packets"
      ? `pipeline reached lifetime.max_packets (${lt?.max_packets}); it is no longer accepting packets`
      : `pipeline reached lifetime.until (${lt?.until}); it is no longer accepting packets`;
  }

  /**
   * Enforce `lifetime.max_packets` and `lifetime.until` (§3.8) from journal counts: on reaching either,
   * intake stops and the pipeline drains (or stops, per `on_end`).
   */
  private checkLifetime() {
    const lt = this.pipeline.lifetime;
    if (!lt || this.lifetimeEnd || this.stopping || this.closed) return;
    if (lt.max_packets === undefined && !lt.until) return;
    const stats = computeStats(this.journal, this._startedAt);
    let why: "max_packets" | "until" | undefined;
    if (lt.max_packets !== undefined && stats.accepted >= lt.max_packets) why = "max_packets";
    if (!why && lt.until) {
      try {
        if (evaluate(lt.until, { stats, env: this.env })) why = "until";
      } catch (e) {
        // Same as other runtime expression errors: logged (once), never fatal; the pipeline keeps running.
        const message = (e as Error).message;
        if (this.untilFailed !== message) {
          this.untilFailed = message;
          this.journal.event("pipeline.lifetime_error", { until: lt.until, error: message });
          this.log(
            "warn",
            `lifetime.until could not be evaluated: ${message}. Fix the expression; the pipeline keeps running without it`,
          );
        }
      }
    }
    if (!why) return;
    this.lifetimeEnd = why;
    this.journal.event("pipeline.lifetime", { reason: why, stats });
    this.log("info", this.lifetimeReason(why).replace("; it is no longer accepting packets", "; draining"));
    // Defer so the packet that hit the limit is answered before the input shuts down.
    setTimeout(() => void (lt.on_end === "stop" ? this.stop() : this.drain()), 0);
  }

  /** "jammed" while a stall is flagged and the pipeline still runs (§2.2); otherwise the plain state. */
  get status(): RunnerState | "jammed" {
    return this.state === "active" && this.stalled ? "jammed" : this.state;
  }

  /**
   * Stall detection (§3.10, D23): pending packets and no delivery progress for `after`. Measured from the
   * latest of the last delivery or filter, start/resume, and the last moment nothing was pending. Fires once
   * per episode; a delivery ends it. Not checked while paused.
   */
  private checkStall() {
    const stall = this.pipeline.delivered?.stall;
    if (!stall || this.stopping || this.closed || this.state !== "active" || this.stalled) return;
    const now = Date.now();
    // Units waiting for an agent (D50) are pending, but the runner isn't moving them, so they don't make a stall.
    if (this.journal.countMoving() <= 0) {
      this.progressAt = now;
      return;
    }
    const stats = computeStats(this.journal, this._startedAt, now);
    const idle = now - this.progressAt;
    if (idle < parseDuration(stall.after)) return;
    const oldest = this.journal.oldestPending();
    const ctx = {
      stats,
      env: this.env,
      stall: {
        pending: stats.pending,
        duration: formatDuration(idle),
        oldest: {
          packet_id: oldest ? (oldest.row.root ?? oldest.row.id) : "",
          node: oldest?.row.cursor ?? "",
          age: oldest ? formatDuration(now - oldest.row.received_at) : "",
          attempt: oldest?.row.attempt ?? 0,
          last_error: oldest?.lastError ?? "",
        },
      },
    };
    const fallback = `Pipeline jammed: ${stats.pending} packet(s) pending and none delivered for ${formatDuration(idle)}.`;
    let message: string;
    try {
      message = stall.message ? String(renderString(stall.message, ctx)).trim() : fallback;
    } catch (e) {
      message = `${fallback} (stall.message could not be rendered: ${(e as Error).message})`;
    }
    message = this.secrets.redact(message);
    this.stalled = true;
    this.stallInfo = { node: ctx.stall.oldest.node, since: new Date(now).toISOString() };
    this.journal.event("pipeline.stall", { message, then: stall.then ?? "notify", stall: ctx.stall, stats });
    this.log("warn", message);
    this.writeRegistry();
    // `then: agent` flags the stall as `notify` does and tells the agent; `on_stall: handle` hands it the units (D50).
    const handle = this.pipeline.agent?.on_stall === "handle";
    if (stall.then === "agent" || handle) {
      const units = handle ? this.handOverStalled(message) : undefined;
      this.journal.event("pipeline.escalated", {
        reason: "stall",
        message,
        then: stall.then ?? "notify",
        handle,
        ...(units && { units }),
        stall: ctx.stall,
      });
      this.log(
        "warn",
        handle
          ? `stall handed to the agent: ${units?.escalated ?? 0} waiting unit(s) now, ${units?.marked ?? 0} at their next step`
          : "stall escalated to the agent",
      );
    }
    if (stall.then === "pause") this.pause("stall");
  }

  /** A delivery or filter is progress: restart the stall clock and clear a flagged stall. */
  private progress() {
    this.progressAt = Date.now();
    if (!this.stalled) return;
    this.stalled = false;
    this.stallInfo = null;
    this.journal.event("pipeline.unjammed");
    this.log("info", "no longer jammed: a packet reached the output again");
    this.writeRegistry();
  }

  /** Resolves when the packet is terminal (in-process, no polling); null if `ms` passes or the runner stops first. */
  private awaitTerminal(id: string, ms: number): Promise<Settled | null> {
    const row = this.journal.get(id);
    // Waiting for an agent (D50) has no end in sight, so a caller waiting for the result gets that state now.
    if (row && ((TERMINAL as readonly string[]).includes(row.state) || row.state === ESCALATED))
      return Promise.resolve({ state: row.state, error: row.error });
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), ms);
      const done = (s: Settled | null) => {
        clearTimeout(timer);
        const rest = (this.settleWaiters.get(id) ?? []).filter((w) => w !== done);
        if (rest.length) this.settleWaiters.set(id, rest);
        else this.settleWaiters.delete(id);
        resolve(s);
      };
      this.settleWaiters.set(id, [...(this.settleWaiters.get(id) ?? []), done]);
    });
  }

  private notifySettled(id: string, state: string, error?: PacketRow["error"]) {
    for (const w of this.settleWaiters.get(id) ?? []) w({ state, error });
  }

  private firstFailedRule(plan: Plan, data: unknown, ctx: Record<string, unknown>): Failure | null {
    const schemaError = plan.validateInput?.(data);
    if (schemaError) return { code: "input.schema", rule: "schema", message: `schema: ${schemaError}` };
    for (const rule of plan.pipeline.input.validate ?? []) {
      try {
        if (!evaluate(rule, ctx)) return { code: "input.invalid", rule, message: `rule '${rule}' failed` };
      } catch (e) {
        return {
          code: "input.invalid",
          rule,
          message: `rule '${rule}' could not be evaluated: ${(e as Error).message}`,
        };
      }
    }
    return null;
  }

  // ── processing ───────────────────────────────────────────────────────────────

  private wake(all = false) {
    const wakers = all ? this.wakers.splice(0) : this.wakers.splice(0, 1);
    for (const w of wakers) w();
  }

  private async work(): Promise<void> {
    while (this.state !== "stopped" && this.state !== "failed") {
      const id = this.holding ? undefined : this.queue.shift();
      if (!id) {
        await new Promise<void>((r) => this.wakers.push(r));
        continue;
      }
      this.busy++;
      try {
        await this.process(id);
      } catch (e) {
        // A bug, not a pipeline error: leave the packet where it is so it resumes on restart.
        this.log("error", `internal error on packet ${id}: ${(e as Error).stack ?? e}`);
      } finally {
        this.busy--;
      }
    }
  }

  private async process(id: string): Promise<void> {
    let row = this.journal.get(id);
    while (row?.cursor && this.state !== "stopped" && this.state !== "failed") {
      // Escalated (D50) or settled meanwhile: nothing to run.
      if (!(IN_FLIGHT as readonly string[]).includes(row.state)) return;
      const step = row.cursor;
      const stalled = this.handOver.get(id);
      if (stalled !== undefined) return this.escalate(id, step, this.stallEscalation(row, stalled));
      if (this.holding) return void this.held.push(id);
      const plan = await this.plan(row.version);
      if (step === BATCH_STEP) return this.batchFor(plan).add(row);
      const began = performance.now();
      const t =
        step === OUTPUT_STEP
          ? await this.writeStep(plan, row)
          : step === VERIFY_STEP
            ? plan.pipeline.delivered?.check === "external"
              ? this.awaitAck(plan, row)
              : await this.verifyStep(plan, row)
            : await this.nodeStep(plan, row, step);

      if (!t) return; // parked until its ack or deadline
      // A completed node or output step records how long it took, on the transition that completes it (D54).
      const ms = step === VERIFY_STEP ? undefined : performance.now() - began;
      if (t.kind === "escalate") return this.escalate(id, step, t);
      if (t.kind === "hold") return this.hold(id, step, t);
      if (t.kind === "end") return this.end(id, step, t, ms);
      if (t.kind === "split") return this.split(row, step, t, ms);
      const state =
        t.to === OUTPUT_STEP || t.to === BATCH_STEP ? "writing" : t.to === VERIFY_STEP ? "verifying" : "processing";
      this.journal.update(
        id,
        {
          state,
          cursor: t.to,
          data: t.data,
          // Joining a batch is not a step of its own: the flush counts the hop, as an unbatched write does.
          hops: t.to === BATCH_STEP ? row.hops : row.hops + 1,
          attempt: 0,
          ...(t.iteration !== undefined && { iteration: t.iteration }),
          ...(t.result !== undefined && { result: t.result }),
        },
        t.event,
        step,
        undefined,
        t.extra,
        ms,
      );
      // It moved on, so it is no longer stalled (D50).
      this.handOver.delete(id);
      row = this.journal.get(id);
    }
  }

  /** The copies a fan-out creates: one per consumer, branch path `<parent branch>/<consumer>` (D22). */
  private copies(parent: PacketRow, to: Cursor[], data: unknown, hops: number) {
    return to.map((cursor) => {
      const segment = cursor === OUTPUT_STEP ? "output" : cursor;
      const branch = parent.branch ? `${parent.branch}/${segment}` : segment;
      const state: PacketState = cursor === OUTPUT_STEP ? "writing" : "processing";
      return { id: `${parent.root ?? parent.id}:${branch}`, branch, state, cursor, data, hops };
    });
  }

  /** Commit a fan-out: the parent's step and every copy in one transaction, so a crash never splits it halfway. */
  private split(row: PacketRow, step: string, t: Extract<Transition, { kind: "split" }>, ms?: number) {
    this.handOver.delete(row.id);
    const copies = this.copies(row, t.to, t.data, row.hops + 1);
    this.journal.atomically(() => {
      this.journal.update(
        row.id,
        { state: BRANCHED, cursor: null, data: t.data, hops: row.hops + 1, attempt: 0 },
        "packet.fanned_out",
        step,
        { branches: copies.map((c) => c.branch) },
        [...(t.extra ?? []), { type: t.event }],
        ms,
      );
      this.journal.insertCopies(row, copies, step);
    });
    for (const c of copies) this.queue.push(c.id);
    this.wake(true);
  }

  private end(id: string, step: string, t: Extract<Transition, { kind: "end" }>, ms?: number) {
    this.handOver.delete(id);
    // A copy's end and the settling of the packet it belongs to commit together (D22).
    const settled = this.journal.atomically(() => {
      this.journal.update(
        id,
        { state: t.state, cursor: null, error: t.error ?? null },
        t.event,
        step,
        t.error ?? undefined,
        t.extra,
        ms,
      );
      return this.journal.settleAncestors(id);
    });
    if (t.state === "delivered" || t.state === "filtered") this.progress();
    this.notifySettled(id, t.state, t.error);
    for (const a of settled) this.notifySettled(a.id, a.state, a.error);
    this.checkLifetime();
    if (t.state === "dead_lettered") this.log("warn", `packet ${id} dead-lettered at ${step}: ${t.error?.message}`);
  }

  // ── agent hand-over (spec §3.9, §3.10, §9, D50) ──────────────────────────────

  /**
   * Hand a unit to the agent: one transaction commits state `escalated`, with the error and the cursor a retry resumes
   * at (the node; the output for an output, batch or delivery-check failure, which writes again, idempotently), and a
   * `packet.escalated` event. Nothing runs it again, in this run or after a restart, until `resolve`.
   */
  private escalate(id: string, step: string, t: Extract<Transition, { kind: "escalate" }>) {
    this.handOver.delete(id);
    const cursor = step === BATCH_STEP || step === VERIFY_STEP ? OUTPUT_STEP : step;
    crashPoint("escalate.prepared");
    this.journal.update(id, { state: ESCALATED, cursor, error: t.error }, "packet.escalated", step, {
      reason: t.reason,
      error: t.error,
      ...(t.stall !== undefined && { stall: t.stall }),
    });
    this.notifySettled(id, ESCALATED, t.error);
    this.log(
      "warn",
      `packet ${id} handed to the agent at ${t.error.node}${t.reason === "stall" ? " (stall)" : ""}: ${t.error.message}; it waits until it is resolved (retry, dead_letter or drop)`,
    );
  }

  /** The escalation of a unit a stall handed over (D50) at a point where no step of it failed. */
  private stallEscalation(row: PacketRow, message: string): Extract<Transition, { kind: "escalate" }> {
    const node =
      row.cursor === OUTPUT_STEP || row.cursor === BATCH_STEP
        ? "output"
        : row.cursor === VERIFY_STEP
          ? "delivered"
          : (row.cursor as string);
    return { kind: "escalate", reason: "stall", error: { code: "stall", message, node }, stall: message };
  }

  /**
   * `agent.on_stall: handle` (D50): every unit in flight when the stall fires goes to the agent. Units that wait (queued,
   * held, parked for an `external` ack) are taken out and escalated now, synchronously, so no worker picks one up in
   * between; a unit a worker or an output batch holds is marked and escalated at its next safe point (before its next
   * step or attempt, or when its current attempt fails). A marked unit that moves on first is not stalled any more.
   */
  private handOverStalled(message: string): { escalated: number; marked: number } {
    const queued = new Set(this.queue);
    const held = new Set(this.held);
    const now: PacketRow[] = [];
    let marked = 0;
    for (const row of this.journal.inFlight()) {
      if (queued.has(row.id) || held.has(row.id) || this.awaiting.has(row.id)) now.push(row);
      else if (!this.handOver.has(row.id)) {
        this.handOver.set(row.id, message);
        marked++;
      }
    }
    const taken = new Set(now.map((r) => r.id));
    const keep = (ids: string[]) => ids.filter((id) => !taken.has(id));
    this.queue.splice(0, this.queue.length, ...keep(this.queue));
    this.held.splice(0, this.held.length, ...keep(this.held));
    for (const id of taken) {
      const timer = this.awaiting.get(id);
      if (timer) clearTimeout(timer);
      this.awaiting.delete(id);
    }
    for (let i = 0; i < now.length; i += HANDOVER_CHUNK) {
      const chunk = now.slice(i, i + HANDOVER_CHUNK);
      this.journal.atomically(() => {
        for (const row of chunk) {
          const t = this.stallEscalation(row, message);
          const cursor = row.cursor === BATCH_STEP || row.cursor === VERIFY_STEP ? OUTPUT_STEP : row.cursor;
          this.journal.update(row.id, { state: ESCALATED, cursor, error: t.error }, "packet.escalated", row.cursor, {
            reason: "stall",
            error: t.error,
            stall: message,
          });
        }
      });
      for (const row of chunk) this.notifySettled(row.id, ESCALATED, this.stallEscalation(row, message).error);
    }
    return { escalated: now.length, marked };
  }

  /**
   * Resolve units waiting for the agent (D50), all or nothing: every id is checked, then one transaction commits each
   * unit's transition with a `packet.resolved` event. `retry` puts it back in flight where it stopped (on its pinned
   * version, `attempt` 0; a `loop.max` failure also resets `iteration`) and queues it once committed, so a crash
   * resumes it; `dead_letter` and `drop` end it (a fan-out copy settles its packet in the same transaction). `drop`
   * is refused at the output, as `then: drop` is (§3.9). An agent (`by_kind: agent`) needs `agent.control` in the
   * version in force.
   */
  resolve(
    ids: string[],
    action: ResolveAction,
    how: { by: string; by_kind?: "agent" | "human" | null; reason?: string | null },
  ): { action: ResolveAction; resolved: { packet_id: string; state: PacketState; node: string | null }[] } {
    const name = this.pipeline.name;
    if (this.state !== "active" && this.state !== "paused") {
      throw new ControlError(
        "invalid_state",
        `cannot resolve: pipeline is ${this.state}`,
        "resolve works while the pipeline is active or paused; start it again (pipo start)",
      );
    }
    if (how.by_kind === "agent" && !this.pipeline.agent?.control) {
      throw new ControlError(
        "invalid_state",
        `agents can't resolve packets of ${name}: agent.control is off in v${this.version}`,
        "a person can resolve them, or turn agent.control on in the pipeline file",
      );
    }
    for (const id of ids) {
      const row = this.journal.get(id);
      if (!row) {
        throw new ControlError(
          "not_found",
          `no packet '${id}' in ${name}`,
          `list the packets waiting for an agent: the packets op with state escalated (pipo packets ${name})`,
        );
      }
      if (row.state !== ESCALATED) {
        const waiting = this.journal
          .copies(row.root ?? row.id)
          .filter((c) => c.state === ESCALATED && (!row.root || c.id.startsWith(`${id}/`)));
        throw new ControlError(
          "invalid_state",
          `packet ${id} is ${row.state}, not waiting for an agent`,
          waiting.length
            ? `its copies wait on their own; resolve them by id: ${waiting.map((c) => c.id).join(", ")}`
            : `pipo inspect ${name} ${id} shows where it is`,
        );
      }
      if (action === "drop" && row.cursor === OUTPUT_STEP) {
        throw new ControlError(
          "invalid_state",
          `packet ${id} waits at the output, where drop is not allowed (spec §3.9)`,
          "retry it or dead_letter it",
        );
      }
    }
    const settled: { id: string; state: PacketState; error: PacketRow["error"] }[] = [];
    const resolved: { packet_id: string; state: PacketState; node: string | null }[] = [];
    this.journal.atomically(() => {
      for (const id of ids) {
        const row = this.journal.get(id) as PacketRow;
        if (row.state !== ESCALATED) {
          throw new ControlError("invalid_state", `packet ${id} was resolved meanwhile`, "nothing was resolved; retry");
        }
        // Free text from the caller: a secret pasted into it must never reach the journal.
        const detail = {
          action,
          by: this.secrets.redact(how.by),
          by_kind: how.by_kind ?? null,
          reason: how.reason == null ? null : this.secrets.redact(how.reason),
          error: row.error,
        };
        if (action === "retry") {
          const state: PacketState = row.cursor === OUTPUT_STEP ? "writing" : "processing";
          this.journal.update(
            id,
            { state, error: null, attempt: 0, ...(row.error?.code === "loop.max" && { iteration: 0 }) },
            "packet.resolved",
            row.cursor,
            detail,
          );
          resolved.push({ packet_id: id, state, node: row.cursor });
          continue;
        }
        const state: PacketState = action === "drop" ? "filtered" : "dead_lettered";
        this.journal.update(
          id,
          { state, cursor: null },
          action === "drop" ? "packet.dropped" : "packet.dead_lettered",
          row.cursor,
          row.error ?? undefined,
          [{ type: "packet.resolved", detail }],
        );
        settled.push({ id, state, error: row.error }, ...this.journal.settleAncestors(id));
        resolved.push({ packet_id: id, state, node: row.error?.node ?? null });
      }
    });
    crashPoint("resolve.committed");
    if (action === "retry") this.requeue(ids);
    for (const s of settled) this.notifySettled(s.id, s.state, s.error);
    if (action === "drop") this.progress();
    this.checkLifetime();
    this.log("info", `${how.by} resolved ${ids.length} packet(s) waiting for the agent: ${action}`);
    return { action, resolved };
  }

  private hold(id: string, step: string, t: Extract<Transition, { kind: "hold" }>) {
    this.journal.event(`packet.held`, { how: t.how, error: t.error }, id, step);
    if (t.how === "pause") {
      this.held.push(id);
      this.pause(t.reason ?? `error at ${step}`, t.detail);
    } else if (this.state !== "failed") {
      this.state = "failed";
      this.log("error", `halted by ${step}: ${t.error?.message}`);
      void this.stop();
    }
  }

  private async nodeStep(plan: Plan, row: PacketRow, id: string): Promise<Transition> {
    const emitted: Emitted = [];
    const t = await this.runNode(plan, row, id, emitted);
    return emitted.length && t.kind !== "hold" && t.kind !== "escalate" ? { ...t, extra: emitted } : t;
  }

  private async runNode(plan: Plan, row: PacketRow, id: string, emitted: Emitted): Promise<Transition> {
    const node = plan.pipeline.nodes?.[id] as Node;
    const kind = nodeKind(node);
    const policy = resolvePolicy(plan.pipeline.errors, node.on_error);
    // Filters and routes are deterministic: retrying them can't change the outcome.
    const effective = kind === "filter" || kind === "route" ? { ...policy, retry: 0 } : policy;

    const run = await attempt(
      effective,
      async (n) => {
        emitted.length = 0;
        const meta = this.meta(plan, row, id, n);
        const ctx = { data: row.data, meta, env: this.env };
        switch (kind) {
          case "filter":
            return { data: row.data, pass: !!evaluate(node.filter as string, ctx) };
          case "route": {
            for (const [branch, expr] of Object.entries(node.route ?? {})) {
              if (expr === "else" || evaluate(expr, ctx)) return { data: row.data, branch };
            }
            return { data: row.data, branch: undefined };
          }
          case "tap":
            await this.action(plan, node.tap as string, "tap", node, row, meta, emitted);
            return { data: row.data };
          case "transform": {
            const out = await this.action(plan, node.transform as string, "transform", node, row, meta, emitted);
            if (out === undefined) throw new Error(`${node.transform} returned nothing; return the new data`);
            return { data: out };
          }
          case "agent":
            return { data: await this.agentCall(plan, node, row, id, meta, n) };
          default:
            throw new Error(`node kind '${kind}' is not implemented`);
        }
      },
      (err, n, wait) => this.retrying(row, id, err, n, wait),
      () => this.handOver.has(row.id),
    );

    if (!run.ok && run.error instanceof BudgetStop) {
      const failure = { code: `budget.${run.error.kind}`, message: run.error.message, attempts: run.attempts };
      if (run.error.kind === "day") {
        // The packet waits at this node; the pause resumes it when the next budget day opens (§3.11).
        const error = { code: failure.code, message: this.secrets.redact(failure.message), node: id, attempts: 1 };
        return {
          kind: "hold",
          how: "pause",
          error,
          reason: "budget",
          detail: { ...run.error.detail, message: error.message },
        };
      }
      // Per-packet cap: dead-lettered whatever `on_error.then` says (§3.11).
      return this.fail(plan, row, id, { ...policy, then: "dead_letter" }, failure);
    }
    if (!run.ok) {
      const failure = {
        code: "node.failed",
        message: run.error.message,
        error: run.error,
        attempts: run.attempts,
        elapsed: run.elapsed,
      };
      if (policy.then === "continue" && kind === "tap")
        return this.advance(plan, id, row.data, "node.failed_continued");
      return this.fail(plan, row, id, policy, failure);
    }
    const value = run.value as { data: unknown; pass?: boolean; branch?: string };
    if (value.pass === false) return { kind: "end", state: "filtered", event: "packet.filtered" };

    if (node.loop) {
      const meta = this.meta(plan, row, id);
      if (!evaluate(node.loop.until, { data: value.data, meta, env: this.env })) {
        if (row.iteration < node.loop.max) {
          return {
            kind: "move",
            to: node.loop.back_to,
            data: value.data,
            iteration: row.iteration + 1,
            event: "node.looped",
          };
        }
        const loopPolicy = { ...policy, then: node.loop.then ?? "dead_letter" };
        return this.fail(
          plan,
          row,
          id,
          loopPolicy,
          { code: "loop.max", message: `loop reached max ${node.loop.max} without '${node.loop.until}'` },
          value.data,
        );
      }
    }
    if (kind === "route") {
      if (!value.branch) return { kind: "end", state: "filtered", event: "packet.filtered" };
      return this.advance(plan, `${id}.${value.branch}`, value.data, "node.done");
    }
    return this.advance(plan, id, value.data, "node.done");
  }

  /**
   * One agent call (§3.4, §3.11, D36): budget checks, the rendered prompt to the provider under `timeout`, the usage
   * journaled as soon as the provider reports it (before the output is checked, so paid calls always count), then the
   * output checked against `with.schema`. A mismatch, a timeout or a provider error is a node error under `on_error`;
   * a budget limit throws BudgetStop, which is never retried.
   */
  private async agentCall(
    plan: Plan,
    node: Node,
    row: PacketRow,
    id: string,
    meta: Record<string, unknown>,
    attemptNo: number,
  ): Promise<unknown> {
    const name = node.agent as string;
    const provider = this.agents.providers.get(name);
    if (!provider) throw new Error(`agent provider '${name}' is not available`);
    const root = row.root ?? row.id;
    const perPacket = plan.pipeline.agent_budget?.per_packet;
    this.budget.checkDay();
    const used = this.budget.checkPacket(root, perPacket);

    const w = render(node.with ?? {}, { data: row.data, meta, env: this.env, secrets: this.secrets.values }) as Record<
      string,
      unknown
    >;
    const manifest = AGENTS[name];
    const cli = manifest?.runs === "cli";
    // A CLI agent without a model uses the CLI's own default (D67).
    const model = w.model === undefined || w.model === null ? "" : String(w.model);
    const price = priceFor(this.agents.pricing[name] ?? {}, model);
    if (!price && !cli)
      throw new Error(`no price for model '${model}'; add agents.${name}.pricing.${model} to config.yaml`);
    const timeout = parseDuration(String(w.timeout ?? manifest?.timeout ?? AGENT_TIMEOUT));
    let cwd: string | undefined;
    if (cli && w.cwd !== undefined) {
      cwd = resolve(dirname(this.opts.file), String(w.cwd));
      if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
        throw new Error(`with.cwd: ${cwd} is not a folder; create it, or leave cwd out to run in a fresh empty folder`);
    }
    const configured = Number(w.max_tokens ?? AGENT_MAX_TOKENS);
    // Never ask for more output than the packet has left (§3.11).
    const maxTokens = perPacket === undefined ? configured : Math.max(1, Math.min(configured, perPacket - used));
    const schema = plan.agentSchemas[id] as Plan["agentSchemas"][string];

    // A cost the provider reports wins; else tokens are priced, and a CLI agent with no known price counts $0 (D67).
    const record = (input: number, output: number, reported?: number) => {
      const cost = reported ?? (price ? costOf(price, input, output) : 0);
      this.journal.recordAgentUsage({
        at: this.clock.now(),
        unit: row.id,
        root,
        node: id,
        provider: name,
        model,
        input_tokens: input,
        output_tokens: output,
        cost_usd: cost,
        attempt: attemptNo,
      });
      const warning = this.budget.warning();
      if (warning) {
        this.journal.event("budget.warning", warning);
        this.log("warn", String(warning.message));
      }
      return used + input + output;
    };

    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctl.abort();
        reject(new Error(`agent call timed out after ${formatDuration(timeout)} (with.timeout)`));
      }, timeout);
    });
    let result: Awaited<ReturnType<typeof provider.complete>>;
    try {
      result = await Promise.race([
        provider.complete({
          model,
          prompt: String(w.prompt),
          schema: schema.schema,
          max_tokens: maxTokens,
          signal: ctl.signal,
          ...(cli && { cwd, allow_tools: w.allow_tools === true }),
        }),
        timedOut,
      ]);
    } catch (e) {
      if (e instanceof AgentCallError && e.usage) {
        const total = record(e.usage.input_tokens, e.usage.output_tokens, e.usage.cost_usd);
        if (perPacket !== undefined && total > perPacket) throw packetStop(total, perPacket);
      }
      throw new Error(this.secrets.redact((e as Error).message));
    } finally {
      clearTimeout(timer);
    }
    const total = record(result.input_tokens, result.output_tokens, result.cost_usd);
    if (perPacket !== undefined && total > perPacket) throw packetStop(total, perPacket);
    const mismatch = schema.validate(result.output);
    if (mismatch) throw new Error(`agent output does not match ${schema.path}: ${this.secrets.redact(mismatch)}`);
    return result.output;
  }

  /** Hand the result to whatever consumes `ref`: nothing (filtered), one step, or several (a fan-out). */
  private advance(plan: Plan, ref: string, data: unknown, event: string): Transition {
    const to = plan.next.get(ref) ?? [];
    if (!to.length) return { kind: "end", state: "filtered", event: "packet.filtered" };
    if (to.length > 1) return { kind: "split", to, data, event };
    return { kind: "move", to: to[0] as string, data, event };
  }

  private async action(
    plan: Plan,
    action: string,
    kind: "tap" | "transform",
    node: Node,
    row: PacketRow,
    meta: Record<string, unknown>,
    emitted: Emitted,
  ) {
    const data = row.data;
    const fn = plan.fns[action];
    if (fn) return await fn(data, meta);
    const w = render(node.with ?? {}, { data, meta, env: this.env, secrets: this.secrets.values }) as Record<
      string,
      unknown
    >;
    if (kind === "tap" && action === "log") {
      const message = w.message === undefined ? JSON.stringify(data) : String(w.message);
      this.log((w.level as string) ?? "info", message);
      this.journal.event(
        "log",
        { level: w.level ?? "info", message: this.secrets.redact(message) },
        row.id,
        meta.node as string,
      );
      return undefined;
    }
    if (kind === "transform" && action === "map") return w.data;
    const factories = kind === "tap" ? tapFactories : transformFactories;
    const factory = factories[action];
    if (!factory) throw new Error(`${kind} '${action}' is not implemented`);
    let adapter = this.steps.get(`${kind}:${action}`);
    if (!adapter) {
      adapter = factory({
        pipeline: this.pipeline,
        dir: this.dir,
        log: (l, m) => this.log(l, m),
        with: {},
        home: this.home,
        bots: this.bots,
        redact: (t) => this.secrets.redact(t),
      });
      this.steps.set(`${kind}:${action}`, adapter);
    }
    try {
      // Step keys use the journal unit, so a branch copy's key is `<packet_id>:<branch>:<node>` (D16, D22).
      const res = await adapter.run({
        packetId: row.id,
        node: meta.node as string,
        data,
        with: w,
        origin: { trigger: row.trigger, source: row.source },
      });
      for (const e of res.events ?? []) {
        emitted.push({
          type: e.type,
          detail: e.detail === undefined ? undefined : JSON.parse(this.secrets.redact(JSON.stringify(e.detail))),
        });
      }
      return kind === "transform" ? res.data : undefined;
    } catch (e) {
      throw new Error(this.secrets.redact((e as Error).message));
    }
  }

  private async writeStep(plan: Plan, row: PacketRow): Promise<Transition> {
    const out = plan.pipeline.output;
    const meta = this.meta(plan, row, "output");
    const ctx = { data: row.data, meta, env: this.env, output: out };
    for (const rule of out.validate ?? []) {
      let ok = false;
      let why = `rule '${rule}' failed`;
      try {
        ok = !!evaluate(rule, ctx);
      } catch (e) {
        why = `rule '${rule}' could not be evaluated: ${(e as Error).message}`;
      }
      if (!ok) {
        const policy = {
          ...resolvePolicy(undefined, undefined),
          then: out.on_invalid?.then ?? "dead_letter",
          message: out.on_invalid?.message,
        };
        return this.fail(plan, row, "output", policy, { code: "output.invalid", rule, message: why });
      }
    }
    // Only packets that passed validation join a batch (spec §3.5.1); the flush writes them.
    if (out.batch) return { kind: "move", to: BATCH_STEP, data: row.data, event: "output.batched" };
    const policy = resolvePolicy(plan.pipeline.errors, out.on_error);
    const run = await attempt(
      policy,
      async (n) => {
        const item = this.writeItem(plan, row, n);
        const [result] = await this.output.write([item]);
        return result;
      },
      (err, n, wait) => this.retrying(row, "output", err, n, wait),
      () => this.handOver.has(row.id),
    );
    if (!run.ok) {
      return this.fail(plan, row, "output", policy, {
        code: "output.failed",
        message: run.error.message,
        error: run.error,
        attempts: run.attempts,
        elapsed: run.elapsed,
      });
    }
    return { kind: "move", to: VERIFY_STEP, data: row.data, result: run.value ?? null, event: "output.written" };
  }

  // ── output batches (spec §3.5.1, D20) ────────────────────────────────────────

  private batchFor(plan: Plan): Batch {
    let batch = this.batches.get(plan.version);
    if (!batch) {
      const cfg = plan.pipeline.output.batch as { size: number; within?: string };
      batch = new Batch(
        cfg.size,
        parseDuration(cfg.within ?? DEFAULT_BATCH_WITHIN),
        (rows) => this.flushGroup(plan, resolvePolicy(plan.pipeline.errors, plan.pipeline.output.on_error), rows),
        (e) => this.log("error", `internal error flushing a batch: ${(e as Error).stack ?? e}`),
      );
      this.batches.set(plan.version, batch);
    }
    return batch;
  }

  private flushBatches(): Promise<void> {
    return Promise.all([...this.batches.values()].map((b) => b.flush())).then(() => undefined);
  }

  private batched(): number {
    let n = 0;
    for (const b of this.batches.values()) n += b.count;
    return n;
  }

  /**
   * One flush is one write of every packet in `rows`, retried under `on_error`. When the retries run
   * out the group is split in half and each half flushed the same way, down to single packets, so
   * only the packets that still fail get the policy's final action. Each successful write commits
   * all of its packets' transitions in one journal transaction; until then they stay at `$batch`
   * and a crash writes them again (outputs are idempotent on their key).
   */
  private async flushGroup(plan: Plan, policy: ResolvedPolicy, rows: PacketRow[]): Promise<void> {
    if (this.closed || !rows.length) return;
    const batch = this.batchFor(plan);
    const began = performance.now();
    const run = await attempt(
      policy,
      (n) => this.output.write(rows.map((row) => this.writeItem(plan, row, n))),
      (err, n, wait) => this.retryingBatch(rows, err, n, wait),
      // A unit a stall handed over (D50) ends the group's retries, so the split isolates it.
      () => this.closed || rows.some((r) => this.handOver.has(r.id)),
    );
    if (this.closed) return;
    // The output's latency for a batched packet is its group's write, retries included (D54).
    const ms = performance.now() - began;
    if (run.ok) {
      for (const row of rows) this.handOver.delete(row.id);
      this.journal.atomically(() => {
        rows.forEach((row, i) => {
          this.journal.update(
            row.id,
            { state: "verifying", cursor: VERIFY_STEP, hops: row.hops + 1, attempt: 0, result: run.value[i] ?? null },
            "output.written",
            OUTPUT_STEP,
            { batch: rows.length },
            [],
            ms,
          );
        });
      });
      for (const row of rows) {
        batch.release(row.id);
        this.queue.push(row.id);
      }
      this.wake(true);
      return;
    }
    const failure: Failure = {
      code: "output.failed",
      message: run.error.message,
      error: run.error,
      attempts: run.attempts,
      elapsed: run.elapsed,
    };
    if (rows.length === 1) {
      const row = rows[0] as PacketRow;
      const t = this.fail(plan, row, "output", policy, failure);
      batch.release(row.id);
      if (t.kind === "hold") this.hold(row.id, OUTPUT_STEP, t);
      else if (t.kind === "end") this.end(row.id, OUTPUT_STEP, t, ms);
      else if (t.kind === "escalate") this.escalate(row.id, OUTPUT_STEP, t);
      return;
    }
    const half = Math.ceil(rows.length / 2);
    const message = this.secrets.redact(run.error.message);
    this.journal.event("output.batch_split", { size: rows.length, into: [half, rows.length - half], error: message });
    this.log(
      "warn",
      `batch of ${rows.length} failed at output after ${run.attempts} attempt(s): ${message}; splitting it to isolate the failing packet(s)`,
    );
    await this.flushGroup(plan, policy, rows.slice(0, half));
    await this.flushGroup(plan, policy, rows.slice(half));
  }

  private retryingBatch(rows: PacketRow[], err: Error, n: number, wait: number) {
    if (this.closed) return;
    const message = this.secrets.redact(err.message);
    this.journal.atomically(() => {
      for (const row of rows) {
        this.journal.update(row.id, { attempt: n }, "step.retry", "output", {
          attempt: n,
          wait,
          error: message,
          batch: rows.length,
        });
      }
    });
    this.log(
      "warn",
      `batch of ${rows.length} failed at output (attempt ${n}): ${message}; retrying in ${formatDuration(wait)}`,
    );
  }

  private async verifyStep(plan: Plan, row: PacketRow): Promise<Transition> {
    const delivered = plan.pipeline.delivered;
    const check = delivered?.check ?? "ack";
    if (check === "ack" || check === "none") return { kind: "end", state: "delivered", event: "packet.delivered" };

    const item = this.writeItem(plan, row);
    const meta = this.meta(plan, row, "delivered");
    const checkWith = render(delivered?.with ?? {}, {
      data: row.data,
      meta,
      env: this.env,
      secrets: this.secrets.values,
      output: plan.pipeline.output,
      result: row.result,
    }) as Record<string, unknown>;
    const within = parseDuration(delivered?.within ?? "10s");
    const started = Date.now();
    let lastError: Error | undefined;
    let checks = 0;
    do {
      checks++;
      try {
        if (await this.output.verify(check, checkWith, item, row.result)) {
          return { kind: "end", state: "delivered", event: "packet.delivered" };
        }
      } catch (e) {
        lastError = e as Error;
      }
      if (Date.now() - started >= within) break;
      await Bun.sleep(Math.min(250, within));
    } while (this.state !== "stopped" && !this.handOver.has(row.id));
    const elapsed = Date.now() - started;
    const policy = resolvePolicy(undefined, delivered?.on_fail);
    const message = lastError
      ? `delivery check '${check}' errored: ${lastError.message}`
      : `delivery check '${check}' did not pass after ${checks} checks over ${formatDuration(elapsed)}`;
    return this.fail(plan, row, "delivered", policy, {
      code: "delivery.unverified",
      message,
      attempts: checks,
      elapsed,
    });
  }

  // ── external acknowledgement (spec §3.10, D24) ───────────────────────────────

  /**
   * The `external` check: deliver once a `packet.acked` event exists; otherwise park the packet, freeing its
   * worker, until `ack()` or the deadline wakes it. The deadline lives in the journal (`delivery.awaiting_ack`),
   * counted from `output.written`, so a restarted runner keeps the remaining time; after a hold (`on_fail:
   * pause`/`halt`) a new window starts. Synchronous from the ack lookup to parking, so an ack can't slip between.
   */
  private awaitAck(plan: Plan, row: PacketRow): Transition | undefined {
    if (this.journal.latestEvent(row.id, ["packet.acked"])) {
      return { kind: "end", state: "delivered", event: "packet.delivered" };
    }
    const delivered = plan.pipeline.delivered;
    const within = parseDuration(delivered?.within ?? "10s");
    const mark = this.journal.latestEvent(row.id, ["output.written", "packet.held", "delivery.awaiting_ack"]);
    let deadline: number;
    let since: number;
    if (mark?.type === "delivery.awaiting_ack") {
      ({ deadline, since } = mark.detail as { deadline: number; since: number });
    } else {
      since = mark?.type === "output.written" ? mark.at : Date.now();
      deadline = since + within;
      this.journal.event(
        "delivery.awaiting_ack",
        { deadline, since, until: new Date(deadline).toISOString() },
        row.id,
        VERIFY_STEP,
      );
    }
    const left = deadline - Date.now();
    if (left > 0) {
      // setTimeout can't wait longer than ~24.8 days; a longer wait wakes early and parks again.
      this.awaiting.set(
        row.id,
        setTimeout(() => this.unpark(row.id), Math.min(left, 2 ** 31 - 1)),
      );
      return undefined;
    }
    return this.fail(plan, row, "delivered", resolvePolicy(undefined, delivered?.on_fail), {
      code: "delivery.unverified",
      message: `delivery check 'external' got no ack within ${formatDuration(within)}`,
      attempts: 1,
      elapsed: Date.now() - since,
    });
  }

  /** Process units a DLQ replay put back in flight (D33); their transition is already committed. */
  requeue(ids: string[]): void {
    this.queue.push(...ids);
    this.wake(true);
  }

  private unpark(id: string) {
    const timer = this.awaiting.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.awaiting.delete(id);
    this.queue.unshift(id);
    this.wake();
  }

  /**
   * Record an outside acknowledgement for a journal unit (the output's key: `packet_id`, or `packet_id:<branch>`
   * for a fan-out copy). The `packet.acked` event is committed before this returns, so the ack survives a crash;
   * the packet then delivers as soon as it is (or once it gets) to `$verify`. Repeating an ack is harmless.
   */
  async ack(id: string, by = "control"): Promise<{ packet_id: string; state: string; acked: true; already: boolean }> {
    const found = this.journal.get(id);
    if (!found) {
      throw new ControlError(
        "not_found",
        `no packet '${id}' in ${this.pipeline.name}`,
        "use the packet id from the push or http reply; a fan-out copy is acked by its output key <packet_id>:<branch>",
      );
    }
    // Descendant copies: every copy of a packet, or the copies nested under a copy (`<id>/…`).
    const descendants = this.journal
      .copies(found.root ?? found.id)
      .filter((c) => !found.root || c.id.startsWith(`${id}/`));
    if (found.state === BRANCHED || descendants.length) {
      const copies = descendants.map((c) => `${c.id} (${c.state})`);
      throw new ControlError(
        "invalid_state",
        `packet ${id} fanned out into ${copies.length} copies; each copy is acked on its own`,
        `ack the copies by their output key: ${copies.join(", ")}`,
      );
    }
    const plan = await this.plan(found.version);
    const check = plan.pipeline.delivered?.check ?? "ack";
    if (check !== "external") {
      throw new ControlError(
        "invalid_state",
        `packet ${id} does not wait for an ack: delivered.check is '${check}' in version ${found.version}`,
        "only pipelines with delivered.check: external take acks",
      );
    }
    if (this.closed) throw new ControlError("unavailable", `pipeline is ${this.state}`, "try again once it runs");
    // Re-read after the await: the packet may have moved on meanwhile.
    const row = this.journal.get(id) as PacketRow;
    if (row.state === "delivered") return { packet_id: id, state: row.state, acked: true, already: true };
    if ((TERMINAL as readonly string[]).includes(row.state)) {
      throw new ControlError(
        "invalid_state",
        `packet ${id} is ${row.state}${row.error ? `: ${row.error.message}` : ""}; it no longer waits for an ack`,
        row.state === "dead_lettered"
          ? "the ack came after delivered.within; replay the packet from the dead-letter queue"
          : "nothing to acknowledge",
      );
    }
    const already = !!this.journal.latestEvent(id, ["packet.acked"]);
    if (!already) this.journal.event("packet.acked", { by }, id, VERIFY_STEP);
    this.unpark(id);
    return { packet_id: id, state: row.state, acked: true, already };
  }

  private writeItem(plan: Plan, row: PacketRow, attemptNo = 1): WriteItem {
    const meta = this.meta(plan, row, "output", attemptNo);
    const w = render(plan.pipeline.output.with ?? {}, {
      data: row.data,
      meta,
      env: this.env,
      secrets: this.secrets.values,
    }) as Record<string, unknown>;
    // The journal unit is the default idempotency key: `packet_id`, or `packet_id:<branch>` for a copy (D22).
    return { packetId: row.id, data: row.data, with: w, origin: { trigger: row.trigger, source: row.source } };
  }

  /** Apply a policy's final action to a failed step. */
  private fail(
    plan: Plan,
    row: PacketRow,
    step: string,
    policy: ResolvedPolicy,
    f: Failure,
    data = row.data,
  ): Transition {
    const meta = this.meta(plan, row, step);
    const errorCtx = {
      message: f.message,
      code: f.code,
      rule: f.rule,
      node: step,
      attempts: f.attempts ?? 1,
      elapsed: formatDuration(f.elapsed ?? 0),
    };
    const message = this.message(
      policy.message,
      { data, meta, env: this.env, output: plan.pipeline.output, result: row.result, error: errorCtx },
      f.message,
    );
    const error = { code: f.code, message, node: step, attempts: f.attempts ?? 1 };
    // A unit a stall handed over goes to the agent whatever its policy says, except past its token cap (§3.11, D50).
    const stalled = this.handOver.get(row.id);
    if (stalled !== undefined && f.code !== "budget.packet")
      return { kind: "escalate", reason: "stall", error, stall: stalled };
    switch (policy.then) {
      case "agent":
        return { kind: "escalate", reason: "error", error };
      case "drop":
        return { kind: "end", state: "filtered", error, event: "packet.dropped" };
      case "pause":
        return { kind: "hold", how: "pause", error };
      case "halt":
        return { kind: "hold", how: "halt", error };
      default:
        return { kind: "end", state: "dead_lettered", error, event: "packet.dead_lettered" };
    }
  }

  private retrying(row: PacketRow, step: string, err: Error, n: number, wait: number) {
    const message = this.secrets.redact(err.message);
    this.journal.update(row.id, { attempt: n }, "step.retry", step, { attempt: n, wait, error: message });
    this.log(
      "warn",
      `packet ${row.id} failed at ${step} (attempt ${n}): ${message}; retrying in ${formatDuration(wait)}`,
    );
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private plan(version: number): Promise<Plan> {
    let plan = this.plans.get(version);
    if (!plan) {
      // A packet accepted by an older version finishes on that version's definition.
      const source = this.journal.versionSource(version);
      plan = compile(load(source).value as Pipeline, version, this.dir);
      this.plans.set(version, plan);
    }
    return plan;
  }

  private meta(
    plan: Plan,
    row: Pick<PacketRow, "id" | "trigger" | "source" | "received_at"> & Partial<PacketRow>,
    node: string,
    attemptNo = 1,
  ) {
    const meta = {
      packet_id: row.root ?? row.id,
      branch: row.branch ?? "",
      pipeline: plan.pipeline.name,
      version: plan.version,
      node,
      trigger: row.trigger,
      source: row.source,
      received_at: row.received_at,
      attempt: attemptNo,
      hops: row.hops ?? 0,
      iteration: row.iteration ?? 0,
      key: row.id,
    };
    // At the output and the delivery check, `meta.key` is what the output writes with, an explicit key included (D55).
    if (node === "output" || node === "delivered")
      meta.key = resolveKey(plan.pipeline.output, row.id, {
        data: row.data,
        meta,
        env: this.env,
        secrets: this.secrets.values,
      });
    return meta;
  }

  /** Render a policy message; fall back to the raw error if the template itself fails. Always redacted. */
  private message(template: string | undefined, ctx: Record<string, unknown>, fallback: string): string {
    let text = fallback;
    if (template) {
      try {
        text = String(renderString(template, ctx)).trim();
      } catch (e) {
        text = `${fallback} (message template failed: ${(e as Error).message})`;
      }
    }
    return this.secrets.redact(text);
  }

  private makeInput(): InputAdapter {
    const p = this.pipeline;
    const factory = inputFactories[p.input.via];
    if (!factory) throw new StartError(`no implementation for input '${p.input.via}'`);
    const ctx: ConnectorContext = {
      pipeline: p,
      dir: this.dir,
      log: (level, message) => this.log(level, message),
      clock: this.opts.clock,
      listen: this.opts.listen,
      hostname: this.opts.hostname,
      with: render((p.input.with ?? {}) as Record<string, any>, { env: this.env, secrets: this.secrets.values }),
      home: this.home,
      bots: this.bots,
    };
    try {
      return factory(ctx);
    } catch (e) {
      if (e instanceof ConnectorError) throw new StartError(e.message);
      throw e;
    }
  }

  private writeRegistry() {
    if (this.stopping) return;
    mkdirSync(dirname(this.registryPath), { recursive: true });
    const entry = {
      pipeline: this.pipeline.name,
      version: this.version,
      pid: process.pid,
      file: resolve(this.opts.file),
      socket: this.socket,
      listen: this.port ?? null,
      ...(this.pollsBot && { telegram_bot: this.pollsBot }),
      detached: this.opts.detached ?? false,
      ...(this.opts.ttl && { ttl: this.opts.ttl }),
      state: this.status,
      started_at: new Date(this._startedAt).toISOString(),
      proc_start: procStart(),
      ...(this.opts.engineId && { engine_id: this.opts.engineId }),
    };
    writeFileSync(`${this.registryPath}.tmp`, JSON.stringify(entry, null, 2));
    // Atomic replace so readers never see a half-written entry.
    renameSync(`${this.registryPath}.tmp`, this.registryPath);
  }

  /** Secret values in `text` replaced (Secrets.redact), for control ops that journal caller text. */
  redact(text: string): string {
    return this.secrets.redact(text);
  }

  log(level: string, message: string) {
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${this.pipeline.name}] ${this.secrets.redact(message)}`;
    (this.opts.log ?? console.log)(line);
  }
}

/** Another live runner of the home whose input polls telegram bot `id` (its registry entry's `telegram_bot`). */
function botPoller(home: string, self: string, id: string): { name: string; pid: number } | null {
  const dir = join(home, "run");
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f === `${self}.json` || f === "engine.json") continue;
    const path = join(dir, f);
    const e = readRegistry(path) as ({ pid: number; telegram_bot?: string } & Liveness) | null;
    if (e?.telegram_bot === id && (Runner.isActive(path) || entryAlive(e))) return { name: f.slice(0, -5), pid: e.pid };
  }
  return null;
}

function readRegistry(path: string): { pid: number } | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
