# Setting up iMessage (beta)

> **BETA.** The iMessage adapter is written against the REST API of the free **BlueBubbles**
> server, version **1.9.9** (the v1 API). It passes the same automated tests as the other chat
> apps, but those tests run against a fake server. It has **not been run against a live BlueBubbles
> server or a real Mac** in this release, and Apple can change Messages at any time. Read "The
> limits" below before you commit to it. If you can use Signal or Telegram instead, those are
> easier and fully supported.

Apple has no bot API for iMessage. The only way to use it is to run a real Messages app on a Mac
and let a program drive it. BlueBubbles is a free server that does that and exposes the Mac's
Messages over a small web API; this bot talks to that API. Plan on an hour the first time.

## What you need

- **A Mac that stays on** (a spare or old one is fine, even a Mac mini in a closet). It must not
  sleep, and it must stay signed in. If it is off, the bot is deaf and mute.
- **A dedicated Apple ID for the bot**, signed into **Messages** on that Mac. Do not use anyone's
  personal Apple ID: the bot sends and reads from the account, so it would see all of that person's
  messages. Give the bot's Apple ID a phone number or email that your household can message.
- **The BlueBubbles server** installed and running on that Mac (bluebubbles.app has the download
  and its own step-by-step setup). When it asks, grant it the permissions it names, normally
  **Full Disk Access** and **Accessibility**. Set a server **password** in it.
- **A reachable address** for the server. Two common ways: if the bot runs on the same home
  network, use the Mac's local address (like `http://192.168.1.20:1234`); otherwise use one of
  BlueBubbles' own tunnel options (its setup lists them) and use the address it gives you. The
  bot itself does **not** have to run on a Mac. Only BlueBubbles does. Anything that can open the
  server's address will do.

## 1. Find your handles and the group

Everyone's identity is the phone number (with country code, like `+15555550101`) or the email
address they use for iMessage. Emails are compared in lowercase.

For a group chat, create the household chat in Messages on any phone, adding the bot's Apple ID.
Then find its **chat GUID**, which looks like `iMessage;+;chat123456789012345678`. In BlueBubbles'
own app, open the chat; its GUID is shown in the chat details. (Through the API it is the `guid` of
`GET /api/v1/chat/query`.) A chat with one person looks like `iMessage;-;+15555550101` and is not
a group. The bot refuses it as a group GUID.

## 2. Set the password

Put the server password in the `.env` file in the project folder (`cp .env.example .env` if you
have not made it). Never in `config.toml`, and never in the server address.

```
BLUEBUBBLES_PASSWORD=the password you set in BlueBubbles
```

