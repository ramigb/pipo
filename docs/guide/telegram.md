# Telegram bots

A pipeline can take messages from a Telegram bot, and send messages with one. A `telegram` input turns messages to the bot into packets, `tap: telegram` sends a message mid-pipeline, and `to: telegram` sends one as the output.

```yaml
pipo: 1
name: telegram-echo
input:
  via: telegram             # messages to the home's default bot
nodes:
  seen:
    from: input
    tap: log
    with:
      message: "${data.from.name} wrote: ${data.text}"
output:
  from: seen
  to: telegram              # no chat_id: reply to the chat the message came from
  with:
    text: "You said: ${data.text}"
```

This is the [telegram-echo](../../examples/telegram-echo) example.

## Set up a bot

Bots are set up once per Pipo home, not in pipeline files, so a token never ends up in a `.pipo` file.

1. In Telegram, message **@BotFather**, send `/newbot` and copy the token it gives you.
2. Run `pipo ui`, open **🤖 Bots** and add a bot: a name (say `main`), the token, and an **Allow** list of chat or user ids. The first bot you add becomes the default.
3. Press **Test** to check the token. It calls Telegram's `getMe` and shows the bot's username.
4. Start the pipeline: `pipo start telegram-echo.pipo`.

To find your own id, message the bot once before adding it to the allow list. The message is ignored, and the log names the sender's ids:

```sh
pipo logs telegram-echo
```

Add the id to the bot's allow list, then restart the pipeline. A change to the bots applies from a pipeline's next start.

### `bots.json`

The Bots page edits `<home>/bots.json` (written atomically, mode 0600). You can also edit it by hand:

```json
{
  "telegram": {
    "default": "main",
    "bots": {
      "main": { "token": "env:TELEGRAM_MAIN_TOKEN", "allow": [123456789] },
      "alerts": { "token": "op://Pipo/telegram-alerts/token", "allow": [123456789], "poll_every": "10s" }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `token` | The raw token from @BotFather, or a reference: `env:VAR` or `op://vault/item/field` (1Password). A reference is resolved at start, like a [secret](secrets.md). |
| `allow` | Chat or user ids whose messages become packets. With no list, every message is ignored. |
| `poll_every` | How long one long-poll request waits for messages. Default `25s`, at least `1s`. |
| `api` | Another Bot API server (a local one, or a test double). Default Telegram's. |

Bot names use lowercase letters, digits, `-` and `_`. The dashboard never shows a raw token again once saved: the list shows only the bot id (the part before `:`), or the reference as written.

> [!TIP]
> Bot tokens are cheap to revoke, so the dashboard accepts the raw token. If you keep secrets in 1Password, store an `op://…` reference instead.

The same operations are available over REST (`GET /api/bots`, `POST /api/bots/telegram/<name>`, `…/delete`, `…/test`); see [REST, SSE and MCP](api.md).

## Choosing a bot

Every telegram `with:` block (input, tap and output) picks its bot the same way:

| Setting | Meaning |
|---|---|
| neither | The home's default bot. |
| `bot: alerts` | A bot by its name in `bots.json`. It must be a literal name, not a template, so the runner knows at start which bots to load. |
| `token: "${secrets.tg_token}"` | A token given inline, usually through a declared secret. |

A pipeline that names a missing bot, or uses the default when there's none, refuses to start and says how to add one. Tokens are redacted from logs, the journal and every API answer.

## Receiving messages: `via: telegram`

```yaml
input:
  via: telegram
  with:
    bot: main             # optional; default bot otherwise
    allow: [123456789]    # optional; replaces the bot's own allow list
    poll_every: 25s       # optional
    download: true        # optional; false keeps only the file's description
```

The runner long-polls Telegram's `getUpdates` only while the pipeline runs. A request waits up to `poll_every` and returns as soon as a message arrives, so `poll_every` limits idle requests without delaying messages.

Only messages whose chat id or sender id is in the allow list become packets. Others are ignored, and the log names the sender's ids so you can add them.

Each message is one packet. `data` looks like this:

```json
{
  "message_id": 42,
  "date": "2026-01-01T09:00:00.000Z",
  "chat_id": 123456789,
  "chat_type": "private",
  "from": { "id": 123456789, "username": "ada", "name": "Ada Lovelace" },
  "text": "hello",
  "file": null
}
```

