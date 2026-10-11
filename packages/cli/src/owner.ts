// `pipo owner` and `pipo owner reset` (docs/spec.md §6, §11, D84): the one owner of this Pipo home. Both work on the
// home's files directly, with or without an engine: reading the home is what makes someone the owner, so a reset needs
// no old password. A reset bumps the owner's epoch, which ends every dashboard session (a running engine notices the
// change on its next request), and `--rotate-key` replaces the engine key the CLI sends.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  engineKeyPath,
  ownerPath,
  passwordProblem,
  readOwner,
  rotateEngineKey,
  sessionsPath,
  setOwnerPassword,
  usernameProblem,
} from "@pipo/runner";
import { parse as parseYaml } from "yaml";
import { CliError } from "./errors";
import { resolveHome, usage } from "./lifecycle";
import { askHidden, readStdinSecret } from "./prompt";
import { done, paint } from "./tty";

const USAGE = "pipo owner [reset [--username <name>] [--password-stdin] [--rotate-key]]";

/** What config.yaml says about logins and mail (the engine validates it; a broken file reads as the defaults). */
function engineSettings(home: string): { auth: string; mail: boolean; public_url: string | null } {
  try {
    const engine = (parseYaml(readFileSync(join(home, "config.yaml"), "utf8")) as any)?.engine ?? {};
    return {
      auth: engine.auth === "open" ? "open" : "owner",
      mail: !!engine.mail,
      public_url: typeof engine.public_url === "string" ? engine.public_url : null,
    };
  } catch {
    return { auth: "owner", mail: false, public_url: null };
  }
}

/** Live sessions of the current epoch, from sessions.json. */
function sessionCount(home: string, epoch: number): number {
  try {
    const raw = JSON.parse(readFileSync(sessionsPath(home), "utf8"));
    const now = Date.now();
    return (Array.isArray(raw?.sessions) ? raw.sessions : []).filter(
      (s: any) => s?.epoch === epoch && Date.parse(s.expires_at) > now,
    ).length;
  } catch {
    return 0;
  }
}

export async function cmdOwner(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      home: { type: "string" },
      json: { type: "boolean" },
      username: { type: "string" },
      "password-stdin": { type: "boolean" },
      "rotate-key": { type: "boolean" },
    },
  });
  const [verb, ...extra] = positionals;
  if (extra.length || (verb !== undefined && verb !== "reset")) return usage(USAGE);
  const home = resolveHome(values.home);
  if (verb === undefined) {
    if (values.username !== undefined || values["password-stdin"] || values["rotate-key"]) return usage(USAGE);
    return show(home, values.json === true);
  }
  return reset(home, values);
}

function show(home: string, json: boolean): number {
  const owner = readOwner(home);
  const settings = engineSettings(home);
  const info = {
    mode: settings.auth,
    owner: owner?.username ?? null,
    email: owner?.email ?? null,
    password_changed_at: owner?.password_changed_at ?? null,
    sessions: owner ? sessionCount(home, owner.epoch) : 0,
    mail: settings.mail,
    public_url: settings.public_url,
    file: ownerPath(home),
  };
  if (json) {
    console.log(JSON.stringify({ ok: true, ...info }, null, 2));
    return 0;
  }
  const p = paint(process.stdout);
  const lines = [
    `mode      ${info.mode === "open" ? `open ${p.dim("(engine.auth: open, no login)")}` : "owner (a login)"}`,
    `owner     ${owner ? owner.username : p.dim("none yet: run pipo ui to create it, or pipo owner reset --username <name>")}`,
  ];
  if (owner) {
    lines.push(`email     ${owner.email ?? p.dim("not set (set it in the dashboard's settings)")}`);
    lines.push(`password  changed ${owner.password_changed_at}`);
    lines.push(`sessions  ${info.sessions} signed in`);
  }
  lines.push(
    `reset     pipo owner reset${settings.mail ? ", or 'Forgot password' on the login page" : p.dim(" (set engine.mail for reset links by email)")}`,
  );
  console.log(lines.join("\n"));
  return 0;
}

async function reset(
  home: string,
  values: { json?: boolean; username?: string; "password-stdin"?: boolean; "rotate-key"?: boolean },
): Promise<number> {
  const before = readOwner(home);
  if (values.username !== undefined) {
    const problem = usernameProblem(values.username);
    if (problem) throw new CliError(`--username '${values.username}': ${problem}`, "pick another one", "bad_request");
  }
  if (!before && values.username === undefined)
    throw new CliError(
      "there is no owner yet, so a username is needed",
      "run pipo owner reset --username <name> (or create the owner in the dashboard: pipo ui)",
      "bad_request",
    );
  let password: string;
  if (values["password-stdin"]) password = await readStdinSecret();
  else {
    password = await askHidden(`new password for '${values.username ?? before?.username}': `);
    const problem = passwordProblem(password);
    if (problem) throw new CliError(problem, "run pipo owner reset again", "bad_request");
    if ((await askHidden("again: ")) !== password)
      throw new CliError("the two passwords differ", "run pipo owner reset again", "bad_request");
  }
  const problem = passwordProblem(password);
  if (problem) throw new CliError(problem, "choose another one", "bad_request");
  const owner = await setOwnerPassword(home, {
    password,
    ...(values.username !== undefined && { username: values.username }),
  });
  const rotated = values["rotate-key"] === true;
  if (rotated) rotateEngineKey(home);
  if (values.json) {
    console.log(
      JSON.stringify({
        ok: true,
        owner: owner.username,
        created: !before,
        sessions_ended: !!before,
        key_rotated: rotated,
      }),
    );
    return 0;
  }
  const what = before
    ? `new password set for '${owner.username}'; every dashboard session ended`
    : `owner '${owner.username}' created`;
  console.log(done(`${what}${rotated ? `; new engine key in ${engineKeyPath(home)}` : ""}`));
  return 0;
}
