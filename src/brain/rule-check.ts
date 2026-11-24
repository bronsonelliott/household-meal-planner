// The rule check: the model writes, the harness grades.
//
// After every model proposal the brain builds the week as it would stand and runs it through
// here. Everything is pure: a week in, a list of problems out. The checks:
//
//   - each typed profile rule (min, max, fixed, require, forbid); advisory rules are only listed
//   - the variety caps: usual dishes per week, nights per protein
//   - vetoes and the repeat window against the log
//   - for a weekly draft: every night filled, and enough discovery nights (see checkDiscoveryNights)
//
// Pins. Pinned nights count toward every total, but only the problems the pins cause are
// excused. A problem the pins cause comes back in `bent` so the reply can say which rule or cap
// was bent; a problem on the nights the agent chose comes back in `violations`.
//
// Dislikes are information, never bans: nothing here reads them.

import { displayTag } from "../display-text.ts";
import { capGroupOf, groupsOfProtein } from "../recipes/protein.ts";
import { findUsableRecord, proteinOf, usableRecords } from "../recipes/catalog.ts";
import { findSourceById } from "../recipes/sources.ts";
import { UNKNOWN_PROTEIN, type RecipeContext } from "../recipes/types.ts";
import type { LogEntry } from "../data/log.ts";
import { NIGHTS, sameWords, type HouseProfile, type NewDish, type Night, type NightTarget } from "../data/profile.ts";
import { capitalize, type NightChange } from "../week/changeset.ts";
import { addDays, shortDate, type DishPool, type WeekNight } from "../week/state.ts";

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

// One night as the check sees it: where the dish came from, its protein and tags, and whether
// an adult pinned it.
export interface CheckNight {
  kind: "dish" | "out" | "away";
  dish: string;
  pool: DishPool | null;
  protein: string | null;
  tags: string[];
  pinned: boolean;
  // The catalog recipe this night came from, if any. Used before the name for repeat checks.
  recipeId?: string;
}

export type CheckWeekNights = Record<Night, CheckNight | null>;

export interface Violation {
  key: string; // a stable label, e.g. "cap:usual:3" or "rule:2:tuesday"
  text: string; // one plain sentence fragment, for the retry prompt and the reply
  nights: Night[];
}

export interface CheckInput {
  weekOf: string; // the Monday of the week being checked
  nights: CheckWeekNights;
  profile: HouseProfile;
  recentLog: LogEntry[];
  // The nights a rule means by "weeknights" (config.toml, planning.weeknights).
  weeknights: readonly Night[];
  // Rules the model says it had to drop. Only the bottom of the profile's order may go.
  droppedRules?: string[];
  // Rules or caps an adult set aside for this week by asking for something they block ("no
  // pasta this week"). Named by the rule's exact text, or by a cap label in SET_ASIDE_CAPS.
  // The caller checks that each one cites a real adult message; this function trusts the list.
  setAside?: string[];
  // Set for a weekly draft: every night must be filled, and the discovery rule applies.
  draft?: { minDiscoveryNights: number };
  // The nights the agent could still have changed. Default: every night nobody pinned. A
  // revision passes only the nights the model changed, since a reply changes only the nights
  // it names; a minimum the agent had no room to meet is then bent, not failed.
  changeable?: Night[];
}

export interface CheckResult {
  violations: Violation[]; // must be fixed: they are on nights the agent chose
  bent: Violation[]; // excused because a pin caused them; the reply names them
  unchecked: string[]; // advisory rules, in profile order
  dropped: string[]; // rules dropped from the bottom, in profile order
  notes: string[]; // other one-line notes for the reply, e.g. the discovery rule could not be met
  setAside: string[]; // the set-aside rules or caps that actually excused something, in order
}

// The house rules only get the week started (the admin's call): an adult's word wins over
// the caps too. These are the names the model uses to set a cap aside.
export const SET_ASIDE_CAPS = {
  usual: "usual dishes limit",
  protein: "protein limit",
  repeat: "repeat window",
  discovery: "discovery rule",
} as const;

// ---------------------------------------------------------------------------------------------
// Dish names: normalizing and near-matching
// ---------------------------------------------------------------------------------------------

