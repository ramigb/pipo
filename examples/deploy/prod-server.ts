// "Production" for the deploy example: a host that serves one release of the shop API at a time and takes new ones
// over HTTP, as a platform's deploy API would. Release <sha> is the artifact the ci pipeline built,
// <artifacts>/<sha>/app.js. A release is switched in only once it loads and answers its own /health; otherwise the
// host keeps the one it has and answers 422.
//   POST /_deploy {sha}   switch to that release      GET /_version   {sha, previous, deployed_at, history}
//   anything else         the live release's own fetch
//   bun examples/deploy/prod-server.ts   (PORT, default 8795; ARTIFACTS, default ../ci/out/artifacts)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface Release {
  sha: string;
  deployed_at: string;
  message?: string;
}
type App = { fetch(req: Request): Response | Promise<Response> };

export async function prodServer(o: { port?: number; artifacts?: string; state?: string; quiet?: boolean } = {}) {
  const log = o.quiet ? () => {} : console.log;
  const artifacts = o.artifacts ?? process.env.ARTIFACTS ?? join(import.meta.dir, "..", "ci", "out", "artifacts");
  const statePath = o.state ?? join(import.meta.dir, "out", "prod.json");
  let history: Release[] = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")).history : [];
  let app: App | null = null;

  const load = async (sha: string): Promise<App> => {
    const file = join(artifacts, sha, "app.js");
    if (!existsSync(file)) throw new Error(`no artifact for ${sha} at ${file}; has ci built it?`);
    const mod = (await import(file)).default as App;
    if (typeof mod?.fetch !== "function") throw new Error(`${file} has no default export with fetch()`);
    const health = await mod.fetch(new Request("http://prod/health"));
    if (health.status !== 200) throw new Error(`${sha.slice(0, 7)} answered /health with ${health.status}`);
    return mod;
  };
  const save = () => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify({ history }, null, 2)}\n`);
  };

  if (history[0]) app = await load(history[0].sha).catch(() => null);

  const server = Bun.serve({
    port: o.port ?? Number(process.env.PORT ?? 8795),
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/_version") {
        const [live, previous] = history;
        return Response.json({
          sha: live?.sha ?? null,
          previous: previous?.sha ?? null,
          deployed_at: live?.deployed_at ?? null,
          history: history.slice(0, 10),
        });
      }
      if (url.pathname === "/_deploy" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { sha?: string; message?: string };
        if (!body.sha) return Response.json({ error: "send {sha}" }, { status: 400 });
        // A retried request for the live release changes nothing.
        if (history[0]?.sha === body.sha) return Response.json({ sha: body.sha, unchanged: true });
        try {
          app = await load(body.sha);
        } catch (e) {
          const live = history[0]?.sha.slice(0, 7) ?? "nothing";
          log(`refused ${body.sha.slice(0, 7)}: ${(e as Error).message}`);
          return Response.json(
            { error: `release refused, still serving ${live}: ${(e as Error).message}` },
            { status: 422 },
          );
        }
        history = [{ sha: body.sha, deployed_at: new Date().toISOString(), message: body.message }, ...history].slice(
          0,
          50,
        );
        save();
        log(`live: ${body.sha.slice(0, 7)} ${body.message ?? ""}`);
        return Response.json({ sha: body.sha, previous: history[1]?.sha ?? null });
      }
      if (!app) return new Response("nothing deployed yet\n", { status: 503 });
      return app.fetch(req);
    },
  });
  return server;
}

if (import.meta.main) {
  const s = await prodServer();
  console.log(`production on http://127.0.0.1:${s.port} (deploys: POST /_deploy, live release: GET /_version)`);
}
