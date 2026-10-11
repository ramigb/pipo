// A minimal SMTP client for the owner's reset links and test emails (docs/spec.md D86): implicit TLS (465), STARTTLS
// (587) or, for a relay on this machine only, plain text. EHLO, AUTH PLAIN (else LOGIN), MAIL FROM, RCPT TO, DATA,
// QUIT; every reply waits at most `timeoutMs`. Plain-text messages only. Errors say which step failed and what the
// server answered, never the password.
import { randomBytes } from "node:crypto";
import { type Socket, connect as tcpConnect } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import type { MailSecurity } from "./config";

export interface SmtpOptions {
  host: string;
  port: number;
  secure: MailSecurity;
  user: string | null;
  password: string | null;
  from: string;
  timeoutMs?: number;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export class MailError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

interface Reply {
  code: number;
  lines: string[];
}

/** The bare address of `Name <a@b>` or `a@b`. */
export function addressOf(from: string): string {
  const m = /<([^<>\s]+)>\s*$/.exec(from);
  return (m?.[1] ?? from).trim();
}

/** An RFC 5322 message: headers, then the body with CRLF line ends, base64 when it is not plain ASCII. */
export function formatMessage(from: string, msg: MailMessage, now = new Date()): string {
  const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);
  const subject = ascii(msg.subject) ? msg.subject : `=?UTF-8?B?${Buffer.from(msg.subject).toString("base64")}?=`;
  const domain = addressOf(from).split("@")[1] ?? "pipo.local";
  const body = msg.text.replace(/\r?\n/g, "\r\n");
  const plain = /^[\x20-\x7e\r\n\t]*$/.test(body);
  const headers = [
    `From: ${from}`,
    `To: ${msg.to}`,
    `Subject: ${subject}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Transfer-Encoding: ${plain ? "7bit" : "base64"}`,
  ];
  const content = plain
    ? body
    : (
        Buffer.from(body)
          .toString("base64")
          .match(/.{1,76}/g) ?? []
      ).join("\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${content}`;
}

/** Send one message. Throws MailError. */
export async function sendMail(opts: SmtpOptions, msg: MailMessage): Promise<void> {
  if (/[\r\n]/.test(msg.to) || /[\r\n]/.test(msg.subject) || /[\r\n]/.test(opts.from))
    throw new MailError("a mail header holds a line break", "check the addresses and the subject");
  const session = new Session(opts);
  try {
    await session.run(msg);
  } finally {
    session.close();
  }
}

class Session {
  private socket!: Socket | TLSSocket;
  private buffer = "";
  private lines: string[] = [];
  private waiting: ((err?: Error) => void) | null = null;
  private failure: Error | null = null;
  private readonly timeout: number;

  constructor(private readonly opts: SmtpOptions) {
    this.timeout = opts.timeoutMs ?? 30_000;
  }