// Small words that say nothing about which dish it is.
const STOP_WORDS = new Set(["a", "an", "the", "and", "n", "with", "of", "in", "on", "for", "to", "style", "easy", "homemade", "classic", "best"]);

// A plain plural stem, so "fajitas" and "fajita" match. Deliberately simple and predictable.
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (/(ches|shes|xes|zes|oes|sses)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

// "Sheet-Pan Chicken Fajitas!" -> ["sheet", "pan", "chicken", "fajita"]
export function dishWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word))
    .map(stem);
}

// Two names are a close match when every word of the shorter one appears in the longer one:
// "Sheet-pan chicken fajitas" matches "Chicken fajitas", "Chicken tacos" does not match
// "Chicken parmesan". A reworded dish cannot slip past a cap or a veto this way.
export function isCloseMatch(a: string, b: string): boolean {
  const wordsA = dishWords(a);
  const wordsB = dishWords(b);
  if (wordsA.length === 0 || wordsB.length === 0) return false;
  const [shorter, longer] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
  return shorter.every((word) => longer.includes(word));
}

// ---------------------------------------------------------------------------------------------
// Building check nights
// ---------------------------------------------------------------------------------------------

// A dish added to the profile in the same change set ("add fish tacos to the usual dishes").
export interface AddedDish {
  pool: "usual" | "also-like";
  dish: NewDish;
}

// The tags any typed rule looks at. Only these can be filled in from the model's tags.
function ruleTags(profile: HouseProfile): Set<string> {
  const tags = new Set<string>();
  for (const rule of profile.rules) {
    const check = rule.check;
    if (check.kind === "min" || check.kind === "max" || check.kind === "require" || check.kind === "forbid") tags.add(check.tag);
    if (check.kind === "fixed") tags.add(check.value);
  }
  return tags;
}

// Proteins the household's data already uses, so a model tag can be recognized as a protein.
function knownProteins(profile: HouseProfile, recipes: RecipeContext): Set<string> {
  const proteins = new Set<string>();
  for (const dish of [...profile.usualDishes, ...profile.alsoLikeDishes]) proteins.add(dish.protein);
  for (const record of usableRecords(recipes.catalog)) proteins.add(proteinOf(record));
  proteins.delete(UNKNOWN_PROTEIN);
  return proteins;
}

// The profile dish a name refers to, compared without case.
function profileDish(profile: HouseProfile, name: string): { pool: "usual" | "also-like"; protein: string; tags: string[]; name: string } | null {
  const wanted = name.trim().toLowerCase();
  const usual = profile.usualDishes.find((dish) => dish.name.toLowerCase() === wanted);
  if (usual) return { pool: "usual", protein: usual.protein, tags: usual.tags, name: usual.name };
  const alsoLike = profile.alsoLikeDishes.find((dish) => dish.name.toLowerCase() === wanted);
  if (alsoLike) return { pool: "also-like", protein: alsoLike.protein, tags: alsoLike.tags, name: alsoLike.name };
  return null;
}

// The profile dish a new dish's name closely matches, usual dishes first.
function closeProfileDish(profile: HouseProfile, name: string): { pool: "usual" | "also-like"; protein: string } | null {
  const usual = profile.usualDishes.find((dish) => isCloseMatch(dish.name, name));
  if (usual) return { pool: "usual", protein: usual.protein };
  const alsoLike = profile.alsoLikeDishes.find((dish) => isCloseMatch(dish.name, name));
  if (alsoLike) return { pool: "also-like", protein: alsoLike.protein };
  return null;
}

// A night already stored in a week file. Its protein and tags were resolved when it was
// written; a new dish that closely matches a profile dish still counts as that dish's pool.
export function nightFromStored(value: WeekNight, profile: HouseProfile): CheckNight {
  let pool = value.pool;
  if (value.kind === "dish" && pool === "new") {
    const match = closeProfileDish(profile, value.dish);
    if (match) pool = match.pool;
  }
  return {
    kind: value.kind,
    dish: value.dish,
    pool,
    protein: value.protein,
    tags: [...value.tags],
    pinned: value.pinnedBy !== null,
    ...(value.recipe?.recipeId ? { recipeId: value.recipe.recipeId } : {}),
  };
}

