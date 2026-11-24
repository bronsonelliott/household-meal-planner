// The rule check: the model writes, the harness grades. Every expected value here is
// written out by hand.

import { describe, expect, test } from "bun:test";
import {
  checkWeek,
  isCloseMatch,
  dishWords,
  nightFromChange,
  nightFromStored,
  type CheckWeekNights,
} from "../src/brain/rule-check.ts";
import { emptyRecipeContext } from "../src/recipes/types.ts";
import type { LogEntry } from "../src/data/log.ts";
import type { WeekNight } from "../src/week/state.ts";
import { MON_TO_THU } from "./fixtures/config-fixtures.ts";
import { BASELINE_RULES, away, baselineWeek, bookmarkRecipe, dish, fetchedRecipe, out, recipeContext, testProfile, withNights } from "./fixtures/brain-fixtures.ts";

const WEEK_OF = "2026-10-05";

function check(nights: CheckWeekNights, extra: Partial<Parameters<typeof checkWeek>[0]> = {}) {
  return checkWeek({ weekOf: WEEK_OF, nights, profile: testProfile({ rules: BASELINE_RULES }), recentLog: [], weeknights: MON_TO_THU, ...extra });
}

function logWeek(weekOf: string, dishes: string[]): LogEntry {
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  return {
    weekOf,
    endDate: "",
    status: "locked",
    nights: dishes.map((name, i) => ({ day: days[i]!, dish: name, protein: "unknown", swappedFromDraft: false })),
    changedAfterLock: [],
    reports: [],
  };
}

// the house rules only get the week started. When Sam or Alex
// asks for something a rule or cap would block ("no pasta this week"), their word wins; the
// model names the rule it set aside and the reply says so.
describe("rules an adult set aside for the week", () => {
  const noPasta = () => withNights(baselineWeek(), { tuesday: dish("Beef and broccoli", "new", "beef", ["quick"]) });

  test("a rule an adult set aside excuses its violation, and is named", () => {
    const result = check(noPasta(), { setAside: ["At least one pasta night a week."] });
    expect(result.violations).toEqual([]);
    expect(result.setAside).toEqual(["At least one pasta night a week."]);
  });

  test("the protein limit can be set aside", () => {
    const week = withNights(baselineWeek(), {
      tuesday: dish("Chicken curry", "new", "chicken", ["pasta"]),
      thursday: dish("Roast chicken", "new", "chicken", ["quick"]),
    });
    expect(check(week).violations.map((v) => v.key)).toContain("cap:protein:chicken:3");
    const result = check(week, { setAside: ["protein limit"] });
    expect(result.violations).toEqual([]);
    expect(result.setAside).toEqual(["protein limit"]);
  });

  test("a set-aside rule that excuses nothing is not named", () => {
    expect(check(baselineWeek(), { setAside: ["At least one pasta night a week."] }).setAside).toEqual([]);
  });
});

describe("the baseline", () => {
  test("a week that keeps every rule and cap has no violations and nothing bent", () => {
    const result = check(baselineWeek());
    expect(result.violations).toEqual([]);
    expect(result.bent).toEqual([]);
  });
});

describe("the usual-dishes cap", () => {
  test("three usual dishes on nights the agent chose fail, and the cap is named", () => {
    const week = withNights(baselineWeek(), { sunday: dish("Smoked brisket", "usual", "beef", ["red-meat", "big-cook"]) });
    const result = check(week);
    expect(result.violations.map((v) => v.text)).toEqual([
      "3 usual dishes this week (Chicken tacos, Pork chops, Smoked brisket); the limit is 2",
    ]);
  });

  test("a third usual dish that an adult pinned is kept, and named as bent", () => {
    const week = withNights(baselineWeek(), { sunday: dish("Smoked brisket", "usual", "beef", ["big-cook"], true) });
    const result = check(week);
    expect(result.violations).toEqual([]);
    expect(result.bent.map((v) => v.text)).toEqual([
      "3 usual dishes this week (Chicken tacos, Pork chops, Smoked brisket); the limit is 2",
    ]);
  });
});

