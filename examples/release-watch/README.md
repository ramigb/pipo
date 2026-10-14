# release-watch

Appends each new [Bun](https://github.com/oven-sh/bun) release to `out/releases.jsonl`, once, by polling GitHub's
releases feed every 30 minutes (docs/spec.md §3.3.2).

```sh
bun pipo start examples/release-watch/release-watch.pipo
bun pipo logs release-watch -f
```

The first fetch only records the releases that are already out (`backfill: false`); remove that line to get them all.
Point `url` at any RSS, Atom or JSON Feed to watch something else.
