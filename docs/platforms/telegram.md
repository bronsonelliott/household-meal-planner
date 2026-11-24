# Setting up Telegram

Telegram is the easiest chat app to set up: you make a bot in a chat with another bot, and no
phone number is involved. This takes about ten minutes. You do not need to be a developer.

You will end up with three things to put in your setup:

- a **bot token** (a long password for the bot),
- the **chat ID** of your household group (a negative number), and
- each adult's **Telegram user ID** (a plain number).

Keep the bot token private. Anyone who has it can act as your bot.

## 1. Make the bot

1. In Telegram, search for **@BotFather** (it has a blue check mark) and open a chat with it.
2. Send `/newbot`.
3. It asks for a name (what people see, for example "Dinner Bot") and then a username. The
   username must end in `bot`, for example `smith_dinner_bot`.
4. BotFather replies with a **token** that looks like `123456789:AAH...`. Copy it somewhere safe
   for the next step. If you ever lose it or it leaks, send `/revoke` to BotFather to get a new one.

## 2. Turn privacy mode off

By default a Telegram bot in a group only sees messages that mention it by name, replies to it,
and slash commands. For a dinner planner you want it to read "Tuesday tacos" without being
tagged every time, so turn that off:

1. Send BotFather `/mybots` and pick your bot.
2. **Bot Settings**, then **Group Privacy**, then **Turn off**.

Do this **before** you add the bot to the group. Telegram applies the setting only to groups the
bot joins afterwards, so if the bot is already in the group, remove it and add it back. (Making
the bot a group admin also works, but turning privacy off is simpler.)

If you skip this step the bot still works, but it only reacts to messages that start with its name
(`@smith_dinner_bot lock it`), replies to its own messages, and `/commands`. The bot's start-up
log, and `bun run doctor --online`, tell you plainly when privacy mode is still on.

## 3. Make the household group and add the bot

1. Make a Telegram group with the adults in it (or use your existing family group).
2. Open the group, then **Add member**, search for your bot's username, and add it.

Skip this step if you chose private chats for everyone (see "Private chats instead of a group"
below). In that case each person just opens a chat with the bot and presses **Start**.

## 4. Find the chat ID and the user IDs

**Do this before the bot is started for the first time, and never while it is running.** Only one
program can read a bot's messages at a time, and this step reads (and, with `getUpdates`, can
consume) them. If the bot is already running, stop it first (Ctrl-C), do this step, then start it
again.

1. Send any message in the group, for example "hello bot".
2. In a web browser, open this address, putting your own token in place of `PASTE_TOKEN_HERE`:

   `https://api.telegram.org/botPASTE_TOKEN_HERE/getUpdates`

   (There is no space between `bot` and the token.) You get a block of text.

   **Warning: that address contains your bot token.** Anyone who has the token can act as your bot.
   Do not paste the address or the page anywhere (not into a chat, an email, a support request or
   a bug report). When you have written down the numbers below, close the browser tab, and clear it
   from your browser history if you share the computer. If the address ever does leak, send
   `/revoke` to BotFather for a new token.
3. Look for `"chat":{"id":-100...` . That negative number is the **chat ID** of the group.
4. Next to it, `"from":{"id":123456789,...` is the **user ID** of the person who wrote the
   message. Have each adult send a message, and write down each one's `from` ID next to their name.

If the page shows `"result":[]`, nothing has reached the bot yet. Check that the bot is in the
group, send another message, and reload. If privacy mode is still on, start the message with the
bot's name, for example `@smith_dinner_bot hello`.

## 5. Fill in config.toml

Copy `config.example.toml` to `config.toml` (`cp config.example.toml config.toml`) and edit it. The
template ships set up for **Signal**, so for Telegram **replace** the `[[members]]` blocks and the
`[messaging]` part (including the whole `[messaging.signal]` block) with the version below. Keep
the other parts (`[household]`, `[schedule]` and so on) and set your own household name and time
zone there. Your numbers will differ. Put them **in quotes**, and keep the minus sign on the chat
ID:

```toml
[[members]]
id = "alex"
name = "Alex"
role = "admin"

[members.identities]
telegram = "100000001"      # Alex's user ID

[[members]]
id = "sam"
name = "Sam"
role = "adult"

[members.identities]
telegram = "100000002"      # Sam's user ID

[messaging]
platform = "telegram"

[messaging.conversation]
mode = "group"

[messaging.telegram]
botTokenEnv = "TELEGRAM_BOT_TOKEN"   # the NAME of the variable that holds the token, not the token
chatId = "-1001234567890"            # the group's chat ID
```

Only the people listed in `[[members]]` are listened to. Anyone else in the group, and anyone who
messages the bot privately, is ignored.

## 6. Give the bot its token

The token never goes in `config.toml`. It goes in the `.env` file in the project folder, under the
name you wrote in `botTokenEnv`:

```
cp .env.example .env
```

Then open `.env` and fill in the line:

```
TELEGRAM_BOT_TOKEN=123456789:AAH...
```

(No quotes and no spaces, exactly as BotFather gave it.) Bun reads `.env` by itself when you run a
command in the project folder, and the deployment options in [../deployment.md](../deployment.md)
read the same file. Leave the lines for other chat apps empty or delete them: `bun run doctor`
only checks the chat app you chose.

## 7. Check it

Run these in the project folder:

```
bun run doctor            # checks the config file and that the variable is set
bun run doctor --online   # also asks Telegram: is the token good, can the bot see the group,
                          # is privacy mode off
```

`--online` is designed to send nothing to the group (covered by the test suite). A pass looks like
this:

```
Online checks:
  Telegram bot: @smith_dinner_bot (token accepted)
  Telegram group: "Family" (group)
  Telegram privacy: the bot sees every message in the group.
  TheMealDB: reachable
```

If privacy mode is on, you see a `Warning:` line with the exact BotFather steps instead of the
privacy line. Then start the bot with `bun start`. Its first log lines are
`Telegram bot @smith_dinner_bot connected` and `bridge running; data folder ...`, each with the
date and time in front. It posts nothing until draft day.

## Private chats instead of a group

If you would rather the bot talk to each person privately and pass things along between them, set:

```toml
[messaging.conversation]
mode = "household-dms"
```

and leave out `chatId`. Each person must open a chat with the bot once and press **Start**;
Telegram does not let a bot write first. The bot's replies go to every adult's private chat.

## When something goes wrong

- **"Telegram rejected the bot token"**: the variable is empty, has extra spaces, or the token was
  revoked. Copy it again from BotFather.
- **"cannot open the household chat"**: the chat ID is wrong, or the bot is not in the group. The
  ID must include the minus sign and be in quotes.
- **The bot ignores plain messages but answers when tagged**: privacy mode is still on (step 2).
- **"another program is already reading this bot's messages"**: a second copy of the bot is
  running (or a webhook is set on the bot). Only one may run.
- **The group was "upgraded to a supergroup"**: Telegram gives a group a new chat ID when it grows
  or gets certain settings. The bot notices, keeps working, and writes the new ID in its log. Put
  the new ID in `chatId` the next time you edit the config.
- **The bot cannot message someone privately**: that person has not pressed **Start** in a chat
  with the bot yet.
- **Reactions**: the bot puts an eyes reaction on a message it has received and a thumbs-up when it
  has answered. Telegram only allows a short list of reactions, which is why it is not a green
  check mark. If a reaction fails, nothing else is affected.
- The bot sends plain text only (no bold or links formatting), and splits very long replies into
  several messages of at most 4096 characters.
