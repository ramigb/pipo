// Telegram input, tap and output end to end (docs/spec.md §3.3, §3.6): the Rust runner binary against a fake Bot API
// set as the bots' `api` in bots.json. Settings, file downloads and token redaction are also unit-tested in
// crates/pipo-runner/src/connectors/telegram.rs.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BotsFile, readBots, writeBots } from "../src/bots";
import { sandbox, waitFor } from "./helpers";
import { RustRunner } from "./rust";

setDefaultTimeout(30_000);

let running: RustRunner[] = [];
let cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const r of running) if (r.proc.exitCode === null) await r.kill();
  for (const c of cleanups) c();
  running = [];
  cleanups = [];
});

const MAIN = "111:main-secret-token";
const ALERTS = "222:alerts-secret-token";

/** A fake Bot API: queued updates, recorded calls, one downloadable file. */
function fakeTelegram() {
  const updates: any[] = [];
  const calls: { token: string; method: string; body: any }[] = [];
  const offsets: number[] = [];
  let failNextSend = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/file/")) return new Response("file-bytes");
      const [, bot, method] = url.pathname.split("/") as [string, string, string];
      const token = bot.slice(3);
      const form = (req.headers.get("content-type") ?? "").startsWith("multipart/");
      const body: any = form ? Object.fromEntries((await req.formData()).entries()) : await req.json();
      if (method === "getUpdates") {
        offsets.push(body.offset);
        const due = updates.filter((u) => u.update_id >= body.offset);
        if (!due.length) await Bun.sleep(20);
        return Response.json({ ok: true, result: due });
      }
      calls.push({ token, method, body });
      if (method === "getFile") return Response.json({ ok: true, result: { file_path: "documents/file_1.txt" } });
      if (failNextSend > 0) {
        failNextSend--;
        return Response.json(
          { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 0 } },
          { status: 429 },
        );
      }
      return Response.json({ ok: true, result: { message_id: calls.length, chat: { id: Number(body.chat_id) } } });
    },
  });
  cleanups.push(() => server.stop(true));
  let next = 1;
  return {
    api: `http://127.0.0.1:${server.port}`,
    calls,
    offsets,
    sends: () => calls.filter((c) => c.method.startsWith("send")),
    failSends: (n: number) => {
      failNextSend = n;
    },
    message(chat: number, extra: Record<string, unknown> = {}) {
      const id = next++;
      updates.push({
        update_id: id,
        message: {
          message_id: id,
          date: 1_700_000_000,
          chat: { id: chat, type: "private" },
          from: { id: chat, first_name: "Ann", username: "ann" },
          ...extra,
        },
      });
      return id;
    },
  };
}

function setup(tg: ReturnType<typeof fakeTelegram>, bots: BotsFile["telegram"]["bots"], def: string | null = "main") {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  for (const b of Object.values(bots)) b.api = tg.api;
  writeBots(box.home, { telegram: { default: def, bots } });
  const write = (name: string, body: string) => box.write(`${name}.pipo`, `pipo: 1\nname: ${name}\n${body}`);
  const open = async (name: string, body: string) => {
    const r = await RustRunner.start(box, write(name, body), name, { listen: null });
    running.push(r);
    return r;
  };
  return { box, open, write };
}

