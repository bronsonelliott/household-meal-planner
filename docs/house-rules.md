# House-rules cookbook

Your house rules are what make this bot plan *your* family's week instead of a generic one. They
live in `data/profile.md`, under the `## Rules` heading, and you can write them without knowing
any code. This page is a menu of 30 ready-to-copy rules, grouped by the kind of household that
tends to want them. Pick the ones that sound like you, paste them in, and change the words.

Don't want to write rules by hand? Start the bot with no profile and it will interview you in the
chat and write them down for you; you can still use this page to choose ideas to tell it, or to
edit the result afterwards.

A few things to know before you start:

- **A rule is a plain sentence.** The sentence is for people. The part in square brackets at the
  end is the check the bot runs on every draft before it posts. If the draft breaks the check,
  the bot sends it back once, naming the problem.
- **Order is importance.** Put the rules that matter most at the top. When a week cannot satisfy
  all of them, the ones at the bottom give way first.
- **The adults still have the last word.** Rules get the week started. If Alex says "make it
  pizza on Tuesday" and that bends a rule, the bot does it and says plainly which rule it bent.
- **You can add rules by chatting.** Say "from now on, fish at least twice a week" and the bot
  writes the rule into `profile.md`, tells you what it wrote, and "undo that" takes it back for
  30 minutes.
- **Tags are your own words, and they must match.** A rule like `[min fish 2]` counts dishes
  tagged `fish`. If none of your usual dishes has `fish` in its `Tags:` line, the bot has nothing
  to count. See "Tags" below.

## How a rule works

```
- Weeknight dinners are quick. [require quick weeknights]
```

There are three parts:

| Part | Example | What it is |
| --- | --- | --- |
| The sentence | `Weeknight dinners are quick.` | For you. The bot shows it back when it names a rule. |
| The check, in square brackets | `[require quick weeknights]` | What the bot actually tests. Always the last thing on the line. |
| The leading dash | `- ` | Every rule is one list line. |

The six kinds of check:

| Check | Meaning |
| --- | --- |
| `[min TAG N]` | At least N dinners that week are tagged TAG. |
| `[max TAG N]` | At most N dinners that week are tagged TAG. |
| `[fixed DAY VALUE]` | That night is always VALUE. VALUE is `out` (eating out), `away` (not home), or a tag the dish must carry. |
| `[require TAG NIGHTS]` | Every home-cooked dinner on those nights is tagged TAG. |
| `[forbid TAG NIGHTS]` | No dinner on those nights is tagged TAG. |
| `[advisory]` | The bot keeps it in mind but does not check it. A rule with no brackets at all counts as advisory. |

**DAY** is a day name: `monday` through `sunday`, lower case.

**NIGHTS** is either a day name or the word `weeknights`. What `weeknights` covers is set by
`planning.weeknights` in your `config.toml`; the default is Monday to Thursday. If your
school nights include Sunday, or your Friday counts as a weekend, change it there and every
rule that says `weeknights` follows.

**TAG** is one word, with no spaces. Use hyphens: `red-meat`, `one-pot`, `kid-friendly`. Case
does not matter.

### Tags

A tag is any word you put on a dish's `Tags:` line:

```
### Chicken tacos
- Protein: chicken
- Tags: chicken, mexican, quick, kid-friendly
```

The rules count those words. Two helpful facts:

- **A dish's protein counts as a tag automatically.** `Protein: beef` means `[max beef 1]` works
  even if you never wrote `beef` in `Tags:`. That is why the fish, chicken and beef rules below
  need no extra tagging.
- **New dishes get tags from the model.** When the bot suggests a dish you have never made, it
  tags it itself, using the words your rules use. Your own dishes use the tags you wrote.

### Protein groups

A dish also counts for the family its protein belongs to, so `[max red-meat 2]` catches a beef
dish even if nobody wrote `red-meat` on it. The built-in families:

| Rule word | Proteins it covers |
|---|---|
| `red-meat` | beef, pork, lamb, goat, veal, venison, bison |
| `poultry` | chicken, turkey, duck |
| `fish` | salmon, tuna, cod, tilapia, halibut, trout and other fish |
| `shellfish` | shrimp, crab, lobster, scallops, mussels, clams |
| `seafood` | all the fish and shellfish above |

The "no protein on more than N nights" limit also treats all fish as one protein and all shellfish
as one, so salmon, tuna and cod on three nights count as three fish nights. Tags you write
yourself keep working exactly as before.

The golden rule: **the tag in a rule has to be on the dishes you actually cook.** Pick your
rules first, then add the matching words to the `Tags:` lines of the dishes you cook most.

## The rules

