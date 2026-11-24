import { describe, expect, test } from "bun:test";
import {
  buildGroceryList,
  changeNight,
  renderDraft,
  renderGroceryList,
  renderListDelta,
  renderNightLine,
  renderRestatedWeek,
  renderWeekLines,
} from "../src/week/state.ts";
import { DEFAULT_SECTIONS } from "./fixtures/config-fixtures.ts";
import { draftedWeek, LEMON_PASTA, night, OUT, TACOS, SPAGHETTI, emptyWeekFile, ingredients } from "./fixtures/week-fixtures.ts";

const STAPLES = ["Olive oil", "Salt", "Garlic", "Butter"];

describe("linked dishes on a night's line", () => {
  const link = { sourceId: "the-kitchn", sourceName: "The Kitchn" };
  const suggested = night({
    ...LEMON_PASTA,
    dish: "Chicken tinga",
    pool: "source",
    recipe: { origin: "source", recipeId: null, url: "https://www.thekitchn.com/search?q=chicken+tinga", ingredientProvenance: "generated", ...link },
  });

  test("a suggested dish says it is a suggestion and links to the site's search", () => {
    expect(renderNightLine("tuesday", suggested)).toBe(
      "Tuesday: Chicken tinga (pasta night) · suggested dish, search The Kitchn: https://www.thekitchn.com/search?q=chicken+tinga",
    );
  });

  test("a saved link shows the saved address, and a fetched recipe names its source", () => {
    const saved = night({
      ...TACOS,
      rule: null,
      pool: "catalog",
      recipe: { origin: "bookmark", recipeId: "rcp-1", url: "https://www.thekitchn.com/tacos", ingredientProvenance: "generated", ...link },
    });
    expect(renderNightLine("monday", saved)).toBe("Monday: Chicken tacos · saved recipe: https://www.thekitchn.com/tacos");
    const fetched = night({
      ...TACOS,
      rule: null,
      pool: "catalog",
      recipe: { origin: "fetched", recipeId: "rcp-2", url: "https://www.themealdb.com/meal/9", sourceId: "themealdb", sourceName: "TheMealDB", ingredientProvenance: "publisher", ingredients: ["1 lb chicken"] },
    });
    expect(renderNightLine("monday", fetched)).toBe("Monday: Chicken tacos · recipe from TheMealDB: https://www.themealdb.com/meal/9");
  });

  test("the link comes after the notes, and the household's own dishes render exactly as before", () => {
    expect(renderNightLine("tuesday", { ...suggested, pinnedBy: "Sam" }, "Alex asked for Lemon pasta")).toBe(
      "Tuesday: Chicken tinga (pasta night, Sam's pick, Alex asked for Lemon pasta) · suggested dish, search The Kitchn: https://www.thekitchn.com/search?q=chicken+tinga",
    );
    expect(renderNightLine("monday", night(TACOS))).toBe("Monday: Chicken tacos (Mexican night)");
    expect(renderNightLine("monday", night({ ...TACOS, recipe: null }))).toBe("Monday: Chicken tacos (Mexican night)");
  });

  test("a night keeps its own copy of the link: changing another night changes nothing here", () => {
    const week = { ...draftedWeek(), nights: { ...draftedWeek().nights, tuesday: suggested } };
    const { week: after } = changeNight(week, "monday", LEMON_PASTA, { mode: "swap", who: "Sam", today: "2026-10-02" });
    expect(renderWeekLines(after)[1]).toBe(renderWeekLines(week)[1]);
    expect(after.nights.tuesday!.recipe).toEqual(week.nights.tuesday!.recipe!);
  });
});

