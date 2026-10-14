# error-tail

Follows `logs/app.log`, a JSON-lines log, and appends its errors to `out/errors.jsonl` (docs/spec.md §3.3.2).

```sh
bun pipo start examples/error-tail/error-tail.pipo
mkdir -p examples/error-tail/logs
echo '{"time":"2026-01-01T09:00:00Z","level":"info","msg":"started"}' >> examples/error-tail/logs/app.log
echo '{"time":"2026-01-01T09:00:01Z","level":"error","msg":"disk full"}' >> examples/error-tail/logs/app.log
cat examples/error-tail/out/errors.jsonl
```

Rotate the log (`mv app.log app.log.1`) and keep writing: the old file is read to its end before the new one.
