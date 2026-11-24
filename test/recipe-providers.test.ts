// The three recipe providers against fake servers on this computer, with invented recipes.
// Nothing here touches the real internet.

import { afterEach, describe, expect, test } from "bun:test";
import { exampleConfig } from "./fixtures/config-fixtures.ts";
import type { RecipesConfig } from "../src/config.ts";
import { runProvider, type ProviderDeps } from "../src/recipes/providers/index.ts";
import { ProviderError } from "../src/recipes/providers/shared.ts";
import { guessProtein } from "../src/recipes/protein.ts";
import { SEED_SOURCES } from "../src/recipes/sources.ts";
import type { FetchedRecord, RecipeSource } from "../src/recipes/types.ts";
import { MEALIE_TOKEN, meal, SAMPLE_MEALS, startFakeMealDb, startFakeMealie, startFakeTandoor, TANDOOR_TOKEN, type FakeServer } from "./fixtures/fake-recipe-apis.ts";

const NOW = "2026-11-24T12:00:00.000Z";
const stoppers: Array<() => void> = [];
afterEach(() => {
  while (stoppers.length > 0) stoppers.pop()!();
});
function track<T extends FakeServer>(server: T): T {
  stoppers.push(server.stop);
  return server;
}

const mealDbSource = SEED_SOURCES.find((source) => source.id === "themealdb")!;
const mealieSource: RecipeSource = { id: "mealie", name: "Mealie", host: "127.0.0.1", mode: "api", policy: "allowed", provider: "mealie", searchUrl: "" };
const tandoorSource: RecipeSource = { id: "tandoor", name: "Tandoor", host: "127.0.0.1", mode: "api", policy: "allowed", provider: "tandoor", searchUrl: "" };

function recipesConfig(changes: Partial<RecipesConfig> = {}): RecipesConfig {
  return { ...exampleConfig().recipes, providerSecondsBetweenRequests: 0, secondsBetweenRequests: 0, ...changes };
}

const quiet: ProviderDeps = { sleep: async () => {} };

// ---------------------------------------------------------------------------------------------

