# signup-store

The other end of the [signup-intake](../signup-intake) chain. A `via: pipeline` input takes packets only from the pipelines in its `from` list, and a `push` input takes manual fixes. Both write one row per email to `./data/signups.db` (an upsert on `email`), and a `record_exists` check confirms each row landed. `from_pipeline` is `meta.upstream.pipeline`: who handed the packet over.

```sh
bun pipo start examples/signup-store/signup-store.pipo
bun pipo push signup-store --input manual --data '{"email": "grace@example.com", "name": "Grace"}'
sqlite3 examples/signup-store/data/signups.db 'select * from signups'
```

`data/` is git-ignored.
