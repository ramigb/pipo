// The dashboard's static files (docs/spec.md §8): plain HTML, ES modules and CSS in `public/`, no build step. The
// engine serves them at `/ui` through serveUi(); the app reads the engine's own `/api` and `/events`.
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const uiRoot = fileURLToPath(new URL("../public", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

/**
 * The response for a request path under `/ui`: the file if it exists, `index.html` for unknown paths without an
 * extension (client-side routes), 404 for a missing asset or a path that escapes the UI folder.
 */
export async function serveUi(pathname: string): Promise<Response> {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname.replace(/^\/ui\/?/, ""));
  } catch {
    return notFound();
  }
  if (rel.includes("\0") || rel.includes("\\")) return notFound();
  const file = normalize(join(uiRoot, rel || "index.html"));
  if (file !== uiRoot && !file.startsWith(uiRoot + sep)) return notFound();
  const ext = file.slice(file.lastIndexOf("."));
  const target = Bun.file(file);
  if (rel && (await target.exists()) && !file.endsWith(sep)) return reply(target, TYPES[ext]);
  if (rel && /\.[a-z0-9]+$/i.test(rel)) return notFound();
  return reply(Bun.file(join(uiRoot, "index.html")), TYPES[".html"]);
}

const reply = (file: ReturnType<typeof Bun.file>, type = "application/octet-stream") =>
  new Response(file, { headers: { "content-type": type, "cache-control": "no-cache" } });

const notFound = () =>
  Response.json({ error: "no such UI file", hint: "the dashboard lives at /ui", code: "not_found" }, { status: 404 });
