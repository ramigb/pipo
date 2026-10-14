// What an agent-written pipeline reaches outside itself, as the human approving it sees it (docs/spec.md §9.4, D81).
import { describe, expect, test } from "bun:test";
import { effectsOf } from "../src/approvals";

describe("effectsOf", () => {
  test("names what each input, step and output reaches", () => {
    const source = `pipo: 1
name: e
inputs:
  hook: { via: http, with: { path: /e } }
  feed: { via: poll, with: { url: "https://e.com/feed", every: 1h } }
  site: { via: crawl, with: { start: "https://e.com/", every: 1d } }
  log: { via: tail, with: { path: ./app.log } }
  prog: { via: command, with: { command: journalctl } }
nodes:
  run: { from: [hook, feed, site, log, prog], transform: exec, with: { command: ffmpeg } }
output: { from: run, to: sqlite, with: { path: ./e.db, table: e } }
`;
    expect(effectsOf(source)).toEqual({
      listens: ["inputs.hook"],
      calls_out: ["inputs.feed", "inputs.site"],
      reads_files: ["inputs.log"],
      runs_programs: ["inputs.prog", "nodes.run"],
      writes_files: ["output"],
    });
  });
});
