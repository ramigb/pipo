// Connector registry (docs/spec.md §3.3–§3.5). The runner builds every input and output
// through these maps, so adding a connector means one file plus one line here. The manifest
// (schema, capabilities) lives in @pipo/spec and must cover what a factory here accepts.
import { join } from "node:path";
import type { Pipeline } from "@pipo/spec";
import { type Bots, pickBot } from "../bots";
import { ExecStep } from "./exec";
import { FileOutput } from "./file-output";
import { HttpInput } from "./http-input";
import { HttpOutput } from "./http-output";
import { PushInput } from "./push-input";
import { type Clock, ScheduleInput } from "./schedule-input";
import { SqliteOutput } from "./sqlite-output";
import { StdoutOutput } from "./stdout-output";
import { EmitTap, FileTap, HttpTap, HttpTransform, type StepAdapter, TelegramTap } from "./steps";
import { SystemInput, type SystemMetric } from "./system-input";
import { TelegramInput, TelegramOutput } from "./telegram";
import type { InputAdapter, OutputAdapter } from "./types";
import { type WatchEvent, WatchInput } from "./watch-input";

/** Everything a factory may need, passed in one object so new needs never change the factories' shape. */
export interface ConnectorContext {
  pipeline: Pipeline;
  /** Folder of the .pipo file; relative paths resolve against it. */
  dir: string;
  log: (level: string, message: string) => void;
  /** Where stdout output prints. */
  print?: (line: string) => void;
  clock?: Clock;
  /** Port override for an http input (0 picks a free port). */
  listen?: number;
  hostname?: string;
  /** The connector's `with:` block, rendered with env and secrets (inputs only). */
  with: Record<string, any>;
  /** Pipo home (a telegram input saves attached files under it). */
  home?: string;
  /** The chat bots the pipeline uses, tokens resolved (§3.13). */
  bots?: Bots;
  /** Hides secret values in text a step returns (exec's stdout and stderr). */
  redact?: (text: string) => string;
}

/** Thrown by a factory when the settings can't work; the runner turns it into a StartError. */
export class ConnectorError extends Error {}

export type InputFactory = (ctx: ConnectorContext) => InputAdapter;
export type OutputFactory = (ctx: ConnectorContext) => OutputAdapter;

export const inputs: Record<string, InputFactory> = {
  push: () => new PushInput(),
  schedule: (ctx) => {
    const w = ctx.with;
    try {
      return new ScheduleInput({
        cron: w.cron as string | undefined,
        every: w.every as string | undefined,
        payload: w.payload,
        clock: ctx.clock,
        log: ctx.log,
      });
    } catch (e) {
      throw new ConnectorError(`schedule input: ${(e as Error).message}`);
    }
  },
  watch: (ctx) =>
    new WatchInput({
      path: ctx.with.path as string,
      dir: ctx.dir,
      events: ctx.with.events as WatchEvent[] | undefined,
      read: ctx.with.read as "content" | "path" | undefined,
      log: ctx.log,
    }),
  system: (ctx) => {
    try {
      return new SystemInput({
        every: ctx.with.every as string,
        metrics: ctx.with.metrics as SystemMetric[] | undefined,
        clock: ctx.clock,
        log: ctx.log,
      });
    } catch (e) {
      throw new ConnectorError(`system input: ${(e as Error).message}`);
    }
  },
  telegram: (ctx) => {
    const w = ctx.with;
    try {
      return new TelegramInput({
        bot: pickBot(ctx.bots, w, "input"),
        allow: w.allow as number[] | undefined,
        poll_every: w.poll_every as string | undefined,
        download: w.download as boolean | undefined,
        filesDir: join(ctx.home ?? ctx.dir, "pipelines", ctx.pipeline.name, "files"),
        log: ctx.log,
      });
    } catch (e) {
      throw new ConnectorError(`telegram input: ${(e as Error).message}`);
    }
  },
  http: (ctx) => {
    const w = ctx.with;
    const port = ctx.listen ?? (w.listen as number | undefined);
    if (port === undefined) {
      throw new ConnectorError(
        "http input needs a port: set input.with.listen or pass --listen, or start it through the engine with engine.listen set (its gateway then serves /in/<pipeline>/… and gives the runner a free loopback port)",
      );
    }
    return new HttpInput({
      pipeline: ctx.pipeline.name,
      path: (w.path as string) ?? "/",
      method: (w.method as string) ?? "POST",
      port,
      hostname: ctx.hostname ?? "127.0.0.1",
      format: (ctx.pipeline.input.format ?? "json") as "json" | "text" | "form" | "csv" | "bytes",
      auth: w.auth?.header ? { header: w.auth.header, equals: String(w.auth.equals ?? "") } : undefined,
      hmac: w.auth?.hmac
        ? {
            header: w.auth.hmac.header,
            secret: String(w.auth.hmac.secret),
            algorithm: w.auth.hmac.algorithm ?? "sha256",
          }
        : undefined,
      respond: w.respond,
      timeout: w.timeout,
    });
  },
};

export const outputs: Record<string, OutputFactory> = {
  sqlite: (ctx) => new SqliteOutput(ctx.dir),
  stdout: (ctx) => new StdoutOutput(ctx.print),
  file: (ctx) => new FileOutput(ctx.dir),
  http: () => new HttpOutput(),
  telegram: (ctx) => new TelegramOutput(ctx.bots, ctx.dir),
};

export type StepFactory = (ctx: ConnectorContext) => StepAdapter;

export const taps: Record<string, StepFactory> = {
  http: () => new HttpTap(),
  file: (ctx) => new FileTap(ctx.dir),
  emit: () => new EmitTap(),
  telegram: (ctx) => new TelegramTap(ctx.bots, ctx.dir),
  exec: (ctx) => new ExecStep(ctx.dir, false, ctx.redact),
};
export const transforms: Record<string, StepFactory> = {
  http: () => new HttpTransform(),
  exec: (ctx) => new ExecStep(ctx.dir, true, ctx.redact),
};