`text` is the message text, or the caption of a file. `meta.trigger` is `telegram` and `meta.source` is the chat id.

**Exactly once.** The update offset is saved in the same transaction that journals the packet, so each message becomes exactly one packet, even across crashes. Updates that aren't messages, and ignored messages, advance the offset on their own.

**Pushback.** When the pipeline's buffer is full, the input waits and tries again. Telegram keeps the messages in the meantime.

### Files

A message with a document, photo (the largest size), audio, voice note, video or animation has it described in `data.file`:

```json
{
  "kind": "document",
  "file_id": "BQACAgQAAxkBAAI",
  "name": "report.pdf",
  "mime_type": "application/pdf",
  "size": 52000,
  "path": "/home/me/.pipo/pipelines/bot/files/AgADxx-report.pdf"
}
```

By default the file is downloaded to `<home>/pipelines/<name>/files/<unique id>-<name>`, and `path` is where it landed. With `download: false`, only the description is kept and `path` is `null`. Telegram doesn't let bots download files over 20 MB. Such a file comes with `path: null` and a warning in the log.

A downloaded file is a good input for an [exec step](exec.md): transcribe a voice note, convert a document, and so on.

### One poller per bot

Telegram lets only one reader take a bot's updates. The runner records the bot id it polls in its registry entry, and a second pipeline polling the same bot refuses to start, naming the first one. Within one pipeline, two telegram inputs can't use the same bot (P062). Across files, `pipo check` on a folder warns when two pipelines poll the same bot (P056).

Sending needs no polling, so any number of pipelines can send with the same bot.

## Sending messages: `tap: telegram` and `to: telegram`

```yaml
nodes:
  alert:
    from: input
    tap: telegram           # send mid-pipeline; data passes on unchanged
    with:
      bot: alerts
      chat_id: 123456789
      text: "New order ${data.id} for ${data.total} EUR"
```

| `with:` | Meaning |
|---|---|
| `chat_id` | Where to send. Defaults to the chat the packet came from, when the pipeline's input is `via: telegram`. Otherwise it's required. |
| `text` | The message. Defaults to `data`, as JSON when it isn't a string. Cut at Telegram's 4096 characters. |
| `photo` | Send a photo: a path relative to the pipeline file, or an http(s) URL. `text` becomes its caption (1024 characters). |
| `document` | Send a file the same way. |
| `parse_mode` | `Markdown`, `MarkdownV2` or `HTML`. Off by default, so text from data can't break the formatting. |
| `bot`, `token` | Which bot sends (see above). |

All values are templates.

**`chat_id` and P057.** Without a `chat_id`, a send replies to the chat the packet came from. That only works when every input that reaches the step is `via: telegram`. Otherwise `pipo check` reports [P057](../reference/diagnostics.md#p057), and you need a `chat_id`.

**Rate limits.** A `429` from Telegram is retried up to 3 times, after the `retry_after` Telegram asks for. Then the step's `on_error` applies.

**Results and delivery.** The output's result is `{chat_id, message_id}`. Telegram has no delivery checks of its own, so `to: telegram` supports the universal ones: `ack` (default), `external` and `none`.

> [!WARNING]
> Sends are at-least-once. Telegram has no idempotency key, so if the runner crashes between a send and its commit, the message is sent again after the restart. A `tap: telegram` before a failing step can also run again on retry.

## A bot that answers with an agent

A fragment: a support bot that drafts an answer with an agent node and replies in the same chat. Agent nodes need a schema file, so this isn't a complete example. See [Agent nodes](agent-nodes.md).

```yaml
input:
  via: telegram
nodes:
  answer:
    from: input
    agent: claude_code
    with:
      prompt: |
        Answer this question in two sentences: ${data.text}
      schema: ./answer.schema.json     # {"type": "object", "properties": {"reply": {"type": "string"}}, "required": ["reply"]}
output:
  from: answer
  to: telegram
  with:
    text: "${data.reply}"
```

The reply still goes to the right chat: `chat_id` defaults to the chat of the packet's original message, even though the agent replaced `data`.

## See also

- [Inputs](inputs.md) and [Outputs](outputs.md)
- [Connectors: `via: telegram`](../reference/connectors.md#via-telegram), [`tap: telegram`](../reference/connectors.md#tap-telegram), [`to: telegram`](../reference/connectors.md#to-telegram)
- The spec: [§3.13 Chat bots](../spec.md#313-chat-bots)
