// The provenance gate on profile changes: the words must be in the cited
// message without a negation in front of them, and the message must name what is changing.

import { describe, expect, test } from "bun:test";
import { provenanceProblem, type Operation } from "../src/week/changeset.ts";

const LOCK_WORDS = ["lock it"];

function rule(prose: string): Operation {
  return { sourceMessageId: "m1", action: "rule", prose, check: { kind: "advisory" } };
}

function veto(dish: string): Operation {
  return { sourceMessageId: "m1", action: "veto", dish };
}

describe("negated profile commands do not pass", () => {
  test('"Don\'t add a rule banning fish" does not add a rule', () => {
    expect(provenanceProblem(rule("No fish"), "Don't add a rule banning fish", LOCK_WORDS)).not.toBeNull();
  });

  test('"don\'t undo that" does not undo', () => {
    expect(provenanceProblem({ sourceMessageId: "m1", action: "undo" }, "don't undo that", LOCK_WORDS)).not.toBeNull();
  });

  test('"never mind, keep it" is not the word "never"', () => {
    // The dish is on the menu, so only the rule words can be what stops it.
    expect(provenanceProblem(veto("Chicken tacos"), "never mind, keep it", LOCK_WORDS, ["Chicken tacos"])).not.toBeNull();
  });
});

describe("the message must name what is changing", () => {
  test('a veto of "Chicken tacos" does not pass on an unrelated "never"', () => {
    const problem = provenanceProblem(veto("Chicken tacos"), "We never have time on Tuesdays, what should we have?", LOCK_WORDS);
    expect(problem).toBe("the message didn't name what to change");
  });

  test('"never again" vetoes a dish that is on this week\'s or next week\'s menu', () => {
    expect(provenanceProblem(veto("Beef liver"), "never again", LOCK_WORDS, ["Chicken tacos", "Beef liver"])).toBeNull();
  });

  test('"never again" does not veto a dish that is not on the menu', () => {
    expect(provenanceProblem(veto("Beef liver"), "never again", LOCK_WORDS, ["Chicken tacos"])).toBe(
      "the message didn't name what to change",
    );
  });

  test("a veto that names the dish passes without the menu", () => {
    expect(provenanceProblem(veto("Beef liver"), "never make the beef liver again", LOCK_WORDS)).toBeNull();
  });

  test("a rule passes when the message says what the rule is about", () => {
    expect(provenanceProblem(rule("No fish on weeknights"), "add a rule: no fish on weeknights", LOCK_WORDS)).toBeNull();
  });

  test('"add a rule" alone does not carry unrelated prose', () => {
    expect(provenanceProblem(rule("Friday is steak night"), "add a rule", LOCK_WORDS)).toBe(
      "the message didn't name what to change",
    );
  });

  test("a remove passes when the message names the item", () => {
    const op: Operation = { sourceMessageId: "m1", action: "remove", list: "vetoes", text: "Tuna casserole" };
    expect(provenanceProblem(op, "remove tuna casserole from the vetoes", LOCK_WORDS)).toBeNull();
  });

  test("an add-dish passes when the message names the dish", () => {
    const op: Operation = {
      sourceMessageId: "m1",
      action: "add-dish",
      pool: "usual",
      dish: { name: "Fish tacos", protein: "fish", tags: [], ingredients: [] },
    };
    expect(provenanceProblem(op, "add fish tacos to the usual dishes", LOCK_WORDS)).toBeNull();
  });
});

describe("the positive cases still pass", () => {
  test("lock, undo, and a from-now-on rule", () => {
    expect(provenanceProblem({ sourceMessageId: "m1", action: "lock" }, "lock it", LOCK_WORDS)).toBeNull();
    expect(provenanceProblem({ sourceMessageId: "m1", action: "undo" }, "undo", LOCK_WORDS)).toBeNull();
    expect(provenanceProblem(rule("Pizza on Fridays"), "from now on, pizza on Fridays", LOCK_WORDS)).toBeNull();
  });

  test("a message with no rule words still gets the rule-words refusal", () => {
    expect(provenanceProblem(rule("Tacos on Tuesdays"), "swap Tuesday for tacos", LOCK_WORDS)).toBe(
      'house rules only change on words like "add a rule," "never," "always," or "from now on"',
    );
  });
});