describe("telegram", () => {
  test("bots.json is written 0600 and validated", () => {
    const box = sandbox();
    cleanups.push(() => box.cleanup());
    writeBots(box.home, { telegram: { default: "main", bots: { main: { token: MAIN, allow: [1] } } } });
    expect(statSync(join(box.home, "bots.json")).mode & 0o777).toBe(0o600);
    expect(readBots(box.home).telegram.bots.main?.allow).toEqual([1]);
    writeFileSync(
      join(box.home, "bots.json"),
      JSON.stringify({ telegram: { default: "x", bots: { main: { token: "", poll_every: "10ms" } } } }),
    );
    expect(() => readBots(box.home)).toThrow(/3 problem/);
  });

  test("replies to the sender's chat, ignores strangers, and resumes after its saved offset", async () => {
    const tg = fakeTelegram();
    const s = setup(tg, { main: { token: MAIN, allow: [42] } });
    const body =
      "input: { via: telegram }\noutput: { from: input, to: telegram, with: { text: 'echo: ${data.text}' } }\n";
    const r = await s.open("echo", body);
    tg.message(7, { text: "let me in" });
    tg.message(42, { text: "hi" });
    await waitFor(() => tg.sends().length === 1, 5000, "the reply");
    expect(tg.sends()[0]).toMatchObject({
      token: MAIN,
      method: "sendMessage",
      body: { chat_id: "42", text: "echo: hi" },
    });
    await waitFor(
      () => r.lines().some((l) => l.includes("ignored a message from @ann (user id 7, chat id 7)")),
      5000,
      "the ignored line",
    );
    expect(JSON.parse(readFileSync(join(s.box.home, "run", "echo.json"), "utf8")).telegram_bot).toBe("111");
    // The fake answers the send before the runner commits the delivery.
    const packet = await waitFor(
      () =>
        r
          .query<{ trigger: string; state: string }>("SELECT trigger, state FROM packets")
          .find((p) => p.state === "delivered"),
      5000,
      "the delivery",
    );
    expect(packet).toEqual({ trigger: "telegram", state: "delivered" });
    expect(await r.stop()).toBe(0);
    expect(r.lines().join("\n") + r.stderr()).not.toContain(MAIN);

    tg.offsets.length = 0;
    await s.open("echo", body);
    await waitFor(() => tg.offsets.length > 0, 5000, "a poll");
    expect(tg.offsets[0]).toBe(3);
    await Bun.sleep(200);
    expect(tg.sends().length).toBe(1);
  });

  test("a tap sends from another bot; 429 is retried as Telegram asks", async () => {
    const tg = fakeTelegram();
    const s = setup(tg, { main: { token: MAIN, allow: [42] }, alerts: { token: ALERTS } });
    tg.failSends(1);
    await s.open(
      "notify",
      "input: { via: telegram }\nnodes:\n  ping: { from: input, tap: telegram, with: { bot: alerts, chat_id: 99, text: 'new: ${data.text}' } }\noutput: { from: ping, to: stdout }\n",
    );
    tg.message(42, { text: "yo" });
    await waitFor(() => tg.sends().length === 2, 5000, "the retried send");
    expect(tg.sends()[1]).toMatchObject({ token: ALERTS, body: { chat_id: 99, text: "new: yo" } });
  });

  test("downloads an attached file and sends one back", async () => {
    const tg = fakeTelegram();
    const s = setup(tg, { main: { token: MAIN, allow: [42] } });
    await s.open(
      "files",
      "input: { via: telegram }\noutput: { from: input, to: telegram, with: { document: '${data.file.path}', text: 'got ${data.file.name}' } }\n",
    );
    tg.message(42, {
      caption: "here",
      document: { file_id: "F1", file_unique_id: "U1", file_name: "notes.txt", file_size: 10 },
    });
    await waitFor(() => tg.sends().length === 1, 5000, "the document");
    const path = join(s.box.home, "pipelines", "files", "files", "U1-notes.txt");
    expect(readFileSync(path, "utf8")).toBe("file-bytes");
    const sent = tg.sends()[0];
    expect(sent?.method).toBe("sendDocument");
    expect(sent?.body.caption).toBe("got notes.txt");
    expect(sent?.body.chat_id).toBe("42");
  });

  test("refuses to start without a bot, and a second poller of the same bot", async () => {
    const tg = fakeTelegram();
    const s = setup(tg, {}, null);
    const body = "input: { via: telegram }\noutput: { from: input, to: stdout }\n";
    const nobot = await RustRunner.refuse(s.box, s.write("nobot", body));
    expect(nobot.code).toBe(1);
    expect(nobot.stderr).toMatch(/no bot is set up/);

    writeBots(s.box.home, { telegram: { default: "main", bots: { main: { token: MAIN, allow: [42], api: tg.api } } } });
    const one = await s.open("one", body);
    const two = await RustRunner.refuse(s.box, s.write("two", body));
    expect(two.code).toBe(1);
    expect(two.stderr).toMatch(new RegExp(`already polled by pipeline 'one' \\(pid ${one.pid}\\)`));
    expect(two.stderr).not.toContain(MAIN);

    // Once the first poller is gone, the bot is free.
    expect(await one.stop()).toBe(0);
    await s.open("two", body);
  });
});
