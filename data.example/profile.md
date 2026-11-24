# House Profile

Hand-editable. The dinner agent reads this file before every draft and writes to it only
when someone in the group uses explicit rule words ("add a rule," "never," "always," "from
now on," "add X to the usual dishes"). Keep the eight required `##` headings (Rules, Usual Dishes,
Also-Like Dishes, Staples, Dislikes, Vetoes, Lock Words, Thresholds) exactly as they are; the
agent refuses to run if one is missing. `## Grocery Sections` is a ninth heading and is
optional (see below). Anything under a heading it does not know is ignored.
Not sure what rules to write? See `docs/house-rules.md` for 30 ready-to-copy ones.

## Rules

Order matters: when the rules cannot all fit, the agent drops them from the bottom up.
Each rule ends with the check the agent runs, in square brackets:
`[min TAG N]` at least N nights tagged TAG, `[max TAG N]` at most N, `[fixed DAY VALUE]`
that night is always VALUE, `[require TAG NIGHTS]` / `[forbid TAG NIGHTS]` where NIGHTS is
`weeknights` (set by `planning.weeknights` in config.toml; Monday to
Thursday by default) or a day name, and `[advisory]` for a rule the agent only
keeps in mind and does not check. A rule with no brackets is treated as advisory.

- Friday is eating out. [fixed friday out]
- At least one chicken night a week. [min chicken 1]
- At least one pasta night a week. [min pasta 1]
- At least one Mexican night a week. [min mexican 1]
- Red meat no more than once a week. [max red-meat 1]
- Weeknight dinners are quick. [require quick weeknights]
- Sunday is the big cook. [require big-cook sunday]
- Lean toward what is in season. [advisory]

## Usual Dishes

Each dish is a `###` heading, then its protein, optional tags, and one ingredient line per
item prefixed by its grocery-pad section. A dish with no ingredient lines is fine: the
agent fills them in when a week with that dish locks.

### Chicken tacos
- Protein: chicken
- Tags: chicken, mexican, quick
- Meat & Fish: chicken thighs, 2 lb
- Breads: corn tortillas, 1 pack
- Vegetables: white onion
- Vegetables: cilantro
- Condiments: salsa verde

### Spaghetti and meatballs
- Protein: beef
- Tags: pasta, red-meat
- Meat & Fish: ground beef, 1 lb
- Pasta & Rice: spaghetti, 1 lb
- Sauces & Oils: marinara, 1 jar
- Dairy: parmesan

### Smoked brisket
- Protein: beef
- Tags: red-meat, big-cook

## Also-Like Dishes

### Shrimp fried rice
- Protein: fish
- Tags: quick
- Meat & Fish: shrimp, 1 lb
- Pasta & Rice: jasmine rice
- Frozen Foods: peas and carrots
- Dairy: eggs, 3

## Grocery Sections

Optional. The sections of your grocery list, in the order you want them printed (most people
use the order they walk their store), one `- Section`
per line. Every ingredient line (`- Dairy: eggs, 3`) must start with one of these names. Delete
this whole heading to use the built-in list (Fruits, Vegetables, Canned Goods, and so on).

- Fruits
- Vegetables
- Canned Goods
- Frozen Foods
- Meat & Fish
- Deli
- Spices
- Condiments
- Sauces & Oils
- Vegetarian
- Snacks
- Breads
- Beverages
- Dairy
- Pasta & Rice
- Baking
- Cereal

## Staples

Checked before buying, never assumed. They land under "check before you buy" on the list.

- Olive oil
- Salt
- Garlic
- Butter

## Dislikes

Information only. A dislike never keeps a dish off the menu. One line per person and thing.

- Sam: mushrooms

## Vetoes

Never drafted again.

- Tuna casserole

## Lock Words

- lock it
- lock the week

## Thresholds

- max-usual-dishes-per-week: 2
- max-nights-per-protein: 2
- repeat-window-weeks: 3
- batching-window-seconds: 15
