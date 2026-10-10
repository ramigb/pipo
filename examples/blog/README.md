# blog

A tiny blog. Three inputs feed one pipeline, posts are normalised and tagged in the middle, and one SQLite table holds
them. A static site in `out/site` is rebuilt from that table on every post.

| Input | `via` | How to post |
|---|---|---|
| `files` | `watch` | Drop or edit a markdown file in `posts/` (front matter: `title`, `author`, `date`, `tags`, `slug`, `draft`) |
| `api` | `http` | `POST /in/blog/posts` with `{title, body, author?, tags?, slug?, date?, draft?}`; no title or body is a `422` |
| `manual` | `push` | `pipo push blog --input manual --data '{…}'` |

- **`parse`** (`fn.fromMarkdown`) turns a watched file into post fields; the slug defaults to the file name.
- **`normalize`** (`fn.normalize`) gives posts from every input one shape: a slug, trimmed title, excerpt, reading time, ISO dates and
  `source` (the input it came through). Tags are lower-cased, folded onto one spelling (`ts` → `typescript`,
  `sqlite3` → `sqlite`), and topics found in the title or body are added (`blog.fn.ts`, `TOPICS`).
- **`site`** (`tap: exec`) runs `build-site.ts`, which reads every post from `data/blog.db`, merges the incoming one
  by slug (the tap runs before the write), and writes `out/site`. Drafts are stored but left off the site. With
  `concurrency: 1`, each build sees every earlier post. A failed build is logged and doesn't hold the post back.
- **The output** upserts into `data/blog.db` by `slug`, so editing a file updates its post in place, and
  `delivered` checks that the row holds this version (`slug` and `updated_at`).

```sh
bun pipo check examples/blog
bun pipo start examples/blog/blog.pipo --listen 8792
cp examples/blog/samples/*.md examples/blog/posts/
curl -X POST localhost:8792/in/blog/posts -H 'content-type: application/json' \
  -d '{"title": "Hello over HTTP", "author": "Ada", "body": "Posted with **curl**.", "tags": ["JS"]}'
bun pipo push blog --input manual --data '{"title": "Pushed by hand", "body": "Fixing a typo.", "tags": ["Meta"]}'
open examples/blog/out/site/index.html        # or xdg-open; plain files, no server needed
sqlite3 examples/blog/data/blog.db 'select slug, tags, source from posts'
bun pipo test examples/blog
```

Files already in `posts/` when the pipeline first starts are its baseline and aren't imported (spec D19), so copy the
samples in after starting it. To rebuild the site from the database alone: `bun examples/blog/build-site.ts < /dev/null`.
