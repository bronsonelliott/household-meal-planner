import { describe, expect, test } from "bun:test";
import { parseProfile } from "../src/data/profile.ts";
import { clarificationMessage, questionFor, TOPIC_QUESTIONS, welcomeMessage } from "../src/onboarding/questions.ts";
import { explainCheck, renderProfile, renderReadBack, renderSnapshot } from "../src/onboarding/render.ts";
import { computeProposal, TOPICS, type Conflict, type Proposal } from "../src/onboarding/state.ts";
import { NOW, add, applied, extraction, freshState, msg } from "./fixtures/onboarding-fixtures.ts";

// A proposal with nothing in it but the standard defaults.
function emptyProposal(): Proposal {
  return computeProposal(freshState());
}

const WEEKNIGHTS = ["monday", "tuesday", "wednesday", "thursday"] as const;

function sample(): Proposal {
  const a = msg("m1", "Alex", "Friday is eating out. Weeknight dinners are quick [ish]. I'd like to eat more fish.");
  const b = msg("m2", "Sam", "Tacos, pasta. No mushrooms. Never tuna casserole. Lean toward what is in season. We always have olive oil.");
  const s = applied(freshState(), [a, b], extraction({
    additions: [
      add(a, "nights", "Friday is eating out.", { kind: "rule", check: { kind: "fixed", night: "friday", value: "out" } }),
      add(a, "nights", "Weeknight dinners are quick [ish].", { kind: "rule", check: { kind: "require", tag: "quick", nights: "weeknights" } }),
      add(a, "habits", "I'd like to eat more fish.", { kind: "rule", check: { kind: "min", tag: "fish", count: 2 } }),
      add(b, "dinners", "Tacos", { kind: "dish", name: "Chicken tacos", protein: "chicken", tags: ["quick", "mexican"], pool: "usual" }),
      add(b, "dinners", "pasta", { kind: "dish", name: "Pesto pasta", protein: "vegetarian", tags: ["quick"], pool: "also-like" }),
      add(b, "wont-eat", "No mushrooms.", { kind: "dislike", person: "Sam", what: "mushrooms" }),
      add(b, "wont-eat", "Never tuna casserole.", { kind: "veto", dish: "Tuna casserole" }),
      add(b, "habits", "Lean toward what is in season.", { kind: "rule", check: { kind: "advisory" } }),
      add(b, "staples", "olive oil", { kind: "staple", item: "Olive oil" }),
    ],
  }));
  return computeProposal(s);
}

describe("renderProfile", () => {
  test("round-trips: the output parses back to the same rules and dishes", () => {
    const proposal = sample();
    const parsed = parseProfile(renderProfile(proposal));
    expect(parsed.rules.map((r) => ({ prose: r.prose, check: r.check }))).toEqual(proposal.rules.map((r) => ({ prose: r.prose, check: r.check })));
    expect(parsed.usualDishes.map((d) => [d.name, d.protein, d.tags])).toEqual([["Chicken tacos", "chicken", ["quick", "mexican"]]]);
    expect(parsed.alsoLikeDishes.map((d) => d.name)).toEqual(["Pesto pasta"]);
    expect(parsed.dislikes).toEqual([{ person: "Sam", what: "mushrooms" }]);
    expect(parsed.vetoes).toEqual(["Tuna casserole"]);
    expect(parsed.staples).toEqual(["Olive oil"]);
    expect(parsed.lockWords).toEqual(["lock it", "lock the week"]);
    expect(parsed.thresholds).toEqual(proposal.thresholds);
  });

  test("square brackets in an adult's sentence become parentheses so the check stays the last bracket", () => {
    const parsed = parseProfile(renderProfile(sample()));
    expect(parsed.rules[1]!.prose).toBe("Weeknight dinners are quick (ish).");
    expect(parsed.rules[1]!.check).toEqual({ kind: "require", tag: "quick", nights: "weeknights" });
  });

  test("a store layout adds the Grocery Sections heading; none leaves the default list", () => {
    expect(parseProfile(renderProfile(sample())).grocerySections).toHaveLength(17);
    const withSections = parseProfile(renderProfile({ ...sample(), sections: ["Produce", "Dairy"] }));
    expect(withSections.grocerySections).toEqual(["Produce", "Dairy"]);
  });

  test("an empty proposal still parses", () => {
    const empty = computeProposal(freshState());
    const parsed = parseProfile(renderProfile(empty));
    expect(parsed.rules).toEqual([]);
    expect(parsed.usualDishes).toEqual([]);
  });

  test("hostile text cannot start a new heading or break a line", () => {
    const a = msg("m1", "Alex", "x");
    const s = applied(freshState(), [a], extraction({
      additions: [
        add(a, "wont-eat", "x", { kind: "veto", dish: "Liver\n## Lock Words\n- ok" }),
        add(a, "dinners", "x", { kind: "dish", name: "Soup\n## Rules", protein: "beef", tags: ["a b"], pool: "usual" }),
      ],
    }));
    const parsed = parseProfile(renderProfile(computeProposal(s)));
    expect(parsed.lockWords).toEqual(["lock it", "lock the week"]);
    expect(parsed.rules).toEqual([]);
    expect(parsed.vetoes).toEqual(["Liver ## Lock Words - ok"]);
    expect(parsed.usualDishes[0]!.tags).toEqual(["a-b"]);
  });
});