// The model's tags on a dish choice. A profile choice may carry tags too (schema.ts keeps
// them), used only to fill a tag the profile entry is missing.
export function modelTagsOf(dish: NightChange["dish"]): string[] {
  if (dish.kind === "catalog" || dish.kind === "source" || dish.kind === "new") return dish.tags;
  if (dish.kind === "profile") return (dish as { tags?: string[] }).tags ?? [];
  return [];
}

export interface ResolvedNight {
  night?: CheckNight;
  problem?: string; // the name is not where the model said it was
  flags: string[]; // model tags used to fill profile gaps
}

// A night the model proposes. Protein comes from the profile or the catalog when the dish is
// known there, and from the model for new and suggested dishes. Tags: profile dishes use their
// profile tags; catalog, suggested and new dishes use the model's.
export function nightFromChange(
  change: NightChange,
  pinned: boolean,
  profile: HouseProfile,
  recipes: RecipeContext,
  added: AddedDish[],
): ResolvedNight {
  const choice = change.dish;
  const lower = (tags: string[]) => tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag !== "");

  switch (choice.kind) {
    case "out":
      return { night: { kind: "out", dish: "Out", pool: null, protein: null, tags: [], pinned }, flags: [] };
    case "away":
      return { night: { kind: "away", dish: "Away", pool: null, protein: null, tags: [], pinned }, flags: [] };

    case "profile": {
      const found = profileDish(profile, choice.name);
      if (!found) {
        const addedDish = added.find((entry) => entry.dish.name.trim().toLowerCase() === choice.name.trim().toLowerCase());
        if (addedDish) {
          const { dish, pool } = addedDish;
          return { night: { kind: "dish", dish: dish.name, pool, protein: dish.protein.toLowerCase(), tags: lower(dish.tags), pinned }, flags: [] };
        }
        return {
          problem: `"${choice.name}" is not on the usual or also-like dishes. Use the exact name from the dish index, or make it a new dish.`,
          flags: [],
        };
      }
      // A tag a typed rule uses, missing from the profile entry, is taken from the model and flagged.
      const tags = [...found.tags];
      const flags: string[] = [];
      const usedByRules = ruleTags(profile);
      for (const tag of lower(modelTagsOf(choice))) {
        if (!usedByRules.has(tag) || tags.includes(tag)) continue;
        tags.push(tag);
        flags.push(`${found.name} has no "${displayTag(tag)}" tag in the profile, so the model's tag was used. Add it to the profile if it's right.`);
      }
      return { night: { kind: "dish", dish: found.name, pool: found.pool, protein: found.protein, tags, pinned }, flags };
    }

    case "catalog": {
      const record = findUsableRecord(recipes.catalog, choice.id);
      if (!record) return { problem: `"${choice.id}" is not in the recipe catalog. Use an id from the catalog index, or make it a new dish.`, flags: [] };
      const tags = lower(choice.tags);
      const protein = proteinFromTags(proteinOf(record), tags, profile, recipes);
      return { night: { kind: "dish", dish: record.name, pool: "catalog", protein, tags, pinned, recipeId: record.id }, flags: [] };
    }

    case "source": {
      const source = findSourceById(recipes.sources, choice.sourceId);
      if (!source) {
        return { problem: `"${choice.sourceId}" is not one of the recipe sources. Use a source id from the sources list, or make it a new dish.`, flags: [] };
      }
      const tags = lower(choice.tags);
      const stated = choice.protein?.trim().toLowerCase() ?? UNKNOWN_PROTEIN;
      return { night: { kind: "dish", dish: choice.name, pool: "source", protein: proteinFromTags(stated, tags, profile, recipes), tags, pinned }, flags: [] };
    }

    case "new": {
      // A close match to a profile dish counts as that dish.
      let pool: DishPool = "new";
      let protein = choice.protein.trim().toLowerCase();
      const profileMatch = closeProfileDish(profile, choice.name);
      if (profileMatch) {
        pool = profileMatch.pool;
        protein = profileMatch.protein;
      }
      return { night: { kind: "dish", dish: choice.name, pool, protein, tags: lower(choice.tags), pinned }, flags: [] };
    }
  }
}

