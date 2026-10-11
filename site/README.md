# Pipo website

A standalone static landing page for Pipo. Plain HTML, CSS and JavaScript, local assets and system fonts. No framework, dependencies, API calls or build step for the landing page itself; the docs under `docs/` are generated (see [Documentation](#documentation)). This site is separate from the runtime dashboard in `packages/ui`.

## Preview

From the repository root, with Bun ≥ 1.3 installed:

```sh
bun run site
# http://127.0.0.1:4173
```

Alternatively, serve the folder with any static server:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory site
```

## Documentation

The docs live under `site/docs/` on the published site, built from `docs/guide/*.md`, `docs/spec.md`, `docs/roadmap.md` and reference pages generated from the code (`packages/docs`). The build output is git-ignored; build it before previewing:

```sh
bun run docs    # writes site/docs
bun run site    # http://127.0.0.1:4173/docs/index.html
```

## Publish

The [GitHub Pages workflow](../.github/workflows/pages.yml) tests and builds the docs, then deploys this folder, when `site/`, the docs sources or the workflow change on `main`. It can also be started manually from the repository's **Actions** tab, selecting **Deploy Pipo website and docs to GitHub Pages** and the `main` branch.

To enable it, open the repository's **Settings → Pages → Build and deployment**, and set **Source** to **GitHub Actions**. Commit and push the website and workflow to `main`; the deployment run reports the published URL. No personal access token or extra secrets are needed. The workflow uses GitHub's `github-pages` environment and the repository's `GITHUB_TOKEN`.

The workflow uploads a copy of the static files and sets its canonical, Open Graph page and social-image URLs using the address returned by GitHub Pages. This supports project paths and configured custom domains while keeping the local source portable. The supplied social image is 1200 × 630.

For another static host, upload the contents of `site/` directly and set `og:image` to an absolute URL to the deployed `social-card.png`; add the site's canonical URL too. Assets use relative paths. No build step, runtime engine or development preview server is required in production.

## Content and interactions

The page pitches Pipo as it is today: small, local pipelines for personal and small-team glue, one file each, that an agent can write. Keep claims to what works now; anything planned is marked as such (dashed chips, the "isn't" list).

- **Manifold** (hero): four example pipelines side by side. Packets flow on their own while it's on screen; clicking or pressing Enter on a source sends one. Decorative.
- **Playground**: four pipelines (`telegram-echo`, `ticket-triage`, `audio-to-video`, `heartbeat`). The YAML is in `app.js` (`RECIPES`), and each must pass `pipo check`: extract the `source:` strings (unescape `\${`) into a folder with a `triage.schema.json` and run `bun pipo check` on it. The runner beside it is a toy that mirrors the real semantics: journal before ack, one commit per step, resume from the last commit after "Pull the plug" (the uncommitted step runs again; a Telegram send can repeat, idempotent writes don't), what each input does while the runner is down, a failed write dead-lettered under the default `retry: 0`, and DLQ replay at the output. It is labelled as simulated.
- **Ask Claude**: a scripted Claude Code session using the real MCP tool names (`check_pipo`, `create_pipeline`, `test_pipeline`, `list_approvals`, `start_pipeline`). It stops at the approval step until the visitor approves or rejects. The `invoice-ping` pipeline it shows must pass `pipo check` too.
- **What plugs in** lists the connectors and steps in `packages/spec/src/manifests.ts`; dashed chips are roadmap items from `docs/roadmap.md`.
- Reduced motion turns the animations off (the manifold counts without moving; the session prints at once). Copy buttons fall back to selecting the text. Nothing is fetched: no fonts, APIs or libraries. Without JavaScript, the playground shows a link to `examples/`.
- `social-card.png` is 1200 × 630 and repeats the hero headline.

For factual updates, check `docs/spec.md`, `docs/roadmap.md`, `docs/guide/install.md` and `examples/`.
