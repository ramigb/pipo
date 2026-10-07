# heartbeat

A `schedule` input fires every 5 seconds with a fixed payload. A `map` node adds the tick time, and the output appends one JSON line to `./out/heartbeat.jsonl`. A `line_contains` delivery check confirms each packet's line is in the file.

```sh
bun pipo check examples/heartbeat
bun pipo run examples/heartbeat/heartbeat.pipo
tail -f examples/heartbeat/out/heartbeat.jsonl
```

Paths are relative to the `.pipo` file. `out/` is git-ignored.
