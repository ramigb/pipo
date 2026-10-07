// Dashboard settings (docs/spec.md §8, D72): the builder's workspace, kept as `engine.workspace` in config.yaml, and
// the folder listing the dashboard's folder picker walks. Saving rewrites only that key and keeps the file's comments.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseDocument } from "yaml";
import { parseConfig } from "./config";
import { configPath } from "./home";
import { HttpError } from "./http-error";

const bad = (message: string, hint: string) => new HttpError(400, message, hint, "bad_request");

/** A folder the builder can use: absolute, existing (made when `create`), a directory. Answers its resolved path. */
export function checkWorkspace(path: unknown, create = false): string {
  if (typeof path !== "string" || !isAbsolute(path.replace(/^~(?=\/|$)/, homedir())))
    throw bad("`path` must be an absolute folder path", 'send {"path": "/home/me/pipes"}');
  const dir = resolve(path.replace(/^~(?=\/|$)/, homedir()));
  if (!existsSync(dir)) {
    if (!create) throw bad(`${dir} does not exist`, 'pick another folder, or send {"create": true} to make it');
    mkdirSync(dir, { recursive: true });
  }
  if (!statSync(dir).isDirectory()) throw bad(`${dir} is a file, not a folder`, "pick a folder");
  return dir;
}

/** Write `engine.workspace` into `<home>/config.yaml`, keeping everything else (and its comments) as it is. */
export function saveWorkspace(home: string, dir: string) {
  const file = configPath(home);
  const doc = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "");
  if (doc.errors.length)
    throw bad(`${file} is not valid YAML: ${doc.errors[0]?.message}`, "fix the file, then save the workspace again");
  doc.setIn(["engine", "workspace"], dir);
  const text = doc.toString();
  parseConfig(text, file); // a config the engine couldn't start with is never written
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

/** The sub-folders of `path` (default: the home folder), for the folder picker. Dot folders and node_modules are left out. */
export function listFolders(path: string | null): { path: string; parent: string | null; folders: string[] } {
  const dir = path ? checkWorkspace(path) : homedir();
  let folders: string[] = [];
  try {
    folders = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {} // unreadable: shown empty
  const parent = dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, folders: folders.slice(0, 500) };
}
