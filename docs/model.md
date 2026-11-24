# The AI model and your Anthropic API key

The bot plans dinners by asking an Anthropic model (Claude). It uses **your household's own
Anthropic API key**, so the usage is billed per token to your own Anthropic account. Nobody else
pays, and nothing goes through anyone else's account.

## 1. Get an API key

1. Sign in (or sign up) at the Anthropic Console: https://console.anthropic.com
2. Add a payment method or credit under **Plans & Billing**. Calls fail with a billing error
   until the account has credit.
3. Open **API keys**, create a key, and copy it. It starts with `sk-ant-`. You only see it once.

Keep the key private. Anyone who has it can spend your credit. Set a monthly spend limit in the
Console if you want a ceiling.

## 2. Give the bot the key

The key never goes in `config.toml`. It goes in the `.env` file in the project folder, and
`config.toml` only holds the variable's **name**:

```toml
[model]
apiKeyEnv = "ANTHROPIC_API_KEY"   # the NAME of the variable, not the key
```

Make the file if you have not (`cp .env.example .env`), open it, and fill in the line (no quotes,
no spaces). Bun reads `.env` by itself when you run a command in the project folder:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Then check it, in the project folder:

```sh
bun run doctor
```

If the variable is missing, `bun run doctor` says: "The environment variable ANTHROPIC_API_KEY is
not set. It should hold the model API key." (It prints the name, never the value.)

If the key is later rejected or the account runs out of credit, the bot stops asking the model,
posts one line in the chat, and alerts the admin if alerts are on. It is designed to check again every 30
minutes and resume by itself once the key works (covered by the test suite). If you changed the key,
restart the bot.

## 3. Change the model

Edit `id` in the `[model]` section of `config.toml`, then restart the bot:

```toml
[model]
id = "claude-sonnet-5-5"
```

The other settings in that section: `timeoutMs` (how long to wait for one answer, default 2
minutes) and `maxOutputTokens` (the longest answer, default 8192).

## Trying the key for real

`bun run doctor` only checks that the variable is filled in. To make one small real call with your
key and check that the reply is understood (it costs a fraction of a cent), run this in the project
folder:

```
HMP_LIVE_TEST=1 bun test test/brain.live.test.ts
```

It is skipped unless you set `HMP_LIVE_TEST=1`.

## What it costs

Each message or weekly draft is one or two model calls, and you pay for the tokens sent and
received. A larger model costs more per token than a smaller one. For current prices see
Anthropic's pricing page. The Console's usage page shows what the bot has actually used.

## What the bot sends

Each call sends the bot's instructions and the context it needs for that one task (the week's
plan, your profile, the recent messages). Nothing is sent that is not needed for the answer, and
the model is given no tools, so it cannot browse, run code or reach anything else. The bot is
designed not to write the key, the prompts or your messages to its log (covered by the test suite).
