// Copies the published schema (`bun run schema` → schema/pipo.schema.json) into the extension (spec §10.1).
import { copyFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
copyFileSync(join(root, "schema", "pipo.schema.json"), join(root, "packages", "vscode", "schemas", "pipo.schema.json"));
