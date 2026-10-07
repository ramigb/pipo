#!/usr/bin/env bun
// `pipo` CLI entry point (docs/spec.md §6). The commands live in cli.ts.
import { runCli } from "./cli";

process.exit(await runCli(Bun.argv.slice(2)));
