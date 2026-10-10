// The shop API's request handler. Production (examples/deploy/prod-server.ts) loads the built file and calls
// `fetch`; `bun src/server.ts` runs it locally.
import { type Line, quote } from "./cart";

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname === "/quote" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { lines?: Line[]; code?: string } | null;
      if (!Array.isArray(body?.lines))
        return Response.json({ error: "send {lines: [{sku, qty, price}]}" }, { status: 400 });
      return Response.json(quote(body.lines, body.code));
    }
    if (url.pathname === "/") return new Response("shop-api: POST /quote {lines, code?}\n");
    return Response.json({ error: "not found" }, { status: 404 });
  },
};
