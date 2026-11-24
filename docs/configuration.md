# Configuration reference

Everything the bot needs to know about your household is in one file, `config.toml`. Make it by
copying the template, which has a comment on every setting:

```
cp config.example.toml config.toml
```

The bot never reads `config.example.toml`. `bun run doctor` checks your `config.toml` and tells you,
in plain words, which setting is wrong and why.

## Rules of the file

- Text goes in "double quotes". Numbers and `true`/`false` do not.
- A line that starts with `#` is a note to you.
- **Secrets never go in this file.** Where a setting ends in `Env`, you write the **name** of an
  environment variable (such as `"ANTHROPIC_API_KEY"`), and put the secret in that variable, which
  you do by adding a line to your `.env` file (see `.env.example`). The bot is designed never to
  write a secret to its logs (covered by the test suite).
- Food preferences (rules, dishes, grocery sections) are not here. They live in `data/profile.md`.
- Relative folder names count from the folder that holds `config.toml`.

## Where the bot looks for the file

`./config.toml` in the folder you start it from, or the file named by the `HMP_CONFIG` environment
variable. Two more variables override folders, which is handy in containers and for tests:
`HMP_DATA_DIR` and `HMP_STATE_DIR`. Setting `HMP_DRY_RUN=1` makes the bot do everything except send
messages; what it would have sent appears in the log on lines starting `DRY RUN` and in `state/dry-run-sends.jsonl`.

## [household]

| Key | Meaning |
| --- | --- |
| `name` | Your household's name, for the bot's own use. |
| `botName` | What the bot calls itself, and the name people use when they talk to it. |

## [[members]]

One block per adult. People who are not listed are ignored, even if they are in the same chat. You
need at least one `admin`.

| Key | Meaning |
| --- | --- |
| `id` | A short lowercase label for the person (letters, digits, dashes). |
| `name` | What the household calls them. |
| `role` | `"admin"` (can change settings and recipe sources from chat) or `"adult"` (plans dinners). |
| `[members.identities]` | How the chat app knows this person. You need the line for the chat app you chose: `signal` (an account ID, a UUID), `telegram` (a number), `whatsapp` (the phone number without the plus), `imessage` (a phone number or email address). The guide for each chat app shows where to find these. |

## [schedule]

| Key | Meaning |
| --- | --- |
| `timezone` | Required. A city name from the standard list, such as `"America/Chicago"` or `"Europe/London"`. Every time below is in this zone, and daylight saving is handled for you. |
| `draftDay` | The day the bot posts next week's draft (`"monday"` to `"sunday"`). Default `"friday"`. |
| `draftTime` | The time of day, 24-hour `"HH:MM"`. Default `"16:00"`. |
| `lateAfterMinutes` | A draft posted this long after `draftTime` is marked "(late)". The watchdog also treats the draft as overdue at this point. Default 30. |
| `[schedule.catchUpUntil]` `day`, `time` | If the bot was off or failing at the draft time, it keeps trying until this moment, then skips the week and alerts the admin. It must come later in the week than the draft time (weeks run Monday to Sunday). Default Sunday `"12:00"`. |

## [planning]

| Key | Meaning |
| --- | --- |
| `weeknights` | Which days "weeknights" means in a rule such as "no fish on weeknights". Default Monday to Thursday. |
| `minDiscoveryNights` | The discovery rule: each week's draft needs at least this many dinners that are new to your household (not on your usual or also-like lists, and not cooked in the last few weeks). A link alone does not make a dish new. `0` turns the rule off. Default 1. |

## [messaging]

| Key | Meaning |
| --- | --- |
| `platform` | One of `"signal"`, `"telegram"`, `"whatsapp"` (beta), `"imessage"` (beta). Only one is active at a time. |
| `[messaging.conversation]` `mode` | `"group"`: the bot sits in one household chat. `"household-dms"`: the bot talks to each person privately and passes things along. WhatsApp can only do `"household-dms"`, and that is its default. |

Only the section for your chosen `platform` is read.

### [messaging.signal]

See [platforms/signal.md](platforms/signal.md).

| Key | Meaning |
| --- | --- |
| `cliPath` | Where the signal-cli program is. |
| `dataDir` | signal-cli's own folder, which holds the bot account's keys. Back it up and keep it private. Default `state/signal-cli`. |
| `javaHome` | The folder of a Java install, if signal-cli cannot find Java by itself. Leave it out to use the Java already installed. |
| `botNumber` | The bot's own Signal phone number, with country code (`"+15555550123"`). |
| `groupId` | The household group's ID (a long code ending in `=`). Group mode only. |

### [messaging.telegram]

See [platforms/telegram.md](platforms/telegram.md).

| Key | Meaning |
| --- | --- |
| `botTokenEnv` | The **name** of the variable holding the token from @BotFather. Default `"TELEGRAM_BOT_TOKEN"`. |
| `chatId` | The group's chat ID (a negative number, in quotes). Group mode only. |

### [messaging.whatsapp] (beta)

See [platforms/whatsapp.md](platforms/whatsapp.md).

