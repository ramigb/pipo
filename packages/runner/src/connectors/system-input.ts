// `via: system` (docs/spec.md §3.3, §7.4). The runner samples the operating system every `every`
// and hands each sample to the intake, which journals it before the next sample is armed.
// A metric the platform can't provide (battery on a server, network without /proc) is null.
import { readdirSync, readFileSync, statfsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { formatDuration, parseDuration } from "@pipo/spec";
import type { Clock } from "./schedule-input";
import type { InputAdapter, Intake } from "./types";

export const SYSTEM_METRICS = ["cpu", "memory", "disk", "battery", "network"] as const;
export type SystemMetric = (typeof SYSTEM_METRICS)[number];
export type Sampler = (metrics: SystemMetric[]) => Promise<Record<string, unknown>> | Record<string, unknown>;

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const attempt = <T>(fn: () => T): T | null => {
  try {
    return fn();
  } catch {
    return null;
  }
};

/** The default sampler: node:os plus /proc, /sys and statfs where they exist. */
export function osSampler(diskPath = "/"): Sampler {
  let lastCpu: { idle: number; total: number } | undefined;
  const cpuTimes = () => {
    let idle = 0;
    let total = 0;
    for (const c of cpus()) {
      idle += c.times.idle;
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    }
    return { idle, total };
  };
  const readers: Record<SystemMetric, () => unknown> = {
    cpu: () => {
      const now = cpuTimes();
      const prev = lastCpu;
      lastCpu = now;
      const dt = prev ? now.total - prev.total : 0;
      const percent = prev && dt > 0 ? Math.round((1 - (now.idle - prev.idle) / dt) * 1000) / 10 : null;
      return { percent, cores: cpus().length, load: loadavg() };
    },
    memory: () => {
      const total = totalmem();
      const free = freemem();
      return { total, free, used: total - free, percent: Math.round(((total - free) / total) * 1000) / 10 };
    },
    disk: () => {
      const s = statfsSync(diskPath);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      return {
        path: diskPath,
        total,
        free,
        used: total - free,
        percent: total ? Math.round((1 - free / total) * 1000) / 10 : null,
      };
    },
    battery: () => {
      const dir = "/sys/class/power_supply";
      const bat = readdirSync(dir).find((n) => n.startsWith("BAT"));
      if (!bat) return null;
      const read = (f: string) => readFileSync(`${dir}/${bat}/${f}`, "utf8").trim();
      return { percent: Number(read("capacity")), status: attempt(() => read("status")) };
    },
    network: () => {
      let rx = 0;
      let tx = 0;
      for (const line of readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)) {
        const [name, rest] = line.split(":");
        if (!rest || name?.trim() === "lo") continue;
        const f = rest.trim().split(/\s+/).map(Number);
        rx += f[0] ?? 0;
        tx += f[8] ?? 0;
      }
      return { rx_bytes: rx, tx_bytes: tx };
    },
  };
  return (metrics) => Object.fromEntries(metrics.map((m) => [m, attempt(readers[m])]));
}

export interface SystemInputOptions {
  every: string;
  metrics?: SystemMetric[];
  sampler?: Sampler;
  clock?: Clock;
  log?: (level: string, message: string) => void;
}

export class SystemInput implements InputAdapter {
  private readonly clock: Clock;
  private readonly everyMs: number;
  private readonly metrics: SystemMetric[];
  private readonly sampler: Sampler;
  private timer: unknown;
  private stopped = true;
  private inflight: Promise<void> = Promise.resolve();

  constructor(private readonly opts: SystemInputOptions) {
    this.clock = opts.clock ?? systemClock;
    this.everyMs = parseDuration(opts.every);
    if (this.everyMs < 1) throw new Error("system `every` must be at least 1ms");
    this.metrics = opts.metrics?.length ? opts.metrics : [...SYSTEM_METRICS];
    this.sampler = opts.sampler ?? osSampler();
  }

  describe(): string {
    return `system ${this.metrics.join(",")} every ${formatDuration(this.everyMs)}`;
  }

  async start(intake: Intake): Promise<void> {
    this.stopped = false;
    // Prime the sampler so the first packet already has a cpu delta.
    await this.sampler(this.metrics);
    this.arm(intake);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    await this.inflight;
  }

  private arm(intake: Intake): void {
    if (this.stopped) return;
    this.timer = this.clock.setTimeout(() => {
      this.inflight = this.fire(intake);
    }, this.everyMs);
  }

  private async fire(intake: Intake): Promise<void> {
    const source = new Date(this.clock.now()).toISOString();
    try {
      const data = { ...(await this.sampler(this.metrics)), sampled_at: source };
      const r = await intake(data, { trigger: "system", source });
      if (r.status !== "accepted") {
        this.opts.log?.(
          "warn",
          `system sample ${source} was not accepted: ${r.status === "rejected" ? r.message : r.reason}`,
        );
      }
    } catch (e) {
      this.opts.log?.("error", `system sample ${source} failed: ${(e as Error).message}`);
    }
    this.arm(intake);
  }
}
