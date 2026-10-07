// Pipo home (docs/spec.md §7.1): --home, else $PIPO_HOME, else ~/.pipo, resolved like the runner does.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveHome(home?: string): string {
  return resolve(home ?? process.env.PIPO_HOME ?? join(homedir(), ".pipo"));
}

export const configPath = (home: string) => join(home, "config.yaml");
export const logPath = (home: string, pipeline: string) => join(home, "logs", `${pipeline}.log`);
export const engineEntryPath = (home: string) => join(home, "run", "engine.json");
export const journalPath = (home: string, pipeline: string) => join(home, "pipelines", pipeline, "journal.db");
/** The engine's event cursor for a pipeline: the last journal `seq` it streamed (D27). */
export const cursorPath = (home: string, pipeline: string) => join(home, "engine", "cursors", `${pipeline}.json`);
