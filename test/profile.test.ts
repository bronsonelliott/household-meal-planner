import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseProfile,
  readProfile,
  compactDishIndex,
  addRule,
  removeRule,
  addVeto,
  addDislike,
  addDish,
  undoLastChange,
  updateProfileText,
  ProfileError,
  DEFAULT_GROCERY_SECTIONS,
  type ProfileFiles,
} from "../src/data/profile.ts";

const EXAMPLE_PROFILE = join(import.meta.dir, "..", "data.example", "profile.md");

// A fresh copy of the example profile in a temp folder for each test that writes.
let files: ProfileFiles;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "profile-test-"));
  files = { profilePath: join(dir, "profile.md"), lastChangePath: join(dir, "profile-last-change.json") };
  copyFileSync(EXAMPLE_PROFILE, files.profilePath);
});

const THRESHOLDS_BLOCK = [
  "## Thresholds",
  "- max-usual-dishes-per-week: 2",
  "- max-nights-per-protein: 2",
  "- repeat-window-weeks: 3",
  "- batching-window-seconds: 15",
].join("\n");

// Builds a minimal valid profile, with the dish sections supplied by the caller.
function profileText(parts: { rules?: string; usual?: string; alsoLike?: string }): string {
  return [
    "# House Profile",
    "## Rules",
    parts.rules ?? "- Friday is eating out. [fixed friday out]",
    "## Usual Dishes",
    parts.usual ?? "",
    "## Also-Like Dishes",
    parts.alsoLike ?? "",
    "## Staples",
    "## Dislikes",
    "## Vetoes",
    "## Lock Words",
    "- lock it",
    THRESHOLDS_BLOCK,
    "",
  ].join("\n");
}