Each entry shows the line exactly as it goes in `profile.md`, then what it does and which tags
your dishes need. These are alternatives, not a checklist: seven nights only hold so many rules
(see "Common mistakes").

### Busy weeknights and school nights

```
- Weeknight dinners are quick. [require quick weeknights]
```
Every home-cooked weeknight dinner must be tagged `quick`. Tag your 30-minutes-or-less dishes `quick`.

```
- Thursday is clean-out-the-fridge night. [fixed thursday leftovers]
```
Thursday's dinner is always a dish tagged `leftovers`. Tag a dish or two `leftovers` (a "leftover buffet" entry works well).

```
- Nothing that needs a long cook on weeknights. [forbid big-cook weeknights]
```
Keeps Sunday-style projects off school nights. Tag your long cooks `big-cook`.

```
- Wednesday is slow-cooker night so dinner is ready when practice ends. [fixed wednesday slow-cooker]
```
Wednesday is always a dish tagged `slow-cooker`. Tag your slow-cooker and Instant Pot dishes.

### Families with young kids

```
- At least three kid-friendly dinners a week. [min kid-friendly 3]
```
At least three dinners tagged `kid-friendly`. Tag the dishes everyone under ten will eat without a fight.

```
- Tuesday is taco night. [fixed tuesday taco]
```
Tuesday is always a `taco` dish. Tag tacos, fajitas, nachos and taco bowls `taco`.

```
- Nothing spicy on weeknights. [forbid spicy weeknights]
```
Keeps heat off school nights. Tag the hot dishes `spicy`.

```
- At least two dinners built around vegetables. [min veggie-heavy 2]
```
A gentle nudge toward vegetables. Tag stir-fries, sheet-pan veg dinners and veggie-loaded pastas `veggie-heavy`.

### Vegetarian and flexitarian

```
- At least three vegetarian dinners a week. [min vegetarian 3]
```
Counts dinners tagged `vegetarian`. Tag every meatless dish `vegetarian`.

```
- No more than two meat dinners a week. [max meat 2]
```
For flexitarians who want meat to be the exception. Tag every dish with meat, poultry or fish `meat`; unlike proteins, `meat` is not added for you.

```
- At least one bean or lentil dinner a week. [min legume 1]
```
Tag chili, dal, black-bean dishes and lentil soups `legume`.

### Budget-conscious

```
- At least two budget dinners a week. [min budget 2]
```
Tag your cheap, pantry-heavy dishes (beans and rice, pasta, egg dinners) `budget`.

```
- At most one splurge dinner a week. [max splurge 1]
```
Steak night, shrimp, anything with a pricey ingredient: tag it `splurge` and the bot rations it.

```
- Beef no more than once a week. [max beef 1]
```
Beef is the expensive protein for many families. Nothing to tag: `Protein: beef` already counts.

### Health-minded

```
- Fish at least twice a week. [min fish 2]
```
Counts dishes whose protein or tag is `fish`. Salmon, shrimp and cod dishes all work if their `Protein:` line says `fish`.

```
- Red meat no more than once a week. [max red-meat 1]
```
Tag beef, pork and lamb dishes `red-meat`. (Proteins count as tags too, so say `Protein: beef` as well.)

```
- No fried food on weeknights. [forbid fried weeknights]
```
Tag fried chicken, fish and chips and similar dishes `fried`.

```
- Favor whole grains and plenty of vegetables. [advisory]
```
A goal the bot keeps in mind but cannot count. Advisory rules are listed as unchecked in every draft.

### Meatless Fridays and other observances

```
- Friday is meatless. [fixed friday meatless]
```
Friday's dinner is always tagged `meatless`. Tag cheese pizza, veggie pasta, bean dishes and fish dishes (if fish counts for you) `meatless`.

```
- Friday is a sit-down family dinner at home. [require sit-down friday]
```
For Shabbat dinner, a weekly family table, or any night with a tradition. Tag the dishes that suit the occasion `sit-down`.

### Batch-cook and leftovers nights

```
- Sunday is the big cook. [require big-cook sunday]
```
Sunday's dish must be tagged `big-cook`. Tag roasts, braises, brisket and big pots of soup.

```
- At least one dinner that makes tomorrow's lunch. [min makes-leftovers 1]
```
Tag dishes that reliably leave a lunch behind (a roast, a big pot of chili, a casserole) `makes-leftovers`.

```
- Monday is leftovers from the Sunday cook. [fixed monday leftovers]
```
Monday is always a `leftovers` dish. It pairs with the Sunday rule above; put the Sunday rule higher in the list.

### Date night and eat-out traditions

