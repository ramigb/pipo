# inbox-forward

A `watch` input sees new `.txt` files in `./inbox`, reads their content, shapes it with a `map` node and POSTs it as JSON to the URL in `INBOX_URL`. Any 2xx status counts as success. Each request carries an `Idempotency-Key: <packet_id>` header, so a retry after a crash does not duplicate.

```sh
mkdir -p examples/inbox-forward/inbox
INBOX_URL=http://localhost:9000/ingest bun pipo run examples/inbox-forward/inbox-forward.pipo
echo hello > examples/inbox-forward/inbox/note.txt   # in another terminal
```

Files already in the folder when the runner first starts are the baseline and are not sent.
