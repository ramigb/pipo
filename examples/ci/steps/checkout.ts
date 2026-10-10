// ci.pipo `checkout`: fetch exactly the pushed commit into out/work/<packet id> (shallow, so a big repository costs
// one commit) and print the build record. A rerun after a crash starts the folder over.
//   stdin: {repo, sha, branch?, message?, author?, ...}   argv: <packet id>
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Build, git, OUT, stdinJson, writeBuild } from "./lib";

const id = process.argv[2];
if (!id) throw new Error("usage: checkout.ts <packet id> < build.json");
const event = await stdinJson<Partial<Build>>();
const workspace = join(OUT, "work", id);
rmSync(workspace, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });
git(workspace, "init", "-q");
git(workspace, "fetch", "-q", "--depth=1", event.repo!, event.sha!);
git(workspace, "checkout", "-q", "--detach", "FETCH_HEAD");

const [subject = "", author = ""] = git(workspace, "log", "-1", "--format=%s%n%an").split("\n");
const build: Build = {
  id,
  repo: event.repo!,
  name: event.name ?? event.repo!,
  sha: event.sha!,
  short: event.sha!.slice(0, 7),
  branch: event.branch ?? "main",
  message: event.message || subject,
  author: event.author || author,
  url: event.url ?? null,
  workspace,
  artifact: join(OUT, "artifacts", event.sha!),
};
writeBuild(build);
console.log(JSON.stringify(build));