describe("TheMealDB", () => {
  function mealDbDeps(fake: { baseUrl: string }): ProviderDeps {
    return { ...quiet, allowLoopbackForTests: true, themealdbBaseUrl: fake.baseUrl };
  }

  test("pulls dinner categories only, looks up each meal, and maps the fields", async () => {
    const fake = track(startFakeMealDb());
    const run = await runProvider(mealDbSource, [], recipesConfig(), {}, NOW, mealDbDeps(fake));

    expect(run.records.map((r) => r.name).sort()).toEqual(["Baked Cod Parcels", "Garden Noodle Bowl", "Lemon Herb Chicken", "Pepper Beef Stew"]);
    expect(run.backlog).toBe(false);
    // Dessert and Breakfast are never asked for.
    const asked = fake.requests.filter((r) => r.path.endsWith("filter.php")).map((r) => r.search);
    expect(asked).toContain("?c=Beef");
    expect(asked.join()).not.toContain("Dessert");
    expect(asked.join()).not.toContain("Breakfast");

    const chicken = run.records.find((r) => r.name === "Lemon Herb Chicken")!;
    expect(chicken).toMatchObject({
      kind: "fetched",
      sourceId: "themealdb",
      ingredientProvenance: "publisher",
      providerId: "101",
      protein: "chicken",
      url: "https://www.themealdb.com/meal/101",
      fetchedAt: NOW,
    });
    expect(chicken.id).toMatch(/^rcp-[0-9a-f]{10}$/);
    expect(chicken.ingredients).toEqual(["2 chicken thighs", "1 tbsp olive oil", "1 lemon"]);
    expect(chicken.instructions).toEqual(["Heat the oven.", "Roast the chicken.", "Serve."]);
    expect(chicken.categories).toEqual(["Chicken", "Greek", "Roast", "Easy"]);

    // A recipe with its own page links there (tracking tail removed); empty measures and "Unknown" areas are dropped.
    const stew = run.records.find((r) => r.name === "Pepper Beef Stew")!;
    expect(stew.url).toBe("https://recipes.example.org/pepper-beef-stew");
    expect(stew.protein).toBe("beef");
    const bowl = run.records.find((r) => r.name === "Garden Noodle Bowl")!;
    expect(bowl.ingredients).toEqual(["200g noodles", "1 carrot", "soy sauce"]);
    expect(bowl.categories).toEqual(["Vegetarian"]);
    expect(bowl.protein).toBe("unknown");
  });

  test("the lookup budget limits one refresh, and the next refresh finishes the rest", async () => {
    const many = Array.from({ length: 7 }, (_, i) => meal(String(200 + i), `Chicken Dish ${i}`, "Chicken", [["1", "chicken"]]));
    const fake = track(startFakeMealDb({ meals: many }));
    const config = recipesConfig({ themealdb: { apiKeyEnv: "THEMEALDB_API_KEY", lookupsPerRefresh: 3 } });

    const first = await runProvider(mealDbSource, [], config, {}, NOW, mealDbDeps(fake));
    expect(first.records.length).toBe(3);
    expect(first.backlog).toBe(true);
    expect(fake.requests.filter((r) => r.path.endsWith("lookup.php")).length).toBe(3);

    const second = await runProvider(mealDbSource, first.records, config, {}, NOW, mealDbDeps(fake));
    expect(second.records.length).toBe(6);
    // The three already held were not looked up again.
    expect(fake.requests.filter((r) => r.path.endsWith("lookup.php")).length).toBe(6);
    const third = await runProvider(mealDbSource, second.records, config, {}, NOW, mealDbDeps(fake));
    expect(third.records.length).toBe(7);
    expect(third.backlog).toBe(false);
  });

  test("a meal that left the list is dropped from the complete set", async () => {
    const fake = track(startFakeMealDb());
    const first = await runProvider(mealDbSource, [], recipesConfig(), {}, NOW, mealDbDeps(fake));
    const smaller = track(startFakeMealDb({ meals: SAMPLE_MEALS.filter((m) => m.id !== "104") }));
    const second = await runProvider(mealDbSource, first.records, recipesConfig(), {}, NOW, mealDbDeps(smaller));
    expect(second.records.map((r) => r.providerId).sort()).toEqual(["101", "102", "103"]);
  });

  test("a supporter key from the environment goes into the address, and is never in an error", async () => {
    const fake = track(startFakeMealDb({ key: "supporter-key-9999" }));
    const base = `${fake.url}/api/json/v1/supporter-key-9999/`;
    const run = await runProvider(mealDbSource, [], recipesConfig(), { THEMEALDB_API_KEY: "supporter-key-9999" }, NOW, { ...quiet, allowLoopbackForTests: true, themealdbBaseUrl: base });
    expect(run.records.length).toBe(4);

    // The wrong key: the fake answers 401 and the message does not repeat the key.
    const wrong = track(startFakeMealDb({ key: "other-key" }));
    const error = await runProvider(mealDbSource, [], recipesConfig(), { THEMEALDB_API_KEY: "supporter-key-9999" }, NOW, { ...quiet, allowLoopbackForTests: true, themealdbBaseUrl: `${wrong.url}/api/json/v1/supporter-key-9999/` }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toContain("refused the login");
    expect(error.message).not.toContain("supporter-key-9999");
  });

  test("one meal that fails to load is skipped and tried again next time; the rest still arrive", async () => {
    const fake = track(startFakeMealDb({ failLookups: ["102"] }));
    const run = await runProvider(mealDbSource, [], recipesConfig(), {}, NOW, mealDbDeps(fake));
    expect(run.records.length).toBe(3);
    expect(run.skipped).toBe(1);
    expect(run.backlog).toBe(true);
  });

  test("three failed lookups in a row stop the whole run", async () => {
    const fake = track(startFakeMealDb({ failLookups: ["101", "102", "103", "104"] }));
    const error = await runProvider(mealDbSource, [], recipesConfig(), {}, NOW, mealDbDeps(fake)).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toContain("in a row failed");
  });

  test("an empty list is an error, not an empty catalog", async () => {
    const fake = track(startFakeMealDb({ meals: [] }));
    const error = await runProvider(mealDbSource, [], recipesConfig(), {}, NOW, mealDbDeps(fake)).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
  });
});

// ---------------------------------------------------------------------------------------------

describe("Mealie", () => {
  const config = (fake: FakeServer, maxRecipes = 300) => recipesConfig({ mealie: { url: fake.url, tokenEnv: "MEALIE_API_TOKEN", maxRecipes } });
  const env = { MEALIE_API_TOKEN: MEALIE_TOKEN };

  test("maps a recipe and sends the token as a Bearer login (a private address is fine for the configured server)", async () => {
    const fake = track(startFakeMealie({ count: 2 }));
    const run = await runProvider(mealieSource, [], config(fake), env, NOW, quiet);

    expect(run.records.length).toBe(2);
    const first = run.records[0]!;
    expect(first).toMatchObject({ kind: "fetched", sourceId: "mealie", ingredientProvenance: "publisher", providerId: "recipe-1", name: "Recipe 1", fetchedAt: NOW });
    expect(first.ingredients).toEqual(["1 cup rice", "2 chicken thighs"]);
    expect(first.instructions).toEqual(["Boil the rice.", "Serve."]);
    expect(first.categories).toEqual(["Dinner", "quick"]);
    expect(first.protein).toBe("chicken");
    expect(first.url).toBe(`${fake.url}/recipe/recipe-1`);
    expect(fake.requests.every((r) => r.authorization === `Bearer ${MEALIE_TOKEN}`)).toBe(true);
    expect(fake.requests[0]!.userAgent).toBe(exampleConfig().recipes.userAgent);
  });

  test("the link uses the group when the recipe names one", async () => {
    const fake = track(startFakeMealie({ count: 1, groupSlug: "home" }));
    const run = await runProvider(mealieSource, [], config(fake), env, NOW, quiet);
    expect(run.records[0]!.url).toBe(`${fake.url}/g/home/r/recipe-1`);
  });

  test("pages through a library larger than one page", async () => {
    const fake = track(startFakeMealie({ count: 120 }));
    const run = await runProvider(mealieSource, [], config(fake), env, NOW, quiet);
    expect(run.records.length).toBe(120);
    const pages = fake.requests.filter((r) => r.path === "/api/recipes").map((r) => r.search);
    expect(pages).toEqual(["?page=1&perPage=50", "?page=2&perPage=50", "?page=3&perPage=50"]);
  });

  test("maxRecipes caps a big library", async () => {
    const fake = track(startFakeMealie({ count: 120 }));
    const run = await runProvider(mealieSource, [], config(fake, 60), env, NOW, quiet);
    expect(run.records.length).toBe(60);
  });

  test("a wrong token is a plain-words login problem that does not repeat the token", async () => {
    const fake = track(startFakeMealie());
    const error = await runProvider(mealieSource, [], config(fake), { MEALIE_API_TOKEN: "not-the-token-1234" }, NOW, quiet).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toContain("refused the login (HTTP 401)");
    expect(error.message).toContain("recipes.mealie.tokenEnv");
    expect(error.message).not.toContain("not-the-token-1234");
    expect(fake.requests.length).toBe(1); // it stopped at once
  });

  test("a token that is not set says which variable to fill in, without asking the server", async () => {
    const fake = track(startFakeMealie());
    const error = await runProvider(mealieSource, [], config(fake), {}, NOW, quiet).catch((e) => e);
    expect(error.message).toContain("MEALIE_API_TOKEN is not set");
    expect(fake.requests).toEqual([]);
  });

  test("a recipe that fails to load keeps its previous copy; recipes without ingredients are skipped", async () => {
    const fake = track(startFakeMealie({ count: 3, failDetails: ["recipe-2"], overrides: { "recipe-3": { recipeIngredient: [] } } }));
    const before = await runProvider(mealieSource, [], config(track(startFakeMealie({ count: 3 }))), env, NOW, quiet);
    const old = before.records.find((r) => r.providerId === "recipe-2")!;
    const run = await runProvider(mealieSource, before.records, config(fake), env, "2026-12-01T00:00:00.000Z", quiet);
    expect(run.records.map((r) => r.providerId)).toEqual(["recipe-1", "recipe-2"]);
    expect(run.records.find((r) => r.providerId === "recipe-2")).toEqual(old);
    expect(run.skipped).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------

describe("Tandoor", () => {
  const config = (fake: FakeServer) => recipesConfig({ tandoor: { url: fake.url, tokenEnv: "TANDOOR_API_TOKEN", maxRecipes: 300 } });
  const env = { TANDOOR_API_TOKEN: TANDOOR_TOKEN };

  test("maps steps, ingredients (amount, unit, food, note) and keywords", async () => {
    const fake = track(startFakeTandoor({ count: 1 }));
    const run = await runProvider(tandoorSource, [], config(fake), env, NOW, quiet);
    const record = run.records[0]!;
    expect(record).toMatchObject({ kind: "fetched", sourceId: "tandoor", providerId: "1", name: "Dish 1", protein: "beef", ingredientProvenance: "publisher" });
    expect(record.ingredients).toEqual(["1.5 lb ground beef", "salt (to taste)", "2 tomatoes (chopped)"]);
    expect(record.instructions).toEqual(["Brown the beef.", "Simmer."]);
    expect(record.categories).toEqual(["weeknight"]);
    expect(record.url).toBe(`${fake.url}/view/recipe/1`);
    expect(fake.requests.every((r) => r.authorization === `Bearer ${TANDOOR_TOKEN}`)).toBe(true);
  });

  test("pages by count and does not follow the server's own 'next' address", async () => {
    const fake = track(startFakeTandoor({ count: 70 }));
    const run = await runProvider(tandoorSource, [], config(fake), env, NOW, quiet);
    expect(run.records.length).toBe(70);
    expect(fake.requests.filter((r) => r.path === "/api/recipe/").map((r) => r.search)).toEqual(["?page=1&page_size=50", "?page=2&page_size=50"]);
  });

  test("a wrong token stops at once with a plain message", async () => {
    const fake = track(startFakeTandoor());
    const error = await runProvider(tandoorSource, [], config(fake), { TANDOOR_API_TOKEN: "wrong-token-5678" }, NOW, quiet).catch((e) => e);
    expect(error.message).toContain("refused the login (HTTP 401)");
    expect(error.message).not.toContain("wrong-token-5678");
  });

  test("a failed detail keeps the previous copy", async () => {
    const good = await runProvider(tandoorSource, [], config(track(startFakeTandoor({ count: 2 }))), env, NOW, quiet);
    const run = await runProvider(tandoorSource, good.records, config(track(startFakeTandoor({ count: 2, failDetails: ["2"] }))), env, NOW, quiet);
    expect(run.records.map((r) => r.providerId)).toEqual(["1", "2"]);
    expect(run.records[1]).toEqual(good.records[1] as FetchedRecord);
    expect(run.skipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("guessing a protein", () => {
  test("the name, then the category, then the ingredient lines", () => {
    expect(guessProtein("Chicken tinga", ["1 onion"])).toBe("chicken");
    expect(guessProtein("Weeknight stew", ["1 onion"], ["Lamb"])).toBe("lamb");
    expect(guessProtein("Seafood supper", [], ["Seafood"])).toBe("fish");
    expect(guessProtein("Sheet pan dinner", ["2 salmon fillets", "1 lemon", "4 eggs"])).toBe("fish");
    expect(guessProtein("Fried rice", ["2 eggs", "1 cup rice"])).toBe("eggs");
    expect(guessProtein("Chili", ["1 can kidney beans", "1 lb ground beef", "2 tomatoes", "beef stock"])).toBe("beef");
    expect(guessProtein("Toast", ["bread", "butter"])).toBe("unknown");
    expect(guessProtein("Shrimp scampi", ["garlic"])).toBe("shellfish");
  });
});

describe("credentials are cleaned once and the same value is sent and blanked out", () => {
  const TOKEN = "abc+def/ghi=xyz-123";
  const pasted = `  "${TOKEN}"\n`; // how it might sit in .env: quotes, spaces, a newline
  const mealie = { url: "http://192.168.1.20:9000", tokenEnv: "MEALIE_API_TOKEN", maxRecipes: 10 };

  test("what is sent is the cleaned token, and it is blanked out of errors in plain and URL-encoded form", async () => {
    const sent: string[] = [];
    const failing = (async (url: string, init: RequestInit) => {
      sent.push((init.headers as Record<string, string>).authorization ?? "");
      throw new Error(`could not connect to ${url}?token=${encodeURIComponent(TOKEN)} (token ${TOKEN})`);
    }) as unknown as typeof fetch;
    const deps: ProviderDeps = { ...quiet, fetch: failing, resolve: async () => ["192.168.1.20"] };
    const error = await runProvider(mealieSource, [], recipesConfig({ mealie }), { MEALIE_API_TOKEN: pasted }, NOW, deps).catch((thrown) => thrown);
    expect(sent[0]).toBe(`Bearer ${TOKEN}`);
    expect(String(error.message)).toContain("***");
    expect(String(error.message)).not.toContain(TOKEN);
    expect(String(error.message)).not.toContain(encodeURIComponent(TOKEN));
  });

  test("a quoted, padded token still logs in", async () => {
    const fake = track(startFakeMealie());
    const run = await runProvider(mealieSource, [], recipesConfig({ mealie: { ...mealie, url: fake.url } }), { MEALIE_API_TOKEN: `  "${MEALIE_TOKEN}"  \n` }, NOW, { ...quiet, allowLoopbackForTests: true });
    expect(run.records.length).toBeGreaterThan(0);
  });
});