describe("parsing the house profile", () => {
  test("the example profile parses into every section", () => {
    const profile = parseProfile(readFileSync(EXAMPLE_PROFILE, "utf8"));

    expect(profile.rules.map((r) => r.prose)).toEqual([
      "Friday is eating out.",
      "At least one chicken night a week.",
      "At least one pasta night a week.",
      "At least one Mexican night a week.",
      "Red meat no more than once a week.",
      "Weeknight dinners are quick.",
      "Sunday is the big cook.",
      "Lean toward what is in season.",
    ]);
    expect(profile.rules[0]!.check).toEqual({ kind: "fixed", night: "friday", value: "out" });
    expect(profile.rules[1]!.check).toEqual({ kind: "min", tag: "chicken", count: 1 });
    expect(profile.rules[4]!.check).toEqual({ kind: "max", tag: "red-meat", count: 1 });
    expect(profile.rules[5]!.check).toEqual({ kind: "require", tag: "quick", nights: "weeknights" });
    expect(profile.rules[6]!.check).toEqual({ kind: "require", tag: "big-cook", nights: "sunday" });
    expect(profile.rules[7]!.check).toEqual({ kind: "advisory" });

    expect(profile.usualDishes.map((d) => d.name)).toEqual(["Chicken tacos", "Spaghetti and meatballs", "Smoked brisket"]);
    expect(profile.usualDishes[0]).toEqual({
      name: "Chicken tacos",
      protein: "chicken",
      tags: ["chicken", "mexican", "quick"],
      ingredients: [
        { section: "Meat & Fish", text: "chicken thighs, 2 lb" },
        { section: "Breads", text: "corn tortillas, 1 pack" },
        { section: "Vegetables", text: "white onion" },
        { section: "Vegetables", text: "cilantro" },
        { section: "Condiments", text: "salsa verde" },
      ],
      needsModelIngredients: false,
    });
    expect(profile.alsoLikeDishes.map((d) => d.name)).toEqual(["Shrimp fried rice"]);
    expect(profile.staples).toEqual(["Olive oil", "Salt", "Garlic", "Butter"]);
    expect(profile.dislikes).toEqual([{ person: "Sam", what: "mushrooms" }]);
    expect(profile.vetoes).toEqual(["Tuna casserole"]);
    expect(profile.lockWords).toEqual(["lock it", "lock the week"]);
    expect(profile.thresholds).toEqual({
      maxUsualDishesPerWeek: 2,
      maxNightsPerProtein: 2,
      repeatWindowWeeks: 3,
      batchingWindowSeconds: 15,
    });
  });

  test("an older profile that still has the export-staleness threshold parses; the key is ignored", () => {
    const text = readFileSync(EXAMPLE_PROFILE, "utf8").replace("- batching-window-seconds: 15", "- export-stale-after-weeks: 6\n- batching-window-seconds: 15");
    expect(text).toContain("export-stale-after-weeks");
    const profile = parseProfile(text);
    expect(profile.thresholds).toEqual({ maxUsualDishesPerWeek: 2, maxNightsPerProtein: 2, repeatWindowWeeks: 3, batchingWindowSeconds: 15 });
  });

  test("a profile missing the Rules heading fails with the heading named", () => {
    const text = readFileSync(EXAMPLE_PROFILE, "utf8").replace("## Rules", "## Rulez");
    expect(() => parseProfile(text)).toThrow(ProfileError);
    expect(() => parseProfile(text)).toThrow(/Rules/);
  });

  test("a profile with 45 usual dishes and 12 rules parses; the dish index has no ingredient lines", () => {
    const rules: string[] = [];
    for (let i = 1; i <= 12; i++) rules.push(`- Rule number ${i}. [max tag${i} 2]`);
    const dishes: string[] = [];
    for (let i = 1; i <= 45; i++) {
      dishes.push(`### Dish ${i}`, "- Protein: chicken", "- Tags: quick", "- Meat & Fish: chicken thighs, 2 lb", "");
    }
    const profile = parseProfile(profileText({ rules: rules.join("\n"), usual: dishes.join("\n") }));

    expect(profile.rules.length).toBe(12);
    expect(profile.usualDishes.length).toBe(45);

    const index = compactDishIndex(profile);
    expect(index.length).toBe(45);
    expect(index[44]).toEqual({ name: "Dish 45", protein: "chicken", tags: ["quick"], pool: "usual" });
    expect(JSON.stringify(index)).not.toContain("chicken thighs");
  });

  test("a dish with no ingredient lines is marked for model-filled ingredients", () => {
    const profile = parseProfile(readFileSync(EXAMPLE_PROFILE, "utf8"));
    const brisket = profile.usualDishes.find((d) => d.name === "Smoked brisket")!;
    expect(brisket.ingredients).toEqual([]);
    expect(brisket.needsModelIngredients).toBe(true);
  });

  test("an ingredient line with an unknown grocery section fails with the dish and line named", () => {
    const text = profileText({ usual: "### Pot roast\n- Protein: beef\n- Produce: carrots, 1 lb" });
    expect(() => parseProfile(text)).toThrow(ProfileError);
    expect(() => parseProfile(text)).toThrow(/Pot roast.*Produce: carrots, 1 lb/);
  });
});

