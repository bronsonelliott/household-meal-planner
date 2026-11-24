// TheMealDB: a free recipe API built for apps (https://www.themealdb.com/api.php).
//
// How a refresh goes:
//   1. list.php?c=list           the category names (we check our dinner categories exist)
//   2. filter.php?c=<category>   the meals in each dinner category (id, name only)
//   3. lookup.php?i=<id>         the full recipe, for meals we do not have yet, up to a budget
//
// The budget (lookupsPerRefresh) keeps one refresh small; a backlog is worked through over the
// next few days. Meals we already have are kept as they are.
//
// Written against TheMealDB API v1 (2026-11). NOT tested against the live service: the field
// names below come from its public documentation.
//
// The key sits inside the address (".../json/v1/<key>/"). The default key "1" is TheMealDB's
// public test key. TheMealDB asks apps that are public or used in production to use a
// supporter key instead (set THEMEALDB_API_KEY).

import { guessProtein } from "../protein.ts";
import { canonicalUrl, checkWebUrl, recipeIdFor } from "../url.ts";
import type { FetchedRecord } from "../types.ts";
import { asArray, asObject, FailureStreak, getJson, ProviderError, text, uniqueWords, type ProviderInput, type ProviderRun } from "./shared.ts";

// Dinner-ish categories. Dessert, Breakfast, Starter and Side are left out on purpose.
export const DINNER_CATEGORIES = ["Beef", "Chicken", "Lamb", "Pasta", "Pork", "Seafood", "Vegetarian", "Vegan", "Goat", "Miscellaneous"];

export const PUBLIC_TEST_KEY = "1";

export interface TheMealDbSettings {
  baseUrl: string; // ends with "/"
  lookupsPerRefresh: number;
}

export function themealdbBaseUrl(key: string): string {
  return `https://www.themealdb.com/api/json/v1/${encodeURIComponent(key)}/`;
}

export async function refreshTheMealDb(input: ProviderInput, settings: TheMealDbSettings): Promise<ProviderRun> {
  const { client, previous, nowIso, source } = input;
  const get = (path: string) => getJson(client, settings.baseUrl + path, {}, "Check the TheMealDB key (the environment variable named in recipes.themealdb.apiKeyEnv).");

  const categoryList = asArray(asObject(await get("list.php?c=list")).meals).map((row) => text(asObject(row).strCategory));
  if (categoryList.length === 0) throw new ProviderError("TheMealDB sent an empty category list, so I kept the recipes I already had.");
  const wanted = DINNER_CATEGORIES.filter((category) => categoryList.includes(category));

  // idMeal -> the category it was listed under (the first one wins)
  const listed = new Map<string, string>();
  for (const category of wanted) {
    const answer = asObject(await get(`filter.php?c=${encodeURIComponent(category)}`));
    for (const row of asArray(answer.meals)) {
      const id = text(asObject(row).idMeal);
      if (id !== "" && !listed.has(id)) listed.set(id, category);
    }
  }
  if (listed.size === 0) throw new ProviderError("TheMealDB listed no meals, so I kept the recipes I already had.");

  // Keep what we have if it is still listed; look up what is new, up to the budget.
  const have = new Map(previous.filter((record) => record.providerId !== undefined).map((record) => [record.providerId!, record]));
  const records: FetchedRecord[] = [];
  const toLookUp: string[] = [];
  for (const [id] of listed) {
    const existing = have.get(id);
    if (existing) records.push(existing);
    else toLookUp.push(id);
  }

  let skipped = 0;
  let failedLookups = 0;
  const streak = new FailureStreak();
  for (const id of toLookUp.slice(0, settings.lookupsPerRefresh)) {
    try {
      const answer = asObject(await get(`lookup.php?i=${encodeURIComponent(id)}`));
      const record = mapMeal(asObject(asArray(answer.meals)[0]), listed.get(id)!, source.id, nowIso);
      if (record) records.push(record);
      else skipped++;
      streak.ok();
    } catch (error) {
      streak.failed(error);
      skipped++;
      failedLookups++;
    }
  }
  return { records, backlog: toLookUp.length > settings.lookupsPerRefresh || failedLookups > 0, skipped };
}

// ONE meal as TheMealDB v1 describes it -> a catalog record. This is the only place that knows
// TheMealDB's field names. Null when the meal has no name or no ingredients.
export function mapMeal(meal: Record<string, unknown>, listedCategory: string, sourceId: string, nowIso: string): FetchedRecord | null {
  const providerId = text(meal.idMeal);
  const name = text(meal.strMeal);
  if (providerId === "" || name === "") return null;

  // strIngredient1..20 and strMeasure1..20 sit side by side.
  const ingredients: string[] = [];
  for (let n = 1; n <= 20; n++) {
    const ingredient = text(meal[`strIngredient${n}`]);
    if (ingredient === "") continue;
    const measure = text(meal[`strMeasure${n}`]);
    ingredients.push(measure === "" ? ingredient : `${measure} ${ingredient}`);
  }
  if (ingredients.length === 0) return null;

  const instructions = text(meal.strInstructions)
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^(step\s*)?\d+\.?$/i.test(line));

  const categories = uniqueWords([text(meal.strCategory) || listedCategory, text(meal.strArea) === "Unknown" ? "" : text(meal.strArea), ...text(meal.strTags).split(",")]);

  // The recipe's own page when TheMealDB names one, else TheMealDB's page for the meal.
  const own = checkWebUrl(text(meal.strSource));
  const url = new URL(own.ok ? own.url : `https://www.themealdb.com/meal/${providerId}`);
  return {
    kind: "fetched",
    id: recipeIdFor(url),
    name,
    url: canonicalUrl(url),
    sourceId,
    ingredients,
    instructions,
    categories,
    protein: guessProtein(name, ingredients, [text(meal.strCategory) || listedCategory]),
    ingredientProvenance: "publisher",
    fetchedAt: nowIso,
    providerId,
  };
}
