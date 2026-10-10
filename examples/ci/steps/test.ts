// ci.pipo `test` and `retest`: run `bun test` in the build's workspace and print the build with the result. After
// Claude Code's fix (`retest`), stdin is its answer, kept in the record as `fixes[<loop pass>]`.
//   argv: <packet id> [--after-fix <pass>]   stdin: the build, or the fix
import { type Build, type Fix, readBuild, stdinJson, writeBuild } from "./lib";

const [id, flag, pass] = process.argv.slice(2);
if (!id) throw new Error("usage: test.ts <packet id> [--after-fix <pass>]");
const input = await stdinJson<unknown>();
const build = readBuild(id);
if (flag === "--after-fix") {
  build.fixes ??= [];
  build.fixes[Number(pass ?? 0)] = input as Fix;
  writeBuild(build);
}

const r = Bun.spawnSync(["bun", "test"], {
  cwd: build.workspace,
  env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  stdout: "pipe",
  stderr: "pipe",
});
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal colours
const log = (r.stdout.toString() + r.stderr.toString()).replace(/\x1b\[[0-9;]*m/g, "");
const count = (word: string) => Number(log.match(new RegExp(`^\\s*(\\d+) ${word}$`, "m"))?.[1] ?? 0);
const ok = r.exitCode === 0;
const result: Build = {
  ...build,
  status: ok ? (build.fixes?.length ? "fixed" : "passed") : "failed",
  tests: {
    ok,
    pass: count("pass"),
    fail: count("fail"),
    failures: log
      .split("\n")
      .filter((l) => l.startsWith("(fail)"))
      .map((l) => l.slice(7).replace(/ \[[\d.]+m?s\]$/, "")),
    log: log.length > 6000 ? `…${log.slice(-6000)}` : log,
  },
};
console.log(JSON.stringify(result));
