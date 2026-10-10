# ci (and deploy)

CI/CD for a small shop API (`app/`) in two chained pipelines. `ci` takes GitHub push events, tests each commit to
`main` and builds green ones. When a commit breaks the tests, Claude Code fixes it in the build's checkout and the fix
is pushed to a branch for review. [`deploy`](../deploy) releases green builds to production one at a time. A commit's
packet in `ci` is delivered only when production reports that commit live.

```
github (http, HMAC) ─┐
manual (push) ───────┴─ main? ─ checkout ─ bun test ─┬─ green ─ bun build ──────────────────────────┐
                                                     │                                              ├─ ship? ─▶ deploy ─▶ production
                                                     └─ red ─ Claude Code ─ bun test ─ push branch ─┘  (passed as pushed only)
                                                               ▲  fixes it   │ still red (max 2)
                                                               └─────────────┘
```

| Step | What it does |
|---|---|
| `github` | A GitHub webhook: `X-Hub-Signature-256` must be the HMAC of the body with `CI_WEBHOOK_SECRET`, or it's a `401` |
| `event`, `main` | `fn.fromPush` reads the push. Pings, branch deletions and other branches are filtered out |
| `checkout` | `steps/checkout.ts` fetches exactly that commit (shallow) into `out/work/<packet id>` |
| `test` | `steps/test.ts` runs `bun test` there; `verdict` routes on the result |
| `build` | `bun build` writes the release artifact, `out/artifacts/<sha>/app.js` |
| `fix` | `claude_code` with its tools on, in the checkout, answering in `fix.schema.json`'s shape. Its cost counts against `agent_budget` |
| `retest` | `bun test` again. Still red: back to `fix` with the new output, at most twice more (`loop`), then the DLQ |
| `propose` | `steps/propose.ts` commits the fix on `autofix/<short>`, pushes it, writes `out/fixes/<short>.patch` and `out/reports/<short>.md` |
| `ship` | Only commits that passed as pushed go on. A fixed commit isn't what was pushed, so it stops here |
| output | Hands `{sha, short, message, author}` to `deploy` (`to: pipeline`). `delivered: downstream` waits until deploy has verified it live |

`concurrency: 1`, so builds run in push order and `main` reaches production in that order. What `pipo packets ci`
shows for each commit:

| State | Meaning |
|---|---|
| `delivered` | Green, and live in production |
| `filtered` | Not built (another branch, a ping), or red and fixed on `autofix/<short>` |
| `dead_lettered` | Claude Code couldn't fix it in three tries (`loop.max`), or production refused the release |

## Try it locally

`demo.ts` stands in for GitHub: a git repository in `out/repo` whose commits send `ci` a signed push event, shaped
like GitHub's. `deploy/prod-server.ts` stands in for production. Claude Code must be installed and logged in
(`claude auth login`), or `ci` refuses to start and says so.

```sh
export CI_WEBHOOK_SECRET=$(openssl rand -hex 20)   # before the engine starts: runners get the engine's environment
bun examples/deploy/prod-server.ts &               # production, on 127.0.0.1:8795
bun pipo start examples/deploy/deploy.pipo
bun pipo start examples/ci/ci.pipo                 # the webhook listens on 127.0.0.1:8793
bun pipo ui                                        # watch the packets move

bun examples/ci/demo.ts init     # create out/repo and push its first commit: tested, built, live
curl -s localhost:8795/_version  # {"sha": "…", …}
curl -s localhost:8795/quote -d '{"lines": [{"sku": "mug", "qty": 2, "price": 1250}], "code": "SAVE10"}'

bun examples/ci/demo.ts bug      # commits a change that breaks the free-shipping test
cat examples/ci/out/reports/*.md # once Claude Code is done: what it found, its patch, the branch it pushed
cd examples/ci/out/repo && git merge autofix/<short> && cd -   # merging is a new push to main: it goes live

bun examples/ci/demo.ts crash    # passes the tests, but /health fails: production refuses it, the old release stays
bun pipo dlq ci                  # "passed CI but did not go live: … release refused, still serving …"
bun pipo push deploy --input rollback --data '{"sha": "<an earlier green sha>"}'
```

Any commit you make in `out/repo` is built too: its `post-commit` and `post-merge` hooks run `demo.ts push`.

## With GitHub

Add a webhook to the repository with payload URL `https://<your host>/in/ci/github` (a tunnel or reverse proxy to
the engine's gateway or the runner's port), content type `application/json`, the push event, and a secret. Give
`secrets.webhook` that secret as a reference, ideally `op://<vault>/<item>/<field>` in 1Password, rather than an
environment variable. To push `autofix/*` branches, the machine needs push access to the repository, through an SSH
key or a credential helper. Without it, the fix is still kept in `out/fixes` and the report says the push failed.
Replace `prod-server.ts` with your platform's deploy API in `deploy.pipo`'s output, and its version endpoint in
`delivered.with.url`.

Claude Code runs as you, with its tools on (`allow_tools: true`), in a fresh checkout of the pushed commit. That's
fine for your own repositories. For code from people you don't trust, run the engine in a container or VM.

## Test it

```sh
bun pipo test examples/ci        # agent and step results are stubbed (fixtures/), nothing runs
bun pipo test examples/deploy
bun test packages/runner/test/examples.test.ts -t ci    # the whole story end to end, with a fake Claude Code
```
