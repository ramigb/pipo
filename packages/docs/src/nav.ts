// The docs site's table of contents. A page is hand-written Markdown under docs/ (`source`) or generated from the
// code at build time (`generate`, see reference.ts). The sidebar, prev/next links and the search index follow this
// order. Add a page here to publish it.

export interface PageEntry {
  slug: string;
  title: string;
  /** Repo-relative Markdown source. */
  source?: string;
  /** Name of a generator in reference.ts. */
  generate?: string;
}

export interface Section {
  title: string;
  pages: PageEntry[];
}

const guide = (slug: string, title: string): PageEntry => ({ slug, title, source: `docs/guide/${slug}.md` });

export const NAV: Section[] = [
  {
    title: "Get started",
    pages: [
      guide("index", "Introduction"),
      guide("install", "Install"),
      guide("quick-start", "Quick start"),
      guide("concepts", "Core concepts"),
    ],
  },
  {
    title: "Writing pipelines",
    pages: [
      guide("pipo-file", "The .pipo file"),
      guide("inputs", "Inputs"),
      guide("nodes", "Nodes and the graph"),
      guide("outputs", "Outputs"),
      guide("delivery", "Delivery checks"),
      guide("expressions", "Expressions and templates"),
      guide("functions", "User functions"),
      guide("exec", "Running programs"),
      guide("errors", "Error policies"),
      guide("lifetime", "Lifetime, concurrency and retention"),
      guide("secrets", "Secrets"),
      guide("chains", "Chains"),
      guide("telegram", "Telegram bots"),
    ],
  },
  {
    title: "Agents",
    pages: [
      guide("agent-nodes", "Agent nodes"),
      guide("agent-operators", "Agents as operators"),
      guide("change-protocol", "Live changes and proposals"),
    ],
  },
  {
    title: "Run and operate",
    pages: [
      guide("running", "Running pipelines"),
      guide("engine", "The engine"),
      guide("observing", "Observing pipelines"),
      guide("recovery", "Recovering packets"),
      guide("versions", "Versions and rollback"),
      guide("dashboard", "Dashboard"),
      guide("builder", "Builder"),
    ],
  },
  {
    title: "Tooling",
    pages: [
      guide("testing", "Testing"),
      guide("scaffolding", "Templates and generators"),
      guide("editor", "Editor support"),
    ],
  },
  {
    title: "Reference",
    pages: [
      { slug: "cli", title: "CLI", generate: "cli" },
      { slug: "connectors", title: "Connectors", generate: "connectors" },
      { slug: "diagnostics", title: "Diagnostics", generate: "diagnostics" },
      guide("api", "REST, SSE and MCP"),
      guide("configuration", "Configuration"),
      { slug: "schema", title: "JSON Schema", generate: "schema" },
      { slug: "examples", title: "Examples", generate: "examples" },
      { slug: "spec", title: "Specification", source: "docs/spec.md" },
      { slug: "roadmap", title: "Roadmap", source: "docs/roadmap.md" },
    ],
  },
];

export const PAGES: PageEntry[] = NAV.flatMap((s) => s.pages);
