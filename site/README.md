# Pipo website

A standalone static landing page for Pipo. Plain HTML, CSS and JavaScript, local assets and system fonts. No framework, dependencies, API calls or build step. This site is separate from the runtime dashboard in `packages/ui`.

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

## Publish

The [GitHub Pages workflow](../.github/workflows/pages.yml) deploys this folder when `site/` or the workflow changes on `main`. It can also be started manually from the repository's **Actions** tab, selecting **Deploy Pipo website to GitHub Pages** and the `main` branch.

To enable it, open the repository's **Settings → Pages → Build and deployment**, and set **Source** to **GitHub Actions**. Commit and push the website and workflow to `main`; the deployment run reports the published URL. No personal access token or extra secrets are needed. The workflow uses GitHub's `github-pages` environment and the repository's `GITHUB_TOKEN`.

The workflow uploads a copy of the static files and sets its canonical, Open Graph page and social-image URLs using the address returned by GitHub Pages. This supports project paths and configured custom domains while keeping the local source portable. The supplied social image is 1200 × 630.

For another static host, upload the contents of `site/` directly and set `og:image` to an absolute URL to the deployed `social-card.png`; add the site's canonical URL too. Assets use relative paths. No build step, runtime engine or development preview server is required in production.

## Content and interactions

- The downloadable `heartbeat.pipo` is the exact compact example shown in the homepage and root README, derived from `examples/heartbeat`. Validate it with `bun pipo check site/heartbeat.pipo`. Its relative output path resolves beside the downloaded file.
- The file/graph comparison highlights corresponding YAML blocks on hover or keyboard focus.
- Delivery stages can be selected to read their meaning. The lifecycle uses the spec's `accepted`, `processing`, `writing`, `verifying` and `delivered` states; journaling is an acceptance boundary, not a new state.
- The crash/recovery demonstration is a finite client-side simulation. It shows recovery from the last committed node, followed by pending work. It does not execute Pipo or demonstrate exactly-once side effects.
- Dashboard and builder previews are explicitly illustrative, with selectable views. They reflect existing capabilities; they are not screenshots or a functional pipeline editor.
- Packet motion is decorative and can be paused. Reduced motion disables animation; the recovery simulation switches immediately to its completed state.
- Copy controls require the clipboard API; if unavailable, they select the command text for manual copying. Core content, links, commands, previews and the static recovery state remain readable without JavaScript.

For factual updates, check `docs/spec.md`, `docs/roadmap.md`, the connector/provider implementations and `examples/`. Keep planned features in the separately labelled roadmap area. CLI agent USD budgets depend on reported cost or configured token pricing; repeated side effects remain possible under at-least-once delivery.