describe("the protein cap", () => {
  const threeChicken = (pinnedWed: boolean, pinnedThu: boolean) =>
    withNights(baselineWeek(), {
      wednesday: dish("Chicken curry", "new", "chicken", [], pinnedWed),
      thursday: dish("Chicken noodle soup", "new", "chicken", [], pinnedThu),
    });

  test("chicken on three nights the agent chose fails", () => {
    const result = check(threeChicken(false, false));
    expect(result.violations.map((v) => v.text)).toEqual([
      "chicken on 3 nights (Monday, Wednesday, Thursday); the limit is 2",
    ]);
    expect(result.violations[0]!.nights).toEqual(["monday", "wednesday", "thursday"]);
  });

  test("the same week passes when two of those nights are pinned, and the cap is named as bent", () => {
    const result = check(threeChicken(true, true));
    expect(result.violations).toEqual([]);
    expect(result.bent.map((v) => v.text)).toEqual(["chicken on 3 nights (Monday, Wednesday, Thursday); the limit is 2"]);
  });

  test("pins that put chicken on three nights are all kept", () => {
    const week = withNights(threeChicken(true, true), {
      monday: dish("Chicken tacos", "usual", "chicken", ["chicken", "mexican", "quick"], true),
    });
    const result = check(week);
    expect(result.violations).toEqual([]);
    expect(result.bent).toHaveLength(1);
  });

  test("out and away nights carry no protein and count toward no cap", () => {
    const week = withNights(baselineWeek(), { thursday: away(), sunday: away(true) });
    expect(check(week).violations).toEqual([]);
  });
});

