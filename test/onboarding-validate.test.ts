import { describe, expect, test } from "bun:test";
import { parseProfile, type RuleCheck } from "../src/data/profile.ts";
import { DEFAULT_LOCK_WORDS, DEFAULT_THRESHOLDS, type Proposal, type ProposalDish } from "../src/onboarding/state.ts";
import { tagCoverageWarnings, validateProposal } from "../src/onboarding/validate.ts";

const SETTINGS = { weeknights: ["monday", "tuesday", "wednesday", "thursday"] as const, minDiscoveryNights: 1 };

function dish(name: string, protein: string, tags: string[] = []): ProposalDish {
  return { name, protein, tags, pool: "usual", ingredients: [] };
}

function proposal(rules: Array<[string, RuleCheck]>, dishes: ProposalDish[] = [], thresholds = DEFAULT_THRESHOLDS): Proposal {
  return {
    rules: rules.map(([prose, check]) => ({ prose, check, who: "Alex" })),
    dishes,
    dislikes: [],
    vetoes: [],
    staples: [],
    sections: [],
    notes: [],
    lockWords: [...DEFAULT_LOCK_WORDS],
    thresholds,
    defaults: { lockWords: true, thresholds: true, sections: true },
  };
}

const TACOS = dish("Tacos", "chicken", ["quick", "mexican"]);
const check = (p: Proposal) => validateProposal(p, SETTINGS);

