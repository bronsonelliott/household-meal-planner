# Setting up Signal

Signal is fully supported, but it takes more setup than Telegram: Signal has no official bot
program, so the bot drives **signal-cli**, a free open-source command-line client. Plan on an hour
the first time. If you just want to try the bot, [Telegram](telegram.md) is quicker.

> Signal support has been tested against a stand-in for signal-cli, not against the live Signal
> service yet. See the status table in the [README](../../README.md).

You will end up with three things in `config.toml`:

- the bot's **own phone number**,
- the **group ID** of your household group (a long code ending in `=`), and
- each adult's **account ID** (a code like `0a1b2c3d-...`, called a UUID).

## 1. Get a number for the bot

The bot should have its **own Signal account**, on its own phone number, so it does not read or
send as one of you. The number only has to receive one text message or call, once. A spare prepaid
SIM or a number from an online phone service works. Do not use a number that is already on Signal
unless you are happy to move that Signal account to the bot.

(You can also *link* the bot to an existing account as a second device. It then sends as that
person and sees all of their chats, so it is not recommended. See "Linking instead of registering"
below.)

## 2. Install Java and signal-cli

signal-cli needs Java. Its release notes say which Java version a release needs (recent releases
want Java 21 or newer). Check with `java -version`. On a Mac with Homebrew: `brew install openjdk`.
On Debian or Ubuntu: `sudo apt install openjdk-21-jre-headless`, or a newer one if signal-cli asks.

Then download a **current** signal-cli release from
https://github.com/AsamK/signal-cli/releases. Signal retires old clients, so an outdated one
eventually stops working; plan to update it every few months.

```
mkdir -p vendor/signal-cli
tar -xzf signal-cli-<version>.tar.gz -C vendor/signal-cli --strip-components=1
vendor/signal-cli/bin/signal-cli --version
```

If Java is installed somewhere signal-cli cannot find, set `javaHome` in `config.toml` (see below).

## 3. Register the bot's number

Run these from the bot's folder. They use a data folder of their own, `state/signal-cli`, which is
where the bot account's keys will live. **Back that folder up and keep it private.**

```
vendor/signal-cli/bin/signal-cli --config state/signal-cli -a +15555550123 register
```

(Use the bot's number, with country code, in place of `+15555550123`.) Signal usually asks you to
solve a captcha first, and the command says so. Open
https://signalcaptchas.org/registration/generate.html, solve it, right-click the "Open Signal"
button, copy the link (it starts with `signalcaptcha://`), and run the command again with it:

```
vendor/signal-cli/bin/signal-cli --config state/signal-cli -a +15555550123 register --captcha 'signalcaptcha://...'
```

Signal texts a 6-digit code to the number (add `--voice` to the register command to get a phone
call instead). Finish with:

```
vendor/signal-cli/bin/signal-cli --config state/signal-cli -a +15555550123 verify 123456
```

Do not open the Signal app with this number on a phone afterwards: registering it there would take
the account away from the bot.

### Linking instead of registering

```
vendor/signal-cli/bin/signal-cli --config state/signal-cli link -n "Dinner Bot"
```

prints a `sgnl://...` address. Turn it into a QR code (any QR generator, on your own computer) and
scan it in Signal on the phone: **Settings, Linked devices, Link new device**. The bot then runs as
a second device of that person's account.

## 4. Put the bot in the household group

From one of your phones, add the bot's number to the household Signal group (or make a new group
with the adults and the bot). The bot only listens to the people listed in `config.toml`, but it
must be in the group to read and write there.

Then let signal-cli pick up the change, and list the groups:

```
scripts/signal-cli.sh receive
scripts/signal-cli.sh -o json listGroups -d
```

`scripts/signal-cli.sh` is a small helper that runs signal-cli with the same Java, data folder and
bot number as the bot, taken from your `config.toml` (it needs `bun` and `jq`). **Stop the bot
first**; two programs should not use the account at once.

In the listing, find your household group. Its `id` is the **group ID** (it ends in `=`). Each
member has a `uuid`: that is the person's **account ID**. Write down each adult's.

If you cannot tell whose UUID is whose, start the bot once with the wrong IDs: when a check fails,
it prints every group it found, with each member's UUID and number, so you can match them up.

## 5. Fill in config.toml

```toml
[[members]]
id = "alex"
name = "Alex"
role = "admin"

[members.identities]
signal = "11111111-1111-4111-8111-111111111111"   # Alex's account ID

[[members]]
id = "sam"
name = "Sam"
role = "adult"

[members.identities]
signal = "22222222-2222-4222-8222-222222222222"

[messaging]
platform = "signal"

[messaging.conversation]
mode = "group"

[messaging.signal]
cliPath = "vendor/signal-cli/bin/signal-cli"
dataDir = "state/signal-cli"
botNumber = "+15555550123"
groupId = "RVhBTVBMRS1HUk9VUC1JRC1ERU1PLTAwMDAwMDAwMDA="
# javaHome = "/opt/homebrew/opt/openjdk"   # only if signal-cli can't find Java by itself
```

If you prefer private chats to a group, set `mode = "household-dms"` and leave out `groupId`. Each
adult then needs to have messaged the bot's number once.

Run `bun run doctor` to check the file, then `bun start`. At start-up the bot checks that the group
exists, that it is in it, and that every adult is in it, and says plainly what is wrong if not.

## Running in Docker

Use `deploy/Dockerfile.signal` (see [../deployment.md](../deployment.md)). It adds Java and a
signal-cli release that you name and verify with a checksum, so the build refuses to run without
the version and checksum you supply. In `config.toml` set:

```toml
[messaging.signal]
cliPath = "/opt/signal-cli/bin/signal-cli"
dataDir = "state/signal-cli"
```

and register the number **inside the container's state folder** so the keys are in the volume
that survives restarts. For example, with the same Compose file you use to run the bot:

```
docker compose -f deploy/compose.yaml run --rm --no-deps planner \
  /opt/signal-cli/bin/signal-cli --config /app/state/signal-cli -a +15555550123 register
```

(and likewise `verify`). The signal-cli release is the Intel/AMD Linux build. On an ARM machine
such as a Raspberry Pi, the plain release does not include the native library signal-cli needs, so
this image may not work there; run signal-cli natively on that machine instead, or use Telegram.

## Keeping it working

- **Update signal-cli every few months.** Signal stops accepting old clients. When it does, the
  bot's heartbeat goes stale and the watchdog alerts you ("Heartbeat is stale" in
  [../operations.md](../operations.md)). Download a new release, replace `vendor/signal-cli`, and
  restart. In Docker, rebuild with the new version and checksum.
- **A number that is not used for a long time can be de-registered.** If so, repeat step 3.
- **Rate limits.** If Signal rate-limits a send, the bot writes a note with a captcha token. Stop the
  bot, solve a captcha at https://signalcaptchas.org/challenge/generate.html, copy the "Open Signal"
  link, and run
  `scripts/signal-cli.sh submitRateLimitChallenge --challenge <the token> --captcha '<the link>'`.
  Then start the bot again.
- **Safety numbers.** When someone gets a new phone their Signal "safety number" changes. The bot
  goes by account IDs, so this does not break it.