describe("changing the house profile", () => {
  test("adding a usual dish appends its entry and the confirmation shows the ingredient lines", () => {
    const result = addDish(files, "Alex", "usual", {
      name: "Chicken tortilla soup",
      protein: "chicken",
      tags: ["mexican", "quick"],
      ingredients: [
        { section: "Meat & Fish", text: "chicken breasts, 1.5 lb" },
        { section: "Canned Goods", text: "black beans, 1 can" },
      ],
    });

    const profile = readProfile(files.profilePath);
    const added = profile.usualDishes.at(-1)!;
    expect(added.name).toBe("Chicken tortilla soup");
    expect(added.ingredients).toEqual([
      { section: "Meat & Fish", text: "chicken breasts, 1.5 lb" },
      { section: "Canned Goods", text: "black beans, 1 can" },
    ]);
    // The also-like list is untouched: the new dish went under Usual Dishes.
    expect(profile.alsoLikeDishes.map((d) => d.name)).toEqual(["Shrimp fried rice"]);

    expect(result.changed).toBe(true);
    expect(result.confirmation).toContain("Alex");
    expect(result.confirmation).toContain("Chicken tortilla soup");
    expect(result.confirmation).toContain("Meat & Fish: chicken breasts, 1.5 lb");
    expect(result.confirmation).toContain("Canned Goods: black beans, 1 can");
    expect(result.confirmation).not.toContain("\n");
  });

  test("a rule write retries once when the file changes underneath, and keeps the outside edit", () => {
    let calls = 0;
    updateProfileText(files.profilePath, (current) => {
      calls++;
      if (calls === 1) {
        // Simulate a hand edit landing from another computer mid-write.
        writeFileSync(files.profilePath, current.replace("- Tuna casserole", "- Tuna casserole\n- Liver and onions"));
        const later = new Date(statSync(files.profilePath).mtimeMs + 5000);
        utimesSync(files.profilePath, later, later);
      }
      return current.replace("- Lean toward what is in season. [advisory]", "- Lean toward what is in season. [advisory]\n- Soup when it is cold. [advisory]");
    });

    expect(calls).toBe(2);
    const profile = readProfile(files.profilePath);
    expect(profile.vetoes).toEqual(["Tuna casserole", "Liver and onions"]);
    expect(profile.rules.at(-1)!.prose).toBe("Soup when it is cold.");
  });

  test("a hand edit to the example profile survives a write byte for byte", () => {
    const handEdited = readFileSync(files.profilePath, "utf8").replace(
      "## Vetoes",
      "## Notes from Alex\n\nTry the new smoker in October.\n\n## Vetoes",
    );
    writeFileSync(files.profilePath, handEdited);

    addVeto(files, "Sam", "Liver and onions");

    const after = readFileSync(files.profilePath, "utf8");
    expect(after).toBe(handEdited.replace("- Tuna casserole\n", "- Tuna casserole\n- Liver and onions\n"));
    expect(readProfile(files.profilePath).vetoes).toEqual(["Tuna casserole", "Liver and onions"]);
  });

  test("an added rule keeps its typed form, and an advisory rule's confirmation says it is not checked", () => {
    const typed = addRule(files, "Sam", "At least one fish night a week.", { kind: "min", tag: "fish", count: 1 });
    expect(readProfile(files.profilePath).rules.at(-1)).toEqual({
      prose: "At least one fish night a week.",
      check: { kind: "min", tag: "fish", count: 1 },
    });
    expect(typed.confirmation).toContain("Sam");
    expect(typed.confirmation).toContain("min fish 1");

    const advisory = addRule(files, "Alex", "Use up leftovers early in the week.", { kind: "advisory" });
    expect(readProfile(files.profilePath).rules.at(-1)!.check).toEqual({ kind: "advisory" });
    expect(advisory.confirmation).toContain("won't check");
  });

  test("a dislike is recorded and leaves rules and vetoes unchanged", () => {
    const before = readProfile(files.profilePath);
    const result = addDislike(files, "Sam", "Riley", "chicken tacos");
    const after = readProfile(files.profilePath);

    expect(after.dislikes).toEqual([
      { person: "Sam", what: "mushrooms" },
      { person: "Riley", what: "chicken tacos" },
    ]);
    expect(after.rules).toEqual(before.rules);
    expect(after.vetoes).toEqual(before.vetoes);
    expect(after.usualDishes).toEqual(before.usualDishes);
    expect(result.confirmation).toContain("Sam");
    expect(result.confirmation).toContain("Riley");
  });

  test("'never again' records a veto, 'drop the rule' removes a rule, and 'undo' reverses the last change", () => {
    const now = new Date("2026-10-02T18:00:00Z");

    const veto = addVeto(files, "Sam", "Beef stroganoff", now);
    expect(readProfile(files.profilePath).vetoes).toEqual(["Tuna casserole", "Beef stroganoff"]);
    expect(veto.confirmation).toContain("Sam");
    expect(veto.confirmation).toContain("Beef stroganoff");

    const drop = removeRule(files, "Alex", "at least one pasta night a week", new Date("2026-10-02T18:05:00Z"));
    expect(drop.changed).toBe(true);
    expect(readProfile(files.profilePath).rules.map((r) => r.prose)).not.toContain("At least one pasta night a week.");
    expect(drop.confirmation).toContain("Alex");

    // Undo reverses only the most recent change (the dropped rule), not the veto.
    const undo = undoLastChange(files, "Alex", new Date("2026-10-02T18:10:00Z"));
    expect(undo.changed).toBe(true);
    const restored = readProfile(files.profilePath);
    expect(restored.rules.map((r) => r.prose)).toContain("At least one pasta night a week.");
    expect(restored.vetoes).toEqual(["Tuna casserole", "Beef stroganoff"]);
  });

  test("a veto with a line break in it throws and leaves the profile and its lock words alone", () => {
    const before = readFileSync(files.profilePath, "utf8");

    expect(() => addVeto(files, "Sam", "Liver\n\n## Lock Words\n- ok")).toThrow(ProfileError);

    expect(readFileSync(files.profilePath, "utf8")).toBe(before);
    const profile = readProfile(files.profilePath);
    expect(profile.lockWords).toEqual(["lock it", "lock the week"]);
    expect(profile.vetoes).toEqual(["Tuna casserole"]);
  });

  test("a new dish whose ingredient line has a line break throws and leaves the profile alone", () => {
    const before = readFileSync(files.profilePath, "utf8");

    expect(() =>
      addDish(files, "Alex", "usual", {
        name: "Chicken soup",
        protein: "chicken",
        tags: [],
        ingredients: [{ section: "Meat & Fish", text: "chicken thighs\n## Lock Words\n- ok" }],
      }),
    ).toThrow(ProfileError);

    expect(readFileSync(files.profilePath, "utf8")).toBe(before);
  });

  test("undo does nothing after 30 minutes", () => {
    addVeto(files, "Sam", "Beef stroganoff", new Date("2026-10-02T18:00:00Z"));
    const undo = undoLastChange(files, "Sam", new Date("2026-10-02T18:31:00Z"));
    expect(undo.changed).toBe(false);
    expect(readProfile(files.profilePath).vetoes).toEqual(["Tuna casserole", "Beef stroganoff"]);
  });

  test("undo does nothing when a hand edit landed after the change", () => {
    addVeto(files, "Sam", "Beef stroganoff", new Date("2026-10-02T18:00:00Z"));
    const handEdited = readFileSync(files.profilePath, "utf8").replace("- Butter", "- Butter\n- Rice");
    writeFileSync(files.profilePath, handEdited);

    const undo = undoLastChange(files, "Sam", new Date("2026-10-02T18:05:00Z"));
    expect(undo.changed).toBe(false);
    expect(readFileSync(files.profilePath, "utf8")).toBe(handEdited);
  });
});

