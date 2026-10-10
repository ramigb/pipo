// The engine's default gateway port (docs/spec.md §7.1, D83): with engine.listen unset, the CLI starts the engine on
// 4747 (here PIPO_ENGINE_PORT, a port picked per run), and on a free port with a warning when that one is taken.
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { sandbox, waitFor } from "../../runner/test/helpers";
import { DEFAULT_ENGINE_PORT, defaultEnginePort, findEngine, startEngine } from "../src/lifecycle";

const sb = sandbox();
const pids: number[] = [];
afterAll(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  sb.cleanup();
});

async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

/** startEngine with stderr captured; retried once when Bun hangs loading modules under WSL. */
async function start(home: string): Promise<{ why: string | null; stderr: string }> {
  const err: string[] = [];
  const { error } = console;
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    let why = await startEngine(home);
    if (why && /did not come up/.test(why)) why = await startEngine(home);
    return { why, stderr: err.join("\n") };
  } finally {
    console.error = error;
  }
}

test("PIPO_ENGINE_PORT overrides the default port 4747; anything else falls back to it", () => {
  const saved = process.env.PIPO_ENGINE_PORT;
  try {
    delete process.env.PIPO_ENGINE_PORT;
    expect(defaultEnginePort()).toBe(DEFAULT_ENGINE_PORT);
    expect(DEFAULT_ENGINE_PORT).toBe(4747);
    process.env.PIPO_ENGINE_PORT = "0";
    expect(defaultEnginePort()).toBe(0);
    process.env.PIPO_ENGINE_PORT = "not-a-port";
    expect(defaultEnginePort()).toBe(DEFAULT_ENGINE_PORT);
  } finally {
    if (saved === undefined) delete process.env.PIPO_ENGINE_PORT;
    else process.env.PIPO_ENGINE_PORT = saved;
  }
});

test("the engine starts on the default port, and on a free one with a warning when it is taken", async () => {
  const saved = process.env.PIPO_ENGINE_PORT;
  const port = await freePort();
  process.env.PIPO_ENGINE_PORT = String(port);
  try {
    const first = join(sb.root, "home-a");
    const a = await start(first);
    expect(a.why).toBeNull();
    const engineA = await waitFor(() => findEngine(first), 5000, "engine A");
    pids.push(engineA.pid);
    expect(engineA.port).toBe(port);
    expect(a.stderr).not.toContain("is taken");

    const second = join(sb.root, "home-b");
    const b = await start(second);
    expect(b.why).toBeNull();
    const engineB = await waitFor(() => findEngine(second), 5000, "engine B");
    pids.push(engineB.pid);
    expect(engineB.port).not.toBe(port);
    expect(b.stderr).toContain(`port ${port} is taken`);
  } finally {
    if (saved === undefined) delete process.env.PIPO_ENGINE_PORT;
    else process.env.PIPO_ENGINE_PORT = saved;
  }
}, 90_000);
