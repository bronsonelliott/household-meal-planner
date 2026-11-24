// The grocery list tidy-up, using lines from a real week: no water, same-unit amounts added,
// spoon-sized amounts shown as just the item, near-duplicates merged, pepper under the staples.

import { describe, expect, test } from "bun:test";
import { buildGroceryList, renderGroceryList } from "../src/week/state.ts";
import { isWaterOrIce, mergeItem } from "../src/week/grocery-merge.ts";
import { DEFAULT_SECTIONS } from "./fixtures/config-fixtures.ts";
import { emptyWeekFile, ingredients, night, TACOS } from "./fixtures/week-fixtures.ts";

// A week with the given lines spread over two dinners, as the live week had them.
function listFor(first: Array<[string, string]>, second: Array<[string, string]>, staples: string[] = []) {
  const week = emptyWeekFile("2026-11-30");
  week.status = "locked";
  week.nights.thursday = night({ ...TACOS, dish: "Beef and broccoli", ingredients: ingredients(...first) });
  week.nights.saturday = night({ ...TACOS, dish: "Shrimp fried rice", ingredients: ingredients(...second) });
  return buildGroceryList(week, staples, DEFAULT_SECTIONS).map((line) => `${line.section}: ${line.text}`);
}

describe("merging lines for one item", () => {
  test("same-unit amounts add up, fractions included", () => {
    expect(mergeItem(["broccoli, 1 lb", "broccoli, 1 lb"])).toBe("broccoli, 2 lb");
    expect(mergeItem(["chicken stock, 1/2 cup", "chicken stock, 1 1/2 cups"])).toBe("chicken stock, 2 cups");
    expect(mergeItem(["flour, 1/3 cup", "flour, 1/3 cup"])).toBe("flour, 2/3 cup");
    expect(mergeItem(["eggs, 4", "eggs, 2"])).toBe("eggs, 6");
  });

  test("unit spellings are treated as one (lb, lbs, pound; oz, ounces)", () => {
    expect(mergeItem(["beef, 1 lb", "beef, 2 lbs", "beef, 1 pound"])).toBe("beef, 4 lb");
    expect(mergeItem(["cheese, 4 oz", "cheese, 4 ounces"])).toBe("cheese, 8 oz");
  });

  test("different units sit side by side; a unit with a different note does not add", () => {
    expect(mergeItem(["rice, 2 cups", "rice, 1 lb"])).toBe("rice, 2 cups + 1 lb");
    expect(mergeItem(["tortellini, 2 packages (20 oz)", "tortellini, 1 package"])).toBe("tortellini, 2 packages (20 oz) + 1 package");
  });

  test("a line of only spoon measures is a pantry amount: the name alone", () => {
    expect(mergeItem(["cornstarch, 1/2 tsp", "cornstarch, 1 tsp"])).toBe("cornstarch");
    expect(mergeItem(["dry sherry, 1 tsp", "dry sherry, 1 tsp"])).toBe("dry sherry");
    expect(mergeItem(["black pepper, 1/8 teaspoon"])).toBe("black pepper");
    expect(mergeItem(["salt, to taste"])).toBe("salt");
    expect(mergeItem(["nutmeg, a pinch"])).toBe("nutmeg");
  });

  test("a spoon amount next to a purchasable one keeps only the purchasable part", () => {
    expect(mergeItem(["soy sauce, 1 tsp", "soy sauce, 1 tablespoon", "soy sauce, 1 bottle"])).toBe("soy sauce, 1 bottle");
  });

  test("a single ordinary line is left exactly as written", () => {
    expect(mergeItem(["chicken thighs, boneless skinless, 2 lb"])).toBe("chicken thighs, boneless skinless, 2 lb");
  });

  test("lines with no amounts are counted", () => {
    expect(mergeItem(["white onion", "white onion"])).toBe("white onion (x2)");
  });
});

describe("water and ice", () => {
  test("water and ice are recognised, other waters are not", () => {
    expect(isWaterOrIce("water, 1 tablespoon")).toBe(true);
    expect(isWaterOrIce("ice")).toBe(true);
    expect(isWaterOrIce("cold water, 1 cup")).toBe(true);
    expect(isWaterOrIce("coconut water, 1 can")).toBe(false);
  });
});

describe("the list built from the live week's lines", () => {
  const thursday: Array<[string, string]> = [
    ["Condiments", "soy sauce, 1 tsp"],
    ["Sauces & Oils", "dry sherry, 1 tsp"],
    ["Baking", "cornstarch, 1/2 tsp"],
    ["Spices", "black pepper, 1/8 teaspoon"],
    ["Condiments", "soy sauce, 1 tablespoon"],
    ["Sauces & Oils", "dry sherry, 1 tsp"],
    ["Vegetables", "broccoli, 1 lb"],
    ["Baking", "cornstarch, 1 tsp"],
    ["Beverages", "water, 1 tablespoon"],
  ];
  const saturday: Array<[string, string]> = [
    ["Condiments", "soy sauce, 1 bottle"],
    ["Vegetables", "broccoli, 1 lb"],
    ["Spices", "coarse black pepper, 3 tbsp"],
  ];

  test("the messy lines come out tidy", () => {
    const lines = listFor(thursday, saturday);
    expect(lines).toContain("Vegetables: broccoli, 2 lb");
    expect(lines).toContain("Condiments: soy sauce, 1 bottle");
    expect(lines).toContain("Baking: cornstarch");
    expect(lines).toContain("Sauces & Oils: dry sherry");
    expect(lines).toContain("Spices: black pepper"); // merged with "coarse black pepper", coarse dropped
    expect(lines.filter((line) => line.includes("pepper"))).toHaveLength(1);
    expect(lines.some((line) => line.toLowerCase().includes("water"))).toBe(false);
  });

  test("pepper in any form goes under check-before-you-buy when pepper is a staple", () => {
    const lines = listFor(thursday, saturday, ["Pepper"]);
    expect(lines.filter((line) => line.startsWith("Spices"))).toEqual([]);
    expect(lines).toContain("Check before you buy: Pepper");
    const sameWithLongName = listFor(thursday, saturday, ["Black pepper"]);
    expect(sameWithLongName.filter((line) => line.startsWith("Spices"))).toEqual([]);
  });

  test("the rendered list reads cleanly", () => {
    const week = emptyWeekFile("2026-11-30");
    week.status = "locked";
    week.nights.thursday = night({ ...TACOS, ingredients: ingredients(...thursday) });
    const text = renderGroceryList(week, buildGroceryList(week, [], DEFAULT_SECTIONS));
    expect(text).not.toContain("+");
    expect(text).not.toContain("tsp");
  });
});
