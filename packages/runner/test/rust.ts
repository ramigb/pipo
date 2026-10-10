// End-to-end harness for the Rust runner binary (docs/rust-runner.md): start it the way the engine does, find it
// through its registry entry (never stdout), drive it over its control socket, and read its journal read-only.
// Output goes to log files, never pipes: awaiting a pipe inside `bun test` sometimes never wakes up.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, type PacketRow } from "../src";
import { runnerBinary, runnerEnv } from "../src/binary";
import { waitFor } from "./helpers";

const TERMINAL = ["delivered", "filtered", "dead_lettered", "rejected"];

export interface StartOptions {
  /** Extra runner arguments; `--listen 0` is added for an http input unless `listen` is null. */
  args?: string[];
  listen?: number | null;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export class RustRunner {
  private constructor(
    readonly proc: ReturnType<typeof Bun.spawn>,
    readonly name: string,
    readonly home: string,
    readonly log: string,
    readonly port: number | null,
    readonly client: ControlClient,
  ) {}

  /** Start `file` and wait until its registry entry names this process and its socket answers `hello`. */
  static async start(box: { root: string; home: string }, file: string, name: string, o: StartOptions = {}) {
    const log = join(box.root, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.log`);
    const listen = o.listen === undefined ? ["--listen", "0"] : o.listen === null ? [] : ["--listen", String(o.listen)];
    const proc = Bun.spawn([runnerBinary(), file, "--home", box.home, ...listen, ...(o.args ?? [])], {
      stdout: Bun.file(log),
      stderr: Bun.file(`${log}.err`),
      env: runnerEnv(o.env),
    });
    const registry = join(box.home, "run", `${name}.json`);
    const entry = await waitFor<{ listen: number | null; socket: string } | null>(
      () => {
        if (proc.exitCode !== null) {
          const err = existsSync(`${log}.err`) ? readFileSync(`${log}.err`, "utf8") : "";
          throw new Error(`runner exited (${proc.exitCode}):\n${err}`);
        }
        if (!existsSync(registry)) return null;
        const e = JSON.parse(readFileSync(registry, "utf8"));
        return e.pid === proc.pid ? (e as { listen: number | null; socket: string }) : null;
      },
      o.timeoutMs ?? 15_000,
      `${name} runner registry entry`,
    ).catch((e) => {
      const kids = Bun.spawnSync(["ps", "--ppid", String(proc.pid), "-o", "pid=,etimes=,args="]).stdout.toString();
      // Never leave a runner behind when its start is given up on.
      proc.kill("SIGKILL");
      throw new Error(`${(e as Error).message}\nchildren:\n${kids}\nstderr: ${readFileSync(`${log}.err`, "utf8")}`);
    });
    const client = await ControlClient.connect(entry.socket);
    return new RustRunner(proc, name, box.home, log, entry.listen, client);
  }

  /** Start a file that must fail to start; resolves with the exit code and stderr. */
  static async refuse(box: { root: string; home: string }, file: string, o: StartOptions = {}) {
    const log = join(box.root, `refused-${Date.now()}.log`);
    const proc = Bun.spawn([runnerBinary(), file, "--home", box.home, ...(o.args ?? [])], {
      stdout: Bun.file(log),
      stderr: Bun.file(`${log}.err`),
      env: runnerEnv(o.env),
    });
    const code = await proc.exited;
    return { code, stderr: readFileSync(`${log}.err`, "utf8"), stdout: readFileSync(log, "utf8") };
  }

  get pid(): number {
    return this.proc.pid;
  }

  get journalPath(): string {
    return join(this.home, "pipelines", this.name, "journal.db");
  }

  /** Lines the runner logged so far (its stdout). */
  lines(): string[] {
    return existsSync(this.log) ? readFileSync(this.log, "utf8").split("\n").filter(Boolean) : [];
  }

  stderr(): string {
    return existsSync(`${this.log}.err`) ? readFileSync(`${this.log}.err`, "utf8") : "";
  }

  request<T = any>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.client.request<T>(op, args);
  }

  push(data: unknown, source = "test"): Promise<{ packet_id: string; state: string }> {
    return this.request("push", { data, source });
  }

  url(path = ""): string {
    return `http://127.0.0.1:${this.port}/in/${this.name}${path}`;
  }

  post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(this.url(path), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  /** Run a read query on the journal (read-only, short-lived connection). */
  query<T = any>(sql: string, ...params: (string | number | null)[]): T[] {
    const db = new Database(this.journalPath, { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      return db.query(sql).all(...params) as T[];
    } finally {
      db.close();
    }
  }

  packet(id: string): PacketRow | null {
    const [r] = this.query<Record<string, unknown>>("SELECT * FROM packets WHERE id = ?", id);
    if (!r) return null;
    const un = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(String(v)));
    return {
      ...(r as unknown as PacketRow),
      data: un(r.data),
      error: un(r.error) as PacketRow["error"],
      result: un(r.result),
    };
  }

  events(id: string): { type: string; node: string | null; detail: unknown }[] {
    return this.query<{ type: string; node: string | null; detail: string | null }>(
      "SELECT type, node, detail FROM events WHERE packet_id = ? ORDER BY seq",
      id,
    ).map((e) => ({ ...e, detail: e.detail === null ? null : JSON.parse(e.detail) }));
  }

  /** Wait until a packet reaches a terminal state and return it. */
  async settled(id: string, timeoutMs = 4000): Promise<PacketRow> {
    try {
      return await waitFor(
        () => {
          const row = this.packet(id);
          return row && TERMINAL.includes(row.state) ? row : null;
        },
        timeoutMs,
        `packet ${id} to settle`,
      );
    } catch (e) {
      const trail = this.query("SELECT packet_id, type, node, at FROM events ORDER BY seq");
      throw new Error(
        `${(e as Error).message}\nrow: ${JSON.stringify(this.packet(id))}\nevents: ${JSON.stringify(trail)}\nlog:\n${this.lines().join("\n")}\n${this.stderr()}`,
      );
    }
  }

  status(): Promise<Record<string, any>> {
    return this.request("status");
  }

  /** SIGTERM (drain), then the exit code. */
  async stop(): Promise<number> {
    this.client.close();
    if (this.proc.exitCode === null) this.proc.kill("SIGTERM");
    return await this.proc.exited;
  }

  kill(): Promise<number> {
    this.client.close();
    this.proc.kill("SIGKILL");
    return this.proc.exited;
  }
}
