// Protein groups: a rule about "red-meat" or "seafood" counts dishes by their protein, and the
// per-protein cap treats all fish (and all shellfish) as one protein.

import { describe, expect, test } from "bun:test";
import { checkWeek } from "../src/brain/rule-check.ts";
import { capGroupOf, dishCountsFor, groupsOfProtein } from "../src/recipes/protein.ts";
import { dishCarries, tagCoverageWarnings } from "../src/onboarding/validate.ts";
import { MON_TO_THU } from "./fixtures/config-fixtures.ts";
import { baselineWeek, dish, testProfile, withNights } from "./fixtures/brain-fixtures.ts";

function check(rules: string[], nights = baselineWeek()) {
  return checkWeek({ weekOf: "2026-10-05", nights, profile: testProfile({ rules }), recentLog: [], weeknights: MON_TO_THU });
}

describe("the group table", () => {
  test("proteins belong to their families", () => {
    expect(groupsOfProtein("beef")).toEqual(["red-meat"]);
    expect(groupsOfProtein("Venison")).toEqual(["red-meat"]);
    expect(groupsOfProtein("salmon")).toEqual(["fish", "seafood"]);
    expect(groupsOfProtein("shrimp")).toEqual(["shellfish", "seafood"]);
    expect(groupsOfProtein("duck")).toEqual(["poultry"]);
    expect(groupsOfProtein("tofu")).toEqual([]);
  });

  test("a dish counts for its protein, its tags, and its protein's groups", () => {
    expect(dishCountsFor("beef", [], "red-meat")).toBe(true);
    expect(dishCountsFor("beef", [], "beef")).toBe(true);
    expect(dishCountsFor("tofu", ["red-meat"], "red-meat")).toBe(true); // an explicit tag still works
    expect(dishCountsFor("chicken", [], "red-meat")).toBe(false);
    expect(dishCountsFor("shrimp", [], "seafood")).toBe(true);
  });

  test("the cap groups fish species and shellfish species", () => {
    expect(capGroupOf("salmon")).toBe("fish");
    expect(capGroupOf("crab")).toBe("shellfish");
    expect(capGroupOf("chicken")).toBe("chicken");
  });
});

describe("the rule check", () => {
  test("an untagged beef dish and an untagged pork dish count toward [max red-meat 1]", () => {
    // Baseline: pork chops (Wed) and beef stew (Sun), neither tagged red-meat.
    const result = check(["Little red meat. [max red-meat 1]"]);
    expect(result.violations.map((v) => v.text).join("\n")).toContain('2 nights tagged "red-meat"');
  });

  test("[forbid seafood weeknights] catches a shrimp dish with no tags", () => {
    const week = withNights(baselineWeek(), { tuesday: dish("Shrimp scampi", "new", "shrimp", []) });
    expect(check(["No seafood on weeknights. [forbid seafood weeknights]"], week).violations.map((v) => v.key)).toContain("rule:0:tuesday");
  });

  test("salmon, tuna and cod on three nights are three fish nights for the protein cap", () => {
    const week = withNights(baselineWeek(), {
      monday: dish("Honey salmon", "new", "salmon", []),
      thursday: dish("Tuna steaks", "new", "tuna", []),
      sunday: dish("Fish and chips", "new", "cod", []),
      saturday: dish("Pot roast", "new", "beef", []),
    });
    expect(check([], week).violations.map((v) => v.key)).toContain("cap:protein:fish:3");
  });
});

describe("onboarding and the doctor", () => {
  test("a beef dish carries the red-meat tag, so the doctor does not warn about a [min red-meat 1] rule", () => {
    expect(dishCarries({ name: "Beef stew", protein: "beef", tags: [] }, "red-meat")).toBe(true);
    const rules = [{ prose: "Some red meat.", check: { kind: "min", tag: "red-meat", count: 1 } } as any];
    expect(tagCoverageWarnings(rules, [{ name: "Beef stew", protein: "beef", tags: [] }])).toEqual([]);
  });

  test("the doctor still warns when no dish is in the group", () => {
    const warnings = tagCoverageWarnings([{ prose: "Seafood once. [min seafood 1]", check: { kind: "min", tag: "seafood", count: 1 } } as any], [{ name: "Chicken tacos", protein: "chicken", tags: [] }]);
    expect(warnings).toHaveLength(1);
  });
});
