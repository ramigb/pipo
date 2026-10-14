# Active inputs

Most inputs wait for something to arrive: a request, a tick, a file. Active inputs go and get data themselves while the pipeline runs:

| `via` | What it does |
|---|---|
| [`poll`](#poll) | Fetches a URL on a timer and sends what is new or changed: API records, feed entries, a part of a page. |
| [`tail`](#tail) | Follows a file and sends each line appended to it. |
| [`command`](#command) | Runs a long-running program and sends each line it prints. |
| [`crawl`](#crawl) | Crawls a site on a timer and sends the pages that are new or changed. |

They remember where they got to in the pipeline's journal: the keys they have seen, a cursor, a byte offset. Each packet saves that position in the same transaction that journals it, so a restart, even after a crash, neither sends again what was already journaled nor skips what wasn't. `command` is the exception (see [below](#command)).

Every field is listed in the [Connectors reference](../reference/connectors.md#inputs).

## `poll`

```yaml
pipo: 1
name: releases
secrets:
  github: env:GITHUB_TOKEN
input:
  via: poll
  with:
    url: https://api.github.com/repos/oven-sh/bun/releases
    every: 10m
    headers: { Authorization: "Bearer ${secrets.github}" }
    items: data                  # the answer is a list: one packet per release
    key: item.id                 # what identifies a release
    backfill: false              # don't send the releases that are already out
nodes:
  note:
    from: input
    transform: map
    with:
      data: { tag: "${data.tag_name}", url: "${data.html_url}" }
output:
  from: note
  to: file
  with: { path: ./out/releases.jsonl, format: jsonl }
```

Each fetch:

1. renders `url`, `headers` and `body` with `env`, `secrets` and `cursor`;
2. reads the answer as `parse` says;
3. splits it into elements with `items`;
4. names each element with `key`, and sends the ones `emit` picks;
5. follows `next` to more pages, then saves `cursor`.

### When it fetches

Exactly one of `every` and `cron` (P038). `every: 10m` fetches when the pipeline starts and then every ten minutes; the time of the last fetch is saved, so a restart waits out the rest of the interval instead of fetching again at once. `cron` fetches at each tick (5 fields, UTC). An answer of `429` or `503` with `Retry-After` holds the next fetch until then.

### The request

`url` (http or https, P066), `method` (default `GET`), `headers`, `body` (sent with methods other than `GET` and `DELETE`: a string as text, anything else as JSON), `timeout` (default `30s`) and `success` (default `200-299`). The input sends `If-None-Match` and `If-Modified-Since` when the last answer had an `ETag` or a `Last-Modified`, and a `304 Not Modified` means nothing new. Requests carry `User-Agent: pipo/<version>` unless `headers` sets one.

### `parse`

| `parse` | `data` |
|---|---|
| `auto` (default) | Chosen from the `Content-Type`: a feed, JSON, a page or text. |
| `json` | The parsed JSON. |
| `text` | The body as a string. |
| `feed` | An RSS, Atom or JSON Feed: `{title, link, entries}`. |
| `html` | The page: `{url, status, title, text, links, html}`. |

A feed's entries all have one shape, whatever the format:

```json
{
  "id": "https://blog.example/hello",
  "title": "Hello",
  "link": "https://blog.example/hello",
  "published": "2026-01-01T08:00:00.000Z",
  "updated": null,
  "summary": "<p>Hi</p>",
  "content": "Full text",
  "author": "Ada",
  "feed": { "title": "Blog", "link": "https://blog.example/" }
}
```

A page's `text` is what a reader sees (scripts and styles left out, whitespace collapsed, one line per block), and `links` are its absolute http(s) links. With `select`, a CSS selector (P065: it needs `parse: html` or `auto`), `text` and `html` hold only the matching elements.

### Elements, keys and `emit`

`items` is an [expression](expressions.md) over `data`, `response` (`{status, url, headers}`) and `cursor` that gives the list to split. Without it, a feed splits into its entries and anything else is one element: the whole answer.

`key` is an expression over `item` and `data`. It defaults to the entry's `id` for a feed, the `url` as written for a whole answer (the template, so a secret in it never becomes the key), and a hash of the element otherwise. It becomes `meta.source`; `meta.trigger` is `poll`.

| `emit` | Sends |
|---|---|
| `new` | Elements whose key it hasn't seen. The default when the answer is split. |
| `changed` | Those, and elements whose content changed since their key was last seen. The default for a whole answer. |
| `all` | Every element of every fetch. |

So `url` and `every` alone send the answer each time it changes, and with `parse: html` and `select` that watches a part of a page:

```yaml
pipo: 1
name: price-watch
input:
  via: poll
  with:
    url: https://shop.example/tea
    every: 1h
    parse: html
    select: "#price"
output:
  from: input
  to: stdout
```

`backfill: false` takes what the first fetch finds as already seen, so only later elements are sent. `remember` (default 10000) caps the keys kept: each fetch refreshes the keys it sees, and only keys that stopped appearing are forgotten, oldest first.

### Cursors and pages

`cursor` is an expression over `data`, `items`, `response` and the previous `cursor`. Its value is saved once the fetch's packets are journaled, and the next fetch's `url`, `headers` and `body` see it as `${cursor}` (`null` before the first fetch). `next` is an expression over `data` and `response` that gives the next page's URL, followed in the same fetch up to `max_pages` (default 10):

```yaml
pipo: 1
name: tickets
secrets:
  token: env:TICKETS_TOKEN
input:
  via: poll
  with:
    url: "https://tickets.example/api/tickets?updated_since=${cursor ?? '2026-01-01T00:00:00Z'}"
    every: 5m
    headers: { Authorization: "Bearer ${secrets.token}" }
    items: data.tickets
    key: item.id
    emit: changed                # a ticket edited later comes again
    cursor: "data.tickets[len(data.tickets) - 1].updated_at ?? cursor"
    next: data.links.next
output:
  from: input
  to: sqlite
  with:
    path: ./tickets.db
    table: tickets
    create: true
    mode: upsert
    key: id
    columns: { id: "${data.id}", status: "${data.status}", updated_at: "${data.updated_at}" }
```

### When things go wrong

A fetch that fails (the server is unreachable, a status outside `success`, a body that doesn't parse) is logged with the reason and tried again at the next fetch. When the pipeline's buffer is full, the fetch stops; what it didn't hand over counts as unseen and is fetched again 5 seconds later (`every`) or at the next tick (`cron`). Bodies over 10 MiB are refused.

## `tail`

```yaml
pipo: 1
name: errors
input:
  via: tail
  with: { path: ./logs/app.log, parse: json }
nodes:
  bad:
    from: input
    filter: data.level == "error"
output:
  from: bad
  to: stdout
```

`tail` sends each complete line added to `path` (relative to the `.pipo` file). With `parse: text` (the default) a packet is `{line, path}`; with `parse: json` it is the line parsed as JSON, and a line that isn't JSON is logged and skipped. `meta.source` is `<path>:<byte offset>`.

- **Where it starts.** A first start reads only what is written from then on (`from: end`, the default) or the whole file (`from: start`). Later starts resume after the last line journaled, including lines written while the pipeline was stopped.
- **Rotation.** When the file is renamed and a new one takes its place (logrotate), the old one is read to its end, then the new one from its start. A file that shrinks is read again from its start. A file rotated while the pipeline was stopped is read from the start of the new file.
- A missing file is waited for. A line without its final newline waits until it has one. Lines over 1 MiB are cut there and sent with `truncated: true`.

## `command`

```yaml
pipo: 1
name: nginx-journal
input:
  via: command
  with:
    command: journalctl
    args: [-f, -o, json, -u, nginx]
    parse: json
output:
  from: input
  to: file
  with: { path: ./out/nginx.jsonl, format: jsonl }
```

The program runs from the pipeline's start to its stop, like an [exec step](exec.md): no shell (`args` go to it one by one, and P058 warns about a `command` with spaces), `cwd` relative to the `.pipo` file, `env` added to the runner's environment, its own process group, stopped with SIGTERM and SIGKILL 2 s later. An untrusted pipeline file can't run one (P052), and a program that isn't installed stops the pipeline from starting.

Each line on stdout is a packet: `{line}`, or with `parse: json` the parsed line. Lines on stderr go to the pipeline's log as warnings. `meta.source` is the command.

`restart` says what happens when the program exits: `always` (default) starts it again, `on-failure` only after an error exit or a signal, `never` leaves the input idle. Restarts wait 1 s, doubling up to a minute, and the wait goes back to 1 s once the program has run for a minute.

When the buffer is full, the input stops reading, so the program blocks on its next write until there is room. A line the program printed but the pipeline hadn't journaled when it crashed is lost, and a restarted program starts over: where that matters, use the program's own way to resume, such as `journalctl --cursor-file`.

## `crawl`

```yaml
pipo: 1
name: docs-changes
input:
  via: crawl
  with:
    start: https://docs.example.com/
    every: 1d
    within: https://docs.example.com/guide/
    exclude: ["/tag/", "\\?print=1"]
    depth: 3
    select: main
output:
  from: input
  to: file
  with: { path: ./out/changed-pages.jsonl, format: jsonl }
```

Each crawl starts at `start` (one URL or a list), follows links breadth first to `depth` (default 3), and fetches at most `max_pages` pages (default 500), one at a time, `delay` apart (default `1s`). It follows only links that start with one of `within` (default: each start URL's origin) and match none of `exclude` (regular expressions). Fragments are dropped, so `/a#top` and `/a` are one page.

Each HTML page becomes `{url, status, title, text, links, html, depth}`, as with `poll`'s `parse: html` (and `select` narrows `text` and `html` the same way). Other content types are skipped. `meta.source` is the page's URL after redirects.

- **`emit`**: `changed` (default) sends a page that is new or whose title, text or links changed since the last crawl; `all` sends every page each time. `remember` (default 10000) caps the pages kept.
- **When.** `every` crawls at start and then that long after the last crawl ended; `cron` at each tick. A crawl cut short by a crash or a stop starts over at the next start, skipping the pages it already sent.
- **Manners.** `robots.txt` is read once per site per crawl and obeyed, including `Crawl-delay`; set `robots: false` only for your own sites. A `429` or `503` waits for its `Retry-After` (up to 5 minutes) once, then skips the page.
- JavaScript isn't run: a page that builds its content in the browser crawls as its HTML.

## Changing an active input

A changed `url` (`poll`), `path` (`tail`) or `start` (`crawl`) starts afresh: what the input remembered belongs to what it pointed at before. Like any change to an input's `with:`, it takes a restart (see [Inputs](inputs.md#changing-inputs-on-a-running-pipeline)).