describe("the seven lines", () => {
  test("each night names the dish and the rule it satisfies; out has no dish detail", () => {
    expect(renderWeekLines(draftedWeek())).toEqual([
      "Monday: Chicken tacos (Mexican night)",
      "Tuesday: Spaghetti and meatballs (pasta night)",
      "Wednesday: Shrimp fried rice (quick weeknight)",
      "Thursday: Sausage and peppers (quick weeknight)",
      "Friday: Out (Friday is eating out)",
      "Saturday: Burgers",
      "Sunday: Smoked brisket (big cook)",
    ]);
  });

  test("a pinned night says whose pick it was; an open night says so", () => {
    expect(renderNightLine("tuesday", night(TACOS, { pinnedBy: "Sam" }))).toBe("Tuesday: Chicken tacos (Mexican night, Sam's pick)");
    expect(renderNightLine("wednesday", null)).toBe("Wednesday: (open)");
    expect(renderNightLine("saturday", night({ ...OUT, kind: "away", dish: "Away", rule: null }))).toBe("Saturday: Away");
  });

  test("the draft is the seven lines and exactly one question, then any notes", () => {
    expect(renderDraft(draftedWeek(), { late: false, notes: [] })).toBe(
      [
        "Here's the draft for Oct 5 to Oct 11:",
        "",
        "• Monday: Chicken tacos (Mexican night)",
        "• Tuesday: Spaghetti and meatballs (pasta night)",
        "• Wednesday: Shrimp fried rice (quick weeknight)",
        "• Thursday: Sausage and peppers (quick weeknight)",
        "• Friday: Out (Friday is eating out)",
        "• Saturday: Burgers",
        "• Sunday: Smoked brisket (big cook)",
        "",
        "Anything to use up, or anything you want different this week?",
      ].join("\n"),
    );
    const late = renderDraft(draftedWeek(), { late: true, notes: ["Kept chicken three nights because you pinned them."] });
    expect(late.startsWith("(late) Here's the draft for Oct 5 to Oct 11:\n")).toBe(true);
    expect(late.endsWith("different this week?\n\nKept chicken three nights because you pinned them.")).toBe(true);
  });

  test("swapping Tuesday leaves the other six lines byte-identical", () => {
    const before = draftedWeek();
    const beforeText = renderRestatedWeek(before);
    const { week: after } = changeNight(before, "tuesday", LEMON_PASTA, { mode: "swap", who: "Sam", today: "2026-10-02" });
    const afterText = renderRestatedWeek(after);

    const beforeLines = beforeText.split("\n");
    const afterLines = afterText.split("\n");
    expect(afterLines.length).toBe(beforeLines.length);
    for (let i = 0; i < beforeLines.length; i++) {
      if (beforeLines[i]!.startsWith("• Tuesday:")) continue;
      expect(afterLines[i]).toBe(beforeLines[i]!);
    }
    expect(afterLines).toContain("• Tuesday: Lemon garlic pasta (pasta night)");
    expect(beforeText.replace("• Tuesday: Spaghetti and meatballs (pasta night)", "• Tuesday: Lemon garlic pasta (pasta night)")).toBe(afterText);
  });

  test("a one-reply note names both adults when they wanted different dishes for a night", () => {
    const lines = renderWeekLines(draftedWeek(), { tuesday: "Sam asked for Chicken tacos" });
    expect(lines[1]).toBe("Tuesday: Spaghetti and meatballs (pasta night, Sam asked for Chicken tacos)");
    expect(lines[0]).toBe("Monday: Chicken tacos (Mexican night)");
  });
});

