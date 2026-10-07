// Output batching (docs/spec.md §3.5.1, D20). Collects packets that passed `output.validate` and
// are journaled at the `$batch` cursor, and hands them to `flush` at `size` packets or `within`
// after the first one joined. The collector is memory only: the journal is the durable copy, so
// after a crash the runner re-queues `$batch` packets and they join a fresh batch.
import type { PacketRow } from "./journal";

export class Batch {
  private pending: PacketRow[] = [];
  /** Packets pending or mid-flush, so a packet never sits in two batches. */
  private readonly members = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly size: number,
    private readonly within: number,
    private readonly write: (rows: PacketRow[]) => Promise<void>,
    private readonly onError: (e: unknown) => void,
  ) {}

  /** Packets waiting or being flushed. */
  get count(): number {
    return this.members.size;
  }

  add(row: PacketRow): void {
    if (this.closed || this.members.has(row.id)) return;
    this.members.add(row.id);
    this.pending.push(row);
    if (this.pending.length >= this.size) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.within);
  }

  /** Flush whatever is pending now. Flushes run one at a time, in order; resolves when this one is done. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending.length) return this.chain;
    const rows = this.pending.splice(0);
    this.chain = this.chain
      .then(() => this.write(rows))
      .catch(this.onError)
      .finally(() => {
        // A held packet may already have been released and re-added to a newer batch.
        const waiting = new Set(this.pending.map((p) => p.id));
        for (const r of rows) if (!waiting.has(r.id)) this.members.delete(r.id);
      });
    return this.chain;
  }

  /** The runner settled this packet (written, failed or held), so it may join a later batch again. */
  release(id: string): void {
    this.members.delete(id);
  }

  /** Stop timers and ignore new packets; whatever still waits stays journaled at `$batch`. */
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