(No quotes. Bun reads `.env` by itself when you run a command in the project folder. Leave the
other chat apps' lines empty or delete them.)

## 3. Configure

```toml
[[members]]
id = "alex"
name = "Alex"
role = "admin"
[members.identities]
imessage = "+15555550101"

[[members]]
id = "sam"
name = "Sam"
role = "adult"
[members.identities]
imessage = "sam@example.com"

[messaging]
platform = "imessage"

[messaging.conversation]
mode = "group"          # or "household-dms": the bot talks to each person privately

[messaging.imessage]
serverUrl = "http://192.168.1.20:1234"
passwordEnv = "BLUEBUBBLES_PASSWORD"
chatGuid = "iMessage;+;chat123456789012345678"   # group mode only
sendMethod = "apple-script"                      # or "private-api", see below
pollIntervalSeconds = 5
allowSms = false
```

In `household-dms` mode there is no `chatGuid`. The bot finds each person's private chat from their
handle, by the BlueBubbles naming convention `iMessage;-;<handle>` (for example
`iMessage;-;+15555550101` or `iMessage;-;sam@example.com`).

## 4. Check it

```
bun run doctor            # the config file, and that the password variable is set
bun run doctor --online   # also pings the server and looks up the group chat
```

`--online` sends nothing. It checks that the server answers, that the password is accepted, what
version it is, whether the Private API is on if you chose it, and that the group chat exists.

## How the bot reads and answers

- **Reading is polling.** Every few seconds (`pollIntervalSeconds`) the bot asks the server for new
  messages. It saves how far it got in the state folder, and each poll re-reads the last five
  minutes, so a message that shares a timestamp with an earlier one, or turns up late, is not
  missed. Restarting loses nothing and handles nothing twice. The bot only moves on from a message
  after it has been written to the inbox journal.
- **What it ignores:** its own messages, tapbacks (reactions), other group chats on that Mac (they
  are not even stored), texts that are not iMessage (SMS) unless you set `allowSms = true`, and
  empty messages. A message with only a photo or file gets the usual "I can't see photos or files.
  Can you send that in words?" reply.
- **Being addressed.** iMessage has no @-mention for a bot, so the bot treats a message as
  speaking to it when it contains the bot's name (`household.botName`, "Dinner Bot" by default) as
  a whole word, in any capitals. It treats a message as a reply to the bot when it is an inline
  reply (long-press, Reply) to a message the bot sent. The bot remembers the guids of its recent
  messages, and also learns them from its own account's messages as it reads them.
- **Sending.** Long replies are split into parts of at most 2000 characters. A send counts as sent
  when BlueBubbles answers with the new message's id. That means BlueBubbles **accepted** it, not
  that Messages has delivered it: BlueBubbles can answer before Messages has actually sent. If the
  server rejects the password the send fails for good and is flagged for you to fix. If the server
  cannot be reached at all (connection refused, or its name does not resolve), nothing was sent, so
  the send is retried at 1, 5 and 15 minutes. If the server answers with a server error (any 5xx,
  such as 502 or 503), or no answer comes in time, the bot does not send it again, because it may
  already have gone out; it is reported as "send-unknown".
- **Health.** The check pings the server, looks up the group chat, and reports how long ago the bot
  last read new messages successfully. It is designed not to send a probe message. The server password is
  removed from every log line and error.

## Reactions (optional, and a security trade-off)

The bot can mark messages with tapbacks (a thumbs-up when it has seen one, a heart when it has
answered). **Tapbacks only work through BlueBubbles' Private API**, and the Private API only works
if you **turn off System Integrity Protection (SIP) on the Mac**. SIP is one of macOS's main
protections against malware. Turning it off lowers that Mac's security. That is why this is
optional and off by default.

- `sendMethod = "apple-script"` (the default): no SIP change, no reactions. The bot answers
  without marking your messages. This is fine.
- `sendMethod = "private-api"`: reactions on, and sends go through the Private API too. Only choose
  this if you understand and accept the SIP change, on a Mac that does nothing else important.
  BlueBubbles' own docs explain the steps.

## The limits

- **Apple can change Messages at any time**, and BlueBubbles then has to catch up. After a macOS
  update, check that the bot still answers.
- **The Mac must stay on and signed in**, with BlueBubbles running. A power cut, a sleep, a signed-out
  Apple ID or a server that is not restarted after a reboot all silence the bot. `bun run
  check-health` and the health alerts will say so.
- **Group sends through AppleScript can be flaky.** Sometimes the first send to a group fails, or the
  group's name has to match. If sends to the group keep failing, try `household-dms` mode, which
  uses plain one-to-one chats and is more reliable.
- **A server error is not resent.** BlueBubbles sometimes answers with an error after Messages did
  send the text, so the bot treats any 5xx answer to a send as "may have gone out" and does not send
  it again. Rarely, that means a reply never arrives; the bot reports it as "send-unknown" and you
  can ask for the week again.
- **Text only.** The bot cannot read photos, voice notes or files.
- **Tapbacks need the Private API**, above.
- **SMS.** `allowSms = true` lets the bot read plain texts from a member (for example from an Android
  phone). Replies still go out as iMessage to that person's iMessage chat.

## When something goes wrong

- **"Could not reach the BlueBubbles server"**: the Mac is asleep or off, BlueBubbles is not running,
  the address is wrong, or the tunnel is down. Try the address in a browser on the same computer as
  the bot.
- **"The BlueBubbles server rejected the password"**: `BLUEBUBBLES_PASSWORD` differs from the one in
  the BlueBubbles app.
- **"BlueBubbles cannot open the household chat"**: `chatGuid` is wrong, or the bot's Apple ID is not
  in that chat.
- **The bot never answers in the group**: say its name ("Dinner Bot, ..."), or reply directly to one
  of its messages. Plain chatter in the group is not addressed to it.
- **A field is named differently in your BlueBubbles version.** The few places that read BlueBubbles'
  field names are `readMessage` and `readServerInfo` in `src/messaging/imessage/normalize.ts`, and
  the three requests in `adapter.ts` marked "MUST BE CHECKED". Fix them there.
