// The dashboard renders data with DOM calls and textContent only (docs/spec.md §8): packet data is untrusted, so no
// script under public/ may parse HTML from strings.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "../public");

test("no UI script uses innerHTML, outerHTML, insertAdjacentHTML, document.write or eval", () => {
  const scripts = readdirSync(dir).filter((f) => f.endsWith(".js"));
  expect(scripts).toContain("app.js");
  expect(scripts).toContain("builder.js");
  for (const file of scripts) {
    const src = readFileSync(join(dir, file), "utf8");
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
      expect(
        src.includes(banned),
        `${file} uses ${banned}; build elements with h()/s() from dom.js and textContent`,
      ).toBe(false);
    }
  }
});