| Key | Meaning |
| --- | --- |
| `phoneNumberId` | The "Phone number ID" from Meta's setup page. It is not the phone number. |
| `apiVersion` | The Graph API version, such as `"v23.0"`. |
| `accessTokenEnv`, `appSecretEnv`, `verifyTokenEnv` | The **names** of the variables holding the access token, the app secret, and a passphrase you choose for the webhook handshake. |
| `[messaging.whatsapp.webhook]` `host`, `port`, `path` | Where the bot listens for Meta's webhook calls. Point your tunnel or reverse proxy here. In a container, use `host = "0.0.0.0"` and publish the port. |
| `[messaging.whatsapp.template]` `name`, `language` | The approved message template sent to someone who has not written to the bot in 24 hours. Without one, that person gets nothing until they write first. |

### [messaging.imessage] (beta)

See [platforms/imessage.md](platforms/imessage.md).

| Key | Meaning |
| --- | --- |
| `serverUrl` | The address of your BlueBubbles server, with no password in it. |
| `passwordEnv` | The **name** of the variable holding the server password. |
| `chatGuid` | The household group chat's GUID. Group mode only. |
| `sendMethod` | `"apple-script"` (default, works on a stock Mac) or `"private-api"` (also allows reactions, but needs BlueBubbles' Private API). |
| `pollIntervalSeconds` | How often to ask the server for new messages. Default 5. |
| `allowSms` | Also read plain text messages (SMS), not just iMessages. Default `false`. |

## [model]

See [model.md](model.md).

| Key | Meaning |
| --- | --- |
| `id` | The model to use. Default `"claude-sonnet-5-5"`. |
| `apiKeyEnv` | The **name** of the variable holding your Anthropic API key. Default `"ANTHROPIC_API_KEY"`. |
| `timeoutMs` | How long to wait for one answer, in milliseconds. Default 120000 (2 minutes). |
| `maxOutputTokens` | The longest answer the model may write. Default 4096. |

## [recipes]

See [recipe-sources.md](recipe-sources.md). These limits keep the bot a polite visitor.

| Key | Meaning |
| --- | --- |
| `userAgent` | How the bot introduces itself to websites. Put a way to reach you (an email address or a web page) in it, so a site owner can contact you. |
| `pagesPerSourcePerDay` | The most recipe pages read from one site per day. Default 20. |
| `sitemapsPerSourcePerDay` | The most sitemap files read from one site per day. Default 10. |
| `secondsBetweenRequests` | The pause between two requests to the same website. Default 5. |
| `refreshHours` | How often the recipe APIs are asked again (they are asked in the background, never while a week is planned). Default 168 (weekly). |
| `providerSecondsBetweenRequests` | The pause between two requests to the same recipe API server. Default 1. |
| `[recipes.themealdb]` `apiKeyEnv`, `lookupsPerRefresh` | TheMealDB is on by default and uses its public test key. TheMealDB asks apps that are public or used in production to use a supporter key: put it in the variable named here (`THEMEALDB_API_KEY`). `lookupsPerRefresh` is how many new recipes one refresh reads (default 40). |
| `[recipes.mealie]` `url`, `tokenEnv`, `maxRecipes` | Your own Mealie server. Off until you add this section. The address may be on your home network. |
| `[recipes.tandoor]` `url`, `tokenEnv`, `maxRecipes` | Your own Tandoor server, the same way. |

## [alerts]

A separate, send-only message to the admin when something needs a human: the model key stopped
working, the draft did not go out, the bridge went quiet. It works whichever chat app your household
uses, because it is its own tiny Telegram bot. See [operations.md](operations.md).

| Key | Meaning |
| --- | --- |
| `channel` | `"none"` (default): alerts are only written to the log and to `check-health`'s error output. `"telegram"`: they are also sent to a Telegram chat. |
| `telegramBotTokenEnv` | The **name** of the variable holding that bot's token. It can be the same bot as your household chat, or a different one. Default `"TELEGRAM_BOT_TOKEN"`. |
| `telegramChatId` | The Telegram chat to send alerts to (required when `channel = "telegram"`). For a private chat with the bot, this is your own user ID, and you must have pressed **Start** in that chat. |

The bot says "the admin's been pinged" in the household chat during a model outage only when
`channel = "telegram"`. With `"none"` it says the admin will see it in the logs.

## [paths]

| Key | Meaning |
| --- | --- |
| `dataDir` | Your profile, weekly plans, recipe catalog and log. Default `./data`. Back it up. |
| `stateDir` | Running state: the message journal, lock file, markers, and signal-cli's folder. Safe to delete while the bot is stopped, except signal-cli's folder, which holds the bot account's keys. Default `./state`. |

## Secrets

Secrets go in a file called `.env` in the project folder (`cp .env.example .env`), one
`NAME=value` line each, no quotes. Bun reads it by itself when you run a command in that folder, and
the service files and Docker setup in [deployment.md](deployment.md) read the same file.
`.env.example` lists every name; leave the lines for chat apps you do not use empty, or delete them.

`bun run doctor` checks that the variables needed for the chat app you chose (and for any recipe
source or alert channel you turned on) are set, and prints the **name** of any that is missing,
never a value. It ignores the others.
