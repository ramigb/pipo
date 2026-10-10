// A local stand-in for GitHub, for trying ci.pipo without one: a git repository in out/repo seeded from ./app, whose
// commits send ci a push event shaped and signed like GitHub's (X-Hub-Signature-256, the HMAC of the body).
//   bun examples/ci/demo.ts init     create out/repo, commit the app, add hooks that send each commit, send the first
//   bun examples/ci/demo.ts push     send the push event for out/repo's HEAD (what the hooks run)
//   bun examples/ci/demo.ts bug      commit a change that breaks a test (Claude Code should fix it on a branch)
//   bun examples/ci/demo.ts crash    commit a change that passes the tests but doesn't start (production refuses it)
// CI_WEBHOOK_SECRET must be the secret ci runs with; CI_URL defaults to http://127.0.0.1:8793/in/ci/github.
import { createHmac } from "node:crypto";
import { chmodSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REPO = join(import.meta.dir, "out", "repo");

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

/** The GitHub push event for `repo`'s HEAD (the fields GitHub sends that ci reads, and a few more). */
export function pushEvent(repo = REPO) {
  const sha = git(repo, "rev-parse", "HEAD");
  const branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const [message = "", name = "", email = "", timestamp = ""] = git(
    repo,
    "log",
    "-1",
    "--format=%B%x00%an%x00%ae%x00%aI",
  ).split("\0");
  let before = "0".repeat(40);
  try {
    before = git(repo, "rev-parse", "HEAD~1");
  } catch {}
  return {
    ref: `refs/heads/${branch}`,
    before,
    after: sha,
    created: before === "0".repeat(40),
    deleted: false,
    repository: { name: "shop-api", full_name: "local/shop-api", clone_url: repo },
    pusher: { name, email },
    head_commit: { id: sha, message: message.trim(), timestamp, author: { name, email } },
  };
}

/** POST `event` the way GitHub delivers a webhook. */
export function sendEvent(event: unknown, o: { url?: string; secret?: string; kind?: string } = {}) {
  const url = o.url ?? process.env.CI_URL ?? "http://127.0.0.1:8793/in/ci/github";
  const secret = o.secret ?? process.env.CI_WEBHOOK_SECRET;
  if (!secret) throw new Error("CI_WEBHOOK_SECRET isn't set; export the secret ci was started with");
  const body = JSON.stringify(event);
  return fetch(url, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": o.kind ?? "push",
      "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
  });
}

/** Edit a file in the repository and commit it; the hook sends the push. */
export function commit(repo: string, file: string, edit: (s: string) => string, message: string) {
  const path = join(repo, file);
  writeFileSync(path, edit(readFileSync(path, "utf8")));
  git(repo, "-c", "user.name=Ada", "-c", "user.email=ada@example.com", "commit", "-qam", message);
  return git(repo, "rev-parse", "HEAD");
}

/** Create the repository from ./app. With `hooks`, each commit or merge on it sends ci its push event. */
export function init(repo = REPO, hooks = true) {
  rmSync(repo, { recursive: true, force: true });
  cpSync(join(import.meta.dir, "app"), repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(
    repo,
    "-c",
    "user.name=Ada",
    "-c",
    "user.email=ada@example.com",
    "commit",
    "-qm",
    "Shop API: quotes with discounts and shipping",
  );
  if (hooks) {
    for (const hook of ["post-commit", "post-merge"]) {
      const path = join(repo, ".git", "hooks", hook);
      writeFileSync(path, `#!/bin/sh\nexec bun ${JSON.stringify(join(import.meta.dir, "demo.ts"))} push\n`);
      chmodSync(path, 0o755);
    }
  }
  return git(repo, "rev-parse", "HEAD");
}

export const BUG = {
  file: "src/cart.ts",
  edit: (s: string) => s.replace("amount >= FREE_SHIPPING_FROM", "amount > FREE_SHIPPING_FROM"),
  message: "Tidy up the shipping rule",
};
export const CRASH = {
  file: "src/app.ts",
  edit: (s: string) =>
    s.replace(
      'if (url.pathname === "/health") return Response.json({ ok: true });',
      'if (url.pathname === "/health") return Response.json({ ok: false }, { status: 503 });',
    ),
  message: "Report maintenance on /health",
};

if (import.meta.main) {
  const [cmd] = process.argv.slice(2);
  const send = async () => {
    const event = pushEvent();
    const res = await sendEvent(event);
    console.log(`${event.after.slice(0, 7)} ${event.ref} → ci: ${res.status} ${await res.text()}`);
  };
  if (cmd === "init") {
    init();
    console.log(`created ${REPO}; commits there are sent to ci`);
    await send();
  } else if (cmd === "push") {
    await send().catch((e) => console.error(`ci didn't get the push: ${e.message}`));
  } else if (cmd === "bug" || cmd === "crash") {
    if (!existsSync(REPO)) throw new Error("no out/repo yet; run `bun examples/ci/demo.ts init` first");
    const c = cmd === "bug" ? BUG : CRASH;
    commit(REPO, c.file, c.edit, c.message);
  } else {
    console.error("usage: bun examples/ci/demo.ts init | push | bug | crash");
    process.exit(64);
  }
}