describe("validateProposal", () => {
  test("a sound proposal has no problems", () => {
    const p = proposal([["Friday is out.", { kind: "fixed", night: "friday", value: "out" }], ["Quick weeknights.", { kind: "require", tag: "quick", nights: "weeknights" }]], [TACOS, dish("Pasta", "vegetarian", ["quick"])]);
    expect(check(p)).toEqual({ problems: [], flags: [] });
  });

  test("a positive-tag rule needs the tag on a proposed dish; the protein counts", () => {
    const rule: [string, RuleCheck] = ["Fish twice.", { kind: "min", tag: "fish", count: 2 }];
    expect(check(proposal([rule], [TACOS])).problems[0]).toContain('needs a dish tagged "fish"');
    const fish = [dish("Salmon", "fish"), dish("Cod", "fish")];
    expect(check(proposal([rule], fish)).problems).toEqual([]);
  });

  test("one dish found is a flag, not a problem", () => {
    const result = check(proposal([["Fish once.", { kind: "min", tag: "fish", count: 1 }]], [dish("Salmon", "fish")]));
    expect(result.problems).toEqual([]);
    expect(result.flags[0]).toContain('One dish found for "fish"');
  });

  test("more asked than dishes found is a flag", () => {
    const result = check(proposal([["Kid dinners three times.", { kind: "min", tag: "kid-friendly", count: 3 }]], [dish("Tacos", "beef", ["kid-friendly"]), dish("Pasta", "vegetarian", ["kid-friendly"])]));
    expect(result.problems).toEqual([]);
    expect(result.flags[0]).toContain("asks for 3");
  });

  test("out and away nights need no dish, and max and forbid need no tag", () => {
    const p = proposal([["Out.", { kind: "fixed", night: "friday", value: "out" }], ["Away.", { kind: "fixed", night: "sunday", value: "away" }], ["Little beef.", { kind: "max", tag: "beef", count: 1 }], ["No fried.", { kind: "forbid", tag: "fried", nights: "weeknights" }]]);
    expect(check(p)).toEqual({ problems: [], flags: [] });
  });

  test("two rules fixing the same night to different things conflict; the same thing twice does not", () => {
    const out: [string, RuleCheck] = ["Friday out.", { kind: "fixed", night: "friday", value: "out" }];
    const meatless: [string, RuleCheck] = ["Friday meatless.", { kind: "fixed", night: "friday", value: "meatless" }];
    expect(check(proposal([out, meatless], [dish("Pizza", "vegetarian", ["meatless"])])).problems[0]).toContain("Friday dinner to different things");
    expect(check(proposal([out, ["Fridays we go out.", { kind: "fixed", night: "friday", value: "out" }]])).problems).toEqual([]);
  });

  test("require and forbid of the same tag on overlapping nights conflict", () => {
    const p = proposal([["Quick weeknights.", { kind: "require", tag: "quick", nights: "weeknights" }], ["No quick on Monday.", { kind: "forbid", tag: "quick", nights: "monday" }]], [TACOS]);
    expect(check(p).problems[0]).toContain("requires \"quick\" on Monday");
    const apart = proposal([["Quick weeknights.", { kind: "require", tag: "quick", nights: "weeknights" }], ["No quick on Sunday.", { kind: "forbid", tag: "quick", nights: "sunday" }]], [TACOS]);
    expect(check(apart).problems).toEqual([]);
  });

  test("a fixed night whose tag is forbidden that night conflicts", () => {
    const p = proposal([["Wednesday slow cooker.", { kind: "fixed", night: "wednesday", value: "slow-cooker" }], ["No slow cooker on weeknights.", { kind: "forbid", tag: "slow-cooker", nights: "weeknights" }]], [dish("Chili", "beef", ["slow-cooker"])]);
    expect(check(p).problems.join(" ")).toContain("forbids that on Wednesday");
  });

  test("a minimum above a maximum for the same tag", () => {
    const p = proposal([["Fish twice.", { kind: "min", tag: "fish", count: 2 }], ["Little fish.", { kind: "max", tag: "fish", count: 1 }]], [dish("Salmon", "fish"), dish("Cod", "fish")]);
    expect(check(p).problems[0]).toContain("allows at most 1");
  });

  test("a minimum above the nights left after fixed and forbidden nights", () => {
    const rules: Array<[string, RuleCheck]> = [
      ["Fri out.", { kind: "fixed", night: "friday", value: "out" }],
      ["Sat out.", { kind: "fixed", night: "saturday", value: "out" }],
      ["Sun away.", { kind: "fixed", night: "sunday", value: "away" }],
      ["No fish weeknights.", { kind: "forbid", tag: "fish", nights: "weeknights" }],
      ["Fish once.", { kind: "min", tag: "fish", count: 1 }],
    ];
    const p = proposal(rules, [dish("Salmon", "fish"), dish("Cod", "fish")]);
    expect(check(p).problems.join(" ")).toContain("only 0 nights are left");
  });

  test("nights forced onto one protein by require and fixed rules count against the protein limit", () => {
    // Four weeknights of chicken, with the default limit of two nights for any one protein.
    const require: [string, RuleCheck] = ["Chicken every weeknight.", { kind: "require", tag: "chicken", nights: "weeknights" }];
    expect(check(proposal([require], [TACOS])).problems[0]).toContain("would put chicken on 4 nights");
    // Three nights fixed to chicken.
    const fixed = (night: "monday" | "tuesday" | "wednesday"): [string, RuleCheck] => [`${night} is chicken`, { kind: "fixed", night, value: "chicken" }];
    expect(check(proposal([fixed("monday"), fixed("tuesday"), fixed("wednesday")], [TACOS])).problems.join(" ")).toContain("chicken on 3 nights");
    // A fixed night and a require on the same night is one night, not two; a min rule only adds nights beyond them.
    const oneNight: [string, RuleCheck] = ["Chicken on Monday.", { kind: "require", tag: "chicken", nights: "monday" }];
    expect(check(proposal([oneNight, fixed("monday"), ["Chicken twice.", { kind: "min", tag: "chicken", count: 2 }]], [TACOS])).problems).toEqual([]);
    // With the limit raised, four is fine.
    expect(check(proposal([require], [TACOS], { ...DEFAULT_THRESHOLDS, maxNightsPerProtein: 4 })).problems).toEqual([]);
  });

  test("a protein asked for more nights than any one protein may be served", () => {
    const p = proposal([["Chicken four nights.", { kind: "min", tag: "chicken", count: 4 }]], [TACOS, dish("Roast chicken", "chicken")]);
    expect(check(p).problems[0]).toContain("limit is 2 nights");
    const ok = proposal([["Chicken four nights.", { kind: "min", tag: "chicken", count: 4 }]], [TACOS, dish("Roast chicken", "chicken")], { ...DEFAULT_THRESHOLDS, maxNightsPerProtein: 4 });
    expect(check(ok).problems).toEqual([]);
  });

  test("the discovery requirement against eating-out and away nights", () => {
    const rules: Array<[string, RuleCheck]> = (["friday", "saturday", "sunday", "monday", "tuesday", "wednesday", "thursday"] as const).map((night) => [`${night} out.`, { kind: "fixed", night, value: "out" }]);
    expect(validateProposal(proposal(rules), SETTINGS).problems.join(" ")).toContain("0 nights are left");
    expect(validateProposal(proposal(rules), { ...SETTINGS, minDiscoveryNights: 0 }).problems).toEqual([]);
  });

  test("advisory rules are never checked and never block", () => {
    expect(check(proposal([["Lean seasonal.", { kind: "advisory" }]]))).toEqual({ problems: [], flags: [] });
  });

  test("a rule whose check would not read back is a problem, not a silent downgrade", () => {
    const p = proposal([["Odd.", { kind: "min", tag: "two words", count: 1 }]]);
    expect(check(p).problems.join(" ")).toContain("check I can't read");
  });
});

describe("doctor tag coverage", () => {
  const profile = parseProfile(
    ["# P", "## Rules", "- Fish. [min fish 1]", "- Quick. [require quick weeknights]", "- Out. [fixed friday out]", "## Usual Dishes", "### Tacos", "- Protein: chicken", "- Tags: quick", "## Also-Like Dishes", "## Staples", "## Dislikes", "## Vetoes", "## Lock Words", "- lock it", "## Thresholds", "- max-usual-dishes-per-week: 2", "- max-nights-per-protein: 2", "- repeat-window-weeks: 3", "- batching-window-seconds: 15"].join("\n"),
  );
  test("warns about positive-tag rules no dish carries, and only those", () => {
    const warnings = tagCoverageWarnings(profile.rules, [...profile.usualDishes, ...profile.alsoLikeDishes]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"Fish."');
    expect(warnings[0]).toContain('tagged "fish"');
  });
});
