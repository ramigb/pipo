# deploy

Releases the shop API to production, one commit at a time. Green builds come from the [`ci`](../ci) pipeline
(`via: pipeline`), and the `rollback` input takes any earlier build by hand. See [`../ci/README.md`](../ci/README.md)
for the whole story.

- **The output** `POST`s `{sha, message}` to production's `/_deploy`. `prod-server.ts` loads
  `../ci/out/artifacts/<sha>/app.js` and switches to it only if it answers its own `/health`. Otherwise it keeps the
  live release and answers `422`, which is retried twice, then dead-lettered.
- **`delivered: follow_up`** polls `/_version` until it reports this sha, for up to 30 s. So "delivered" means the
  commit is serving traffic, not just that the request was accepted. `ci`'s `delivered: downstream` waits for that.
- **`concurrency: 1`**: one release at a time, in the order they arrive.
- **`stall`** flags deploys stuck for 10 minutes.

```sh
bun examples/deploy/prod-server.ts &     # PORT (8795) and ARTIFACTS (../ci/out/artifacts) can be changed
bun pipo start examples/deploy/deploy.pipo
bun pipo push deploy --input rollback --data '{"sha": "<40-character sha of an earlier green build>"}'
bun pipo test examples/deploy
```