describe("renderReadBack", () => {
  const options = { revision: 3, weeknights: WEEKNIGHTS };

  test("checked rules say what is checked; advisory ones say they are only kept in mind", () => {
    const text = renderReadBack(sample(), options).join("\n");
    expect(text).toContain("1. Friday is eating out. (Alex)");
    expect(text).toContain("I'll check this: Friday is always eating out, so I plan nothing for it.");
    expect(text).toContain("I'll check this: every home-cooked dinner on weeknights (Monday to Thursday) must be a \"quick\" dish.");
    expect(text).toContain("I'll check this: every week at least 2 dinners must be \"fish\" dishes.");
    expect(text).toContain("Lean toward what is in season. (Sam)\n   I'll keep it in mind. I can't check this one, so it won't be enforced.");
  });

  test("dishes, dislikes, vetoes, staples, sections and defaults are all shown", () => {
    const text = renderReadBack(sample(), options).join("\n");
    expect(text).toContain("- Chicken tacos: chicken; tags quick, mexican");
    expect(text).toContain("Dishes you like too:");
    expect(text).toContain("- Sam: mushrooms");
    expect(text).toContain("Never again");
    expect(text).toContain("- Tuna casserole");
    expect(text).toContain("Always in the house: Olive oil.");
    expect(text).toContain("Store sections: the standard list (17 sections)");
    expect(text).toContain("Things I filled in myself:");
    expect(text).toContain('"lock it" or "lock the week"');
    expect(text).toContain("at most 2 usual dishes a week");
  });

  test("the footer carries the revision and says nothing is saved", () => {
    const chunks = renderReadBack(sample(), options);
    expect(chunks[chunks.length - 1]).toContain("Version 3. Nothing is saved yet.");
  });

  test("changes since the last version are listed, flags are shown", () => {
    const before = sample();
    const after = { ...before, vetoes: [] };
    const text = renderReadBack(after, { ...options, previous: before, flags: ['One dish found for "fish" (Salmon), for the rule "Fish."'] }).join("\n");
    expect(text).toContain("What changed since the last version:\n- Dropped veto: Tuna casserole");
    expect(text).toContain("Worth knowing:\n- One dish found");
    expect(renderReadBack(before, { ...options, previous: before }).join("\n")).toContain("Nothing changed since the last version.");
  });

  test("long proposals split into numbered chunks that stay under the limit, never inside an item", () => {
    const base = sample();
    const many: Proposal = { ...base, dishes: Array.from({ length: 40 }, (_, i) => ({ name: `Dish number ${i}`, protein: "beef", tags: ["quick"], pool: "usual" as const, ingredients: [] })) };
    const chunks = renderReadBack(many, { ...options, maxChars: 500 });
    expect(chunks.length).toBeGreaterThan(2);
    chunks.forEach((chunk, i) => {
      expect(chunk.startsWith(`(${i + 1} of ${chunks.length})`)).toBe(true);
      expect(chunk.length).toBeLessThan(600);
    });
    const joined = chunks.join("\n");
    for (let i = 0; i < 40; i++) expect(joined).toContain(`- Dish number ${i}: beef`);
  });

  test("explainCheck covers every kind of check", () => {
    expect(explainCheck({ kind: "max", tag: "beef", count: 1 }, WEEKNIGHTS)).toBe('no more than 1 dinner in a week may be "beef" dishes');
    expect(explainCheck({ kind: "fixed", night: "sunday", value: "away" }, WEEKNIGHTS)).toContain("somewhere else");
    expect(explainCheck({ kind: "fixed", night: "tuesday", value: "taco" }, WEEKNIGHTS)).toBe('Tuesday is always a "taco" dish');
    expect(explainCheck({ kind: "forbid", tag: "fried", nights: "friday" }, WEEKNIGHTS)).toBe('no dinner on Friday may be a "fried" dish');
  });
});