describe("typed profile rules", () => {
  test('"no fish on weeknights" fails a Tuesday salmon and passes a Sunday one', () => {
    const tuesday = withNights(baselineWeek(), { tuesday: dish("Honey garlic salmon", "also-like", "fish", ["quick"]) });
    const tuesdayResult = check(tuesday);
    expect(tuesdayResult.violations.map((v) => v.text)).toContain(
      'Tuesday is Honey garlic salmon, which breaks "No fish on weeknights."',
    );

    const sunday = withNights(baselineWeek(), {
      saturday: dish("Pork tenderloin", "new", "pork", []),
      sunday: dish("Honey garlic salmon", "also-like", "fish", ["quick"]),
    });
    expect(check(sunday).violations).toEqual([]);
  });

  test("the protein counts as a tag, so a fish dish without a fish tag is still caught", () => {
    const week = withNights(baselineWeek(), { thursday: dish("Cod tacos", "new", "fish", ["quick"]) });
    expect(check(week).violations.map((v) => v.key)).toEqual(["rule:2:thursday"]);
  });

  test("a fixed night fails when the agent chose something else there, and is bent when pinned", () => {
    const chosen = withNights(baselineWeek(), { friday: dish("Pizza", "new", "vegetarian", []) });
    expect(check(chosen).violations.map((v) => v.text)).toEqual(['Friday is Pizza, which breaks "Friday is eating out."']);

    const pinned = withNights(baselineWeek(), { friday: dish("Pizza", "new", "vegetarian", [], true) });
    expect(check(pinned).violations).toEqual([]);
    expect(check(pinned).bent.map((v) => v.key)).toEqual(["rule:0:friday"]);
  });

  test("a minimum fails when the agent could have met it", () => {
    const week = withNights(baselineWeek(), { tuesday: dish("Beef and broccoli", "new", "beef", ["quick"]) });
    const result = check(week);
    expect(result.violations.map((v) => v.text)).toContain('only 0 nights tagged "pasta"; "At least one pasta night a week." needs 1');
  });

  test("two pinned pasta nights satisfy a two-pasta-night minimum without the agent adding a third", () => {
    const profile = testProfile({ rules: ["Two pasta nights. [min pasta 2]"] });
    const week = withNights(baselineWeek(), {
      tuesday: dish("Pesto pasta", "also-like", "vegetarian", ["pasta", "quick"], true),
      thursday: dish("Baked ziti", "new", "beef", ["pasta"], true),
      sunday: dish("Roast chicken", "new", "chicken", ["big-cook"]),
    });
    const result = checkWeek({ weekOf: WEEK_OF, nights: week, profile, recentLog: [], weeknights: MON_TO_THU });
    expect(result.violations).toEqual([]);

    const onePinned = withNights(week, { thursday: dish("Turkey chili", "new", "turkey", ["quick"]) });
    const failing = checkWeek({ weekOf: WEEK_OF, nights: onePinned, profile, recentLog: [], weeknights: MON_TO_THU });
    expect(failing.violations.map((v) => v.key)).toEqual(["rule:0"]);
  });

  test("a minimum the pins leave no room for is bent, not failed", () => {
    const profile = testProfile({ rules: ["A Mexican night. [min mexican 1]"] });
    const pinnedWeek: CheckWeekNights = {
      monday: dish("Pork chops", "usual", "pork", ["quick"], true),
      tuesday: dish("Pesto pasta", "also-like", "vegetarian", ["pasta"], true),
      wednesday: dish("Beef stew", "new", "beef", [], true),
      thursday: dish("Turkey chili", "new", "turkey", [], true),
      friday: out(true),
      saturday: away(true),
      sunday: away(true),
    };
    const result = checkWeek({ weekOf: WEEK_OF, nights: pinnedWeek, profile, recentLog: [], weeknights: MON_TO_THU });
    expect(result.violations).toEqual([]);
    expect(result.bent.map((v) => v.key)).toEqual(["rule:0"]);
  });

  test("in a revision, only the nights the agent changed count as room to meet a minimum", () => {
    const week = withNights(baselineWeek(), { tuesday: dish("Beef tacos", "new", "beef", ["quick"], true) });
    const pinOnly = check(week, { changeable: [] });
    expect(pinOnly.violations).toEqual([]);
    expect(pinOnly.bent.map((v) => v.key)).toEqual(["rule:1"]);

    const withSwap = check(week, { changeable: ["thursday"] });
    expect(withSwap.violations.map((v) => v.key)).toEqual(["rule:1"]);
  });

  test("a minimum is not checked on a week that still has open nights", () => {
    const week = withNights(baselineWeek(), { tuesday: null });
    expect(check(week).violations).toEqual([]);
  });

  test("a maximum fails over the whole week", () => {
    const profile = testProfile({ rules: ["Red meat no more than once a week. [max red-meat 1]"] });
    const week = withNights(baselineWeek(), {
      tuesday: dish("Beef ragu", "new", "beef", ["pasta", "red-meat"]),
      sunday: dish("Beef stew", "new", "beef", ["red-meat"]),
    });
    const result = checkWeek({ weekOf: WEEK_OF, nights: week, profile, recentLog: [], weeknights: MON_TO_THU });
    expect(result.violations.map((v) => v.text)).toEqual([
      '2 nights tagged "red-meat" (Tuesday, Sunday); "Red meat no more than once a week." allows 1',
    ]);
  });

  test("a required tag fails on a weeknight without it and ignores out and away nights", () => {
    const profile = testProfile({ rules: ["Weeknight dinners are quick. [require quick weeknights]"] });
    const week = withNights(baselineWeek(), {
      monday: away(),
      tuesday: dish("Beef stew", "new", "beef", ["big-cook"]),
      sunday: dish("Pot roast", "new", "beef", []),
    });
    const result = checkWeek({ weekOf: WEEK_OF, nights: week, profile, recentLog: [], weeknights: MON_TO_THU });
    expect(result.violations.map((v) => v.key)).toEqual(["rule:0:tuesday"]);
  });

  test("an advisory rule never fails and is listed as unchecked", () => {
    const profile = testProfile({ rules: ["Lean toward what is in season. [advisory]", "Something vague"] });
    const result = checkWeek({ weekOf: WEEK_OF, nights: baselineWeek(), profile, recentLog: [], weeknights: MON_TO_THU });
    expect(result.violations).toEqual([]);
    expect(result.unchecked).toEqual(["Lean toward what is in season.", "Something vague"]);
  });
});

