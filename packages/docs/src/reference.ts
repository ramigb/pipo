// Reference pages generated from the code at build time, so they can't drift from it: the CLI from the command table
// (`@pipo/cli/commands`), connectors from the manifests and the JSON Schema from `buildSchema()` (`@pipo/spec`), the
// diagnostics from diagnostics.ts (whose test checks it covers every code `pipo check` reports), and the examples
// from examples/.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, type CommandHelp } from "@pipo/cli/commands";
import {
  AGENTS,
  buildSchema,
  CHECKS,
  INPUTS,
  type Manifest,
  OUTPUTS,
  TAPS,
  TRANSFORMS,
  UNIVERSAL_CHECKS,
} from "@pipo/spec";
import { DIAGNOSTICS } from "./diagnostics";
import { fieldDoc } from "./fields";
import { REPO } from "./markdown";
import { PAGES } from "./nav";

export interface GeneratedPage {
  slug: string;
  title: string;
  /** A virtual repo path, for resolving relative links in the generated Markdown. */
  source: string;
  markdown: string;
  /** Shown in the sidebar under this nav entry, e.g. each example under "Examples". */
  parent?: string;
}

type JsonSchema = Record<string, any>;

const root = join(import.meta.dir, "../../..");
const code = (s: string) => `\`${s}\``;
/** Text safe inside a Markdown table cell. */
/** Data text as Markdown: `<` outside code spans is text, not HTML (e.g. "/in/<pipeline><path>"). */
export const text = (s: string) =>
  s
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/</g, "&lt;")))
    .join("");
const cell = (s: string) => text(s).replace(/\|/g, "\\|").replace(/\n+/g, " ");

export function generate(name: string): GeneratedPage[] {
  switch (name) {
    case "cli":
      return [cliPage()];
    case "connectors":
      return [connectorsPage()];
    case "diagnostics":
      return [diagnosticsPage()];
    case "schema":
      return [schemaPage()];
    case "examples":
      return examplesPages();
    default:
      throw new Error(`unknown generated page '${name}'; add it to reference.ts or fix nav.ts`);
  }
}

// --- CLI ---

const CLI_AREAS: [area: string, commands: string[], guide: string][] = [
  ["Create and validate", ["check", "fmt", "test", "schema", "new", "generate", "templates", "trust", "compile"], ""],
  ["Run", ["run", "start", "stop", "pause", "resume", "restart"], "running.md"],
  ["Observe", ["status", "logs", "runners", "attach", "packets", "inspect"], "observing.md"],
  ["Recover", ["dlq", "rerun", "push", "ack", "resolve"], "recovery.md"],
  ["Versions and proposals", ["history", "diff", "rollback", "proposals"], "versions.md"],
  ["Engine and dashboard", ["engine", "ui", "help"], "engine.md"],
];

const COMMAND_GUIDE: Record<string, string> = {
  check: "../guide/pipo-file.md#checking-a-file",
  fmt: "../guide/scaffolding.md",
  test: "../guide/testing.md",
  schema: "schema.md",
  new: "../guide/scaffolding.md",
  generate: "../guide/scaffolding.md",
  templates: "../guide/scaffolding.md",
  trust: "../guide/scaffolding.md",
  compile: "../guide/engine.md",
  proposals: "../guide/change-protocol.md",
  resolve: "../guide/agent-operators.md",
  ui: "../guide/dashboard.md",
};

