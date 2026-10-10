// ci.pipo `propose`: Claude Code made a red build pass in its workspace. Commit that on a branch, autofix/<short>,
// push it to the repository, and write out/fixes/<short>.patch and a report, out/reports/<short>.md. Nothing is
// merged: a person reviews the branch, and merging it to main is a new push that goes through CI like any other.
//   stdin: the build (status "fixed")
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Build, git, OUT, stdinJson } from "./lib";

const b = await stdinJson<Build>();
const fixes = (b.fixes ?? []).filter(Boolean);
const last = fixes.at(-1);
const branch = `autofix/${b.short}`;
mkdirSync(join(OUT, "fixes"), { recursive: true });
mkdirSync(join(OUT, "reports"), { recursive: true });

// A rerun after a crash finds the commit already made.
if (git(b.workspace, "rev-parse", "--abbrev-ref", "HEAD") !== branch) {
  git(b.workspace, "checkout", "-q", "-B", branch);
  git(b.workspace, "add", "-A");
  const message = `Fix ${b.short}: ${last?.summary ?? "make the tests pass"}\n\n${last?.cause ?? ""}\n\nProposed by Claude Code through Pipo's ci pipeline for ${b.sha}.\n`;
  git(b.workspace, "-c", "user.name=pipo-ci", "-c", "user.email=pipo-ci@localhost", "commit", "-q", "-m", message);
}
const patch = git(b.workspace, "diff", b.sha, "HEAD");
const patchFile = join(OUT, "fixes", `${b.short}.patch`);
writeFileSync(patchFile, `${patch}\n`);

let pushed = "";
try {
  git(b.workspace, "push", "-q", "-f", b.repo, `HEAD:refs/heads/${branch}`);
  pushed = `Pushed to \`${branch}\` in ${b.name}.`;
} catch (e) {
  pushed = `Could not push \`${branch}\`: ${(e as Error).message}. The patch is in ${patchFile}.`;
}

const report = `# ${b.short} was red; Claude Code fixed it

- Commit: ${b.sha} on ${b.branch}, "${b.message}" by ${b.author}${b.url ? ` (${b.url})` : ""}
- Tests after the fix: ${b.tests?.pass} pass, ${b.tests?.fail} fail
- ${pushed}

${fixes.map((f, i) => `## Attempt ${i + 1}\n\n${f.summary}\n\nCause: ${f.cause}\n\nFiles: ${f.files.join(", ") || "none"}\n`).join("\n")}
## Patch

\`\`\`diff
${patch}
\`\`\`
`;
writeFileSync(join(OUT, "reports", `${b.short}.md`), report);
console.log(JSON.stringify({ branch, patch: patchFile, pushed: pushed.startsWith("Pushed") }));
