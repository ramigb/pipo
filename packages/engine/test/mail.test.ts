// Password reset by email (docs/spec.md D86) against a mock SMTP server on loopback (`secure: none`): the SMTP
// conversation (AUTH PLAIN, dot-stuffing), a test email, a reset link built from engine.public_url that works once,
// the same answer for an unknown name, and a refused recipient reported with its hint.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Supervisor } from "../src";
import type { EngineConfig } from "../src/config";
import { sendMail } from "../src/smtp";
import { sandbox, testConfig, waitFor } from "./helpers";

interface Mail {
  auth: string | null;
  from: string;
  to: string[];
  data: string;
}

interface Conn {
  buf: string;
  inData: boolean;
  data: string[];
  mail: Mail;
}

/** A tiny SMTP server: records what it is sent; `reject` makes RCPT TO fail for that address. */
function mockSmtp(reject = new Set<string>()) {
  const mails: Mail[] = [];
  const server = Bun.listen<Conn>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        s.data = { buf: "", inData: false, data: [], mail: { auth: null, from: "", to: [], data: "" } };
        s.write("220 mock ESMTP\r\n");
      },
      data(s, chunk) {
        const c = s.data;
        c.buf += chunk.toString();
        let at = c.buf.indexOf("\r\n");
        while (at >= 0) {
          const line = c.buf.slice(0, at);
          c.buf = c.buf.slice(at + 2);
          at = c.buf.indexOf("\r\n");
          if (c.inData) {
            if (line === ".") {
              c.inData = false;
              c.mail.data = c.data.join("\r\n");
              mails.push(c.mail);
              c.mail = { auth: c.mail.auth, from: "", to: [], data: "" };
              c.data = [];
              s.write("250 queued\r\n");
            } else c.data.push(line.startsWith("..") ? line.slice(1) : line);
            continue;
          }
          const cmd = line.toUpperCase();
          if (cmd.startsWith("EHLO")) s.write("250-mock\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
          else if (cmd.startsWith("AUTH PLAIN ")) {
            c.mail.auth = Buffer.from(line.slice(11), "base64").toString();
            s.write("235 ok\r\n");
          } else if (cmd.startsWith("MAIL FROM:")) {
            c.mail.from = line.slice(10);
            s.write("250 ok\r\n");
          } else if (cmd.startsWith("RCPT TO:")) {
            const to = line.slice(8).replace(/[<>]/g, "");
            if (reject.has(to)) s.write("550 5.1.1 no such user\r\n");
            else {
              c.mail.to.push(to);
              s.write("250 ok\r\n");
            }
          } else if (cmd === "DATA") {
            c.inData = true;
            s.write("354 go on\r\n");
          } else if (cmd === "QUIT") {
            s.write("221 bye\r\n");
            s.end();
          } else s.write("502 unknown\r\n");
        }
      },
    },
  });
  return { port: server.port, mails, stop: () => server.stop(true) };
}

const box = sandbox();
const smtp = mockSmtp(new Set(["nobody@example.com"]));
const engines: Supervisor[] = [];
afterAll(async () => {
  for (const e of engines) await Promise.race([e.shutdown({ now: true }), Bun.sleep(10_000)]);
  smtp.stop();
  box.cleanup();
});

process.env.PIPO_TEST_SMTP_PASSWORD = "smtp-secret-123";
const MAIL: EngineConfig["mail"] = {
  host: "127.0.0.1",
  port: smtp.port,
  secure: "none",
  user: "pipo",
  password: "env:PIPO_TEST_SMTP_PASSWORD",
  from: "Pipo <pipo@example.com>",
};

type Answer = { status: number; body: any; headers: Headers };
const answer = async (res: Response): Promise<Answer> => ({
  status: res.status,
  body: await res.json().catch(() => null),
  headers: res.headers,
});

