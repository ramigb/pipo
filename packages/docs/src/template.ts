// The HTML shell around every docs page: header, sidebar, on-this-page list and prev/next links. Plain HTML; the
// stylesheet and script are docs.css and docs.js, copied next to the pages.
import { escapeHtml, type Heading, REPO } from "./markdown";
import type { Section } from "./nav";

export interface PageView {
  slug: string;
  title: string;
  html: string;
  headings: Heading[];
  description: string;
  /** Repo-relative source, for the "Edit this page" link; null for generated pages. */
  editPath: string | null;
  prev?: { slug: string; title: string };
  next?: { slug: string; title: string };
  /** The nav slug to mark as current (a generated child page marks its parent). */
  current: string;
  children: Map<string, { slug: string; title: string }[]>;
}

const href = (slug: string) => `${slug}.html`;

function sidebar(nav: Section[], view: PageView): string {
  return nav
    .map((section) => {
      const items = section.pages
        .map((p) => {
          const current = p.slug === view.current;
          const kids = view.children.get(p.slug) ?? [];
          const sub =
            current && kids.length
              ? `<ul>${kids.map((k) => `<li><a href="${href(k.slug)}"${k.slug === view.slug ? ' aria-current="page"' : ""}>${escapeHtml(k.title)}</a></li>`).join("")}</ul>`
              : "";
          const aria = p.slug === view.slug ? ' aria-current="page"' : current ? ' class="active"' : "";
          return `<li><a href="${href(p.slug)}"${aria}>${escapeHtml(p.title)}</a>${sub}</li>`;
        })
        .join("");
      return `<p class="nav-title">${escapeHtml(section.title)}</p><ul>${items}</ul>`;
    })
    .join("\n");
}

function toc(headings: Heading[]): string {
  const items = headings.filter((h) => h.level === 2 || h.level === 3);
  if (items.length < 2) return "";
  return `<nav class="toc" aria-label="On this page"><p class="nav-title">On this page</p><ul>${items
    .map((h) => `<li class="toc-${h.level}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
    .join("")}</ul></nav>`;
}

export function page(nav: Section[], view: PageView): string {
  const title = view.slug === "index" ? "Pipo documentation" : `${view.title} — Pipo docs`;
  const pager = [
    view.prev
      ? `<a class="pager-prev" href="${href(view.prev.slug)}"><span>Previous</span>${escapeHtml(view.prev.title)}</a>`
      : "<span></span>",
    view.next
      ? `<a class="pager-next" href="${href(view.next.slug)}"><span>Next</span>${escapeHtml(view.next.title)}</a>`
      : "<span></span>",
  ].join("");
  const edit = view.editPath
    ? `<a href="${REPO}/edit/main/${view.editPath}">Edit this page on GitHub</a>`
    : `<span>Generated from the Pipo source code.</span>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(view.description)}">
    <meta property="og:type" content="article">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(view.description)}">
    <meta name="theme-color" content="#f6f5ee" media="(prefers-color-scheme: light)">
    <meta name="theme-color" content="#171a15" media="(prefers-color-scheme: dark)">
    <link rel="icon" href="../favicon.svg" type="image/svg+xml">
    <link rel="stylesheet" href="docs.css">
    <script src="docs.js" defer></script>
  </head>
  <body>
    <a class="skip-link" href="#content">Skip to content</a>
    <header class="topbar">
      <button class="menu" type="button" aria-controls="sidebar" aria-expanded="false" aria-label="Open navigation">☰</button>
      <a class="brand" href="../index.html"><img src="../favicon.svg" width="28" height="28" alt=""><span>pipo<span class="dot">.</span></span></a>
      <a class="brand-docs" href="index.html">docs</a>
      <div class="search" role="search">
        <input id="search" type="search" placeholder="Search the docs" aria-label="Search the docs" autocomplete="off" spellcheck="false">
        <kbd>/</kbd>
        <ul id="search-results" role="listbox" hidden></ul>
      </div>
      <nav class="top-links" aria-label="Site">
        <a href="../index.html">Home</a>
        <a href="${REPO}">GitHub <span aria-hidden="true">↗</span></a>
      </nav>
    </header>
    <div class="layout">
      <nav id="sidebar" class="sidebar" aria-label="Documentation">
${sidebar(nav, view)}
      </nav>
      <main id="content" class="content">
        <article class="prose">
${view.html}
        </article>
        <nav class="pager" aria-label="Previous and next page">${pager}</nav>
        <footer class="page-footer">${edit}<span>Pipo is licensed under the <a href="${REPO}/blob/main/LICENSE">AGPLv3</a>.</span></footer>
      </main>
      ${toc(view.headings)}
    </div>
  </body>
</html>
`;
}
