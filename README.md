# Household meal planner

A chat bot that plans your household's dinners. It lives in the family chat you already use. Once a
week it posts a draft for the next seven dinners. You change nights by talking to it in plain
language, say "lock it", and it posts the grocery list, sorted the way you walk your store.

- It reads a profile you can edit by hand: house rules ("no fish on weeknights"), usual dishes,
  things nobody will eat, how your grocery list is laid out.
- It uses your own Anthropic API key and runs on your own computer or home server. There is no
  account with us and no service to sign up for.
- It is designed to answer only the adults you list; anyone else in the chat is ignored (covered by
  the test suite).

## What it looks like

On draft day (Friday afternoon by default) the bot posts:

```
Here's the draft for Oct 5 to Oct 11:

• Monday: Chicken tacos (Mexican night)
• Tuesday: Spaghetti and meatballs (Pasta night)
• Wednesday: Sheet-pan sausage and peppers
• Thursday: Shrimp fried rice
• Friday: out (Friday is eating out)
• Saturday: Lemon chicken with rice · suggested dish, search Allrecipes: https://www.allrecipes.com/search?q=lemon+chicken
• Sunday: Smoked brisket (Sunday is the big cook)

Anything to use up, or anything you want different this week?
```

Alex and Sam answer in the chat, the way they would to a person, and the bot replies:

```
Alex: swap Wednesday for something with beans
Dinner Bot: Done: Wednesday is now Black bean quesadillas.
Sam: we have tortillas and cheese already. lock it
Dinner Bot: Locked the week of Oct 5.
```

Then it posts the grocery list for the week:

```
Grocery list for Oct 5 to Oct 11 (dinners only):

Meat & Fish
- chicken thighs, 2 lb
- ground beef, 1 lb
- shrimp, 1 lb

Vegetables
- white onion (x2)
- cilantro

Check before you buy
- olive oil
- salt and pepper
```

(This is made-up sample output to show the shape. Your dishes, rules and wording will differ.)

## What it can do

- Posts a weekly draft on the day and time you choose, in your time zone.
- Changes nights on request ("swap Tuesday for tacos", "something lighter on Thursday").
- Keeps your house rules ("at least one pasta night", "Friday is eating out") and says so when a
  request bends one.
- Wants at least one dinner each week that is new to your household (you can change or turn off
  this "discovery rule").
- Builds the grocery list when you lock the week, leaves off what you already have, and puts staples
  you may be out of under "Check before you buy".
- Remembers what you never want again ("never make tuna casserole") and who dislikes what.
- Suggests dishes from recipe sources you choose: search links, a free recipe API, your own Mealie or
  Tandoor, and, if you turn it on for a site, recipe pages it reads itself.
- Tells the admin when something is wrong (the model key stopped working, the draft did not go
  out), and has a watchdog (`bun run check-health`) designed to work even when the bot itself is
  down.

## Status

Be clear-eyed about this table. Nothing here has been run against a live chat service yet.

| Part | Status | What has been tried |
| --- | --- | --- |
| Signal | Built, tested against simulated services, not yet live | Automated fakes only. Not yet run against the live Signal service. |
| Telegram | Built, tested against simulated services, not yet live (the easiest to set up) | An automated fake of Telegram's Bot API only. Not yet run against live Telegram. |
| WhatsApp | Beta, tested against simulated services | A fake of Meta's Cloud API only. Not yet run against Meta's live service. |
| iMessage (through BlueBubbles) | Beta, tested against simulated services | A fake BlueBubbles server only. Not yet run against a real Mac or server. |
| TheMealDB recipes (on by default) | Field mapping checked against the live API once (2026-11-24) | Otherwise a fake. |
| Mealie and Tandoor recipes (off by default) | Built, tested against simulated services, not yet live | Fakes only. Not yet tried against a live Mealie or Tandoor. |
| Reading recipe pages from websites (off for every site) | Opt-in, tested against simulated sites, not yet live | Fake sites only. Not yet tried on a live site. |
| The AI model calls | Built, tested against a simulated service, not yet live | A fake of the Anthropic API. A live check exists and runs only when you ask: `HMP_LIVE_TEST=1 bun test test/brain.live.test.ts` (it makes one small real call with your key). |

"Tested against simulated services" means the automated tests pass against a stand-in that behaves
the way the service's documentation says it should. It does not prove the real service behaves that
way. Expect to find rough edges the first time, and please report them.

## Quick start (Telegram)

