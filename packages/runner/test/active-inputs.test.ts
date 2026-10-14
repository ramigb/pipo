// Active inputs end to end (docs/spec.md §3.3.2, D87): poll, tail, command and crawl under the Rust runner binary,
// with SIGKILL restarts for exactly-once. Their logic is unit-tested in crates/pipo-runner/src/connectors/.
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, waitFor } from "./helpers";
import { RustRunner } from "./rust";

setDefaultTimeout(30_000);

const box = sandbox();
let running: RustRunner[] = [];
let servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const r of running) if (r.proc.exitCode === null) await r.kill();
  for (const s of servers) s.stop(true);
  running = [];
  servers = [];
});
afterAll(() => box.cleanup());

const delivered = (r: RustRunner) =>
  r
    .query<{ data: string; source: string; trigger: string }>(
      "SELECT data, source, trigger FROM packets WHERE state = 'delivered' ORDER BY received_at, id",
    )
    .map((p) => ({ ...p, data: JSON.parse(p.data) }));

describe("poll input", () => {
  test("sends new elements once, follows its cursor and survives SIGKILL", async () => {
    let items = [{ id: "a" }, { id: "b" }];
    const queries: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        queries.push(url.search);
        if (url.searchParams.get("k") !== "s3cret") return new Response("no key", { status: 401 });
        return Response.json({ items, max: items.length });
      },
    });
    servers.push(server);
    const file = box.write(
      "poll.pipo",
      `pipo: 1
name: poll
secrets: { k: "env:POLL_KEY" }
input:
  via: poll
  with:
    url: "http://127.0.0.1:${server.port}/items?k=\${secrets.k}&since=\${cursor ?? 0}"
    every: 200ms
    items: data.items
    key: item.id
    cursor: data.max
output: { from: input, to: stdout }
`,
    );
    const env = { POLL_KEY: "s3cret" };
    let r = await RustRunner.start(box, file, "poll", { listen: null, env });
    running.push(r);
    await waitFor(() => delivered(r).length >= 2, 10_000, "two elements");
    await waitFor(() => queries.includes("?k=s3cret&since=2"), 10_000, "a fetch with the cursor");
    expect(delivered(r).map((p) => [p.source, p.trigger])).toEqual([
      ["a", "poll"],
      ["b", "poll"],
    ]);
    await r.kill();
    items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    r = await RustRunner.start(box, file, "poll", { listen: null, env });
    running.push(r);
    await waitFor(() => delivered(r).length >= 3, 10_000, "the third element");
    await Bun.sleep(500);
    expect(delivered(r).map((p) => p.data.id)).toEqual(["a", "b", "c"]);
    expect(await r.stop()).toBe(0);
  });
});

describe("tail input", () => {
  test("follows a file and resumes after SIGKILL exactly once", async () => {
    const log = join(box.root, "app.log");
    writeFileSync(log, "before start\n");
    const file = box.write(
      "tail.pipo",
      "pipo: 1\nname: tail\ninput: { via: tail, with: { path: ./app.log } }\noutput: { from: input, to: stdout }\n",
    );
    let r = await RustRunner.start(box, file, "tail", { listen: null });
    running.push(r);
    await Bun.sleep(500);
    appendFileSync(log, "one\ntwo\n");
    await waitFor(() => delivered(r).length >= 2, 10_000, "two lines");
    await r.kill();
    appendFileSync(log, "three\n");
    r = await RustRunner.start(box, file, "tail", { listen: null });
    running.push(r);
    await waitFor(() => delivered(r).length >= 3, 10_000, "the line written while it was down");
    await Bun.sleep(500);
    expect(delivered(r).map((p) => p.data.line)).toEqual(["one", "two", "three"]);
    expect(delivered(r)[0]?.data.path).toBe(log);
    expect(await r.stop()).toBe(0);
  });
});

describe("command input", () => {
  test("each stdout line is a packet, and stop ends the program", async () => {
    const marker = join(box.root, "cmd-running");
    const file = box.write(
      "cmd.pipo",
      `pipo: 1
name: cmd
input:
  via: command
  with:
    command: sh
    args: ["-c", "trap 'rm -f ${marker}; exit 0' TERM; touch ${marker}; echo '{\\"n\\":1}'; echo '{\\"n\\":2}'; while true; do sleep 0.1; done"]
    parse: json
output: { from: input, to: stdout }
`,
    );
    const r = await RustRunner.start(box, file, "cmd", { listen: null });
    running.push(r);
    await waitFor(() => delivered(r).length >= 2, 10_000, "two lines");
    expect(delivered(r).map((p) => [p.data, p.trigger, p.source])).toEqual([
      [{ n: 1 }, "command", "sh"],
      [{ n: 2 }, "command", "sh"],
    ]);
    expect(existsSync(marker)).toBe(true);
    expect(await r.stop()).toBe(0);
    await waitFor(() => !existsSync(marker), 5000, "the program to end");
  });

  test("a program that isn't installed refuses the start", async () => {
    const file = box.write(
      "nocmd.pipo",
      "pipo: 1\nname: nocmd\ninput: { via: command, with: { command: pipo-no-such-program } }\noutput: { from: input, to: stdout }\n",
    );
    const { code, stderr } = await RustRunner.refuse(box, file);
    expect(code).not.toBe(0);
    expect(stderr).toContain("input.with.command: 'pipo-no-such-program' is not installed or not on PATH");
  });
});

describe("crawl input", () => {
  test("crawls a site within scope and sends each page", async () => {
    const pages: Record<string, string> = {
      "/": '<title>Home</title><a href="/a">a</a> <a href="/b">b</a> <a href="/secret/x">s</a>',
      "/a": "<title>A</title><p>alpha</p>",
      "/b": "<title>B</title><p>beta</p>",
    };
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /secret/\n");
        const body = pages[path];
        return body
          ? new Response(`<html><body>${body}</body></html>`, { headers: { "content-type": "text/html" } })
          : new Response("no", { status: 404 });
      },
    });
    servers.push(server);
    const file = box.write(
      "crawl.pipo",
      `pipo: 1\nname: crawl\ninput: { via: crawl, with: { start: "http://127.0.0.1:${server.port}/", every: 1h, delay: 0ms } }\noutput: { from: input, to: stdout }\n`,
    );
    const r = await RustRunner.start(box, file, "crawl", { listen: null });
    running.push(r);
    await waitFor(() => delivered(r).length >= 3, 10_000, "three pages");
    await Bun.sleep(300);
    const got = delivered(r).map((p) => [new URL(p.source).pathname, p.data.title, p.data.depth]);
    expect(got.sort()).toEqual([
      ["/", "Home", 0],
      ["/a", "A", 1],
      ["/b", "B", 1],
    ]);
    expect(await r.stop()).toBe(0);
  });
});