describe("vetoes and dislikes", () => {
  test("a dislike never causes a failure", () => {
    const profile = testProfile({ rules: BASELINE_RULES, dislikes: ["Sam: Chicken tacos", "Riley: pork"] });
    const result = checkWeek({ weekOf: WEEK_OF, nights: baselineWeek(), profile, recentLog: [], weeknights: MON_TO_THU });
    expect(result.violations).toEqual([]);
    expect(result.bent).toEqual([]);
  });

  test("a veto fails on a night the agent chose and is excused on a pinned night", () => {
    const profile = testProfile({ rules: BASELINE_RULES, vetoes: ["Pork chops"] });
    const chosen = checkWeek({ weekOf: WEEK_OF, nights: baselineWeek(), profile, recentLog: [], weeknights: MON_TO_THU });
    expect(chosen.violations.map((v) => v.text)).toEqual(['Wednesday is Pork chops, which is vetoed ("Pork chops")']);

    const pinnedWeek = withNights(baselineWeek(), { wednesday: dish("Pork chops", "usual", "pork", ["quick"], true) });
    const pinned = checkWeek({ weekOf: WEEK_OF, nights: pinnedWeek, profile, recentLog: [], weeknights: MON_TO_THU });
    expect(pinned.violations).toEqual([]);
    expect(pinned.bent.map((v) => v.key)).toEqual(["veto:wednesday"]);
  });

  test("a new dish that closely matches a vetoed dish fails the veto", () => {
    const profile = testProfile({ rules: BASELINE_RULES, vetoes: ["Tuna casserole"] });
    const week = withNights(baselineWeek(), { thursday: dish("Tuna noodle casseroles", "new", "fish", []) });
    const result = checkWeek({ weekOf: WEEK_OF, nights: week, profile, recentLog: [], weeknights: MON_TO_THU });
    expect(result.violations.map((v) => v.key)).toContain("veto:thursday");
  });
});

describe("the repeat window", () => {
  test("a dish logged two weeks ago fails; one logged four weeks ago passes", () => {
    const twoWeeksAgo = [logWeek("2026-09-21", ["Pork chops"])];
    expect(check(baselineWeek(), { recentLog: twoWeeksAgo }).violations.map((v) => v.text)).toEqual([
      "Wednesday is Pork chops, which was on the menu the week of Sep 21",
    ]);

    const fourWeeksAgo = [logWeek("2026-09-07", ["Pork chops"])];
    expect(check(baselineWeek(), { recentLog: fourWeeksAgo }).violations).toEqual([]);
  });

  test("a change after lock counts as on the menu", () => {
    const entry = logWeek("2026-09-28", ["Beef stroganoff"]);
    entry.changedAfterLock.push({ day: "Tuesday", dish: "Turkey chili", protein: "turkey" });
    expect(check(baselineWeek(), { recentLog: [entry] }).violations.map((v) => v.key)).toEqual(["repeat:thursday"]);
  });
});

describe("near-match names", () => {
  test("dish words drop case, punctuation, stop words, and plural endings", () => {
    expect(dishWords("Sheet-Pan Chicken Fajitas!")).toEqual(["sheet", "pan", "chicken", "fajita"]);
    expect(dishWords("Mac and Cheese with Tomatoes")).toEqual(["mac", "cheese", "tomato"]);
    expect(dishWords("Berries")).toEqual(["berry"]);
  });

  test("a name whose words all appear in the other is a close match", () => {
    expect(isCloseMatch("Sheet-pan chicken fajitas", "Chicken fajitas")).toBe(true);
    expect(isCloseMatch("Chicken fajitas", "Sheet-pan chicken fajitas")).toBe(true);
    expect(isCloseMatch("Chicken tacos", "Chicken parmesan")).toBe(false);
    expect(isCloseMatch("", "Chicken")).toBe(false);
  });

  test('"Sheet-pan chicken fajitas" counts as the usual "Chicken fajitas" for the cap and the repeat window', () => {
    const profile = testProfile({ rules: BASELINE_RULES });
    const change = {
      night: "thursday" as const,
      rule: null,
      dish: { kind: "new" as const, name: "Sheet-pan chicken fajitas", protein: "chicken", tags: ["quick"], ingredients: [] },
    };
    const resolved = nightFromChange(change, false, profile, emptyRecipeContext(), []);
    expect(resolved.night).toEqual(dish("Sheet-pan chicken fajitas", "usual", "chicken", ["quick"]));

    const week = withNights(baselineWeek(), { thursday: resolved.night! });
    expect(check(week).violations.map((v) => v.key)).toEqual(["cap:usual:3"]);

    const logged = [logWeek("2026-09-28", ["Chicken fajitas"])];
    expect(check(week, { recentLog: logged }).violations.map((v) => v.key)).toContain("repeat:thursday");
  });

  test("a stored new dish that closely matches a usual dish also counts as usual", () => {
    const stored: WeekNight = {
      kind: "dish",
      dish: "Easy pork chop",
      rule: null,
      protein: "pork",
      tags: [],
      pool: "new",
      ingredients: [],
      pinnedBy: null,
      changedBy: null,
      swappedFromDraft: false,
      changedAfterLock: false,
    };
    expect(nightFromStored(stored, testProfile())).toEqual(dish("Easy pork chop", "usual", "pork", []));
  });
});