// An unknown protein is treated like a new, model-tagged dish: take a protein named in the
// model's tags, if exactly one known protein is.
function proteinFromTags(protein: string, tags: string[], profile: HouseProfile, recipes: RecipeContext): string {
  if (protein !== UNKNOWN_PROTEIN) return protein;
  const proteins = knownProteins(profile, recipes);
  const named = tags.filter((tag) => proteins.has(tag));
  return named.length === 1 ? named[0]! : protein;
}

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

function nightList(nights: Night[]): string {
  return nights.map(capitalize).join(", ");
}

function targetNights(target: NightTarget, weeknights: readonly Night[]): readonly Night[] {
  return target === "weeknights" ? weeknights : [target];
}

// A night's tags for rule purposes: its own tags, its protein, and the groups that protein belongs
// to (beef -> red-meat), so "no fish on weeknights" catches a salmon dish whose tags don't say "fish".
function tagsOf(night: CheckNight): string[] {
  return night.protein ? [...night.tags, night.protein, ...groupsOfProtein(night.protein)] : night.tags;
}

// Compares rule text without case, extra spaces, or trailing punctuation.
// Which rule indexes the model dropped, or a problem when the drop is not from the bottom.
function droppedRuleIndexes(profile: HouseProfile, dropped: string[]): { indexes: Set<number>; problem: string | null } {
  if (dropped.length === 0) return { indexes: new Set(), problem: null };
  const checked = profile.rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => rule.check.kind !== "advisory");
  const indexes = new Set<number>();
  for (const text of dropped) {
    const match = checked.find(({ rule }) => sameWords(rule.prose, text));
    if (!match) return { indexes: new Set(), problem: `"${text}" is not one of the checked house rules, so it can't be dropped` };
    indexes.add(match.index);
  }
  const bottom = checked.slice(checked.length - indexes.size).map(({ index }) => index);
  if (!bottom.every((index) => indexes.has(index))) {
    const names = bottom.map((index) => `"${profile.rules[index]!.prose}"`).join(", ");
    return { indexes: new Set(), problem: `rules can only be dropped from the bottom of the list; dropping ${indexes.size} means dropping ${names}` };
  }
  return { indexes, problem: null };
}

