# Setting up WhatsApp (beta)

> **BETA.** The WhatsApp adapter is built against Meta's official WhatsApp Cloud API and passes the
> same automated tests as the other chat apps, but it has not been run against Meta's live service
> in this release. Expect rough edges, and read "The limits" below before you commit to it. If
> you can use Signal or Telegram instead, those are easier and fully supported.

WhatsApp is the most work to set up of the supported chat apps. Meta only lets businesses run bots,
so you register as a (very small) business, get a phone number of your own for the bot, and give
Meta a public web address to deliver messages to. Plan on an hour or two the first time.

## What you need

- A **Meta developer account** (free), at developers.facebook.com.
- A **business portfolio** (Meta Business Suite). It can be just you; Meta may ask you to verify
  it before some limits are lifted.
- A **phone number for the bot** that is **not already registered on the WhatsApp app** (a number
  registered on the Cloud API cannot also be used in the WhatsApp or WhatsApp Business app). A
  spare prepaid SIM or a number from an online phone service works. Meta also provides a free test
  number while you are trying things out.
- A **permanent access token** from a *system user* in Meta Business Settings. The 24-hour token
  shown on the setup page expires, so it is only good for a first try.
- An **approved message template** (a *utility* template), so the bot can reach someone who has not
  written to it in the last day. Strongly recommended; see "The 24-hour window".
- A **public HTTPS web address** that forwards to the bot's webhook, because Meta delivers
  messages by calling a web address you give it. A Cloudflare Tunnel is the easiest way, or a
  reverse proxy you already run (Caddy, nginx). The bot itself only listens on your own computer.

Keep the access token, the app secret and the verify token private. Anyone with them can act as
your bot or send it fake messages.

## 1. Create the app

1. At developers.facebook.com, **My Apps**, **Create app**. Choose the **Business** type and attach
   your business portfolio.
2. Add the **WhatsApp** product to the app.
3. Open **WhatsApp**, then **API Setup**. Add your phone number (or use the test number), and note
   the **Phone number ID** (a long number; it is *not* the phone number itself). That goes in
   `config.toml` as `phoneNumberId`.
4. In the app's **Settings**, **Basic**, copy the **App secret** (click Show). Meta signs every
   webhook call with it, and the bot refuses anything that is not signed.

## 2. Make the permanent token

1. In **Meta Business Settings**, **Users**, **System users**, add a system user with the
   **Admin** role.
2. **Add assets**: give it your app with full control, and your WhatsApp account.
3. **Generate token**: choose your app, set expiry to **Never**, and tick
   `whatsapp_business_messaging` and `whatsapp_business_management`. Copy it.

## 3. Make and approve the template

In **WhatsApp Manager**, **Message templates**, **Create template**:

- Category: **Utility**.
- Name: for example `meal_plan_ready`. Language: for example English (US), which is `en_US`.
- Body, with no variables: *"Your household meal planner has something for you. Reply to this
  message to see it."*

Approval usually takes minutes to a day. The bot sends this template when it has something for
someone who has not written to it in 24 hours, and delivers the real message as soon as they reply.

## 4. Choose the secrets and set the environment variables

Pick any long random text for the **verify token** (this is a password you make up, which you will
also type into Meta's dashboard in step 6). Then put three lines in the `.env` file in the project folder (`cp .env.example .env` if you have
not made it; the names can be changed in `config.toml`):

```
WHATSAPP_ACCESS_TOKEN=the permanent system-user token
WHATSAPP_APP_SECRET=the app secret from Basic settings
WHATSAPP_VERIFY_TOKEN=the random text you made up
```

No quotes. Bun reads `.env` by itself, and the deployment options in
[../deployment.md](../deployment.md) read the same file. Leave the other chat apps' lines empty or
delete them.

## 5. Fill in config.toml

Each adult's identity is their WhatsApp number with country code, digits only (a leading `+` is
fine; it is dropped). Put them in quotes.

```toml
[[members]]
id = "alex"
name = "Alex"
role = "admin"

[members.identities]
whatsapp = "15555550101"

[[members]]
id = "sam"
name = "Sam"
role = "adult"

[members.identities]
whatsapp = "15555550102"

[messaging]
platform = "whatsapp"

[messaging.conversation]
mode = "household-dms"     # the only mode WhatsApp supports; this is also the default

[messaging.whatsapp]
phoneNumberId = "100000000000000"
apiVersion = "v23.0"       # the Graph API version; Meta retires old ones every couple of years

[messaging.whatsapp.webhook]
host = "127.0.0.1"         # leave as is: the tunnel or proxy reaches it from this computer
port = 8787
path = "/whatsapp/webhook"

[messaging.whatsapp.template]
name = "meal_plan_ready"
language = "en_US"
```

