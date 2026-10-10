// Markdown to HTML for the docs site: Bun's built-in renderer, then GitHub-compatible heading ids (so links written
// for GitHub, such as `spec.md#93-change-protocol-propose--validate--apply`, work on the site too), callouts,
// rewritten links and highlighted code.
import { dirname, join, normalize } from "node:path";

export const REPO = "https://github.com/ramigb/pipo";

export interface Heading {
  level: number;
  id: string;
  text: string;
}

export interface Rendered {
  html: string;
  title: string;
  headings: Heading[];
  /** Plain text per section, for the search index. */
  sections: { id: string; heading: string; text: string }[];
}

export interface LinkContext {
  /** The page's source path, relative to the repo root (e.g. `docs/guide/inputs.md`); generated pages use a virtual one. */
  source: string;
  /** Repo-relative source path → the page's output file name (`inputs.html`). */
  pages: Map<string, string>;
  /** Paths that exist in the repo, for choosing `blob` or `tree` links (a directory has no extension). */
  isDir?: (repoPath: string) => boolean;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

export function unescapeHtml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function stripTags(html: string): string {
  return unescapeHtml(html.replace(/<[^>]*>/g, ""));
}

/** GitHub's heading slug: lower case, drop everything but letters, digits, spaces, `-` and `_`, spaces to `-`. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

export function render(markdown: string, links: LinkContext): Rendered {
  let html = Bun.markdown.html(markdown);
  const headings: Heading[] = [];
  const seen = new Map<string, number>();
  html = html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_, level: string, inner: string) => {
    const text = stripTags(inner).trim();
    const base = slugify(text) || "section";
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const id = n ? `${base}-${n}` : base;
    headings.push({ level: Number(level), id, text });
    if (level === "1") return `<h1 id="${id}">${inner}</h1>`;
    return `<h${level} id="${id}">${inner}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`;
  });
  html = callouts(html);
  html = html.replace(
    /<a href="([^"]*)"/g,
    (_, href: string) => `<a href="${escapeHtml(rewriteLink(unescapeHtml(href), links))}"`,
  );
  html = html.replace(
    /<img src="([^"]*)"/g,
    (_, src: string) => `<img src="${escapeHtml(rewriteImage(unescapeHtml(src), links))}"`,
  );
  html = html.replace(
    /<pre><code class="language-([\w-]+)">([\s\S]*?)<\/code><\/pre>/g,
    (_, lang: string, code: string) => codeBlock(lang, unescapeHtml(code)),
  );
  html = html.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (_, code: string) =>
    codeBlock("text", unescapeHtml(code)),
  );
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");
  const title = headings.find((h) => h.level === 1)?.text ?? "Pipo";
  return { html, title, headings, sections: sections(html, headings) };
}

/** `> [!NOTE]` (and TIP, WARNING, IMPORTANT, CAUTION) blockquotes become callouts, as GitHub draws them. */
function callouts(html: string): string {
  return html.replace(
    /<blockquote>\s*<p>\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*([\s\S]*?)<\/blockquote>/g,
    (_, kind: string, rest: string) => {
      const label = kind[0] + kind.slice(1).toLowerCase();
      return `<aside class="callout callout-${kind.toLowerCase()}"><p class="callout-title">${label}</p><p>${rest}</aside>`;
    },
  );
}

/**
 * A relative link is resolved against the page's source file: a docs page becomes its `.html` file, anything else
 * in the repo a GitHub link. Absolute URLs and in-page anchors are left alone.
 */
export function rewriteLink(href: string, links: LinkContext): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) return href;
  const [path = "", hash] = href.split("#", 2);
  if (!path) return href;
  const target = normalize(join(dirname(links.source), path)).replace(/\/$/, "");
  const page = links.pages.get(target);
  if (page) return hash ? `${page}#${hash}` : page;
  if (target.startsWith("..")) return href;
  const kind = links.isDir?.(target) ? "tree" : "blob";
  return `${REPO}/${kind}/main/${target}${hash ? `#${hash}` : ""}`;
}

function rewriteImage(src: string, links: LinkContext): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return src;
  const target = normalize(join(dirname(links.source), src));
  return `https://raw.githubusercontent.com/ramigb/pipo/main/${target}`;
}

