// User functions for blog.pipo, available as fn.<export> (docs/spec.md §3.6). They run in the runner's QuickJS:
// plain JavaScript, no Bun or Node APIs.

interface Meta {
  input: string;
  received_at: number;
}

interface WatchedFile {
  name: string;
  content: string | null;
  mtime: string;
}

export interface Post {
  slug: string;
  title: string;
  author: string;
  body: string;
  excerpt: string;
  tags: string[];
  draft: boolean;
  reading_minutes: number;
  published_at: string;
  updated_at: string;
  source: string;
}

// Tags written by authors are folded onto one spelling.
const ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  db: "databases",
  database: "databases",
  sqlite3: "sqlite",
  ml: "machine-learning",
  llm: "ai",
  llms: "ai",
  howto: "how-to",
  tutorial: "how-to",
};

// Topics found in the title or body: tag → words that suggest it.
const TOPICS: Record<string, string[]> = {
  rust: ["rust", "cargo", "tokio", "clippy"],
  typescript: ["typescript", "bun", "deno", "tsc"],
  javascript: ["javascript", "node.js", "npm"],
  sqlite: ["sqlite"],
  databases: ["database", "databases", "sql", "postgres"],
  pipelines: ["pipeline", "pipelines", "etl", "webhook", "ingest", "pipo"],
  ai: ["agent", "agents", "llm", "claude", "prompt"],
  "how-to": ["how to", "step by step", "guide"],
};

const MAX_TAGS = 6;

/** A watched markdown file → the fields of a post. Front matter is a `---` block of `key: value` lines. */
export function fromMarkdown(data: WatchedFile) {
  const text = (data.content ?? "").replace(/\r\n?/g, "\n");
  const fm: Record<string, string> = {};
  let body = text;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (m) {
    body = text.slice(m[0].length);
    for (const line of (m[1] ?? "").split("\n")) {
      const [, key, value] = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line) ?? [];
      if (key) fm[key.toLowerCase()] = unquote((value ?? "").trim());
    }
  }
  let title = fm.title;
  if (!title) {
    const h = /^#\s+(.+)$/m.exec(body);
    if (h) {
      title = h[1];
      body = body.replace(h[0], "");
    }
  }
  return {
    slug: fm.slug || data.name.replace(/\.md$/i, ""),
    title: title || data.name.replace(/\.md$/i, ""),
    author: fm.author,
    date: fm.date,
    tags: fm.tags,
    draft: fm.draft === "true" || fm.draft === "yes",
    body,
    updated_at: data.mtime,
  };
}

/** Any post (from a file, the API or a push) → one shape, with tags normalised and topics added. */
export function normalize(data: Record<string, unknown>, meta: Meta): Post {
  const title = clean(String(data.title ?? ""));
  const body = String(data.body ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
  const updated = isoOr(data.updated_at, new Date(meta.received_at).toISOString());
  const words = body.split(/\s+/).filter(Boolean).length;
  return {
    slug: slugify(String(data.slug ?? "")) || slugify(title) || "untitled",
    title: title || "Untitled",
    author: clean(String(data.author ?? "")) || "Anonymous",
    body,
    excerpt: excerpt(body),
    tags: tagsFor(data.tags, `${title}\n${body}`),
    draft: data.draft === true,
    reading_minutes: Math.max(1, Math.ceil(words / 200)),
    published_at: isoOr(data.date ?? data.published_at, updated),
    updated_at: updated,
    source: meta.input,
  };
}

function tagsFor(given: unknown, text: string): string[] {
  const list = Array.isArray(given) ? given : typeof given === "string" ? splitList(given) : [];
  const tags: string[] = [];
  for (const t of list) {
    const s = slugify(String(t));
    const tag = ALIASES[s] ?? s;
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  const lower = text.toLowerCase();
  for (const [tag, words] of Object.entries(TOPICS)) {
    if (
      !tags.includes(tag) &&
      words.some((w) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(w)}($|[^a-z0-9])`).test(lower))
    )
      tags.push(tag);
  }
  return tags.slice(0, MAX_TAGS).sort();
}

// `[a, b]`, `a, b` or `"a"` → ["a", "b"].
function splitList(s: string): string[] {
  return s
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((x) => unquote(x.trim()))
    .filter(Boolean);
}

function excerpt(body: string): string {
  const para =
    body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith("#") && !p.startsWith("```")) ?? "";
  const plain = clean(
    para
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`>#]/g, "")
      .replace(/^\s*[-+] /gm, ""),
  );
  return plain.length > 160 ? `${plain.slice(0, 157).replace(/\s+\S*$/, "")}…` : plain;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function isoOr(v: unknown, fallback: string): string {
  if (typeof v !== "string" && typeof v !== "number") return fallback;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function unquote(s: string): string {
  return /^(["']).*\1$/.test(s) ? s.slice(1, -1) : s;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