function cliPage(): GeneratedPage {
  const listed = new Set(CLI_AREAS.flatMap(([, c]) => c));
  const missing = COMMANDS.filter((c) => !listed.has(c.name)).map((c) => c.name);
  const areas = missing.length ? [...CLI_AREAS, ["Other", missing, ""] as (typeof CLI_AREAS)[number]] : CLI_AREAS;
  const out = [
    "# CLI reference",
    "",
    "Every `pipo` command, generated from the CLI's own command table, so it matches `pipo help <command>`.",
    "From a checkout of the repository, run the CLI as `bun pipo …`.",
    "",
    "## Global behaviour",
    "",
    '- **`--json`**: every command except `pipo run` (which streams the foreground runner\'s log) prints one JSON document for scripts and agents. A failure is `{"ok": false, "error", "hint", "code"}` with exit code 1.',
    "- **Plain output**: on a terminal, output has colour, ✔/▲/✖ symbols and spinners. `--plain` (any command), `PIPO_PLAIN=1`, `NO_COLOR`, `CI`, `TERM=dumb`, `--json` and output that isn't a terminal all give the stable plain format.",
    "- **The engine starts on demand**: commands that need the control plane start it when it isn't running. `--no-engine` talks to detached runners directly through their sockets instead (see [The engine](../guide/engine.md)).",
    "- **`--home <dir>`**: the Pipo home, `~/.pipo` by default, or `PIPO_HOME`.",
    "- **Help**: `pipo help <command>`, `pipo <command> --help` or `-h`.",
    "",
    "| Area | Commands |",
    "|---|---|",
    ...areas.map(([area, cmds]) => `| ${area} | ${cmds.map((c) => `[${code(c)}](#pipo-${c})`).join(" · ")} |`),
  ];
  for (const [area, names, guide] of areas) {
    out.push("", `## ${area}`, "");
    if (guide) out.push(`See also: [${titleOf(guide)}](../guide/${guide}).`, "");
    for (const name of names) {
      const c = COMMANDS.find((x) => x.name === name);
      if (c) out.push(...commandSection(c), "");
    }
  }
  return { slug: "cli", title: "CLI", source: "docs/reference/cli.md", markdown: out.join("\n") };
}

function commandSection(c: CommandHelp): string[] {
  const out = [`### pipo ${c.name}`, "", `${c.summary}.`, "", "```sh", c.usage, "```"];
  if (c.flags?.length) {
    out.push("", "| Flag | Meaning |", "|---|---|", ...c.flags.map(([f, d]) => `| ${code(f)} | ${cell(d)} |`));
  }
  const guide = COMMAND_GUIDE[c.name];
  if (guide) out.push("", `See also: [${titleOf(guide.split("#")[0]!.replace("../guide/", ""))}](${guide}).`);
  return out;
}

/** A guide page's title from nav.ts, by its file name (`running.md`). */
const titleOf = (file: string) => PAGES.find((p) => `${p.slug}.md` === file)?.title ?? file;

// --- Connectors ---

/** A short, readable type for a JSON Schema property. */
export function typeOf(s: JsonSchema | undefined): string {
  if (!s || Object.keys(s).length === 0) return "any";
  if (s.const !== undefined) return code(JSON.stringify(s.const));
  if (s.enum) return s.enum.map((v: unknown) => code(String(v))).join(" \\| ");
  if (typeof s.pattern === "string" && s.pattern.includes("ms|s|m|h|d")) return "duration";
  if (s.type === "array") {
    const items = s.items as JsonSchema | undefined;
    if (items?.enum) return `list of ${items.enum.map((v: unknown) => code(String(v))).join(", ")}`;
    return items ? `list of ${typeOf(items).replace(/^list of /, "")}` : "list";
  }
  if (Array.isArray(s.type)) return s.type.join(" or ");
  if (s.type === "object") return s.properties ? "object" : "map";
  return String(s.type ?? "any");
}

function constraints(s: JsonSchema): string {
  const parts: string[] = [];
  if (s.default !== undefined) parts.push(`default ${code(JSON.stringify(s.default))}`);
  if (s.minimum !== undefined && s.maximum !== undefined) parts.push(`${s.minimum}–${s.maximum}`);
  else if (s.minimum !== undefined) parts.push(`≥ ${s.minimum}`);
  return parts.join(", ");
}

function fieldTable(group: string, name: string, schema: JsonSchema): string[] {
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set<string>(schema.required ?? []);
  if (!Object.keys(props).length) return ["No `with:` settings."];
  const rows = Object.entries(props).map(([field, s]) => {
    const req = required.has(field) ? "yes" : "";
    const extra = constraints(s);
    const doc = fieldDoc(group, name, field) ?? "";
    return `| ${code(field)} | ${typeOf(s)} | ${req} | ${cell(doc)}${extra ? ` (${extra})` : ""} |`;
  });
  const out = ["| Field | Type | Required | Meaning |", "|---|---|:-:|---|", ...rows];
  if (schema.anyOf) out.push("", "One of `sql` and `query` is required.");
  return out;
}

interface ConnectorGroup {
  title: string;
  key: string;
  verb: string;
  guide: string;
  intro: string;
  entries: Record<string, Manifest>;
}

function connectorsPage(): GeneratedPage {
  const groups: ConnectorGroup[] = [
    {
      title: "Inputs",
      key: "input",
      verb: "via",
      guide: "inputs.md",
      intro: "Set with `input.via` (or `inputs.<name>.via`).",
      entries: INPUTS,
    },
    {
      title: "Taps",
      key: "tap",
      verb: "tap",
      guide: "nodes.md#tap",
      intro:
        "Side effects in the middle of the graph; `data` passes on unchanged. `tap: fn.<name>` calls a user function.",
      entries: TAPS,
    },
    {
      title: "Transforms",
      key: "transform",
      verb: "transform",
      guide: "nodes.md#transform",
      intro: "Replace `data` with a result. `transform: fn.<name>` calls a user function.",
      entries: TRANSFORMS,
    },
    {
      title: "Agent providers",
      key: "agent",
      verb: "agent",
      guide: "agent-nodes.md",
      intro: "An `agent:` node's provider.",
      entries: AGENTS,
    },
    {
      title: "Outputs",
      key: "output",
      verb: "to",
      guide: "outputs.md",
      intro: "Set with `output.to`. Every pipeline has exactly one output.",
      entries: OUTPUTS,
    },
    {
      title: "Delivery checks",
      key: "check",
      verb: "check",
      guide: "delivery.md",
      intro: "Set with `delivered.check`. All `with:` values are templates, rendered per packet.",
      entries: CHECKS,
    },
  ];
  const out = [
    "# Connectors",
    "",
    "Every built-in connector and its `with:` settings, generated from the connector manifests that `pipo check`, the JSON Schema and the builder's forms all use.",
    "",
    "Every block follows the same pattern: **verb: connector**, then **`with:`** for that connector's settings. `pipo check` validates each `with:` against the schema below; unknown keys are errors (P002).",
    "",
    ...groups.map(
      (g) =>
        `- [${g.title}](#${g.title.toLowerCase().replace(/ /g, "-")}): ${Object.keys(g.entries).map(code).join(", ")}`,
    ),
  ];
  for (const g of groups) {
    out.push("", `## ${g.title}`, "", `${g.intro} Guide: [${titleOf(g.guide.split("#")[0]!)}](../guide/${g.guide}).`);
    if (g.key === "check") out.push("", ...checkMatrix());
    for (const [name, m] of Object.entries(g.entries)) {
      out.push("", `### ${g.verb}: ${name}`, "", text(m.description.replace(/\.?$/, ".")));
      const facts: string[] = [];
      if (g.key === "agent") {
        const a = m as (typeof AGENTS)[string];
        facts.push(
          `Runs: ${a.runs === "api" ? "a model API" : `a local CLI (${code(a.command ?? name)})`}`,
          `default ${code("timeout")}: ${a.timeout}`,
        );
      }
      if (g.key === "output") {
        const o = m as (typeof OUTPUTS)[string];
        facts.push(
          `Delivery checks: ${[...UNIVERSAL_CHECKS, ...o.checks].map(code).join(", ")}`,
          `Batching: ${o.batch ? "yes" : "no"}`,
        );
      }
      if (facts.length) out.push("", facts.join(" · "));
      out.push("", ...fieldTable(g.key, name, m.with));
      const sample = (m as (typeof INPUTS)[string]).sample;
      if (g.key === "input" && sample !== undefined && Object.keys(sample as object).length) {
        out.push("", "Example `data` of one packet:", "", "```json", JSON.stringify(sample, null, 2), "```");
      }
    }
  }
  return { slug: "connectors", title: "Connectors", source: "docs/reference/connectors.md", markdown: out.join("\n") };
}

function checkMatrix(): string[] {
  const outputs = Object.keys(OUTPUTS);
  const rows = Object.keys(CHECKS).map((check) => {
    const marks = outputs.map((o) =>
      UNIVERSAL_CHECKS.includes(check) || OUTPUTS[o]!.checks.includes(check) ? "✓" : "",
    );
    return `| ${code(check)} | ${marks.join(" | ")} |`;
  });
  return [
    "Which output supports which check. `pipo check` rejects any other combination (P031).",
    "",
    `| Check | ${outputs.map(code).join(" | ")} |`,
    `|---|${outputs.map(() => ":-:").join("|")}|`,
    ...rows,
  ];
}

// --- Diagnostics ---

function diagnosticsPage(): GeneratedPage {
  const out = [
    "# Diagnostics",
    "",
    "Every finding `pipo check` reports, by code. Each one is printed as `file:line:col severity code message`, followed by a hint that says what to do:",
    "",
    "```text",
    "people-intake.pipo:61:10  error  P031  delivered.check 'file_exists' is not supported by output 'sqlite'",
    "  supported: ack, record_exists, row_count, query, external, none",
    "```",
    "",
    "An **error** stops `pipo start`, `pipo run`, a live change and a proposal. A **warning** is reported but doesn't stop anything. `pipo check --json` gives the same findings as data. See [The .pipo file](../guide/pipo-file.md#checking-a-file).",
    "",
    "| Code | Severity | What it means |",
    "|---|---|---|",
    ...DIAGNOSTICS.map((d) => `| [${d.code}](#${d.code.toLowerCase()}) | ${d.severity} | ${cell(d.title)} |`),
  ];
  for (const d of DIAGNOSTICS) {
    out.push("", `## ${d.code}`, "", `**${text(d.title)}** (${d.severity})`, "", text(d.detail));
    if (d.fix) out.push("", `**Fix:** ${text(d.fix)}`);
  }
  return {
    slug: "diagnostics",
    title: "Diagnostics",
    source: "docs/reference/diagnostics.md",
    markdown: out.join("\n"),
  };
}

// --- JSON Schema ---

function schemaPage(): GeneratedPage {
  const schema = buildSchema() as JsonSchema;
  const props = schema.properties as Record<string, JsonSchema>;
  const required = new Set<string>(schema.required ?? []);
  const out = [
    "# JSON Schema",
    "",
    "A `.pipo` file is YAML with a published JSON Schema. Each connector's `with:` block is a conditional schema chosen by `via`, `to`, `tap`, `transform`, `agent` and `check`, so completion and validation follow the connector you pick.",
    "",
    "- **Download:** [pipo.schema.json](pipo.schema.json), generated from the same code as `pipo schema`.",
    "- **From the CLI:** `pipo schema > pipo.schema.json`.",
    "- **In any editor with the YAML language server**, put this line at the top of a `.pipo` file:",
    "",
    "```yaml",
    "# yaml-language-server: $schema=https://raw.githubusercontent.com/ramigb/pipo/main/schema/pipo.schema.json",
    "```",
    "",
    "The VS Code extension attaches the schema to `.pipo` files by itself; see [Editor support](../guide/editor.md). The schema checks structure only. `pipo check` adds the rules a schema can't express (references, the graph, expressions, compatibility); see [Diagnostics](diagnostics.md).",
    "",
    "## Top-level keys",
    "",
    "| Key | Type | Required | Meaning |",
    "|---|---|:-:|---|",
    ...Object.entries(props).map(
      ([k, s]) =>
        `| ${code(k)} | ${typeOf(s)} | ${required.has(k) ? "yes" : ""} | ${cell(fieldDoc("top", "pipo", k) ?? s.description ?? "")} |`,
    ),
    "",
    "Exactly one of `input` and `inputs` is required (P060).",
  ];
  return { slug: "schema", title: "JSON Schema", source: "docs/reference/schema.md", markdown: out.join("\n") };
}

export function schemaJson(): string {
  return `${JSON.stringify(buildSchema(), null, 2)}\n`;
}

// --- Examples ---

function examplesPages(): GeneratedPage[] {
  const dir = join(root, "examples");
  const names = readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isDirectory())
    .filter((n) => readdirSync(join(dir, n)).some((f) => f.endsWith(".pipo")))
    .sort();
  const pages: GeneratedPage[] = [];
  const index = [
    "# Examples",
    "",
    "Runnable pipelines from the repository's [`examples/`](../../examples) folder. Every one passes `pipo check` in CI. From a checkout, `bun pipo check examples` checks them all.",
    "",
    "| Example | What it does |",
    "|---|---|",
  ];
  for (const name of names) {
    const folder = join(dir, name);
    const pipoFile = readdirSync(folder).find((f) => f.endsWith(".pipo"))!;
    const pipo = readFileSync(join(folder, pipoFile), "utf8");
    const readmePath = join(folder, "README.md");
    const readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "";
    const description = summaryOf(readme) || descriptionOf(pipo) || "";
    index.push(`| [${name}](example-${name}.md) | ${cell(description)} |`);
    const body = readme ? readme.replace(/^# .*\n/, "") : `${description}\n`;
    pages.push({
      slug: `example-${name}`,
      title: name,
      source: `examples/${name}/README.md`,
      parent: "examples",
      markdown: [
        `# ${name}`,
        "",
        body.trim(),
        "",
        `## ${pipoFile}`,
        "",
        "```yaml",
        pipo.trimEnd(),
        "```",
        "",
        `Source: [examples/${name}](${REPO}/tree/main/examples/${name}).`,
      ].join("\n"),
    });
  }
  pages.unshift({
    slug: "examples",
    title: "Examples",
    source: "docs/reference/examples.md",
    markdown: index.join("\n"),
  });
  return pages;
}

/** The first paragraph of a README, after its title. */
function summaryOf(readme: string): string {
  const para = readme.replace(/^# .*\n+/, "").split(/\n\s*\n/)[0] ?? "";
  // Links are dropped: they are relative to the example's folder, not to the index page.
  return para.startsWith("```")
    ? ""
    : para
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\n/g, " ")
        .trim();
}

function descriptionOf(pipo: string): string {
  return pipo.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "") ?? "";
}
