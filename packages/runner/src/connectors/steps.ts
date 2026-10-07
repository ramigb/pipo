// Taps and transforms (docs/spec.md §3.4): `tap: http | file | emit`, `transform: http`.
// A tap's side effect may run again after a crash before its step commits (at-least-once, §7.3):
// http sends `Idempotency-Key: <packet_id>:<node>`, file skips a repeat of the same packet+node,
// emit only returns events, which the runner commits in the step's own transaction.

import type { Bots } from "../bots";
import { FileOutput } from "./file-output";
import { httpCall } from "./http-output";
import { telegramSend } from "./telegram";
import type { Origin } from "./types";

export interface StepInput {
  packetId: string;
  node: string;
  data: unknown;
  /** The node's `with:` block, rendered for this packet. */
  with: Record<string, unknown>;
  origin?: Origin;
}

export interface StepResult {
  /** Transforms only: the new data. */
  data?: unknown;
  /** Custom events to record in the packet's trail with the step's transition. */
  events?: { type: string; detail?: unknown }[];
}

export interface StepAdapter {
  run(input: StepInput): Promise<StepResult>;
  close(): void;
}

const key = (i: StepInput) => `${i.packetId}:${i.node}`;

export class HttpTap implements StepAdapter {
  async run(i: StepInput): Promise<StepResult> {
    await httpCall(i.with, i.data, key(i), `nodes.${i.node}`);
    return {};
  }
  close() {}
}

export class HttpTransform implements StepAdapter {
  async run(i: StepInput): Promise<StepResult> {
    const res = await httpCall(i.with, i.data, key(i), `nodes.${i.node}`);
    if (/json/i.test(res.contentType)) {
      try {
        return { data: JSON.parse(res.text) };
      } catch {
        throw new Error(`${i.with.url} answered with content type ${res.contentType} but the body is not valid JSON`);
      }
    }
    return { data: res.text };
  }
  close() {}
}

export class TelegramTap implements StepAdapter {
  constructor(
    private readonly bots: Bots | undefined,
    private readonly dir: string,
  ) {}
  async run(i: StepInput): Promise<StepResult> {
    await telegramSend(this.bots, this.dir, i.with, i.data, i.origin, `nodes.${i.node}`);
    return {};
  }
  close() {}
}

export class FileTap implements StepAdapter {
  private readonly file: FileOutput;
  constructor(dir: string) {
    this.file = new FileOutput(dir);
  }
  async run(i: StepInput): Promise<StepResult> {
    if (!i.with.path) throw new Error(`nodes.${i.node}.with.path is empty after rendering; check the template`);
    await this.file.write([{ packetId: key(i), data: i.data, with: i.with }]);
    return {};
  }
  close() {
    this.file.close();
  }
}

export class EmitTap implements StepAdapter {
  async run(i: StepInput): Promise<StepResult> {
    const type = String(i.with.event ?? "");
    if (!type) throw new Error(`nodes.${i.node}.with.event is empty after rendering; check the template`);
    return { events: [{ type, detail: i.with.detail }] };
  }
  close() {}
}
