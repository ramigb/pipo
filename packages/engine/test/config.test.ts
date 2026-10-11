// Engine config (docs/spec.md §7.1, D25): defaults, parsing, and errors that say where and what to do.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, EngineError, loadConfig, parseConfig, Supervisor } from "../src";
import { sandbox } from "./helpers";

const box = sandbox();
afterAll(() => box.cleanup());

function fails(source: string): EngineError {
  try {
    parseConfig(source, "config.yaml");
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    expect((e as EngineError).code).toBe("config");
    return e as EngineError;
  }
  throw new Error("expected the config to be refused");
}

test("a missing or empty config.yaml means every default", () => {
  expect(loadConfig(join(box.root, "nowhere"))).toEqual(DEFAULT_CONFIG);
  expect(parseConfig("")).toEqual(DEFAULT_CONFIG);
  expect(parseConfig("engine:\n")).toEqual(DEFAULT_CONFIG);
  expect(DEFAULT_CONFIG.restart).toEqual({
    backoff: 1000,
    max_backoff: 30_000,
    stable: 60_000,
    max_restarts: 5,
    window: 600_000,
  });
});

test("values are parsed; missing keys keep their defaults", () => {
  const c = parseConfig(`engine:
  ttl: 8h
  listen: 7700
  env_allow: [REGION, STAGE]
  start_timeout: 20s
  restart:
    backoff: 500ms
    max_restarts: 3
`);
  expect(c.ttl).toBe(8 * 3_600_000);
  expect(c.listen).toBe(7700);
  expect(c.detached).toBe(false);
  expect(c.env_allow).toEqual(["REGION", "STAGE"]);
  expect(c.start_timeout).toBe(20_000);
  expect(c.restart).toEqual({ ...DEFAULT_CONFIG.restart, backoff: 500, max_restarts: 3 });
});

test("bad values name the file position, the key, and what is expected", () => {
  const e = fails(`engine:
  listen: 99999
  restart:
    backoff: fast
    max_restarts: -1
`);
  expect(e.message).toContain("3 problem(s)");
  expect(e.message).toContain("config.yaml:2:11 engine.listen must be a port 0–65535 (0 picks a free one), got 99999");
  expect(e.message).toContain("config.yaml:4:14 engine.restart.backoff must be a duration such as 500ms");
  expect(e.message).toContain("engine.restart.max_restarts must be a whole number");
  expect(e.hint).toContain("a missing key uses its default");
});

test("unknown keys are errors (a typo never falls back to a default silently)", () => {
  const e = fails("engine:\n  restart:\n    max_restart: 3\nengnie: {}\n");
  expect(e.message).toContain("config.yaml:3:5 unknown key 'engine.restart.max_restart' (known: backoff,");
  expect(e.message).toContain("config.yaml:4:1 unknown key 'engnie'");
});

test("wrong shapes and inconsistent numbers are refused", () => {
  expect(fails("- engine").message).toContain("expected a mapping with an `engine` key");
  expect(fails("engine: 3").message).toContain("'engine' must be a mapping");
  expect(fails("engine:\n  restart: true").message).toContain("'engine.restart' must be a mapping");
  expect(fails("engine:\n  detached: yes please").message).toContain("engine.detached must be true or false");
  expect(fails("engine:\n  restart: { backoff: 10s, max_backoff: 1s }").message).toContain(
    "engine.restart.max_backoff (1.0s) is shorter than engine.restart.backoff (10s)",
  );
});

test("YAML syntax errors point at the line", () => {
  const e = fails("engine:\n  restart: [\n");
  expect(e.message).toMatch(/^config\.yaml:\d+:\d+ /);
  expect(e.hint).toBe("fix the YAML syntax");
});

test("the engine refuses to open with a bad config.yaml, before claiming the home", async () => {
  const home = join(box.root, "bad-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.yaml"), "engine:\n  restart: { window: soon }\n");
  await expect(Supervisor.open({ home })).rejects.toThrow(
    /config\.yaml:2:22 engine\.restart\.window must be a duration/,
  );
});

test("auth, host, public_url and mail (D84–D86)", () => {
  const ok = parseConfig(
    `engine:
  auth: owner
  host: 0.0.0.0
  public_url: https://pipo.example.com/
  mail: { host: smtp.example.com, user: pipo@example.com, password: op://Pipo/smtp/password, from: "Pipo <pipo@example.com>" }
`,
  );
  expect(ok.auth).toBe("owner");
  expect(ok.host).toBe("0.0.0.0");
  expect(ok.public_url).toBe("https://pipo.example.com");
  expect(ok.mail).toEqual({
    host: "smtp.example.com",
    port: 587,
    secure: "starttls",
    user: "pipo@example.com",
    password: "op://Pipo/smtp/password",
    from: "Pipo <pipo@example.com>",
  });
  const tls = parseConfig("engine:\n  mail: { host: smtp.example.com, port: 465, from: pipo@example.com }\n");
  expect(tls.mail).toMatchObject({ secure: "tls", user: null, password: null });

  expect(fails("engine:\n  auth: nobody\n").message).toContain("owner (a login, the default) or open");
  expect(fails("engine:\n  host: 192.168.1.5\n").message).toContain("0.0.0.0");
  expect(fails("engine:\n  public_url: https://pipo.example.com/app\n").message).toContain("no path");
  expect(fails("engine:\n  public_url: ftp://pipo.example.com\n").message).toContain("http(s) URL");
  const open = fails("engine:\n  host: 0.0.0.0\n  auth: open\n  public_url: https://a.example\n");
  expect(open.message).toContain("engine.auth: open");
  expect(fails("engine:\n  host: '::'\n").message).toContain("engine.public_url is not set");

  const literal = fails(
    "engine:\n  mail: { host: smtp.example.com, user: me, password: hunter2-literal, from: me@example.com }\n",
  );
  expect(literal.message).toContain("secret reference");
  expect(literal.message).not.toContain("hunter2-literal");
  expect(fails("engine:\n  mail: { host: smtp.example.com, secure: none, from: me@example.com }\n").message).toContain(
    "only allowed for a relay on this machine",
  );
  expect(fails("engine:\n  mail: { host: smtp.example.com, user: me, from: me@example.com }\n").message).toContain(
    "both user and password",
  );
  expect(fails("engine:\n  mail: { host: smtp.example.com, from: nobody }\n").message).toContain("sender address");
  expect(fails("engine:\n  mail: { host: smtp.example.com, from: a@b.c, tls: yes }\n").message).toContain(
    "unknown key 'engine.mail.tls'",
  );
});