describe("where protein and tags come from", () => {
  const profile = testProfile({ rules: ["Weeknight dinners are quick. [require quick weeknights]"] });
  const recipes = recipeContext([
    fetchedRecipe("Green chile chicken enchiladas", "chicken", { id: "rcp-enchiladas" }),
    bookmarkRecipe("Mystery stew", { id: "rcp-stew" }),
  ]);

  test("a catalog dish tagged quick by the model satisfies a quick-weeknight rule", () => {
    const change = { night: "tuesday" as const, rule: "quick weeknight", dish: { kind: "catalog" as const, id: "rcp-enchiladas", tags: ["quick", "mexican"] } };
    const resolved = nightFromChange(change, false, profile, recipes, []);
    expect(resolved.night).toEqual({ ...dish("Green chile chicken enchiladas", "catalog", "chicken", ["quick", "mexican"]), recipeId: "rcp-enchiladas" });
    expect(resolved.flags).toEqual([]);

    const week = withNights(baselineWeek(), { tuesday: resolved.night! });
    expect(checkWeek({ weekOf: WEEK_OF, nights: week, profile, recentLog: [], weeknights: MON_TO_THU }).violations).toEqual([]);
  });

  test("a saved link has no protein of its own and takes one named in the model's tags", () => {
    const change = { night: "sunday" as const, rule: null, dish: { kind: "catalog" as const, id: "rcp-stew", tags: ["beef", "big-cook"] } };
    expect(nightFromChange(change, false, profile, recipes, []).night!.protein).toBe("beef");
    const untagged = { night: "sunday" as const, rule: null, dish: { kind: "catalog" as const, id: "rcp-stew", tags: ["big-cook"] } };
    expect(nightFromChange(untagged, false, profile, recipes, []).night!.protein).toBe("unknown");
  });

  test("a suggested source dish takes its stated protein and the model's tags", () => {
    const change = { night: "tuesday" as const, rule: null, dish: { kind: "source" as const, sourceId: "the-kitchn", name: "Chicken tinga", protein: "Chicken", tags: ["mexican"] } };
    expect(nightFromChange(change, false, profile, recipes, []).night).toEqual(dish("Chicken tinga", "source", "chicken", ["mexican"]));
  });

  test("a profile dish missing a tag a rule uses takes the model's tag, and the output flags it", () => {
    const change = {
      night: "monday" as const,
      rule: null,
      dish: { kind: "profile" as const, name: "Spaghetti and meatballs", tags: ["quick", "made-up"] },
    };
    const resolved = nightFromChange(change, false, profile, recipes, []);
    expect(resolved.night).toEqual(dish("Spaghetti and meatballs", "usual", "beef", ["pasta", "red-meat", "quick"]));
    expect(resolved.flags).toEqual([
      'Spaghetti and meatballs has no "quick" tag in the profile, so the model\'s tag was used. Add it to the profile if it\'s right.',
    ]);
  });

  test("a profile dish uses the profile's protein, whatever the model says", () => {
    const change = { night: "monday" as const, rule: null, dish: { kind: "profile" as const, name: "pork chops" } };
    expect(nightFromChange(change, true, profile, recipes, []).night).toEqual(dish("Pork chops", "usual", "pork", ["quick"], true));
  });

  test("a name, id or source that is not known is a problem, not a night", () => {
    const profileMiss = { night: "monday" as const, rule: null, dish: { kind: "profile" as const, name: "Beef Wellington" } };
    expect(nightFromChange(profileMiss, false, profile, recipes, []).problem).toBe(
      '"Beef Wellington" is not on the usual or also-like dishes. Use the exact name from the dish index, or make it a new dish.',
    );
    const catalogMiss = { night: "monday" as const, rule: null, dish: { kind: "catalog" as const, id: "rcp-nope", tags: [] } };
    expect(nightFromChange(catalogMiss, false, profile, recipes, []).problem).toBe(
      '"rcp-nope" is not in the recipe catalog. Use an id from the catalog index, or make it a new dish.',
    );
    const sourceMiss = { night: "monday" as const, rule: null, dish: { kind: "source" as const, sourceId: "nowhere", name: "Soup", tags: [] } };
    expect(nightFromChange(sourceMiss, false, profile, recipes, []).problem).toBe(
      '"nowhere" is not one of the recipe sources. Use a source id from the sources list, or make it a new dish.',
    );
  });

  test("a recipe from a removed source can't be chosen", () => {
    const removed = recipeContext([fetchedRecipe("Green chile chicken enchiladas", "chicken", { id: "rcp-enchiladas" })], ["themealdb"]);
    const change = { night: "tuesday" as const, rule: null, dish: { kind: "catalog" as const, id: "rcp-enchiladas", tags: [] } };
    expect(nightFromChange(change, false, profile, removed, []).problem).toContain("is not in the recipe catalog");
  });

  test("a dish added to the profile in the same change set can be placed by name", () => {
    const added = [{ pool: "usual" as const, dish: { name: "Fish tacos", protein: "fish", tags: ["mexican"], ingredients: [] } }];
    const change = { night: "tuesday" as const, rule: null, dish: { kind: "profile" as const, name: "Fish tacos" } };
    expect(nightFromChange(change, true, profile, recipes, added).night).toEqual(dish("Fish tacos", "usual", "fish", ["mexican"], true));
  });
});