You need a computer or home server that stays on, and about 30 minutes. You do not need to be a
developer, but you will type a few commands into a terminal and edit a few text files. It runs on
macOS and Linux. (Windows is not tested.) Do these steps in order.

**1. Install Bun, get the code, install its parts.** Bun is the program that runs the bot.

```
curl -fsSL https://bun.sh/install | bash
```

Close the terminal and open a new one, then check it worked:

```
bun --version
```

It prints a version number. Then get the code (or click **Code**, then **Download ZIP**, on the
repository page, unzip it, and open a terminal in that folder). The repository is private until
its owner makes it public, so cloning may ask you to sign in to GitHub.

```
git clone https://github.com/bronsonelliott/household-meal-planner.git
cd household-meal-planner
bun install
```

Run every command in this guide **in this folder** (the "project folder").

**2. Make the Telegram bot and find your IDs.** Follow steps 1 to 4 of
[docs/platforms/telegram.md](docs/platforms/telegram.md): make the bot with BotFather, turn privacy
mode off, make the group, and find the group's chat ID and each adult's user ID. Keep the bot token
and the numbers in a note for the next steps. Do it now, before you edit any file.

**3. Make your settings file.** `config.example.toml` is a template with comments on every line. It
ships set up for Signal, so you must change it for Telegram:

```
cp config.example.toml config.toml
```

Open `config.toml` in a text editor and make these changes:

- Under `[household]`, put in your household's name.
- Under each `[[members]]`, change `name`, and on the `[members.identities]` line replace
  `signal = "..."` with `telegram = "<that person's user ID>"` (in quotes). Delete the other
  platforms' lines.
- Under `[schedule]`, set your `timezone`.
- Under `[messaging]`, change `platform = "signal"` to `platform = "telegram"`.
- Delete the whole `[messaging.signal]` block (down to the `groupId` line). Remove the `#` from
  `[messaging.telegram]`, `botTokenEnv` and `chatId`, and put your group's chat ID in `chatId`.

If you would rather copy than edit, step 5 of the Telegram guide has the complete Telegram version
of these parts: replace the `[[members]]` and `[messaging]` parts of `config.toml` with it.

**4. Put your secrets in a `.env` file.** This is the one place secrets go:

```
cp .env.example .env
```

Open `.env` and replace the placeholder after `ANTHROPIC_API_KEY=` with your Anthropic API key
([docs/model.md](docs/model.md) shows how to get one) and the one after `TELEGRAM_BOT_TOKEN=` with
the bot token. Leave the lines for other chat apps (WhatsApp, BlueBubbles) empty or delete them: the
checks only look at the chat app you chose. Bun reads `.env` by itself whenever you run a command in
the project folder, so there is nothing to "load". The file stays on your computer; `.gitignore` keeps it out of git.

**5. Make your profile**, which holds your rules and usual dishes:

```
mkdir -p data
cp data.example/profile.md data/profile.md
```