```
- Friday is eating out. [fixed friday out]
```
Friday is always an eat-out night. No tags needed.

```
- Saturday is date night, so we are out. [fixed saturday out]
```
Saturday is always out. No tags needed.

```
- Sundays we are at the grandparents'. [fixed sunday away]
```
`away` means dinner happens somewhere else and the bot plans nothing for that night. No tags needed.

### Picky eaters and one-pot dinners

```
- At least two one-pot dinners a week. [min one-pot 2]
```
Fewer dishes to wash. Tag skillet, sheet-pan and Dutch-oven dishes `one-pot`.

```
- At least one dinner everyone agrees on. [min crowd-pleaser 1]
```
Tag the "nobody complains" dishes (pizza, burgers, baked potatoes) `crowd-pleaser`.

### Seasonal and grilling

```
- Saturday is grill night. [fixed saturday grill]
```
Saturday's dish is always tagged `grill`. In winter, drop the line or add a `grill` indoor dish.

```
- At least two grill nights a week in summer. [min grill 2]
```
A summer rule: add it when the weather turns and remove it in autumn ("drop the grill rule").

```
- At least one big salad dinner a week. [min salad 1]
```
Tag main-course salads `salad`.

```
- Lean toward what is in season. [advisory]
```
The bot keeps the season in mind when it suggests new dishes. Not checked.

## Sample rule blocks

Three whole `## Rules` sections you can start from. Each puts the most important rules first and
leaves room in the week for the bot to choose.

**Two working parents, two kids.** Alex and Sam are home by six and the kids have practice most
evenings.

```
## Rules

- Friday is eating out. [fixed friday out]
- Weeknight dinners are quick. [require quick weeknights]
- At least three kid-friendly dinners a week. [min kid-friendly 3]
- Sunday is the big cook. [require big-cook sunday]
- Red meat no more than once a week. [max red-meat 1]
- Lean toward what is in season. [advisory]
```

**Vegetarian couple.** Riley and Jamie eat no meat, like cooking on weekends, and go out on Saturdays.

```
## Rules

- Saturday is date night, so we are out. [fixed saturday out]
- At least one bean or lentil dinner a week. [min legume 1]
- Weeknight dinners are quick. [require quick weeknights]
- Sunday is the big cook. [require big-cook sunday]
- At least one big salad dinner a week. [min salad 1]
- Try a new cuisine now and then. [advisory]
```

**Big family on a budget.** Six at the table and a tight grocery bill.

```
## Rules

- At least three budget dinners a week. [min budget 3]
- Beef no more than once a week. [max beef 1]
- At most one splurge dinner a week. [max splurge 1]
- Monday is leftovers from the Sunday cook. [fixed monday leftovers]
- Sunday is the big cook. [require big-cook sunday]
- At least two one-pot dinners a week. [min one-pot 2]
- Plain sides everyone will eat on the table every night. [advisory]
```

## Common mistakes

- **A tag in a rule that is on no dish.** The most common one. `[min fish 2]` needs dishes whose
  protein or tags say `fish`. A `[require quick weeknights]` rule with no `quick` dishes cannot be
  met by your own dishes, so the bot has to invent new ones. Check each rule's tag against the
  `Tags:` lines of the dishes you cook.
- **Too many hard rules for seven nights.** Each checked rule narrows what can go on a night.
  Eight or ten checked rules plus fixed nights leave the bot nothing to choose from. Aim for five
  or six checked rules and make the rest `[advisory]`.
- **Contradictory fixed nights.** `[fixed friday out]` and `[fixed friday meatless]` cannot both
  hold, and two `fixed` rules for the same night are always a conflict. One rule per night.
  Likewise `[require quick weeknights]` fights a `[fixed wednesday slow-cooker]` unless your
  slow-cooker dishes are also tagged `quick`.
- **Forgetting that order matters.** When the week cannot satisfy everything, the bottom rules
  go first. Put the ones you would never bend at the top and the nice-to-haves at the bottom.
- **Spaces or capitals in tags and checks.** Tags are single words: write `red-meat`, not
  `red meat`. A check the bot cannot read stops it, and `bun run doctor` tells you which line.
- **Square brackets in the sentence.** The check is the last pair of square brackets on the
  line. Keep brackets out of the sentence part.
- **Forgetting the brackets.** A rule with no check is treated as `[advisory]`: it is
  remembered but never enforced. If a rule is being ignored, look for a missing check.
- **Counting out nights.** `min` and `max` count only home-cooked dinners. A night marked
  `out` or `away` has no dish, so it counts toward nothing.

After any edit, run `bun run doctor`. It reads the whole file and tells you, in plain words, what
it cannot understand.
