// Local preview of the standalone static site. Deploy site/ directly; no build is needed.
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

const root = await realpath(resolve(import.meta.dir, "../site"));
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 4173,
  async fetch(request) {
    let path: string;
    try {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      path = await realpath(resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`));
    } catch {
      return new Response("Not found", { status: 404 });
    }
    if (!path.startsWith(`${root}${sep}`)) return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : file, {
      headers: { "Content-Type": file.type, "X-Content-Type-Options": "nosniff" },
    });
  },
});
console.log(`Pipo website: ${server.url}`);