Open `data/profile.md` and replace the example dishes and rules with yours. The format is explained
in [Your household profile](#your-household-profile) below.

**6. Check your files and settings.** This sends nothing and starts nothing:

```
bun run doctor
```

If everything is in place it ends with "Nothing was started and nothing was sent." and looks like
this (your names, times and folders will differ):

```
All good. Your setup looks ready.
  Config file: /home/you/household-meal-planner/config.toml
  Profile: /home/you/household-meal-planner/data/profile.md (3 usual dishes, 17 grocery sections)
  Household: The Example Household, bot "Dinner Bot", 2 members
  Chat app: telegram (group)
  Draft: friday at 16:00, America/New_York
  Telegram: run `bun run doctor --online` to check the token, the group and BotFather's privacy mode.
  Recipe API TheMealDB: using the public test key. TheMealDB asks public or production apps to use a supporter key (set THEMEALDB_API_KEY).
  Recipe API Mealie: not set up (optional).
  Recipe API Tandoor: not set up (optional).
  Recipe APIs refresh every 168 hours, in the background.
Nothing was started and nothing was sent.
```

If not, it starts "Not ready yet." and lists, in plain words, what to fix. Fix them and run it again.
It only checks the chat app you chose, so unused variables for other chat apps do not matter.

**7. Check that Telegram accepts the bot.** The bot is not running yet, so nothing else is reading
its messages. This asks Telegram (and the recipe service) whether things work; it is designed to
send nothing to your group:

```
bun run doctor --online
```

After the same report as above, a pass adds:

```
Online checks:
  Telegram bot: @smith_dinner_bot (token accepted)
  Telegram group: "Family" (group)
  Telegram privacy: the bot sees every message in the group.
  TheMealDB: reachable
```

A line starting `Warning:` about privacy mode means step 2 of the Telegram guide is not finished.
Any line starting with `-` is a problem, with the fix beside it.

**8. Start it:**

```
bun start
```

The first lines it prints look like this (each starts with the date and time):

```
2026-11-24T21:05:12.345Z Telegram bot @smith_dinner_bot connected
2026-11-24T21:05:13.001Z bridge running; data folder /home/you/household-meal-planner/data
```

"bridge running" means it is up. The bot keeps running until you press Ctrl-C. **It does not post
anything when it starts.** It posts the weekly draft on draft day and time (Friday 4 PM by
default), and it answers when Alex or Sam (the adults you listed) write to it.

To see it work without waiting for Friday, and without it sending anything, stop it and start it
in dry-run mode:

```
HMP_DRY_RUN=1 bun start
```

The log line then says "bridge running (DRY RUN: nothing is sent)". Write to the group as one of
the adults, and the log shows lines starting "DRY RUN" for what it would have sent (they include the message text,
and are also saved in `state/dry-run-sends.jsonl`). Stop it
(Ctrl-C) and run plain `bun start` for real.

To keep it running after you close the terminal, and to start it again after a reboot, use your
system's service manager: [docs/deployment.md](docs/deployment.md).

Using Signal, WhatsApp or iMessage instead? Make the same edits to `config.toml` for that chat app
and follow its guide: [Signal](docs/platforms/signal.md), [WhatsApp](docs/platforms/whatsapp.md),
[iMessage](docs/platforms/imessage.md).

**Group chat or private chats.** By default the bot sits in one shared group chat
(`mode = "group"`). If you would rather it talk to each adult privately and pass things between
them, set `mode = "household-dms"`; see
[Private chats instead of a group](docs/platforms/telegram.md#private-chats-instead-of-a-group).

## Your household profile

`data/profile.md` is a plain text file you edit by hand. The bot reads it before every draft. Run
`bun run doctor` after editing: it reads the whole file and tells you, in plain words, what it
cannot understand. The example in `data.example/profile.md` is the best starting point; here is
how it works.

- **Headings.** Each part starts with a `##` heading, and the names must stay exactly as they are:
  Rules, Usual Dishes, Also-Like Dishes, Staples, Dislikes, Vetoes, Lock Words and Thresholds. A
  missing one stops the bot with a message saying which. `## Grocery Sections` is optional. Notes
  you write under a heading the bot does not know are left alone.
- **Rules.** One per line, in order of importance (when not all can fit, the bottom ones go
  first). End a rule with a check in square brackets so the bot can verify its own drafts:

  | Check | Meaning |
  | --- | --- |
  | `[fixed friday out]` | That night is always `out` (eating out), `away`, or a dish with that tag. |
  | `[min chicken 1]` | At least 1 night tagged `chicken` per week. |
  | `[max red-meat 1]` | At most 1 night tagged `red-meat`. |
  | `[require quick weeknights]` | Every dinner on those nights is tagged `quick`. Use `weeknights` (Monday to Thursday by default) or a day name. |
  | `[forbid fish weeknights]` | No dinner tagged `fish` on those nights. |
  | `[advisory]` | The bot keeps it in mind but does not check it. A rule with no brackets is advisory. |

- **Dishes.** Under Usual Dishes (what you cook often) and Also-Like Dishes (liked, less often),
  each dish is a `###` heading followed by list lines. `- Protein: chicken` is required.
  `- Tags: chicken, mexican, quick` is the list the rule checks count. Tags are your own words.
- **Ingredient lines** are optional and begin with the grocery section they belong to, then a colon:
  `- Meat & Fish: chicken thighs, 2 lb`. The section name must be one from your grocery sections
  (capital letters do not matter). A dish with no ingredient lines is fine; the bot fills them in
  when you lock a week with that dish.
- **`## Grocery Sections`.** The sections of your grocery list, one `- Section` per line, in the
  order you walk your store. Leave the heading out to use the built-in list (Fruits, Vegetables,
  Canned Goods, and so on).
- **Staples, Dislikes, Vetoes.** Staples are checked before buying ("Check before you buy" on the
  list). Dislikes are written `- Sam: mushrooms` and are information only. Vetoes are dishes never
  drafted again.
- **Lock words.** Phrases that lock the week and trigger the grocery list, one per line, for example
  `- lock it`.
- **Thresholds.** Four numbers the bot needs, all required: `max-usual-dishes-per-week`,
  `max-nights-per-protein`, `repeat-window-weeks`, `batching-window-seconds`. Keep the example
  values until you have a reason to change them.

## How the week works

1. **Draft day.** On the day and time in `config.toml` (Friday 4 PM by default) the bot posts a
   draft for the coming Monday to Sunday. If it was off or failing, it keeps trying until the
   catch-up deadline (Sunday noon by default), marks a late draft "(late)", and skips the week
   after the deadline.
2. **Change things.** Talk to it like a person: "swap Tuesday for tacos", "Thursday should be
   quick", "no fish this week". A message that is just "ok" or chatter between you is left alone.
3. **Lock it.** Say "lock it" (or any lock phrase in your profile). The bot posts the grocery list.
   Tell it what you already have ("we have tortillas") and it adjusts the list.
4. **The week runs.** Tell it when you ate something different ("we did pizza instead on Tuesday");
   that is remembered for next time.
5. **Chat commands for recipe sources** (anyone can ask; the admin changes them):
   `sources` lists them, `sources add <address>`, `sources remove <site>`,
   `sources fetch <site> on|off`, `recipe save <address>`, and `recipes status`.
   See [docs/recipe-sources.md](docs/recipe-sources.md).

## Privacy and cost

- **Your key, your bill.** The bot calls the Anthropic API with the household's own key. You pay
  Anthropic directly for the tokens used; a household's weekly use is small, and the Anthropic
  Console shows exactly what was used. Details: [docs/model.md](docs/model.md).
- **What the model is sent.** For each request: the bot's instructions, the plan for the current
  and coming week, your profile (rules, dishes, dislikes), the recent log, the recipe catalog, and
  the new chat messages being answered. The model has no tools: it cannot browse, run code or reach
  anything else.
- **What else leaves your machine.** Messages to and from your chat provider (Signal, Telegram,
  Meta for WhatsApp, or your BlueBubbles server). Requests to the recipe sources you turn on
  (TheMealDB by default; your own Mealie or Tandoor; any site you switch on for page reading).
  Optionally, alert messages to a Telegram chat you choose. The bot is designed to send nothing else
  (no analytics), and this project keeps no copy of your data.
- **Where your data is.** In the `data/` and `state/` folders you choose. Back them up.
- **Secrets** live in your `.env` file, never in `config.toml`. The bot is designed never to write
  them to its logs or send them to the model (covered by the test suite).

## Recipe sources and the terms caveat

Each source has a mode: **link** (the bot only builds a search link; it does not open the site),
**api** (it asks a recipe API built for apps: TheMealDB, your Mealie, your Tandoor, and keeps the
recipes), or **fetch** (it reads recipe pages from a site, slowly, if an admin switches that site
on). Fetching is off for every site until someone turns it on.

Please read this before you turn fetching on for a site: the bot checks the site's `robots.txt`
and refuses when it says no, but **it does not and cannot check the site's terms of use**. Whether
fetching is allowed under those terms is your household's responsibility. TheMealDB asks apps that
are public or used in production to use a supporter key instead of its public test key. Full
details: [docs/recipe-sources.md](docs/recipe-sources.md).

## Guides

- [Configuration reference](docs/configuration.md): every setting in `config.toml`.
- Chat apps: [Telegram](docs/platforms/telegram.md), [Signal](docs/platforms/signal.md),
  [WhatsApp (beta)](docs/platforms/whatsapp.md), [iMessage (beta)](docs/platforms/imessage.md).
- [The AI model and your API key](docs/model.md).
- [Recipe sources](docs/recipe-sources.md).
- [Deployment](docs/deployment.md): Docker, systemd, launchd, updating, backups.
- [Operations](docs/operations.md): the watchdog, what each alert means, pausing the bot.

## Contributing

Bug reports and pull requests are welcome. To work on the code you need Bun:

```
bun install
bun test             # the whole test suite; it is designed not to touch the network
bunx tsc --noEmit    # the type check
```

Both must pass. Tests use fakes and temporary folders only; a test that needs a real service is
skipped unless you set an environment variable to opt in. Keep the code plain and readable, with
comments that explain why.

## License

MIT. See [LICENSE](LICENSE).
