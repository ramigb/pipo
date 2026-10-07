// Screenshots of every dashboard view (docs/spec.md §8) at 375 and 1440 px, light and dark, into /tmp/pipo-ui-shots/.
// Starts an engine in a temp home with two example pipelines and some packets, drives headless Chrome over the
// DevTools protocol (tabs need clicks; the theme is the UI's own localStorage "pipo-theme"), and kills everything by pid.
//   bun scripts/ui-shots.ts
import { type ChildProcess, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = "/tmp/pipo-ui-shots";
const WORK = mkdtempSync("/tmp/pipo-ui-shots-work-");
const HOME = join(WORK, "home");
const PROJECT = join(WORK, "examples");
const SIZES = [
  { width: 375, height: 812 },
  { width: 1440, height: 900 },
];
const THEMES = ["light", "dark"] as const;

class StepError extends Error {}
const fail = (step: string, detail: string): never => {
  throw new StepError(`ui-shots: ${step} failed: ${detail}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, PIPO_HOME: HOME, PIPO_INTAKE_TOKEN: "shots-token" };
const children: ChildProcess[] = [];
const log = (name: string) => openSync(join(WORK, `${name}.log`), "a");

function chromePath(): string {
  if (existsSync("/usr/bin/google-chrome")) return "/usr/bin/google-chrome";
  const cache = join(homedir(), ".cache/ms-playwright");
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium-")) : [];
  dirs.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  const found = dirs.map((d) => join(cache, d, "chrome-linux/chrome")).find(existsSync);
  return (
    found ?? fail("find Chrome", "no /usr/bin/google-chrome and no ~/.cache/ms-playwright/chromium-*; install Chrome")
  );
}

async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => res(port));
    });
  });
}

function pipo(args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const out = openSync(join(WORK, "cli.log"), "a");
    const p = spawn("bun", [join(ROOT, "packages/cli/src/main.ts"), ...args], { env, stdio: ["ignore", out, out] });
    const timer = setTimeout(() => p.kill("SIGKILL"), 40000);
    p.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) res();
      else rej(new StepError(`ui-shots: pipo ${args.join(" ")} exited ${code}; see ${WORK}/cli.log`));
    });
  });
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, ms = 30000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch {}
    await sleep(200);
  }
  return fail(what, `not ready after ${ms / 1000}s; logs are in ${WORK}`);
}

async function api(base: string, path: string, body?: unknown): Promise<any> {
  const init = body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : undefined;
  const res = await fetch(`${base}/api${path}`, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) fail(`api ${path}`, `${res.status} ${JSON.stringify(json)}`);
  return json;
}

// A minimal DevTools client over Bun's WebSocket.
class Cdp {
  private id = 0;
  private waiting = new Map<number, (m: any) => void>();
  constructor(private ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id) this.waiting.get(m.id)?.(m);
    };
  }
  static async connect(url: string) {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new StepError(`ui-shots: connecting to Chrome DevTools at ${url} failed`));
    });
    return new Cdp(ws);
  }
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiting.set(id, (m) =>
        m.error ? rej(new StepError(`ui-shots: ${method}: ${m.error.message}`)) : res(m.result),
      );
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async js(expression: string): Promise<any> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) fail("page script", r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  close() {
    this.ws.close();
  }
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  cpSync(join(ROOT, "examples"), PROJECT, { recursive: true });

  const port = await freePort();
  const engine = spawn(
    "bun",
    [join(ROOT, "packages/engine/src/main.ts"), "--home", HOME, "--listen", String(port), "--ttl", "1h"],
    { env, stdio: ["ignore", log("engine"), log("engine")] },
  );
  children.push(engine);
  const base = `http://127.0.0.1:${port}`;
  await waitFor("start engine", async () => ((await fetch(`${base}/api/pipelines`)).ok ? true : undefined));

  // people-intake (HTTP in, SQLite out) and heartbeat (schedule in, file out).
  const intakePort = await freePort();
  await pipo(["start", join(PROJECT, "people-intake/people-intake.pipo"), "--listen", String(intakePort)]);
  await pipo(["start", join(PROJECT, "heartbeat/heartbeat.pipo"), "--ttl", "6h"]);
  await waitFor("pipelines running", async () => {
    const l = await api(base, "/pipelines");
    const items: any[] = l.pipelines ?? l;
    return items.length >= 2 && items.every((p) => p.state === "running") ? true : undefined;
  });

  // Good packets, plus one that fails the output rule (name over 200 characters) into the DLQ.
  const people = [
    { name: "Ada Lovelace", age: 36, bio: "Mathematician" },
    { name: " Grace Hopper ", age: 45, bio: "Admiral" },
    { name: "Alan Turing", age: 41 },
    { name: "x".repeat(300), age: 50 },
    { name: "Edsger Dijkstra", age: 52, bio: "Structured programming" },
  ];
  for (const p of people) await pipo(["push", "people-intake", "--data", JSON.stringify(p)]);
  await waitFor(
    "DLQ packet",
    async () => {
      const d = await api(base, "/pipelines/people-intake/dlq");
      return (d.items ?? d.packets ?? d.dlq ?? []).length > 0 ? true : undefined;
    },
    60000,
  );

  // A second version through an applied proposal, so versions and diff have content.
  const info = await api(base, "/pipelines/people-intake");
  const current = readFileSync(join(PROJECT, "people-intake/people-intake.pipo"), "utf8");
  await api(base, "/pipelines/people-intake/proposals", {
    source: current.replace("Accept people from a webhook", "Accept adults from a webhook"),
    base_version: info.version,
    reason: "Clarify the description",
    by: "ui-shots",
    apply: true,
  });
  await waitFor("second version", async () =>
    (await api(base, "/pipelines/people-intake")).version > info.version ? true : undefined,
  );
  // An agent's proposal the pipeline does not let it make: stored rejected, so the agent feed has a second row.
  await api(base, "/pipelines/people-intake/proposals", {
    source: current.replace("Accept people from a webhook", "Accept people, adults only"),
    base_version: info.version + 1,
    reason: "Narrow the intake to adults",
    by: "ops-agent",
    by_kind: "agent",
    apply: false,
  });

  // shots-lab: one packet that escalates to an agent, and hostile data (markup, a long string, RTL text) that is
  // delivered, so the packets list and the inspector show how untrusted payloads render.
  const lab = join(WORK, "lab");
  mkdirSync(lab, { recursive: true });
  writeFileSync(
    join(lab, "lab.fn.ts"),
    'export const gate = (d: any) => { if (d.fail) throw new Error("upstream refused the record"); return d; };\n',
  );
  writeFileSync(
    join(lab, "shots-lab.pipo"),
    `pipo: 1
name: shots-lab
fn: ./lab.fn.ts
input: { via: push }
nodes:
  gate_with_an_extremely_long_node_identifier_that_never_stops_growing: { from: input, transform: fn.gate, on_error: { retry: 0, then: agent, message: "gate failed: \${error.message}" } }
output: { from: gate_with_an_extremely_long_node_identifier_that_never_stops_growing, to: file, with: { path: ./shots-lab.jsonl, format: jsonl } }
agent: { control: true }
`,
  );
  await pipo(["start", join(lab, "shots-lab.pipo")]);
  await waitFor("shots-lab running", async () =>
    (await api(base, "/pipelines/shots-lab")).state === "running" ? true : undefined,
  );
  const hostile = {
    name: "<script>alert(1)</script>",
    bio: "<img src=x onerror=\"document.title='pwned'\">",
    long: "L".repeat(2000),
    rtl: "مرحبا بالعالم ‮evil‬ שלום עולם",
  };
  const hostileId: string = (
    await api(base, "/pipelines/shots-lab/push", {
      data: hostile,
      source: "<b onmouseover=alert(1)>مصدر-" + "s".repeat(120) + "‮evil",
    })
  ).packet_id;
  await api(base, "/pipelines/shots-lab/push", { data: { fail: true, note: "needs a human decision" } });
  await waitFor("escalated packet", async () =>
    ((await api(base, "/pipelines/shots-lab/packets?state=escalated")).packets ?? []).length ? true : undefined,
  );
  await waitFor("hostile packet delivered", async () =>
    ((await api(base, "/pipelines/shots-lab/packets?state=delivered")).packets ?? []).some(
      (p: any) => p.packet_id === hostileId,
    )
      ? true
      : undefined,
  );
  const dlq = await api(base, "/pipelines/people-intake/dlq");
  const dlqId: string = (dlq.items ?? dlq.packets ?? dlq.dlq ?? [])[0]?.packet_id;
  if (!dlqId) fail("find a dead-lettered packet", "people-intake's DLQ is empty");
  await sleep(6000); // heartbeat ticks

  const dbgPort = await freePort();
  const chrome = spawn(
    chromePath(),
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      `--remote-debugging-port=${dbgPort}`,
      `--user-data-dir=${join(WORK, "chrome")}`,
      "--remote-allow-origins=*",
      "about:blank",
    ],
    { stdio: ["ignore", log("chrome"), log("chrome")] },
  );
  children.push(chrome);
  const target = await waitFor("start Chrome", async () => {
    const list = (await (await fetch(`http://127.0.0.1:${dbgPort}/json`)).json()) as any[];
    return list.find((t) => t.type === "page")?.webSocketDebuggerUrl as string | undefined;
  });
  const cdp = await Cdp.connect(target);
  await cdp.send("Page.enable");

  const page = await api(base, "/pipelines/people-intake/packets?limit=1");
  const packetId: string | undefined = (page.packets ?? page.items ?? [])[0]?.packet_id;
  if (!packetId) fail("find a packet", "people-intake has no packets");

  const clickTab = (t: string) =>
    cdp.js(
      `(async()=>{const b=[...document.querySelectorAll("button.tab")].find(x=>x.textContent===${JSON.stringify(t)});` +
        `if(!b)throw new Error("no tab ${t}");b.click();await new Promise(r=>setTimeout(r,800));})()`,
    );
  const hold = (path: string) => () => api(base, path, {}).then(() => sleep(1000));
  const views: {
    name: string;
    hash: string;
    contains: string;
    tab?: string;
    click?: string;
    before?: () => Promise<unknown>;
    after?: () => Promise<unknown>;
  }[] = [
    { name: "pipelines", hash: "#/", contains: "people-intake" },
    { name: "detail", hash: "#/p/people-intake", tab: "overview", contains: "Recent packets" },
    { name: "logs", hash: "#/p/people-intake", tab: "logs", contains: "Runner log" },
    { name: "agent", hash: "#/p/people-intake", tab: "agent", contains: "Agent activity" },
    { name: "dlq", hash: "#/p/people-intake", tab: "DLQ", contains: "" },
    { name: "versions", hash: "#/p/people-intake", tab: "versions", contains: "" },
    { name: "packet", hash: `#/p/people-intake/${encodeURIComponent(packetId as string)}`, contains: "Packet" },
    { name: "detail-heartbeat", hash: "#/p/heartbeat", tab: "overview", contains: "heartbeat" },
    // What the first round of shots could not see: opened rows, banners, escalation, hostile data.
    { name: "version-diff", hash: "#/p/people-intake", tab: "versions", click: "button:diff vs", contains: "+" },
    { name: "proposal-open", hash: "#/p/people-intake", tab: "agent", click: "tr.click:", contains: "Proposals" },
    {
      name: "paused",
      hash: "#/p/heartbeat",
      tab: "overview",
      contains: "paused",
      before: hold("/pipelines/heartbeat/pause"),
      after: hold("/pipelines/heartbeat/resume"),
    },
    { name: "escalation", hash: "#/p/shots-lab", tab: "agent", contains: "Agent activity" },
    { name: "escalation-list", hash: "#/p/shots-lab", tab: "overview", contains: "Recent packets" },
    { name: "packet-dlq", hash: `#/p/people-intake/${encodeURIComponent(dlqId)}`, contains: "Packet" },
    { name: "hostile-list", hash: "#/p/shots-lab", tab: "overview", contains: "Recent packets" },
    { name: "hostile-packet", hash: `#/p/shots-lab/${encodeURIComponent(hostileId)}`, contains: "Packet" },
  ];

  let count = 0;
  for (const size of SIZES) {
    const metrics = { ...size, deviceScaleFactor: 1, mobile: size.width < 600 };
    for (const theme of THEMES) {
      await cdp.send("Emulation.setDeviceMetricsOverride", metrics);
      await cdp.send("Page.navigate", { url: `${base}/ui/` });
      await sleep(800);
      // Click the UI's own toggle until its label names the theme, so label, storage and colours agree.
      await cdp.js(
        `(()=>{const b=document.getElementById("theme");for(let i=0;i<3&&b.textContent.toLowerCase()!==${JSON.stringify(theme)};i++)b.click();` +
          `if(b.textContent.toLowerCase()!==${JSON.stringify(theme)})throw new Error("theme toggle did not reach ${theme}");})()`,
      );
      for (const v of views) {
        await v.before?.();
        await cdp.js(`location.hash = ${JSON.stringify(v.hash)}`);
        await sleep(600);
        if (v.tab) await clickTab(v.tab === "DLQ" ? "DLQ" : v.tab);
        if (v.click) {
          const [sel, label] = v.click.split(":");
          await cdp.js(
            `(async()=>{const el=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>!x.disabled&&x.textContent.startsWith(${JSON.stringify(label ?? "")}));` +
              `if(!el)throw new Error("nothing to click for ${v.name}");el.click();await new Promise(r=>setTimeout(r,800));})()`,
          );
        }
        const text: string = await waitFor(
          `render ${v.name}`,
          async () => {
            const t = (await cdp.js("document.getElementById('app').innerText")) as string;
            return t && t.length > 20 && t.toLowerCase().includes(v.contains.toLowerCase()) ? t : undefined;
          },
          10000,
        );
        if (/^(error|failed)/i.test(text.trim())) fail(`render ${v.name}`, text.slice(0, 200));
        // Full page: grow the viewport to the content height, capture, restore.
        const full = Math.ceil(await cdp.js("document.documentElement.scrollHeight"));
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          ...metrics,
          height: Math.min(Math.max(full, size.height), 4000),
        });
        await sleep(200);
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
        await Bun.write(join(OUT, `${v.name}-${size.width}-${theme}.png`), Buffer.from(shot.data, "base64"));
        await cdp.send("Emulation.setDeviceMetricsOverride", metrics);
        count++;
        await v.after?.();
      }
    }
  }
  cdp.close();
  console.log(`ui-shots: wrote ${count} PNGs to ${OUT}`);
}

// Kills the engine, Chrome and every runner in <home>/run by pid, then removes the temp dir.
async function cleanup() {
  const pids = new Set<number>(children.map((c) => c.pid).filter((p): p is number => !!p));
  try {
    for (const f of readdirSync(join(HOME, "run"))) {
      const e = JSON.parse(readFileSync(join(HOME, "run", f), "utf8"));
      if (typeof e.pid === "number") pids.add(e.pid);
    }
  } catch {}
  for (const pid of pids)
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  await sleep(2000);
  for (const pid of pids)
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {}
}

let code = 0;
try {
  await main();
} catch (e) {
  console.error(e instanceof StepError ? e.message : `ui-shots: unexpected error: ${(e as Error).stack}`);
  console.error(`ui-shots: logs kept in ${WORK}`);
  code = 1;
} finally {
  await cleanup();
}
if (code === 0) rmSync(WORK, { recursive: true, force: true });
process.exit(code);
