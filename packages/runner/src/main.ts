#!/usr/bin/env bun
// Runner process entry: one pipeline per process (docs/spec.md §7.1).
// Usage: bun packages/runner/src/main.ts <file.pipo> [--listen <port>] [--home <dir>] [--env-allow A,B] [--engine-id <id>]
//        [--detached] [--ttl <duration>]
// `--engine-id`, `--detached` and `--ttl` are set by the engine (pipod) that supervises this runner and land in the
// registry entry (§7.2, D30, D57). The engine starts a detached runner in its own session, so it outlives the engine.
// `--ttl` replaces the file's `lifetime.ttl` for this start, counted from the same journal anchor (§7.4).
import { parseArgs } from "node:util";
import { runForeground } from "./foreground";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    listen: { type: "string" },
    home: { type: "string" },
    "env-allow": { type: "string" },
    "engine-id": { type: "string" },
    detached: { type: "boolean" },
    ttl: { type: "string" },
  },
});

const file = positionals[0];
if (!file) {
  console.error(
    "usage: runner <file.pipo> [--listen <port>] [--home <dir>] [--env-allow A,B] [--engine-id <id>] [--detached] [--ttl <duration>]",
  );
  process.exit(64);
}

process.exit(
  await runForeground({
    file,
    listen: values.listen === undefined ? undefined : Number(values.listen),
    home: values.home,
    envAllow: values["env-allow"]?.split(",").filter(Boolean),
    engineId: values["engine-id"],
    detached: values.detached,
    ttl: values.ttl,
  }),
);
