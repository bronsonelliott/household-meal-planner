// Hand-built week files and nights for the week tests. Every value here is written out by
// hand, never produced by the code under test, so the tests compare against known answers.

import type { IngredientLine } from "../../src/data/profile.ts";
import type { NightValue, WeekFile, WeekNight } from "../../src/week/state.ts";

export function ingredients(...lines: Array<[IngredientLine["section"], string]>): IngredientLine[] {
  return lines.map(([section, text]) => ({ section, text }));
}

// The dishes the tests use, as a night would store them.
export const TACOS: NightValue = {
  kind: "dish",
  dish: "Chicken tacos",
  rule: "Mexican night",
  protein: "chicken",
  tags: ["chicken", "mexican", "quick"],
  pool: "usual",
  ingredients: ingredients(
    ["Meat & Fish", "chicken thighs, 2 lb"],
    ["Breads", "corn tortillas, 1 pack"],
    ["Vegetables", "white onion"],
    ["Vegetables", "cilantro"],
    ["Condiments", "salsa verde"],
  ),
};

export const SPAGHETTI: NightValue = {
  kind: "dish",
  dish: "Spaghetti and meatballs",
  rule: "pasta night",
  protein: "beef",
  tags: ["pasta", "red-meat"],
  pool: "usual",
  ingredients: ingredients(
    ["Meat & Fish", "ground beef, 1 lb"],
    ["Pasta & Rice", "spaghetti, 1 lb"],
    ["Sauces & Oils", "marinara, 1 jar"],
    ["Dairy", "parmesan"],
  ),
};

export const FRIED_RICE: NightValue = {
  kind: "dish",
  dish: "Shrimp fried rice",
  rule: "quick weeknight",
  protein: "fish",
  tags: ["quick"],
  pool: "also-like",
  ingredients: ingredients(
    ["Meat & Fish", "shrimp, 1 lb"],
    ["Pasta & Rice", "jasmine rice"],
    ["Frozen Foods", "peas and carrots"],
    ["Dairy", "eggs, 3"],
  ),
};

export const SAUSAGE: NightValue = {
  kind: "dish",
  dish: "Sausage and peppers",
  rule: "quick weeknight",
  protein: "pork",
  tags: ["quick"],
  pool: "new",
  ingredients: ingredients(
    ["Meat & Fish", "smoked sausage, 1 lb"],
    ["Vegetables", "bell peppers, 3"],
    ["Vegetables", "white onion"],
    ["Vegetables", "garlic, 3 cloves"],
  ),
};

export const OUT: NightValue = {
  kind: "out",
  dish: "Out",
  rule: "Friday is eating out",
  protein: null,
  tags: [],
  pool: null,
  ingredients: [],
};

export const BURGERS: NightValue = {
  kind: "dish",
  dish: "Burgers",
  rule: null,
  protein: "beef",
  tags: ["red-meat"],
  pool: "new",
  ingredients: ingredients(["Meat & Fish", "ground beef, 2 lb"], ["Breads", "burger buns"]),
};

export const BRISKET: NightValue = {
  kind: "dish",
  dish: "Smoked brisket",
  rule: "big cook",
  protein: "beef",
  tags: ["red-meat", "big-cook"],
  pool: "usual",
  ingredients: [],
};

export const LEMON_PASTA: NightValue = {
  kind: "dish",
  dish: "Lemon garlic pasta",
  rule: "pasta night",
  protein: "vegetarian",
  tags: ["pasta", "quick"],
  pool: "new",
  ingredients: ingredients(["Pasta & Rice", "linguine, 1 lb"], ["Fruits", "lemons, 2"]),
};

export function night(value: NightValue, extra: Partial<WeekNight> = {}): WeekNight {
  return {
    ...value,
    pinnedBy: null,
    changedBy: null,
    swappedFromDraft: false,
    changedAfterLock: false,
    ...extra,
  };
}

// The week of Oct 5, 2026 as the Friday draft would leave it.
export function draftedWeek(): WeekFile {
  return {
    weekOf: "2026-10-05",
    status: "drafted",
    nights: {
      monday: night(TACOS),
      tuesday: night(SPAGHETTI),
      wednesday: night(FRIED_RICE),
      thursday: night(SAUSAGE),
      friday: night(OUT),
      saturday: night(BURGERS),
      sunday: night(BRISKET),
    },
    have: [],
    lockedAt: null,
    postedList: null,
  };
}

export function emptyWeekFile(weekOf: string): WeekFile {
  return {
    weekOf,
    status: "empty",
    nights: { monday: null, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null, sunday: null },
    have: [],
    lockedAt: null,
    postedList: null,
  };
}