  async run(msg: MailMessage) {
    const o = this.opts;
    const where = `${o.host}:${o.port}`;
    this.socket = await this.open(o.secure === "tls");
    await this.expect("connect", [220]);
    let ehlo = await this.command("EHLO pipo.localhost", [250], "EHLO");
    if (o.secure === "starttls") {
      if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l)))
        throw new MailError(
          `${where} does not offer STARTTLS`,
          "set engine.mail.secure: tls (usually with port 465), or use a server that supports STARTTLS on this port",
        );
      await this.command("STARTTLS", [220], "STARTTLS");
      this.socket = await this.upgrade();
      ehlo = await this.command("EHLO pipo.localhost", [250], "EHLO");
    }
    if (o.user !== null && o.password !== null) {
      const auth = ehlo.lines.find((l) => /^AUTH\b/i.test(l))?.toUpperCase() ?? "";
      if (/\bPLAIN\b/.test(auth) || !/\bLOGIN\b/.test(auth)) {
        const token = Buffer.from(`\0${o.user}\0${o.password}`).toString("base64");
        await this.command(`AUTH PLAIN ${token}`, [235], "AUTH", "AUTH PLAIN");
      } else {
        await this.command("AUTH LOGIN", [334], "AUTH");
        await this.command(Buffer.from(o.user).toString("base64"), [334], "AUTH", "AUTH LOGIN (user)");
        await this.command(Buffer.from(o.password).toString("base64"), [235], "AUTH", "AUTH LOGIN (password)");
      }
    }
    await this.command(`MAIL FROM:<${addressOf(o.from)}>`, [250], "MAIL FROM");
    await this.command(`RCPT TO:<${addressOf(msg.to)}>`, [250, 251], "RCPT TO");
    await this.command("DATA", [354], "DATA");
    const data = formatMessage(o.from, msg)
      .split("\r\n")
      .map((l) => (l.startsWith(".") ? `.${l}` : l))
      .join("\r\n");
    await this.command(`${data}\r\n.`, [250], "DATA", "the message");
    await this.command("QUIT", [221], "QUIT").catch(() => {});
  }

  close() {
    this.socket?.destroy();
  }

  private open(tls: boolean): Promise<Socket | TLSSocket> {
    const o = this.opts;
    return new Promise((resolve, reject) => {
      const socket = tls
        ? tlsConnect({ host: o.host, port: o.port, servername: o.host })
        : tcpConnect({ host: o.host, port: o.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(this.connectError(new Error("timed out")));
      }, this.timeout);
      socket.once(tls ? "secureConnect" : "connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        this.listen(socket);
        resolve(socket);
      });
      socket.once("error", (e) => {
        clearTimeout(timer);
        reject(this.connectError(e));
      });
    });
  }

  private upgrade(): Promise<TLSSocket> {
    const o = this.opts;
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    return new Promise((resolve, reject) => {
      const socket = tlsConnect({ socket: plain, servername: o.host });
      const timer = setTimeout(
        () => reject(new MailError(`TLS with ${o.host} timed out`, "check engine.mail")),
        this.timeout,
      );
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        this.buffer = "";
        this.lines = [];
        this.listen(socket);
        resolve(socket);
      });
      socket.once("error", (e) => {
        clearTimeout(timer);
        reject(
          new MailError(
            `TLS with ${o.host} failed: ${e.message}`,
            "check that the server's certificate is valid for engine.mail.host",
          ),
        );
      });
    });
  }

  private connectError(e: Error): MailError {
    const o = this.opts;
    return new MailError(
      `can't reach the mail server ${o.host}:${o.port}: ${e.message}`,
      o.secure === "tls"
        ? "check engine.mail.host and port (implicit TLS is usually port 465; for 587 set secure: starttls)"
        : "check engine.mail.host and port, and that this machine may connect to it",
    );
  }

  private listen(socket: Socket | TLSSocket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let at = this.buffer.indexOf("\n");
      while (at >= 0) {
        this.lines.push(this.buffer.slice(0, at).replace(/\r$/, ""));
        this.buffer = this.buffer.slice(at + 1);
        at = this.buffer.indexOf("\n");
      }
      this.wake();
    });
    socket.on("error", (e) => {
      this.failure = e;
      this.wake();
    });
    socket.on("close", () => {
      this.failure ??= new Error("the server closed the connection");
      this.wake();
    });
  }

  private wake() {
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }

  /** The next whole reply (`250-…` lines up to the `250 …` one). */
  private async reply(step: string): Promise<Reply> {
    const deadline = Date.now() + this.timeout;
    for (;;) {
      const end = this.lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
      if (end >= 0) {
        const got = this.lines.splice(0, end + 1);
        return { code: Number(got[end]!.slice(0, 3)), lines: got.map((l) => l.slice(4)) };
      }
      if (this.failure)
        throw new MailError(
          `the mail server ${this.opts.host} broke off during ${step}: ${this.failure.message}`,
          "check engine.mail (host, port, secure) and try again",
        );
      const left = deadline - Date.now();
      if (left <= 0)
        throw new MailError(
          `the mail server ${this.opts.host} did not answer ${step} within ${Math.round(this.timeout / 1000)} s`,
          "check engine.mail.port and secure (tls for 465, starttls for 587)",
        );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiting = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  private async expect(step: string, codes: number[]): Promise<Reply> {
    const r = await this.reply(step);
    if (!codes.includes(r.code)) throw this.refused(step, r);
    return r;
  }

  /** Send `line` (never logged: it may hold the password) and check the reply. */
  private async command(line: string, codes: number[], step: string, what = step): Promise<Reply> {
    this.socket.write(`${line}\r\n`);
    const r = await this.reply(what);
    if (!codes.includes(r.code)) throw this.refused(what, r);
    return r;
  }

  private refused(step: string, r: Reply): MailError {
    const said = `${r.code} ${r.lines.join(" ")}`.trim();
    const hint = step.startsWith("AUTH")
      ? "check engine.mail.user and the password its reference points to (some providers need an app password)"
      : step === "MAIL FROM"
        ? "check engine.mail.from: the server may only send as the account's own address"
        : step === "RCPT TO"
          ? "check the owner's email address in the dashboard's settings"
          : "check engine.mail and the server's requirements";
    return new MailError(`the mail server refused ${step}: ${said}`, hint);
  }
}