export function checkWeek(input: CheckInput): CheckResult {
  const { profile, nights, weekOf } = input;
  const violations: Violation[] = [];
  const bent: Violation[] = [];
  const notes: string[] = [];

  const filled = NIGHTS.filter((night) => nights[night] !== null);
  const dishNights = filled.filter((night) => nights[night]!.kind === "dish");
  const isPinned = (night: Night) => nights[night]!.pinned;
  const complete = filled.length === NIGHTS.length;
  const changeable = input.changeable ?? filled.filter((night) => !isPinned(night));
  const canChange = (night: Night) => changeable.includes(night) && !isPinned(night);

  // A problem on one night: excused when that night is pinned.
  const perNight = (night: Night, key: string, text: string) => {
    (isPinned(night) ? bent : violations).push({ key, text, nights: [night] });
  };

  // A "too many" problem over the week: the nights the agent chose are at fault only when
  // they would break the limit on their own; otherwise the pins caused it.
  const tooMany = (offending: Night[], limit: number, key: string, text: string) => {
    if (offending.length <= limit) return;
    const chosen = offending.filter((night) => !isPinned(night));
    (chosen.length > limit ? violations : bent).push({ key, text, nights: offending });
  };

  // Rules the model dropped from the bottom.
  const drop = droppedRuleIndexes(profile, input.droppedRules ?? []);
  if (drop.problem) violations.push({ key: "dropped", text: drop.problem, nights: [] });

  const unchecked: string[] = [];
  const dropped: string[] = [];

  profile.rules.forEach((rule, index) => {
    const check = rule.check;
    if (check.kind === "advisory") {
      unchecked.push(rule.prose);
      return;
    }
    if (drop.indexes.has(index)) {
      dropped.push(rule.prose);
      return;
    }
    const quoted = `"${rule.prose}"`;
    switch (check.kind) {
      case "fixed": {
        const value = nights[check.night];
        if (!value) return;
        const satisfied =
          (check.value === "out" && value.kind === "out") ||
          (check.value === "away" && value.kind === "away") ||
          (value.kind === "dish" && tagsOf(value).includes(check.value));
        if (!satisfied) perNight(check.night, `rule:${index}:${check.night}`, `${capitalize(check.night)} is ${value.dish}, which breaks ${quoted}`);
        return;
      }
      case "require":
      case "forbid": {
        for (const night of targetNights(check.nights, input.weeknights)) {
          const value = nights[night];
          if (!value || value.kind !== "dish") continue; // out and away nights have no dish
          const has = tagsOf(value).includes(check.tag);
          const broken = check.kind === "require" ? !has : has;
          if (broken) perNight(night, `rule:${index}:${night}`, `${capitalize(night)} is ${value.dish}, which breaks ${quoted}`);
        }
        return;
      }
      case "min": {
        if (!complete) return; // open nights may still meet it
        const tagged = dishNights.filter((night) => tagsOf(nights[night]!).includes(check.tag));
        if (tagged.length >= check.count) return;
        const text = `only ${tagged.length} nights tagged "${displayTag(check.tag)}"; ${quoted} needs ${check.count}`;
        // The agent is at fault when it had enough nights of its own to reach the required count.
        const room = dishNights.filter((night) => canChange(night) && !tagsOf(nights[night]!).includes(check.tag));
        (room.length >= check.count - tagged.length ? violations : bent).push({ key: `rule:${index}`, text, nights: [] });
        return;
      }
      case "max": {
        const tagged = dishNights.filter((night) => tagsOf(nights[night]!).includes(check.tag));
        const text = `${tagged.length} nights tagged "${displayTag(check.tag)}" (${nightList(tagged)}); ${quoted} allows ${check.count}`;
        tooMany(tagged, check.count, `rule:${index}`, text);
        return;
      }
    }
  });

  // The variety caps.
  const { maxUsualDishesPerWeek, maxNightsPerProtein, repeatWindowWeeks } = profile.thresholds;
  const usual = dishNights.filter((night) => nights[night]!.pool === "usual");
  tooMany(
    usual,
    maxUsualDishesPerWeek,
    `cap:usual:${usual.length}`,
    `${usual.length} usual dishes this week (${usual.map((night) => nights[night]!.dish).join(", ")}); the limit is ${maxUsualDishesPerWeek}`,
  );

  const byProtein = new Map<string, Night[]>();
  for (const night of dishNights) {
    const stated = nights[night]!.protein;
    if (!stated || stated === UNKNOWN_PROTEIN) continue;
    const protein = capGroupOf(stated); // salmon, tuna and cod are one protein for the cap
    if (!byProtein.has(protein)) byProtein.set(protein, []);
    byProtein.get(protein)!.push(night);
  }
  for (const [protein, proteinNights] of byProtein) {
    tooMany(
      proteinNights,
      maxNightsPerProtein,
      `cap:protein:${protein}:${proteinNights.length}`,
      `${protein} on ${proteinNights.length} nights (${nightList(proteinNights)}); the limit is ${maxNightsPerProtein}`,
    );
  }

  // Vetoes, matched by close name so a reworded dish can't slip past.
  for (const night of dishNights) {
    const name = nights[night]!.dish;
    const veto = profile.vetoes.find((vetoed) => isCloseMatch(vetoed, name));
    if (veto) perNight(night, `veto:${night}`, `${capitalize(night)} is ${name}, which is vetoed ("${veto}")`);
  }

  // The repeat window: logged weeks that started within the window before this one.
  const windowStart = addDays(weekOf, -7 * repeatWindowWeeks);
  const windowWeeks = input.recentLog.filter((entry) => entry.weekOf >= windowStart && entry.weekOf < weekOf);
  for (const night of dishNights) {
    const name = nights[night]!.dish;
    const hit = windowWeeks.find((entry) => [...entry.nights, ...entry.changedAfterLock].some((logged) => sameDish(logged, nights[night]!)));
    if (hit) perNight(night, `repeat:${night}`, `${capitalize(night)} is ${name}, which was on the menu the week of ${shortDate(hit.weekOf)}`);
  }

  // weekly draft only.
  if (input.draft) {
    for (const night of NIGHTS) {
      if (nights[night] === null) violations.push({ key: `open:${night}`, text: `${capitalize(night)} has no dinner`, nights: [night] });
    }
    checkDiscoveryNights(input, input.draft.minDiscoveryNights, windowWeeks, dishNights, dishNights.filter(canChange).length > 0, violations, bent);
  }

  // An adult's instruction wins: a violation of a rule or cap they set aside this week moves
  // out of the violations and is named instead.
  const wanted = new Set((input.setAside ?? []).map((label) => label.trim().toLowerCase()));
  const setAside: string[] = [];
  const kept = violations.filter((violation) => {
    const label = labelFor(violation.key, profile);
    if (label === null || !wanted.has(label.toLowerCase())) return true;
    if (!setAside.includes(label)) setAside.push(label);
    return false;
  });

  return { violations: kept, bent, unchecked, dropped, notes, setAside };
}

