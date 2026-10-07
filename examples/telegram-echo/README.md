# telegram-echo

Replies to every message your Telegram bot gets (docs/spec.md §3.13).

1. In Telegram, message @BotFather, send `/newbot`, and copy the token.
2. `bun pipo ui`, open **🤖 Bots**, add a bot named `main` with that token.
3. `bun pipo start examples/telegram-echo/telegram-echo.pipo`, then message the bot.
   The first message is ignored: the log (`bun pipo logs telegram-echo`) names your chat id.
4. Add that id to the bot's **Allow** list, restart the pipeline, and message it again.
