# Recipe sources

Where the bot's recipe ideas can come from, how each source is used, and how to manage them from
chat. Everything here is about *recipes*; the week's plan itself is described elsewhere.

## The three modes

Each source has a **mode** that says what the bot may do with it.

| Mode | What the bot does | Example |
| --- | --- | --- |
| **link** | Builds a search link to the site and puts it in the plan ("find one on Food Network"). It never opens the site. | Food Network, Allrecipes, The Kitchn, and any site you add with `sources add` |
| **api** | Asks the source's published recipe API, in the background, and keeps the recipes it gets in its own catalog (with the publisher's own ingredient list). | TheMealDB, your Mealie, your Tandoor |
| **fetch** | Downloads recipe pages from a site, slowly, and reads the recipe data on them. Off until an admin turns it on for that site. | Any site you add and switch on with `sources fetch` (see "Fetch mode" below) |

Each source also has a **policy**: `blocked` (never fetched, and chat cannot change that),
`unverified` (nobody has checked the site's terms), or `allowed` (the source offers a public API or
is your own server).

## The starting sources

The first run adds these four. An admin can remove any of them (`sources remove <site>`) and a
removed one stays removed.

- **Food Network**, **Allrecipes**, **The Kitchn**: link mode only. When these were checked on
  2026-11-24, Allrecipes' `robots.txt` prohibits automated scraping except to direct traffic to
  it, and Food Network and The Kitchn blocked automated requests. So the bot only builds search
  links to them; it does not open their pages.
- **TheMealDB**: api mode, policy allowed. It is a free recipe API built for apps.

## TheMealDB

Nothing to set up: it works out of the box with TheMealDB's public test key (`1`).

**TheMealDB asks apps that are public or used in production to use a supporter key instead.** If
you have one, add it as a line in the `.env` file in the project folder and the bot will use it:

```
THEMEALDB_API_KEY=your-supporter-key
```