describe("drafts", () => {
  const draft = { draft: { minDiscoveryNights: 1 } };

  test("a draft with an open night fails", () => {
    const week = withNights(baselineWeek(), { thursday: null });
    expect(check(week, draft).violations.map((v) => v.text)).toEqual(["Thursday has no dinner"]);
  });
});

// The discovery rule: at least N nights whose dish, of any kind, is not on the usual or
// also-like lists and was not cooked inside the repeat window.
describe("the discovery rule", () => {
  const discovery = (week: CheckWeekNights, extra: Partial<Parameters<typeof checkWeek>[0]> = {}) =>
    check(week, { draft: { minDiscoveryNights: 1 }, ...extra });
  const keys = (result: ReturnType<typeof checkWeek>) => result.violations.map((v) => v.key);
  // Both of the baseline's new dishes replaced by familiar ones (cap-safe: out and a catalog "Chicken tacos").
  const familiarOnly = () =>
    withNights(baselineWeek(), { thursday: dish("Chicken tacos", "catalog", "unknown", ["quick"]), sunday: out() });

  test("the baseline has two new dishes, so the rule is met", () => {
    expect(discovery(baselineWeek()).violations).toEqual([]);
  });

  test("a familiar dish saved under a new link does not count", () => {
    // The catalog dish is named like a usual dish; its link is new but the dish is not.
    const result = discovery(familiarOnly());
    expect(keys(result)).toEqual(["discovery"]);
    expect(result.violations[0]!.text).toContain("only 0 of the dinners are new to the house");
  });

  test("a suggested source dish and a plain new dish count the same way", () => {
    const viaSource = withNights(familiarOnly(), { thursday: dish("Chicken tinga", "source", "chicken", ["mexican"]) });
    expect(discovery(viaSource).violations).toEqual([]);
    const viaCatalog = withNights(familiarOnly(), { thursday: dish("Lemon orzo soup", "catalog", "unknown", []) });
    expect(discovery(viaCatalog).violations).toEqual([]);
  });

  test("a reworded familiar dish does not count either", () => {
    const reworded = withNights(familiarOnly(), { thursday: dish("Sheet-pan chicken fajitas", "new", "unknown", ["quick"]) });
    expect(keys(discovery(reworded))).toContain("discovery");
  });

  test("a dish cooked inside the repeat window does not count", () => {
    const logged = [logWeek("2026-09-28", ["Turkey chili", "Beef stew"])];
    expect(keys(discovery(baselineWeek(), { recentLog: logged }))).toContain("discovery");
    // Outside the three-week window it counts again.
    const old = [logWeek("2026-08-31", ["Turkey chili", "Beef stew"])];
    expect(keys(discovery(baselineWeek(), { recentLog: old }))).not.toContain("discovery");
  });

  test("a recipe its provider renamed is still recognised by its id: recently cooked, so not a discovery", () => {
    const renamed = () => withNights(familiarOnly(), { thursday: { ...dish("Garden veggie pinwheels", "catalog", "unknown", []), recipeId: "rcp-1234567890" } });
    const cooked = (recipeId?: string): LogEntry => {
      const entry = logWeek("2026-09-28", ["Zucchini lasagna rolls"]);
      if (recipeId) entry.nights[0]!.recipeId = recipeId;
      return entry;
    };
    // Cooked last week under its old name: same id, so the renamed recipe is not new.
    const same = discovery(renamed(), { recentLog: [cooked("rcp-1234567890")] });
    expect(keys(same)).toContain("discovery");
    expect(keys(same)).toContain("repeat:thursday");
    // A different recipe id with an unrelated name is new.
    expect(keys(discovery(renamed(), { recentLog: [cooked("rcp-0000000000")] }))).not.toContain("discovery");
    // An old log line with no id falls back to the name, which no longer matches.
    expect(keys(discovery(renamed(), { recentLog: [cooked()] }))).not.toContain("discovery");
    // Same name, no ids on either side: the name still decides.
    const byName = withNights(familiarOnly(), { thursday: dish("Zucchini lasagna rolls", "catalog", "unknown", []) });
    expect(keys(discovery(byName, { recentLog: [cooked()] }))).toContain("discovery");
  });

  test("the minimum is configurable, and zero turns the rule off", () => {
    expect(keys(check(baselineWeek(), { draft: { minDiscoveryNights: 3 } }))).toEqual(["discovery"]);
    expect(check(baselineWeek(), { draft: { minDiscoveryNights: 2 } }).violations).toEqual([]);
    expect(check(familiarOnly(), { draft: { minDiscoveryNights: 0 } }).violations).toEqual([]);
  });

  test("an adult can set the rule aside for the week, and it is named", () => {
    const result = discovery(familiarOnly(), { setAside: ["discovery rule"] });
    expect(result.violations).toEqual([]);
    expect(result.setAside).toEqual(["discovery rule"]);
  });

  test("when the adults' pinned nights leave no room, the shortfall is bent, not a violation", () => {
    const pinned = withNights(familiarOnly(), {
      monday: dish("Chicken tacos", "usual", "chicken", ["quick"], true),
      tuesday: dish("Pesto pasta", "also-like", "vegetarian", ["pasta", "quick"], true),
      wednesday: dish("Pork chops", "usual", "pork", ["quick"], true),
      thursday: dish("Chicken tacos", "catalog", "unknown", ["quick"], true),
      saturday: dish("Honey garlic salmon", "also-like", "fish", ["quick"], true),
    });
    const result = discovery(pinned);
    expect(result.violations).toEqual([]);
    expect(result.bent.map((v) => v.key)).toEqual(["discovery"]);
  });

  test("it applies to drafts only", () => {
    expect(check(familiarOnly()).violations).toEqual([]);
  });
});