function sections(html: string, headings: Heading[]): Rendered["sections"] {
  const out: Rendered["sections"] = [];
  const parts = html.split(/(?=<h[1-3] id=")/);
  for (const part of parts) {
    const m = part.match(/^<h[1-3] id="([^"]+)"/);
    const heading = m ? headings.find((h) => h.id === m[1]) : undefined;
    const body = part.replace(/^<h([1-3])[^>]*>[\s\S]*?<\/h\1>/, "").replace(/<pre[\s\S]*?<\/pre>/g, " ");
    const text = stripTags(body).replace(/\s+/g, " ").trim();
    out.push({ id: heading?.id ?? "", heading: heading?.text ?? "", text: text.slice(0, 2000) });
  }
  return out.filter((s) => s.heading || s.text);
}

// --- Code highlighting: a small, line-based tokenizer for the languages the docs use. ---

function codeBlock(lang: string, code: string): string {
  const body =
    lang === "yaml" || lang === "pipo"
      ? highlightYaml(code)
      : lang === "sh" || lang === "bash"
        ? highlightSh(code)
        : escapeHtml(code);
  const label = lang === "text" ? "" : ` data-lang="${escapeHtml(lang)}"`;
  return `<div class="code"${label}><button class="copy" type="button" aria-label="Copy code">Copy</button><pre tabindex="0"><code>${body}</code></pre></div>`;
}

const span = (cls: string, text: string) => `<span class="${cls}">${escapeHtml(text)}</span>`;

/** Quoted strings and `${…}` templates within a YAML value. */
function yamlValue(text: string, inString = false): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const tpl = rest.match(/^\$\{(?:[^{}]|\{[^{}]*\})*\}/);
    const str = inString ? null : rest.match(/^"(?:[^"\\]|\\.)*"|^'(?:[^']|'')*'/);
    if (tpl) {
      out += span("t-tpl", tpl[0]);
      i += tpl[0].length;
    } else if (str && (i === 0 || /[\s:[{,(=]/.test(text[i - 1]!))) {
      const q = escapeHtml(str[0][0]!);
      out += `<span class="t-str">${q}${yamlValue(str[0].slice(1, -1), true)}${q}</span>`;
      i += str[0].length;
    } else {
      const next = rest.slice(1).search(inString ? /\$\{/ : /\$\{|"|'/);
      const chunk = next < 0 ? rest : rest.slice(0, next + 1);
      out += escapeHtml(chunk);
      i += chunk.length;
    }
  }
  return out;
}

/** The start of a YAML comment: `#` at the line start or after a space, outside quotes. */
function commentStart(line: string): number {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s:[{,]/.test(line[i - 1]!)) quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return i;
  }
  return -1;
}

export function highlightYaml(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      const hash = commentStart(line);
      const body = hash >= 0 ? line.slice(0, hash) : line;
      const comment = hash >= 0 ? span("t-com", line.slice(hash)) : "";
      const key = body.match(/^(\s*(?:- )?)([A-Za-z_$][\w$.-]*|"[^"]*")(:)(?=\s|$)/);
      if (key) {
        return `${escapeHtml(key[1]!)}${span("t-key", key[2]!)}${escapeHtml(key[3]!)}${yamlValue(body.slice(key[0].length))}${comment}`;
      }
      return yamlValue(body) + comment;
    })
    .join("\n");
}

export function highlightSh(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      const hash = commentStart(line);
      const body = hash >= 0 ? line.slice(0, hash) : line;
      const comment = hash >= 0 ? span("t-com", line.slice(hash)) : "";
      const prompt = body.match(/^(\$ )/);
      const rest = prompt ? body.slice(2) : body;
      const cmd = rest.match(/^(\s*(?:[A-Z_][A-Z0-9_]*=\S+\s+)*)(\S+)/);
      const head = cmd ? `${escapeHtml(cmd[1]!)}${span("t-cmd", cmd[2]!)}` : "";
      const tail = cmd ? rest.slice(cmd[0].length) : rest;
      return (prompt ? span("t-prompt", "$ ") : "") + head + yamlValue(tail) + comment;
    })
    .join("\n");
}