describe("the grocery list", () => {
  test("usual dishes: every ingredient under its grocery section, shared ones merged with both quantities", () => {
    const week = emptyWeekFile("2026-10-05");
    week.status = "locked";
    week.nights.monday = night(TACOS);
    week.nights.tuesday = night(SPAGHETTI);
    week.nights.wednesday = night({
      ...TACOS,
      dish: "Chicken enchiladas",
      ingredients: ingredients(["Meat & Fish", "chicken thighs, 1 lb"], ["Vegetables", "white onion"], ["Dairy", "shredded cheese"]),
    });
    week.nights.friday = night(OUT);

    expect(renderGroceryList(week, buildGroceryList(week, STAPLES, DEFAULT_SECTIONS))).toBe(
      [
        "Grocery list for Oct 5 to Oct 11 (dinners only):",
        "",
        "Vegetables",
        "- white onion (x2)",
        "- cilantro",
        "",
        "Meat & Fish",
        "- chicken thighs, 2 lb + 1 lb",
        "- ground beef, 1 lb",
        "",
        "Condiments",
        "- salsa verde",
        "",
        "Sauces & Oils",
        "- marinara, 1 jar",
        "",
        "Breads",
        "- corn tortillas, 1 pack",
        "",
        "Dairy",
        "- parmesan",
        "- shredded cheese",
        "",
        "Pasta & Rice",
        "- spaghetti, 1 lb",
        "",
        "Check before you buy",
        "- Olive oil",
        "- Salt",
        "- Garlic",
        "- Butter",
      ].join("\n"),
    );
  });

  test("the have-list keeps ground beef and tortillas off; staples move to check-before-you-buy", () => {
    const week = emptyWeekFile("2026-10-05");
    week.status = "locked";
    week.nights.monday = night(TACOS);
    week.nights.tuesday = night(SPAGHETTI);
    week.nights.thursday = night({
      ...TACOS,
      dish: "Garlic shrimp",
      ingredients: ingredients(["Meat & Fish", "shrimp, 1 lb"], ["Vegetables", "garlic, 4 cloves"]),
    });
    week.have = ["ground beef", "tortillas"];

    const text = renderGroceryList(week, buildGroceryList(week, STAPLES, DEFAULT_SECTIONS));
    expect(text).not.toContain("ground beef");
    expect(text).not.toContain("tortillas");
    expect(text).not.toContain("garlic, 4 cloves");
    expect(text).toContain("Meat & Fish\n- chicken thighs, 2 lb\n- shrimp, 1 lb\n");
    expect(text.endsWith("Check before you buy\n- Olive oil\n- Salt\n- Garlic\n- Butter")).toBe(true);
  });

  test("an out or away night contributes no list items", () => {
    const week = emptyWeekFile("2026-10-05");
    week.nights.friday = night(OUT);
    week.nights.saturday = night({ ...OUT, kind: "away", dish: "Away", rule: null });
    expect(buildGroceryList(week, [], DEFAULT_SECTIONS)).toEqual([]);
  });

  test("a list delta names what to add and drop after a night changes", () => {
    const before = draftedWeek();
    before.status = "locked";
    const beforeList = buildGroceryList(before, STAPLES, DEFAULT_SECTIONS);
    const { week: after } = changeNight(before, "tuesday", LEMON_PASTA, { mode: "swap", who: "Sam", today: "2026-10-02" });
    const afterList = buildGroceryList(after, STAPLES, DEFAULT_SECTIONS);

    expect(renderListDelta(after, beforeList, afterList)).toBe(
      [
        "List changes for Oct 5 to Oct 11:",
        "Add (Fruits): lemons, 2",
        "Add (Pasta & Rice): linguine, 1 lb",
        "Drop (Sauces & Oils): marinara, 1 jar",
        "Drop (Dairy): parmesan",
        "Drop (Pasta & Rice): spaghetti, 1 lb",
        "Change (Meat & Fish): ground beef, 2 lb (was ground beef, 1 lb + 2 lb)",
      ].join("\n"),
    );
    expect(renderListDelta(after, afterList, afterList)).toBeNull();
  });
});

describe("the grocery list follows the household's own sections", () => {
  test("sections print in the profile's order, not the built-in one", () => {
    const week = emptyWeekFile("2026-10-05");
    week.status = "locked";
    week.nights.monday = night({ ...TACOS, ingredients: ingredients(["Meat & Fish", "chicken thighs, 2 lb"], ["Vegetables", "white onion"], ["Dairy", "cheese"]) });

    const text = renderGroceryList(week, buildGroceryList(week, [], ["Dairy", "Vegetables", "Meat & Fish"]));
    expect(text.indexOf("Dairy")).toBeLessThan(text.indexOf("Vegetables"));
    expect(text.indexOf("Vegetables")).toBeLessThan(text.indexOf("Meat & Fish"));
  });
});
