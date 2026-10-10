// Rebuilds the static site in ./out/site from ./data/blog.db. blog.pipo runs it as a `tap: exec` before the post is
// written, with that post as JSON on stdin, so the post is merged in by slug. Run it by hand to rebuild from the
// database alone:  bun examples/blog/build-site.ts < /dev/null
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Post {
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
}

const DIR = import.meta.dir;
const DB = join(DIR, "data", "blog.db");
const SITE = join(DIR, "out", "site");

function stored(): Post[] {
  if (!existsSync(DB)) return [];
  const db = new Database(DB, { readonly: true });
  try {
    const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'posts'").get();
    if (!table) return [];
    return db
      .query("SELECT * FROM posts")
      .all()
      .map((r: any) => ({ ...r, tags: JSON.parse(r.tags || "[]"), draft: Boolean(r.draft) }));
  } finally {
    db.close();
  }
}

function page(title: string, root: string, main: string, current: string): string {
  const nav = tags
    .map((t) => `<a href="${root}tags/${t}.html"${t === current ? ' aria-current="page"' : ""}>#${t}</a>`)
    .join(" ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${root}style.css">
</head>
<body>
<header><a class="home" href="${root}index.html">Pipo blog</a><nav>${nav}</nav></header>
<main>
${main}
</main>
<footer>Built by <code>blog.pipo</code> from <code>data/blog.db</code>.</footer>
</body>
</html>
`;
}

function list(ps: Post[], root: string): string {
  if (ps.length === 0) return "<p>No posts yet.</p>";
  return ps
    .map(
      (p) => `<article class="card">
<h2><a href="${root}posts/${p.slug}.html">${esc(p.title)}</a></h2>
${byline(p)}
<p>${esc(p.excerpt)}</p>
${chips(p, root)}
</article>`,
    )
    .join("\n");
}

function article(p: Post): string {
  return `<article>
<h1>${esc(p.title)}</h1>
${byline(p)}
${chips(p, "../")}
${markdown(p.body)}
</article>`;
}

function byline(p: Post): string {
  return `<p class="meta">${esc(p.author)} · <time datetime="${esc(p.published_at)}">${p.published_at.slice(0, 10)}</time> · ${p.reading_minutes} min read</p>`;
}

function chips(p: Post, root: string): string {
  return `<p class="tags">${p.tags.map((t) => `<a href="${root}tags/${t}.html">#${t}</a>`).join(" ")}</p>`;
}

// A small markdown subset: headings, paragraphs, lists, quotes, fenced code, and inline code, bold, italics, links.
function markdown(src: string): string {
  const out: string[] = [];
  const rest = src.split("\n");
  // Takes lines from the front while they match.
  const take = (ok: (l: string) => boolean) => {
    const got: string[] = [];
    while (rest.length > 0 && ok(rest[0] ?? "")) got.push(rest.shift() ?? "");
    return got;
  };
  const LIST = /^\s*([-*+]|\d+\.)\s/;
  const BLOCK = /^(```|#{1,4}\s|>|\s*([-*+]|\d+\.)\s)/;
  while (rest.length > 0) {
    const line = rest[0] ?? "";
    if (line.startsWith("```")) {
      rest.shift();
      const code = take((l) => !l.startsWith("```"));
      rest.shift();
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    } else if (/^#{1,4}\s/.test(line)) {
      rest.shift();
      const level = line.indexOf(" ");
      out.push(`<h${level}>${inline(line.slice(level).trim())}</h${level}>`);
    } else if (LIST.test(line)) {
      const items = take((l) => LIST.test(l)).map((l) => `<li>${inline(l.replace(/^\s*([-*+]|\d+\.)\s+/, ""))}</li>`);
      out.push(/^\s*\d+\./.test(line) ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
    } else if (line.startsWith(">")) {
      const quote = take((l) => l.startsWith(">")).map((l) => l.replace(/^>\s?/, ""));
      out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
    } else if (line.trim() === "") {
      rest.shift();
    } else {
      const para = [rest.shift() ?? "", ...take((l) => l.trim() !== "" && !BLOCK.test(l))];
      out.push(`<p>${inline(para.join(" "))}</p>`);
    }
  }
  return out.join("\n");
}

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/|#|\.\.?\/)[^\s)]*)\)/g, '<a href="$2">$1</a>');
}

function esc(s: string): string {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

const CSS = `:root {
  --bg: #fbfaf7; --fg: #1d1d1f; --muted: #6b6b70; --line: #e4e2dc; --accent: #2b59c3; --chip: #eef2fb;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #151517; --fg: #ececee; --muted: #9a9aa2; --line: #2c2c31; --accent: #8fb0ff; --chip: #1f2636; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.65 Georgia, "Iowan Old Style", serif; }
header, main, footer { max-width: 42rem; margin: 0 auto; padding: 0 16px; }
header { padding-top: 2rem; padding-bottom: 1rem; border-bottom: 1px solid var(--line); }
.home { font: 700 1.4rem/1 system-ui, sans-serif; color: var(--fg); text-decoration: none; }
nav { margin-top: .75rem; display: flex; flex-wrap: wrap; gap: .4rem; }
nav a, .tags a { font: .8rem system-ui, sans-serif; padding: .15rem .55rem; border-radius: 999px;
  background: var(--chip); color: var(--accent); text-decoration: none; }
nav a[aria-current] { background: var(--accent); color: var(--bg); }
.card { padding: 1.25rem 0; border-bottom: 1px solid var(--line); }
.card h2 { margin: 0; font: 600 1.3rem/1.3 system-ui, sans-serif; }
.card h2 a { color: var(--fg); text-decoration: none; }
.card h2 a:hover { color: var(--accent); }
.meta { margin: .25rem 0; color: var(--muted); font: .85rem system-ui, sans-serif; }
.tags { display: flex; flex-wrap: wrap; gap: .4rem; margin: .5rem 0; }
h1 { font: 700 2rem/1.2 system-ui, sans-serif; margin: 2rem 0 .5rem; }
a { color: var(--accent); }
pre { overflow-x: auto; padding: 1rem; background: var(--chip); border-radius: 6px; font-size: .85rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 3px solid var(--line); color: var(--muted); }
footer { padding-top: 2rem; padding-bottom: 3rem; color: var(--muted); font: .8rem system-ui, sans-serif; }
`;

const incoming = (await Bun.stdin.text()).trim();
const bySlug = new Map(stored().map((p) => [p.slug, p]));
if (incoming) {
  const p = JSON.parse(incoming) as Post;
  bySlug.set(p.slug, p);
}
const posts = [...bySlug.values()]
  .filter((p) => !p.draft)
  .sort((a, b) => b.published_at.localeCompare(a.published_at) || a.slug.localeCompare(b.slug));
const tags = [...new Set(posts.flatMap((p) => p.tags))].sort();

// Build next to the site, then swap, so a reader never sees half a site.
const next = `${SITE}.next`;
rmSync(next, { recursive: true, force: true });
mkdirSync(join(next, "posts"), { recursive: true });
mkdirSync(join(next, "tags"), { recursive: true });
writeFileSync(join(next, "style.css"), CSS);
writeFileSync(join(next, "index.html"), page("Blog", "", list(posts, ""), ""));
for (const t of tags) {
  const tagged = posts.filter((p) => p.tags.includes(t));
  writeFileSync(join(next, "tags", `${t}.html`), page(`#${t}`, "../", list(tagged, "../"), t));
}
for (const p of posts) writeFileSync(join(next, "posts", `${p.slug}.html`), page(p.title, "../", article(p), ""));
rmSync(SITE, { recursive: true, force: true });
renameSync(next, SITE);
console.log(`built ${posts.length} posts and ${tags.length} tags into ${SITE}`);
