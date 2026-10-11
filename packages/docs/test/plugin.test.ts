// The Claude Code plugin (plugins/pipo, docs/spec.md §9.4, D81): its skill's full examples pass `pipo check`, the
// resources it names exist on the MCP endpoint, and the plugin, its MCP server and the marketplace agree.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "@pipo/spec";
import { connectorsMarkdown, guidePages } from "../../engine/src/mcp";

const root = join(import.meta.dir, "../../..");
const skill = readFileSync(join(root, "plugins/pipo/skills/pipo/SKILL.md"), "utf8");
const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

describe("the Claude Code plugin", () => {
  test("the skill has frontmatter with a name and a description", () => {
    const front = /^---\nname: pipo\ndescription: (.+)\n---\n/.exec(skill);
    expect(front?.[1]?.length).toBeGreaterThan(50);
  });

  test("every full YAML example in the skill passes pipo check", () => {
    const examples = [...skill.matchAll(/```yaml\n(pipo: 1\n[\s\S]*?)```/g)].map((m) => m[1] as string);
    expect(examples.length).toBeGreaterThan(0);
    for (const src of examples) {
      const errors = check(src, { fs: false }).filter((d) => d.severity === "error");
      expect(errors.map((d) => `${d.code} ${d.message}`)).toEqual([]);
    }
  });

  test("the resources the skill names exist", () => {
    const pages = new Set(guidePages().map((p) => p.slug));
    for (const m of skill.matchAll(/pipo:\/\/docs\/guide\/([a-z0-9-]+)\.md/g)) expect(pages).toContain(m[1] as string);
    expect(skill).toContain("pipo://docs/reference/connectors.md");
    expect(connectorsMarkdown()).toContain("### input `http`");
  });

  test("plugin, MCP server and marketplace agree", () => {
    const plugin = json("plugins/pipo/.claude-plugin/plugin.json");
    const market = json(".claude-plugin/marketplace.json");
    expect(market.plugins).toEqual([expect.objectContaining({ name: plugin.name, source: "./plugins/pipo" })]);
    expect(json("plugins/pipo/.mcp.json").mcpServers.pipo).toEqual({ type: "http", url: "http://127.0.0.1:4747/mcp" });
    expect(plugin.license).toBe(json("package.json").license);
  });
});
