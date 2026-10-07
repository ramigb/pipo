// `via: push` (docs/spec.md §3.3, D24): no listener of its own. Packets arrive only through the runner's
// control socket (`push` op, used by `pipo push`, the UI and agents), which journals them before replying.
import type { InputAdapter } from "./types";

export class PushInput implements InputAdapter {
  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  describe(): string {
    return "push (control socket)";
  }
}