describe("dropping rules from the bottom", () => {
  const rules = ["A pasta night. [min pasta 1]", "A Mexican night. [min mexican 1]", "Nothing red. [max red-meat 0]", "Be nice. [advisory]"];
  const week = withNights(baselineWeek(), {
    monday: dish("Pork tenderloin", "new", "pork", []),
    sunday: dish("Smoked brisket", "usual", "beef", ["red-meat", "big-cook"]),
  });

  test("the bottom checked rules may be dropped, and are named", () => {
    const profile = testProfile({ rules });
    const result = checkWeek({ weekOf: WEEK_OF, nights: week, profile, recentLog: [], weeknights: MON_TO_THU, droppedRules: ["A Mexican night.", "nothing red"] });
    expect(result.violations).toEqual([]);
    expect(result.dropped).toEqual(["A Mexican night.", "Nothing red."]);
  });

  test("dropping a rule that is not at the bottom is itself a violation", () => {
    const profile = testProfile({ rules });
    const result = checkWeek({ weekOf: WEEK_OF, nights: week, profile, recentLog: [], weeknights: MON_TO_THU, droppedRules: ["A Mexican night."] });
    expect(result.violations.map((v) => v.key)).toEqual(["dropped", "rule:1", "rule:2"]);
    expect(result.dropped).toEqual([]);
  });
});
