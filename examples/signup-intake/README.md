# signup-intake

Two inputs feed one pipeline: an `http` form at `/in/signup-intake/form` and a nightly `schedule` import. A `map` node cleans both the same way and records `meta.input`, the input each sign-up came through. The output is `to: pipeline`: every sign-up is handed to [signup-store](../signup-store), exactly once, and `delivered.check: downstream` waits until signup-store has written and verified it.

```sh
bun pipo check examples                      # checks both ends of the chain together (P064)
bun pipo start examples/signup-store/signup-store.pipo
bun pipo start examples/signup-intake/signup-intake.pipo --listen 8790
curl -X POST localhost:8790/in/signup-intake/form -H 'content-type: application/json' -d '{"email": "Ada@Example.com", "name": "Ada"}'
bun pipo test examples/signup-intake
```

If signup-store isn't running, the hand-off is retried (`output.on_error`) and the sign-ups wait in signup-intake's journal.