describe("grocery sections", () => {
  // A minimal profile with an optional "## Grocery Sections" heading.
  function withSections(sectionsBlock: string | null, usual = ""): string {
    return profileText({ usual }).replace("## Staples", `${sectionsBlock === null ? "" : `## Grocery Sections\n${sectionsBlock}\n`}## Staples`);
  }

  test("no heading means the built-in default list", () => {
    const profile = parseProfile(withSections(null));
    expect(profile.grocerySections).toEqual([...DEFAULT_GROCERY_SECTIONS]);
    expect(profile.grocerySections[0]).toBe("Fruits");
  });

  test("the example profile shows the heading, with the default order", () => {
    expect(parseProfile(readFileSync(EXAMPLE_PROFILE, "utf8")).grocerySections).toEqual([...DEFAULT_GROCERY_SECTIONS]);
  });

  test("a custom list is used, in the order written, and dish lines may use its names in any case", () => {
    const text = withSections("- Produce\n- Butcher\n- Dairy", "### Pot roast\n- Protein: beef\n- butcher: chuck roast, 3 lb\n- Produce: carrots, 1 lb");
    const profile = parseProfile(text);
    expect(profile.grocerySections).toEqual(["Produce", "Butcher", "Dairy"]);
    // stored under the list's own spelling
    expect(profile.usualDishes[0]!.ingredients).toEqual([
      { section: "Butcher", text: "chuck roast, 3 lb" },
      { section: "Produce", text: "carrots, 1 lb" },
    ]);
  });

  test("a dish line using a section that is not on the custom list is refused, listing the sections", () => {
    const text = withSections("- Produce\n- Butcher", "### Pot roast\n- Protein: beef\n- Dairy: butter");
    expect(() => parseProfile(text)).toThrow(/Pot roast.*Dairy: butter.*Sections are: Produce, Butcher/);
  });

  test("a heading with nothing under it is refused rather than silently emptying the list", () => {
    expect(() => parseProfile(withSections(""))).toThrow(/Grocery Sections.*no sections/);
  });

  test("a section listed twice is refused", () => {
    expect(() => parseProfile(withSections("- Produce\n- produce"))).toThrow(/listed twice/);
  });
});