(The variable's name can be changed in `config.toml` under `[recipes.themealdb]`.)

What a refresh does: it reads TheMealDB's category list, then the meals in the dinner categories
(Beef, Chicken, Lamb, Pasta, Pork, Seafood, Vegetarian, Vegan, Goat, Miscellaneous; Dessert,
Breakfast, Starter and Side are skipped), then reads the full recipe of each meal it does not have
yet. One refresh reads at most `lookupsPerRefresh` new recipes (40 by default), so a first fill
takes a few days: while there is more to fetch, the bot comes back after a day instead of a week.

## Your own Mealie or Tandoor

[Mealie](https://mealie.io) and [Tandoor](https://tandoor.dev) are recipe managers you run
yourself. Pointing the bot at one lets it plan from the household's own collection.

1. Make an API token in the app (Mealie: your profile, "API Tokens". Tandoor: Settings, "API").
2. Put the token in your `.env` file, never in a file you share: a line
   `MEALIE_API_TOKEN=...` (or `TANDOOR_API_TOKEN=...`).
3. Add a section to `config.toml` (the example file has it ready to uncomment):

   ```toml
   [recipes.mealie]
   url = "http://mealie.local:9000"   # your server's address; a home-network address is fine
   tokenEnv = "MEALIE_API_TOKEN"
   maxRecipes = 300
   ```

   Tandoor is the same with `[recipes.tandoor]`.
4. Run `bun run doctor` (it checks the token variable is set) and `bun run doctor --online` (it
   makes one small read to prove the address and, for Tandoor, the token work).
5. Start the bridge. The first time, Mealie or Tandoor is added to the source list ("sources" shows
   it) and refreshed straight away.

Good to know:

- **Only the servers you name in `config.toml` may be on a home-network address.** Everywhere else
  the bot refuses addresses that point inside your network (private, loopback, link-local), and
  it re-checks every redirect. Your server is allowed as an exact address and port: if `url` is
  `http://192.168.1.10` (port 80), then `http://192.168.1.10:8080` is still refused. Saved links
  (bookmarks) are never replaced by a fetched copy of the same page.
- If an admin removes the source from chat (`sources remove mealie`), it stays removed after a
  restart. Changing the `url` in `config.toml` is treated as a new setup and adds it again.
- Links to your recipes are `<url>/g/<group>/r/<slug>` for Mealie when it says which group a recipe
  is in, otherwise `<url>/recipe/<slug>`; for Tandoor `<url>/view/recipe/<id>`. They are links for
  people to open; the bot never opens them.
- The field names were written against Mealie v2.x and Tandoor 1.5.x and have **not** been
  tried against a live server yet. If a refresh says "could not be read" for everything, a newer
  version probably renamed something; the single function that maps each app's fields is named in
  the first lines of `src/recipes/providers/mealie.ts` and `tandoor.ts`.

## When refreshes happen

Never while a week is being planned. The bridge starts a refresh when it starts and then checks
once a minute whether any source is due:

- every `refreshHours` (168, one week, by default; set under `[recipes]`),
- after a day, if the last refresh could not fetch everything (TheMealDB's lookup budget),
- six hours after a failed refresh (not every minute).

A refresh builds the source's complete recipe list, checks it, and swaps it in with one atomic file
write. If anything goes wrong, the source keeps the recipes it already had and `recipes status`
says what happened. Recipes you saved from chat and other sources are never touched. Planning reads
a snapshot of the catalog, so a refresh in progress changes nothing mid-plan.

The bot is designed never to write a token to its log, its status file, or a chat reply (covered by
the test suite).

## Chat commands

Anyone can ask; the ones marked "admin" need an admin.

- `sources`: list the sources and what the bot does with each.
- `sources add <web address>` (admin): add a site in link mode.
- `sources remove <site>` (admin): remove a source. Its saved recipes stay on file but are no
  longer suggested; adding it back returns them. For your own servers, `sources remove mealie`
  works (the name, since their addresses are rarely typed).
- `sources fetch <site> on|off` (admin): turn page fetching on or off for a site (see "Fetch mode").
- `recipe save <web address> [name]`: save a recipe link. On a site that is switched on for fetching,
  the bot reads the page and saves the recipe itself.
- `recipes status`: how many recipes are saved per source, and for an API source when it was last
  refreshed, whether that worked, and, if not, why and which recipes were kept.

## Fetch mode (opt-in, per site)

Fetch mode reads recipe pages straight from a site, so the bot has the publisher's own ingredient
list and steps instead of writing the ingredients itself. It is **off for every site** until an
admin turns it on, one site at a time.

### Turning it on

1. `sources add https://example-recipes.com` (admin) if the site is not a source yet.
2. `sources fetch example-recipes.com on` (admin).

The bot reads the site's `robots.txt` and **refuses** if:

- the source is `blocked` (chat can never change that), or an API source (those are always on);
- `robots.txt` disallows the whole site for the bot, or disallows `/recipe/` or `/recipes/`
  (it looks at the group for the bot's name, else the `*` group, longest matching rule wins);
- `robots.txt` carries `Content-Signal: ai-input=no`, because the bot's use feeds a model;
- `robots.txt` cannot be read (the site is down or answers with a server error). Nothing changes;
  try again later.

A missing `robots.txt` (404 or any other 4xx) sets no limits, as the standard says, so the site can
be switched on. Otherwise it records who turned it on and when, and the reply says in plain words
that fetching is on, that `robots.txt` allows it, and that **the site's terms of use were NOT
checked**. Checking them is the household's responsibility. A friendly `robots.txt` never changes a
site's policy: `unverified` stays `unverified`.

`sources fetch <site> off` goes back to links only. Recipes already fetched **stay on file and can
still be suggested**, but are no longer refreshed, and the site is not contacted again. To hide them,
`sources remove <site>`.

### What it does once on

- **Finds pages through sitemaps only.** The sitemaps named in `robots.txt` (else `/sitemap.xml`),
  including sitemap indexes and `.xml.gz` files. It keeps addresses that look like recipes
  (`/recipe/...`, `/recipes/...`, names ending in `-recipe`; category, tag and paging pages are
  skipped) and confirms each by reading the page. A site whose recipe addresses look different can
  be given its own rule in `HOST_RECIPE_PATTERNS` (`src/recipes/site/discovery.ts`; empty by
  default). It never follows links on pages and never uses a site's search.
- **Reads only the page's recipe data** (the `application/ld+json` block, as plain data). Page
  scripts are never run and no outside address in the data is fetched. A page counts as a recipe
  only with a name and at least three ingredients.
- **Is polite.** It names itself (`userAgent` in `config.toml`; put a real contact there), waits
  `secondsBetweenRequests` (5) between requests to a site, honours `Retry-After`, caps sizes, will
  not open private network addresses (a redirect to one is refused), and checks `robots.txt` (cached
  up to 24 hours) before every page. A redirect is only followed when it stays on the same site (the
  same host or its `www.` twin), does not go from https to plain http, and leads to a path
  `robots.txt` allows; the destination is checked before it is requested. `Crawl-delay` is not read; the default pause is already long.
- **Has daily budgets per site**, in `config.toml`: `sitemapsPerSourcePerDay` (10) and
  `pagesPerSourcePerDay` (20). What does not fit waits in a saved queue for the next day, so a big
  site fills in over days. The count is per UTC day; a saved page counts too.
- **Keeps what is good.** Each source's recipes are published in one atomic step, like the API
  sources. A failed run keeps the recipes already on file. Recipes are re-checked after 7 days with
  `ETag` / `Last-Modified`; a page that is gone or that `robots.txt` now closes is dropped. If
  `robots.txt` cannot be read, fetching pauses and retries in 6 hours. Three failed requests in a row
  stop a run. `recipes status` shows the last refresh, any problem, and whether more is waiting.
- Recipes get a stable id from the page's canonical address (its `<link rel="canonical">` when that
  is on the same site), so the same page is never saved twice.

### A known limit: DNS rebinding

Before each request the bot looks up the site's name and refuses private addresses (see above). The
web client then looks the name up again to connect, and Bun's `fetch` cannot be told to connect to
exactly the address that was checked while still verifying the site's certificate for its name. So a
hostile DNS server could in theory answer "public" to the check and "private" to the connection. The
bot narrows that window by running the check immediately before every single request (after the
politeness wait, and again on every retry and every redirect hop), but it cannot close it. This
matters only in fetch mode, which is off for every site until an admin turns it on, one site at a
time, and is meant for well-known public recipe sites. Do not switch it on for a site you do not
trust.

### Saving one page from chat

`recipe save <address>` on a site that is switched on makes the bot read that page right then
(still subject to `robots.txt` and the day's page budget). The reply comes only once the recipe is
on file, with the publisher's ingredients. If the page can't be read (no recipe data, `robots.txt`
says no, the site is down, the budget is spent) the link is saved as a plain link, the reply says
why, and nothing is queued for later. Sites that are not switched on are never contacted.

### Candidates, not permission

A 2026-11-24 look at the `robots.txt` of some popular recipe sites found these did not restrict AI
tools. **Their terms of use were not reviewed**, so this is a starting list to check, not
permission. Read a site's terms before switching it on:

- Smitten Kitchen
- Pinch of Yum
- Love and Lemons
- Taste of Home
- King Arthur Baking

Seed sources Food Network and The Kitchn start in link mode: Food Network blocked automated
requests when checked, and The Kitchn's terms pages did. Allrecipes is `blocked`.