describe("reset by email", () => {
  const home = join(box.root, "mail-home");
  let base = "";
  let cookie = "";
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }).then(answer);

  test("the SMTP client logs in, dot-stuffs the body and ends lines with CRLF", async () => {
    await sendMail({ ...MAIL, password: "smtp-secret-123" } as any, {
      to: "ada@example.com",
      subject: "hi",
      text: "line one\n.starts with a dot\nend",
    });
    const m = smtp.mails.at(-1)!;
    expect(m.auth).toBe("\0pipo\0smtp-secret-123");
    expect(m.from).toBe("<pipo@example.com>");
    expect(m.to).toEqual(["ada@example.com"]);
    expect(m.data).toContain("Subject: hi");
    expect(m.data).toContain("From: Pipo <pipo@example.com>");
    expect(m.data).toMatch(/Message-ID: <[0-9a-f]+@example.com>/);
    expect(m.data.split("\r\n\r\n")[1]).toBe("line one\r\n.starts with a dot\r\nend");
  });

  test("a refused recipient is an error with a hint", async () => {
    const err = await sendMail({ ...MAIL, password: "smtp-secret-123" } as any, {
      to: "nobody@example.com",
      subject: "x",
      text: "x",
    }).catch((e) => e);
    expect(err.message).toContain("550");
    expect(err.message).toContain("RCPT TO");
    expect(err.hint).toContain("email address");
  });

  test("set up an owner with an email; /api/auth says mail works; a test email arrives", async () => {
    const engine = await Supervisor.open({
      home,
      config: { ...testConfig(), auth: "owner", listen: 0, public_url: "https://pipo.example.com", mail: MAIL },
      log: () => {},
    });
    engines.push(engine);
    base = engine.gateway?.url as string;
    const { readEngineKey } = await import("@pipo/runner");
    const state = await fetch(`${base}/api/auth`, { headers: { authorization: `Bearer ${readEngineKey(home)}` } }).then(
      answer,
    );
    await waitFor(async () => (await fetch(`${base}/api/auth`).then(answer)).body.mail === true, 5000, "mail ready");
    const setup = await post("/api/auth/setup", {
      code: state.body.setup_code,
      username: "ada",
      password: "correct horse battery",
      email: "ada@example.com",
    });
    expect(setup.status).toBe(201);
    cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const sent = await post("/api/auth/test-mail", {}, { cookie });
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ sent: "ada@example.com" });
    expect(smtp.mails.at(-1)?.data).toContain("Subject: Pipo test email");
  });

  test("forgot: an unknown name gets the same answer and no email; the owner's gets a link from public_url", async () => {
    const before = smtp.mails.length;
    const unknown = await post("/api/auth/forgot", { login: "eve" });
    const known = await post("/api/auth/forgot", { login: "ADA@example.com" });
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    await waitFor(() => smtp.mails.length === before + 1, 5000, "the reset email");
    const mail = smtp.mails.at(-1)!;
    expect(mail.to).toEqual(["ada@example.com"]);
    expect(mail.data).toContain("Subject: Reset your Pipo password");
    const token = /https:\/\/pipo\.example\.com\/ui\/#\/reset\/([A-Za-z0-9_-]{43})/.exec(mail.data)?.[1];
    expect(token).toBeTruthy();

    const short = await post("/api/auth/reset", { token, password: "short" });
    expect(short.status).toBe(400);
    const ok = await post("/api/auth/reset", { token, password: "a new password from mail" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ user: "ada" });
    expect(ok.headers.get("set-cookie")).toContain("; Secure");
    // The old session ended with the reset; the link works once.
    expect((await fetch(`${base}/api/pipelines`, { headers: { cookie } })).status).toBe(401);
    const again = await post("/api/auth/reset", { token, password: "a new password from mail" });
    expect(again.status).toBe(400);
    expect(again.body.hint).toContain("pipo owner reset");
    const login = await post("/api/auth/login", { username: "ada", password: "a new password from mail" });
    expect(login.status).toBe(200);
  });
});
