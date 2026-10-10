import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "@pipo/cli/commands";
import { AGENTS, buildSchema, CHECKS, check, INPUTS, OUTPUTS, TAPS, TRANSFORMS } from "@pipo/spec";
import { buildPages } from "../src/build";
import { DIAGNOSTICS } from "../src/diagnostics";
import { fieldDoc } from "../src/fields";
import { highlightYaml, render, rewriteLink, slugify } from "../src/markdown";
import { PAGES } from "../src/nav";

const root = join(import.meta.dir, "../../..");
const { pages } = buildPages();
const byFile = new Map(pages.map((p) => [p.file, p]));

describe("site", () => {
  test("every nav entry builds a page", () => {
    for (const entry of PAGES) expect(byFile.has(`${entry.slug}.html`)).toBe(true);
  });

  test("every internal link reaches a page and an anchor that exist", () => {
    const broken: string[] = [];
    for (const p of pages) {
      for (const href of p.hrefs) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) continue;
        const [file = "", hash] = href.split("#", 2);
        const target = file ? byFile.get(file) : p;
        if (file === "pipo.schema.json") continue;
        if (!target) broken.push(`${p.source}: ${href} (no such page)`);
        else if (hash && !target.ids.includes(decodeURIComponent(hash)))
          broken.push(`${p.source}: ${href} (no such anchor)`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("links into the repo point at files that exist", () => {
    const missing: string[] = [];
    for (const p of pages) {
      for (const href of p.hrefs) {
        const m = href.match(/^https:\/\/github\.com\/ramigb\/pipo\/(?:blob|tree)\/main\/([^#?]+)/);
        if (!m) continue;
        try {
          readdirSync(join(root, m[1]!), { withFileTypes: true });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOTDIR") continue;
          missing.push(`${p.source}: ${m[1]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("guide examples", () => {
  const examples = pages
    .filter((p) => p.source.startsWith("docs/guide/"))
    .flatMap((p) =>
      [...p.markdown.matchAll(/```yaml\n(pipo: 1\n[\s\S]*?)```/g)].map((m) => [p.source, m[1] as string]),
    );

  test("there are full examples to check", () => {
    expect(examples.length).toBeGreaterThan(5);
  });

  test.each(examples.map(([source, src]) => [`${source} ${/name: (\S+)/.exec(src!)?.[1]}`, src]))(
    "%s passes pipo check",
    (_, src) => {
      const errors = check(src as string, { fs: false }).filter((d) => d.severity === "error");
      expect(errors.map((d) => `${d.code} ${d.message}`)).toEqual([]);
    },
  );
});

describe("reference data covers the code", () => {
  test("every diagnostic code pipo check reports is documented, once", () => {
    const used = new Set<string>();
    for (const dir of ["packages/spec/src", "packages/cli/src"]) {
      for (const f of readdirSync(join(root, dir), { recursive: true }) as string[]) {
        if (!f.endsWith(".ts")) continue;
        for (const m of readFileSync(join(root, dir, f), "utf8").matchAll(/["'`](P0\d\d)["'`]/g)) used.add(m[1]!);
      }
    }
    const documented = DIAGNOSTICS.map((d) => d.code);
    expect(new Set(documented).size).toBe(documented.length);
    expect([...used].filter((c) => !documented.includes(c)).sort()).toEqual([]);
    expect(documented.filter((c) => !used.has(c))).toEqual([]);
  });

  test("every connector field and top-level key has a description", () => {
    const groups = { input: INPUTS, tap: TAPS, transform: TRANSFORMS, agent: AGENTS, output: OUTPUTS, check: CHECKS };
    const missing: string[] = [];
    for (const [group, entries] of Object.entries(groups)) {
      for (const [name, m] of Object.entries(entries)) {
        for (const field of Object.keys((m.with as { properties?: object }).properties ?? {})) {
          if (!fieldDoc(group, name, field)) missing.push(`${group}.${name}.${field}`);
        }
      }
    }
    for (const key of Object.keys((buildSchema() as { properties: object }).properties)) {
      if (!fieldDoc("top", "pipo", key)) missing.push(`top.pipo.${key}`);
    }
    expect(missing).toEqual([]);
  });

  test("every CLI command is covered by a guide page", () => {
    const guide = pages
      .filter((p) => p.source.startsWith("docs/guide/"))
      .map((p) => p.markdown)
      .join("\n");
    const uncovered = COMMANDS.map((c) => c.name).filter((n) => n !== "help" && !guide.includes(`pipo ${n}`));
    expect(uncovered).toEqual([]);
  });
});

describe("markdown", () => {
  const links = { source: "docs/guide/a.md", pages: new Map([["docs/spec.md", "spec.html"]]), isDir: () => true };

  test("heading ids follow GitHub's slugs", () => {
    expect(slugify("9.3 Change protocol: propose → validate → apply")).toBe(
      "93-change-protocol-propose--validate--apply",
    );
    expect(slugify("`via: http`")).toBe("via-http");
    const r = render("# T\n\n## Dup\n\n## Dup\n", links);
    expect(r.headings.map((h) => h.id)).toEqual(["t", "dup", "dup-1"]);
  });

  test("links to pages become .html, other repo paths GitHub links", () => {
    expect(rewriteLink("../spec.md#73-delivery-guarantees", links)).toBe("spec.html#73-delivery-guarantees");
    expect(rewriteLink("../../examples/heartbeat", links)).toBe(
      "https://github.com/ramigb/pipo/tree/main/examples/heartbeat",
    );
    expect(rewriteLink("https://bun.sh", links)).toBe("https://bun.sh");
    expect(rewriteLink("#here", links)).toBe("#here");
  });

  test("YAML highlighting keeps the text and marks keys, strings, templates and comments", () => {
    const src = `name: x  # c\nmessage: "id \${meta.packet_id}"\n- data.a > 1`;
    const html = highlightYaml(src);
    expect(
      html
        .replace(/<[^>]+>/g, "")
        .replace(/&quot;/g, '"')
        .replace(/&gt;/g, ">"),
    ).toBe(src);
    expect(html).toContain('<span class="t-key">name</span>');
    expect(html).toContain('<span class="t-com"># c</span>');
    expect(html).toContain('<span class="t-tpl">${meta.packet_id}</span>');
  });
});