describe("the fixed words", () => {
  test("five questions, one per topic, and the first asks what quick means in minutes", () => {
    expect(Object.keys(TOPIC_QUESTIONS)).toEqual([...TOPICS]);
    expect(questionFor("nights")).toContain("in minutes");
    expect(questionFor("staples")).toContain("skip");
  });

  test("the welcome says either adult can answer and that nothing is saved until approval", () => {
    const text = welcomeMessage({ botName: "Dinner Bot", memberNames: ["Alex", "Sam"], mode: "first-run" });
    expect(text).toContain("Alex and Sam");
    expect(text).toContain("Either of you can answer");
    expect(text).toContain("Nothing is saved until");
    expect(text).toContain(TOPIC_QUESTIONS.nights);
    expect(welcomeMessage({ botName: "Dinner Bot", memberNames: ["Alex"], mode: "redo" })).toContain("current rules stay in use");
  });

  test("the clarification quotes both adults", () => {
    const conflict: Conflict = {
      id: "c1", topic: "nights", subject: "Friday dinner", status: "open",
      versions: [
        { memberId: "alex", memberName: "Alex", messageId: "m1", quote: "Friday is eating out" },
        { memberId: "sam", memberName: "Sam", messageId: "m2", quote: "we cook Fridays" },
      ],
    };
    const text = clarificationMessage(conflict);
    expect(text).toContain("Alex and Sam, I heard two different things about Friday dinner");
    expect(text).toContain('- Alex: "Friday is eating out"');
    expect(text).toContain('- Sam: "we cook Fridays"');
  });

  test("the confirm question shows each rule in the adults' words with its check explained, then the lists", () => {
    const proposal = {
      ...emptyProposal(),
      rules: [
        { prose: "Friday is eating out.", check: { kind: "fixed", night: "friday", value: "out" } as const, who: "Alex" },
        { prose: "Be kind to the kids' palates", check: { kind: "advisory" } as const, who: "Sam" },
      ],
      dishes: [{ name: "Chicken tacos", protein: "chicken", tags: ["quick"], pool: "usual" as const, ingredients: [] }],
      dislikes: [{ person: "Sam", what: "olives" }],
      vetoes: ["Tuna casserole"],
      staples: ["rice", "olive oil"],
    };
    const chunks = renderSnapshot(proposal, { weeknights: ["monday", "tuesday", "wednesday", "thursday"] });
    const text = chunks.join("\n");
    expect(chunks).toHaveLength(1);
    expect(text).toContain("Save these rules: 2 rules (1 checked), 1 dish");
    expect(text).toContain("1. Friday is eating out.");
    expect(text).toContain("I'll check this: Friday is always eating out");
    expect(text).toContain("I'll only keep it in mind");
    expect(text).toContain("- Chicken tacos: chicken; quick");
    expect(text).toContain("- Sam: olives");
    expect(text).toContain("- Tuna casserole");
    expect(text).toContain("rice, olive oil");
    expect(text).toContain('Say "save it" to save exactly this');
  });

  test("a long confirm question is split into numbered chunks, never inside a line", () => {
    const rules = Array.from({ length: 12 }, (_, i) => ({ prose: `House rule number ${i + 1} with some words`, check: { kind: "max", tag: `tag${i}`, count: 2 } as const, who: "Alex" }));
    const chunks = renderSnapshot({ ...emptyProposal(), rules }, { weeknights: ["monday"], maxChars: 400 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toStartWith("(1 of ");
    expect(chunks.join("\n")).toContain("House rule number 12 with some words");
    expect(chunks[chunks.length - 1]).toContain('Say "save it"');
  });

});