Only the people listed in `[[members]]` are listened to.

## 6. Point Meta at the bot

1. Start your tunnel or proxy so that `https://your-public-address/whatsapp/webhook` reaches
   `127.0.0.1:8787/whatsapp/webhook` on the computer that runs the bot.
2. Start the bot (`bun start`). It has to be running for Meta's handshake to succeed.
3. In the app, **WhatsApp**, **Configuration**, **Webhook**: set **Callback URL** to your public
   address plus the path, and **Verify token** to the random text from step 4. **Verify and save**.
4. Under **Webhook fields**, subscribe to **messages**.

Each person then messages the bot's number once. (WhatsApp lets a bot reply only after the person
writes first, or by template; see below.)

## 7. Check it

```
bun run doctor            # the config file, and that the three variables are set
bun run doctor --online   # also asks Meta: is the token good, is this the right number
```

`--online` only reads the phone number's record; it sends nothing. It cannot tell whether Meta can
reach your public address. For that, use the Test button next to the webhook in Meta's dashboard,
and watch the bot's log: each webhook call is logged, and a call with a bad signature says so.

## The 24-hour window

WhatsApp only lets a bot send ordinary messages to someone within 24 hours of that person's last
message to it. After that, only an approved template is allowed. The bot keeps track per person:

- **Inside the window:** your plan and replies go out as normal messages.
- **Outside the window, template set:** the bot sends the template (at most once a day per person)
  and holds the real message. When that person next writes to the bot, the held message is sent
  first. Until then the bot's records say the message was **not delivered**, and the health alerts
  mention it. Held messages older than a week are dropped, since last week's plan helps nobody.
- **Outside the window, no template:** the send fails with "waiting for Sam to message the bot;
  WhatsApp only allows replies within 24 hours", and nothing is held. The plan is not treated as
  posted to that person.

The weekly plan is posted on a schedule, so on any given Friday someone who has been quiet all week
will get the template first. That is how WhatsApp works, not a fault.

## The limits

- **No group chats.** Meta's group feature for bots is limited to verified business accounts, so
  the bot talks to each person privately and relays between them (`household-dms`). Choosing
  `mode = "group"` is refused with a message saying so.
- **The 24-hour window**, above.
- **Cost.** Meta may charge for template conversations, and its pricing and free allowances change.
  Check Meta's current pricing for your country before relying on it.
- **Text only.** The bot cannot read photos, voice notes or files; it asks for words instead. It
  sends plain text, split into messages of at most 4096 characters.
- **Reactions.** The bot puts an eyes reaction on a message it has received (and marks it read),
  and a thumbs-up when it has answered. Reactions are best effort.
- **A public address is required.** If your tunnel or computer is down, Meta retries delivery for a
  while, then gives up.

## When something goes wrong

- **"WhatsApp rejected the access token"**: the variable is empty or wrong, or the token was
  revoked. Make a new permanent token (step 2).
- **Meta's "Verify and save" fails**: the bot is not running, the tunnel does not reach the port
  and path, or the verify token differs from `WHATSAPP_VERIFY_TOKEN`. The bot's log says
  "handshake refused" when the token is wrong.
- **Messages never arrive, and the log shows "missing or wrong signature"**: `WHATSAPP_APP_SECRET`
  is not the app secret from the app's Basic settings.
- **Messages never arrive and the log shows nothing**: Meta is not calling you. Check the webhook
  subscription to **messages**, and that the tunnel is up.
- **"waiting for ... to message the bot"**: that person's 24-hour window is closed and no template
  is set. Set one (step 3), or ask them to send the bot any message.
- **Template send fails with "template does not exist"**: the `name` or `language` in
  `[messaging.whatsapp.template]` does not match an *approved* template exactly.
- **A number cannot receive messages (131026)**: it is not on WhatsApp, or the person has not
  accepted WhatsApp's terms. With Meta's test number, each recipient must also be added to the
  allowed list in API Setup.