// The rule text or cap label a violation belongs to, or null for problems no adult can set
// aside (vetoes, open nights, a bad drop list).
function labelFor(key: string, profile: HouseProfile): string | null {
  const rule = /^rule:(\d+)/.exec(key);
  if (rule) return profile.rules[Number(rule[1])]?.prose ?? null;
  if (key.startsWith("cap:usual:")) return SET_ASIDE_CAPS.usual;
  if (key.startsWith("cap:protein:")) return SET_ASIDE_CAPS.protein;
  if (key.startsWith("repeat:")) return SET_ASIDE_CAPS.repeat;
  if (key === "discovery") return SET_ASIDE_CAPS.discovery;
  return null;
}

// Is a logged dish the same as this night's? The recipe id decides first: a recipe whose id
// matches is the same dish even if its name was changed since. Without ids on both sides (a
// household dish, an older log), the normalized name decides.
function sameDish(logged: { dish: string; recipeId?: string }, night: CheckNight): boolean {
  if (logged.recipeId !== undefined && night.recipeId !== undefined && logged.recipeId === night.recipeId) return true;
  return isCloseMatch(logged.dish, night.dish);
}

// The discovery rule: a weekly draft needs at least `minimum` nights whose dish the house has
// not had before. A night counts when its dish, of ANY kind (a saved or fetched recipe, a
// suggested dish, a plain new dish), is not on the usual or also-like lists and was not cooked
// inside the repeat window, compared by normalized name. A link alone proves nothing: a familiar
// dish saved under a new web address still matches its old name, so it does not count. A recipe
// that was renamed by its provider is still recognised, because the log keeps its catalog id.
//
// An adult's instruction wins: a pinned night that blocks the rule is excused (`bent`), and an
// adult can set the rule aside for the week by name.
function checkDiscoveryNights(
  input: CheckInput,
  minimum: number,
  windowWeeks: LogEntry[],
  dishNights: Night[],
  agentHadRoom: boolean,
  violations: Violation[],
  bent: Violation[],
): void {
  if (minimum <= 0) return;
  const { profile, nights } = input;
  const known: Array<{ dish: string; recipeId?: string }> = [
    ...profile.usualDishes.map((dish) => ({ dish: dish.name })),
    ...profile.alsoLikeDishes.map((dish) => ({ dish: dish.name })),
    ...windowWeeks.flatMap((entry) => [...entry.nights, ...entry.changedAfterLock]),
  ];
  const discovery = dishNights.filter((night) => !known.some((logged) => sameDish(logged, nights[night]!)));
  if (discovery.length >= minimum) return;

  const text = `only ${discovery.length} of the dinners ${discovery.length === 1 ? "is" : "are"} new to the house; the discovery rule wants ${minimum} (a dish that is not on the usual or also-like lists and wasn't cooked in the last ${profile.thresholds.repeatWindowWeeks} weeks)`;
  (agentHadRoom ? violations : bent).push({ key: "discovery", text, nights: [] });
}
