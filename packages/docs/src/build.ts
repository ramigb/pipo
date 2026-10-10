// Builds the documentation site: the Markdown under docs/ plus the reference pages generated from the code
// (reference.ts), rendered into static HTML with a search index. Output goes to site/docs by default, which the
// GitHub Pages workflow publishes next to the landing page.
//
//   bun run docs                  build into site/docs
//   bun run docs --out <dir>      build somewhere else
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { render } from "./markdown";
import { NAV, PAGES } from "./nav";
import { type GeneratedPage, generate, schemaJson } from "./reference";
import { page } from "./template";

const root = resolve(import.meta.dir, "../../..");

export interface BuiltPage {
  slug: string;
  title: string;
  file: string;
  html: string;
  /** Links and ids, for the link check in docs.test.ts. */
  hrefs: string[];
  ids: string[];
  markdown: string;
  source: string;
}

interface Source {
  slug: string;
  title: string;
  source: string;
  markdown: string;
  generated: boolean;
  parent?: string;
}

function sources(): Source[] {
  const out: Source[] = [];
  for (const entry of PAGES) {
    if (entry.generate) {
      for (const g of generate(entry.generate) as GeneratedPage[]) out.push({ ...g, generated: true });
    } else if (entry.source) {
      const path = join(root, entry.source);
      if (!existsSync(path))
        throw new Error(`${entry.source} is listed in nav.ts but doesn't exist; write it or remove the entry`);
      out.push({
        slug: entry.slug,
        title: entry.title,
        source: entry.source,
        markdown: readFileSync(path, "utf8"),
        generated: false,
      });
    }
  }
  return out;
}

/** Renders every page; writes nothing. */
export function buildPages(): { pages: BuiltPage[]; search: unknown[] } {
  const all = sources();
  const links = new Map<string, string>();
  for (const s of all) {
    links.set(s.source, `${s.slug}.html`);
    links.set(`docs/reference/${s.slug}.md`, `${s.slug}.html`);
    if (s.slug.startsWith("example-")) links.set(`examples/${s.title}`, `${s.slug}.html`);
  }
  links.set("docs/reference/pipo.schema.json", "pipo.schema.json");
  // The guide's README is the index page; the repo README links into docs/ as well.
  const isDir = (p: string) => {
    try {
      return statSync(join(root, p)).isDirectory();
    } catch {
      return false;
    }
  };
  const children = new Map<string, { slug: string; title: string }[]>();
  for (const s of all)
    if (s.parent) children.set(s.parent, [...(children.get(s.parent) ?? []), { slug: s.slug, title: s.title }]);
  const order = PAGES.map((p) => p.slug);
  const search: unknown[] = [];
  const pages = all.map((s) => {
    const r = render(s.markdown, { source: s.source, pages: links, isDir });
    const idx = order.indexOf(s.slug);
    const prev = idx > 0 ? PAGES[idx - 1] : undefined;
    const next = idx >= 0 && idx < PAGES.length - 1 ? PAGES[idx + 1] : undefined;
    const description = r.sections.find((x) => x.text)?.text.slice(0, 160) ?? s.title;
    const html = page(NAV, {
      slug: s.slug,
      title: s.parent ? `Example: ${s.title}` : r.title || s.title,
      html: r.html,
      headings: r.headings,
      description,
      editPath: s.generated ? null : s.source,
      prev: prev && { slug: prev.slug, title: prev.title },
      next: next && { slug: next.slug, title: next.title },
      current: s.parent ?? s.slug,
      children,
    });
    for (const sec of r.sections) {
      search.push({ p: s.slug, t: s.parent ? `Example: ${s.title}` : s.title, h: sec.heading, a: sec.id, x: sec.text });
    }
    return {
      slug: s.slug,
      title: s.title,
      file: `${s.slug}.html`,
      html,
      hrefs: [...r.html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&")),
      ids: r.headings.map((h) => h.id),
      markdown: s.markdown,
      source: s.source,
    };
  });
  return { pages, search };
}

export function build(out: string): BuiltPage[] {
  const { pages, search } = buildPages();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const p of pages) writeFileSync(join(out, p.file), p.html);
  writeFileSync(join(out, "search.json"), JSON.stringify(search));
  writeFileSync(join(out, "pipo.schema.json"), schemaJson());
  for (const asset of ["docs.css", "docs.js"]) cpSync(join(import.meta.dir, "../assets", asset), join(out, asset));
  return pages;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--out");
  const out = resolve(i >= 0 && args[i + 1] ? args[i + 1]! : join(root, "site/docs"));
  const pages = build(out);
  console.log(`Built ${pages.length} pages into ${out}`);
}
