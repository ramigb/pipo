// `to: stdout` (docs/spec.md §3.5). Supports only the universal delivery checks.
import { toText } from "@pipo/spec";
import type { OutputAdapter, WriteItem } from "./types";

export class StdoutOutput implements OutputAdapter {
  constructor(private readonly print: (line: string) => void = console.log) {}

  async write(items: WriteItem[]): Promise<unknown[]> {
    return items.map((item) => {
      const format = (item.with.format as string | undefined) ?? "jsonl";
      if (format === "text") this.print(toText(item.data));
      else this.print(JSON.stringify({ packet_id: item.packetId, data: item.data }, null, format === "json" ? 2 : 0));
      return null;
    });
  }

  async verify(check: string): Promise<boolean> {
    throw new Error(`stdout does not support delivery check '${check}'`);
  }

  close(): void {}
}
