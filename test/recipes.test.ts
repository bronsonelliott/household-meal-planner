// Recipe sources, the saved-recipe catalog, web addresses, and the chat commands. Everything
// runs on temp folders; nothing opens a network connection (fetch is replaced with a trap).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogError, SHORTLIST_SIZE, loadCatalog, saveCatalog, usableRecords, weeklyShortlist, withBookmark, withSourceExcluded, withSourceIncluded } from "../src/recipes/catalog.ts";
import { parseRecipeCommand, runRecipeCommand, type CommandContext, type RecipeCommand } from "../src/recipes/commands.ts";
import { SEED_SOURCES, SourcesError, findSourceByHost, hostFromInput, loadSources, saveSources, withSourceAdded, withSourceRemoved } from "../src/recipes/sources.ts";
import { emptyRecipeContext, type Catalog } from "../src/recipes/types.ts";
import { canonicalUrl, checkWebUrl, nameFromUrl, recipeIdFor, searchLink } from "../src/recipes/url.ts";
import { bookmarkRecipe, fetchedRecipe } from "./fixtures/brain-fixtures.ts";

const NOW = "2026-10-02T23:00:00.000Z";

let dir: string;
let sourcesPath: string;
let catalogPath: string;
const realFetch = globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recipes-test-"));
  sourcesPath = join(dir, "recipe-sources.json");
  catalogPath = join(dir, "recipe-catalog.json");
  // A recipe command must never open a connection. Any call here fails the test.
  globalThis.fetch = (() => {
    throw new Error("a recipe command tried to use the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const url = (text: string) => new URL(text);

describe("web addresses", () => {
  test("only plain public http and https addresses pass", () => {
    expect(checkWebUrl("https://www.thekitchn.com/recipes/tinga").ok).toBe(true);
    expect(checkWebUrl("http://example.org").ok).toBe(true);
    const rejected = [
      "not a web address",
      "ftp://example.com/file",
      "javascript:alert(1)",
      "https://user:secret@example.com/",
      "http://127.0.0.1/admin",
      "http://10.0.0.5/",
      "http://2130706433/",
      "http://[::1]/",
      "http://localhost:3000/",
      "http://printer.localhost/",
      "http://intranet/",
      "http://nas.local/recipes",
    ];
    for (const text of rejected) expect(checkWebUrl(text).ok).toBe(false);
  });

  test("tracking tails, fragments, trailing slashes and host case are cleaned off", () => {
    expect(canonicalUrl(url("HTTPS://WWW.TheKitchn.com/Recipes/Tinga/?utm_source=x&fbclid=1&b=2&a=1#top"))).toBe(
      "https://www.thekitchn.com/Recipes/Tinga?a=1&b=2",
    );
    expect(canonicalUrl(url("https://example.com/"))).toBe("https://example.com/");
    expect(canonicalUrl(url("https://example.com/a/"))).toBe("https://example.com/a");
  });

  test("the same page gets the same id however it was written; another page gets another id", () => {
    const a = recipeIdFor(url("http://thekitchn.com/recipes/tinga/"));
    const b = recipeIdFor(url("https://WWW.thekitchn.com/recipes/tinga?utm_medium=email#steps"));
    expect(a).toBe(b);
    expect(a).toMatch(/^rcp-[0-9a-f]{10}$/);
    expect(recipeIdFor(url("https://thekitchn.com/recipes/other"))).not.toBe(a);
    expect(recipeIdFor(url("https://thekitchn.com/recipes/tinga?page=2"))).not.toBe(a);
  });

  test("a name is made from the end of the address", () => {
    expect(nameFromUrl(url("https://x.com/recipes/chicken-tinga-tacos-12345/"))).toBe("Chicken Tinga Tacos");
    expect(nameFromUrl(url("https://x.com/recipe/Best_Pie.html"))).toBe("Best Pie");
    expect(nameFromUrl(url("https://www.x.com/"))).toBe("x.com");
  });

  test("search links put the words where the template says: dashes in a path, plus signs in a query", () => {
    const [foodNetwork, allrecipes] = SEED_SOURCES;
    expect(searchLink(foodNetwork!, "Chicken tinga!")).toBe("https://www.foodnetwork.com/search/chicken-tinga-");
    expect(searchLink(allrecipes!, "Chicken tinga!")).toBe("https://www.allrecipes.com/search?q=chicken+tinga");
    expect(searchLink({ searchUrl: "https://duckduckgo.com/?q=site%3Aexample.com+{q}" }, "Mac & cheese")).toBe(
      "https://duckduckgo.com/?q=site%3Aexample.com+mac+cheese",
    );
  });
});

describe("recipe sources", () => {
  test("the first read seeds the four starting sources and saves them", () => {
    expect(existsSync(sourcesPath)).toBe(false);
    const file = loadSources(sourcesPath, NOW);
    expect(file.seededAt).toBe(NOW);
    expect(file.sources.map((source) => [source.id, source.mode, source.policy])).toEqual([
      ["food-network", "link", "unverified"],
      ["allrecipes", "link", "blocked"],
      ["the-kitchn", "link", "unverified"],
      ["themealdb", "api", "allowed"],
    ]);
    expect(file.sources[3]!.provider).toBe("themealdb");
    expect(JSON.parse(readFileSync(sourcesPath, "utf8"))).toEqual(file);
  });

  test("a seed that was removed stays removed on the next read", () => {
    const first = loadSources(sourcesPath, NOW);
    const removed = withSourceRemoved(first, "thekitchn.com");
    expect(removed.ok).toBe(true);
    if (removed.ok) saveSources(sourcesPath, removed.file);

    const again = loadSources(sourcesPath, "2026-12-01T00:00:00.000Z");
    expect(again.sources.map((source) => source.id)).toEqual(["food-network", "allrecipes", "themealdb"]);
    expect(again.seededAt).toBe(NOW);
  });

  test("a file saved without a seeded marker is seeded once, keeping what it already had", () => {
    saveSources(sourcesPath, { version: 1, seededAt: null, sources: [{ ...SEED_SOURCES[0]!, name: "My Food Network" }] });
    const file = loadSources(sourcesPath, NOW);
    expect(file.sources.map((source) => source.name)).toEqual(["My Food Network", "Allrecipes", "The Kitchn", "TheMealDB"]);
  });

  test("a damaged or unknown-version file is reported in plain words and left alone", () => {
    writeFileSync(sourcesPath, "{ not json");
    expect(() => loadSources(sourcesPath, NOW)).toThrow(SourcesError);
    expect(readFileSync(sourcesPath, "utf8")).toBe("{ not json");
    writeFileSync(sourcesPath, JSON.stringify({ version: 99, sources: [] }));
    expect(() => loadSources(sourcesPath, NOW)).toThrow("isn't in a form this version understands");
  });

  test("writes leave no temp files behind", () => {
    loadSources(sourcesPath, NOW);
    expect(readdirSync(dir)).toEqual(["recipe-sources.json"]);
  });

  test("a user-added source is link mode, unverified, with a generic site search", () => {
    const file = loadSources(sourcesPath, NOW);
    const added = withSourceAdded(file, "https://www.SmittenKitchen.com/some/recipe?utm_source=x");
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.source).toEqual({
      id: "smittenkitchen-com",
      name: "smittenkitchen.com",
      host: "smittenkitchen.com",
      mode: "link",
      policy: "unverified",
      searchUrl: "https://duckduckgo.com/?q=site%3Asmittenkitchen.com+{q}",
    });
  });

  test("bad addresses and duplicates are refused with a reason", () => {
    const file = loadSources(sourcesPath, NOW);
    const bad = withSourceAdded(file, "http://192.168.1.4/");
    expect(bad).toEqual({ ok: false, reason: "IP addresses aren't allowed, only site names" });
    expect(withSourceAdded(file, "https://thekitchn.com")).toEqual({ ok: false, reason: "thekitchn.com is already a source" });
    expect(withSourceAdded(file, "https://m.thekitchn.com/x")).toEqual({ ok: false, reason: "thekitchn.com is already a source" });
  });

  test("removing and re-adding a blocked starting source brings it back blocked", () => {
    const file = loadSources(sourcesPath, NOW);
    const removed = withSourceRemoved(file, "www.allrecipes.com");
    if (!removed.ok) throw new Error("expected the removal to work");
    const readded = withSourceAdded(removed.file, "https://www.allrecipes.com/recipe/1/x");
    if (!readded.ok) throw new Error("expected the add to work");
    expect(readded.restoredSeed).toBe(true);
    expect(readded.source.policy).toBe("blocked");
    expect(readded.source.mode).toBe("link");
  });

  test("hosts are found from bare names, www names and full addresses, subdomains included", () => {
    const { sources } = loadSources(sourcesPath, NOW);
    expect(findSourceByHost(sources, "TheKitchn.com")?.id).toBe("the-kitchn");
    expect(findSourceByHost(sources, "https://www.thekitchn.com/a/b")?.id).toBe("the-kitchn");
    expect(findSourceByHost(sources, "m.thekitchn.com")?.id).toBe("the-kitchn");
    expect(findSourceByHost(sources, "notthekitchn.com")).toBeUndefined();
    expect(hostFromInput("http://127.0.0.1")).toBeNull();
  });
});

describe("the catalog", () => {
  const sources = SEED_SOURCES;
  const empty = (): Catalog => emptyRecipeContext().catalog;

  test("a missing file is an empty catalog; a saved one reads back the same", () => {
    expect(loadCatalog(catalogPath)).toEqual(empty());
    const saved: Catalog = { version: 1, excludedSourceIds: ["x"], records: [bookmarkRecipe("Sheet pan gnocchi")] };
    saveCatalog(catalogPath, saved);
    expect(loadCatalog(catalogPath)).toEqual(saved);
    expect(readdirSync(dir)).toEqual(["recipe-catalog.json"]);
  });

  test("a damaged or unknown-version catalog is reported, not replaced", () => {
    writeFileSync(catalogPath, "oops");
    expect(() => loadCatalog(catalogPath)).toThrow(CatalogError);
    writeFileSync(catalogPath, JSON.stringify({ version: 2, records: [] }));
    expect(() => loadCatalog(catalogPath)).toThrow("expected version 1");
  });

  test("a saved link gets a stable id, the given name, and its configured source", () => {
    const result = withBookmark(empty(), sources, "https://www.thekitchn.com/recipes/chicken-tinga?utm_source=mail", "Our tinga");
    if (!result.ok) throw new Error(result.reason);
    expect(result.created).toBe(true);
    expect(result.configuredSource?.id).toBe("the-kitchn");
    expect(result.record).toEqual({
      kind: "bookmark",
      id: recipeIdFor(url("https://thekitchn.com/recipes/chicken-tinga")),
      name: "Our tinga",
      url: "https://www.thekitchn.com/recipes/chicken-tinga",
      sourceId: "the-kitchn",
      ingredientProvenance: "generated",
    });
  });

  test("with no name given, the name comes from the address", () => {
    const result = withBookmark(empty(), sources, "https://www.thekitchn.com/recipes/chicken-tinga-tacos-9/", null);
    if (!result.ok) throw new Error(result.reason);
    expect(result.record.name).toBe("Chicken Tinga Tacos");
  });

  test("the same page saved again, written differently, is not added twice", () => {
    const first = withBookmark(empty(), sources, "https://www.thekitchn.com/recipes/chicken-tinga", null);
    if (!first.ok) throw new Error(first.reason);
    const second = withBookmark(first.catalog, sources, "http://thekitchn.com/recipes/chicken-tinga/#comments", "Another name");
    if (!second.ok) throw new Error(second.reason);
    expect(second.created).toBe(false);
    expect(second.catalog.records).toHaveLength(1);
    expect(second.record.name).toBe("Chicken Tinga");
  });

  test("a link from a site that isn't a source is still saved, under an unlisted id", () => {
    const result = withBookmark(empty(), sources, "https://pinchofyum.com/best-tacos", null);
    if (!result.ok) throw new Error(result.reason);
    expect(result.configuredSource).toBeNull();
    expect(result.record.sourceId).toBe("unlisted-pinchofyum-com");
  });

  test("a bad address is refused", () => {
    expect(withBookmark(empty(), sources, "javascript:alert(1)", null)).toEqual({ ok: false, reason: "only http and https web addresses work" });
  });

  test("records of a removed source leave planning and come back when it is added again", () => {
    const catalog: Catalog = { version: 1, excludedSourceIds: [], records: [bookmarkRecipe("A"), bookmarkRecipe("B", { sourceId: "food-network" })] };
    const removed = withSourceExcluded(catalog, "the-kitchn");
    expect(usableRecords(removed).map((record) => record.name)).toEqual(["B"]);
    expect(weeklyShortlist(removed, "2026-10-05").map((record) => record.name)).toEqual(["B"]);
    expect(removed.records).toHaveLength(2); // still on file
    expect(withSourceExcluded(removed, "the-kitchn")).toBe(removed);
    expect(usableRecords(withSourceIncluded(removed, "the-kitchn"))).toHaveLength(2);
  });
});

describe("the weekly shortlist", () => {
  const catalogOf = (records: Catalog["records"]): Catalog => ({ version: 1, excludedSourceIds: [], records });
  const many = (protein: string, count: number) => Array.from({ length: count }, (_, i) => fetchedRecipe(`${protein} dish ${i}`, protein));

  test("the same catalog and week always give the same list, whatever order the records were saved in", () => {
    const records = [...many("chicken", 30), ...many("beef", 30), ...many("fish", 30)];
    const a = weeklyShortlist(catalogOf(records), "2026-10-05", 20).map((record) => record.id);
    const b = weeklyShortlist(catalogOf([...records].reverse()), "2026-10-05", 20).map((record) => record.id);
    expect(a).toEqual(b);
    expect(a).toHaveLength(20);
  });

  test("a different week gives a different mix", () => {
    const catalog = catalogOf([...many("chicken", 40), ...many("beef", 40)]);
    const week1 = weeklyShortlist(catalog, "2026-10-05", 20).map((record) => record.id);
    const week2 = weeklyShortlist(catalog, "2026-10-12", 20).map((record) => record.id);
    expect(week1).not.toEqual(week2);
  });

  test("proteins are taken in turn, so no protein crowds the list", () => {
    const catalog = catalogOf([...many("chicken", 50), ...many("beef", 5), ...many("fish", 5)]);
    const picked = weeklyShortlist(catalog, "2026-10-05", 12);
    const count = (protein: string) => picked.filter((record) => record.kind === "fetched" && record.protein === protein).length;
    expect([count("beef"), count("chicken"), count("fish")]).toEqual([4, 4, 4]);
  });

  test("when a protein runs out the others fill the rest, and the list never passes the size", () => {
    const catalog = catalogOf([...many("chicken", 50), ...many("beef", 2)]);
    const picked = weeklyShortlist(catalog, "2026-10-05", 10);
    expect(picked).toHaveLength(10);
    expect(picked.filter((record) => record.kind === "fetched" && record.protein === "beef")).toHaveLength(2);
    expect(weeklyShortlist(catalogOf(many("chicken", 400)), "2026-10-05")).toHaveLength(SHORTLIST_SIZE);
  });

  test("desserts and breakfasts by name or category stay off the dinner list; saved links with no protein are listed", () => {
    const catalog = catalogOf([
      fetchedRecipe("Fudge brownies", "unknown"),
      fetchedRecipe("Lemon bars", "unknown", { categories: ["Desserts"] }),
      fetchedRecipe("Sheet pan chicken", "chicken"),
      bookmarkRecipe("Sheet pan gnocchi"),
    ]);
    expect(weeklyShortlist(catalog, "2026-10-05").map((record) => record.name).sort()).toEqual(["Sheet pan chicken", "Sheet pan gnocchi"]);
  });
});

describe("parsing recipe commands", () => {
  const parse = parseRecipeCommand;

  test("every command parses, with or without a slash, in any case", () => {
    expect(parse("sources")).toEqual({ kind: "sources" });
    expect(parse("/sources")).toEqual({ kind: "sources" });
    expect(parse("  SOURCES  ")).toEqual({ kind: "sources" });
    expect(parse("Sources Add https://example.com")).toEqual({ kind: "sources-add", url: "https://example.com" });
    expect(parse("/sources remove example.com")).toEqual({ kind: "sources-remove", host: "example.com" });
    expect(parse("sources fetch example.com ON")).toEqual({ kind: "sources-fetch", host: "example.com", setting: "on" });
    expect(parse("recipe save https://example.com/a")).toEqual({ kind: "recipe-save", url: "https://example.com/a", name: null });
    expect(parse("/recipe save https://example.com/a  Grandma's   tinga ")).toEqual({
      kind: "recipe-save",
      url: "https://example.com/a",
      name: "Grandma's   tinga",
    });
    expect(parse("recipes status")).toEqual({ kind: "recipes-status" });
  });

  test("an incomplete command gets a usage reply, not the model", () => {
    for (const text of ["sources add", "sources remove", "sources fetch example.com", "sources fetch example.com maybe", "recipe save", "/recipe", "/sources bogus"]) {
      const command = parse(text) as RecipeCommand;
      expect(command.kind).toBe("usage");
    }
    const usage = parse("sources add") as Extract<RecipeCommand, { kind: "usage" }>;
    expect(usage.text).toContain("sources add <web address>");
  });

  test("ordinary talk, and a command inside other words or lines, is not a command", () => {
    for (const text of [
      "sources of inspiration for dinner?",
      "recipes are great",
      "can you run sources add example.com",
      "sources add https://example.com\nand swap Tuesday",
      "sources add https://example.com and swap Tuesday please",
      "sources remove the old ones from the list",
      "",
    ]) {
      expect(parse(text)).toBeNull();
    }
  });
});

describe("running recipe commands", () => {
  const admin = (): CommandContext => ({ sourcesPath, catalogPath, admin: true, nowIso: NOW });
  const member = (): CommandContext => ({ sourcesPath, catalogPath, admin: false, nowIso: NOW });
  const run = (text: string, context: CommandContext = admin()) => runRecipeCommand(parseRecipeCommand(text)!, context);

  test("sources lists each source with its mode, policy and a plain-words status", () => {
    const reply = run("sources", member());
    expect(reply).toBe(
      [
        "Recipe sources:",
        "- Food Network (foodnetwork.com): link mode, unverified. links only; the site's terms are unverified, so nothing is fetched.",
        "- Allrecipes (allrecipes.com): link mode, blocked. links only, and fetching is blocked for this site.",
        "- The Kitchn (thekitchn.com): link mode, unverified. links only; the site's terms are unverified, so nothing is fetched.",
        "- TheMealDB (themealdb.com): api mode, allowed. recipes come from its public API, refreshed in the background.",
      ].join("\n"),
    );
  });

  test("only an admin adds or removes a source, and nothing changes for anyone else", () => {
    expect(run("sources add https://example.com", member())).toBe("Only an admin can add recipe sources.");
    expect(run("sources remove thekitchn.com", member())).toBe("Only an admin can remove recipe sources.");
    expect(run("sources fetch thekitchn.com on", member())).toBe("Only an admin can change site fetching.");
    expect(loadSources(sourcesPath, NOW).sources).toHaveLength(4);
  });

  test("adding a source: success, duplicate, bad address", () => {
    expect(run("sources add https://www.smittenkitchen.com/")).toBe(
      "Added smittenkitchen.com (smittenkitchen.com): link mode, unverified; I only make search links to it and never open its pages.",
    );
    expect(findSourceByHost(loadSources(sourcesPath, NOW).sources, "smittenkitchen.com")?.mode).toBe("link");
    expect(run("sources add smittenkitchen.com")).toBe("I didn't add that source: that doesn't look like a web address.");
    expect(run("sources add https://smittenkitchen.com")).toBe("I didn't add that source: smittenkitchen.com is already a source.");
    expect(run("sources add http://localhost:8080")).toBe("I didn't add that source: that is not a public site name.");
  });

  test("removing a source: success, unknown host, and its saved recipes stay on file but leave planning", () => {
    run("recipe save https://www.thekitchn.com/recipes/tinga", member());
    expect(run("sources remove thekitchn.com")).toBe(
      "Removed The Kitchn. Its 1 saved recipe stays on file but I won't suggest it. Weeks already planned keep their dishes.",
    );
    expect(run("sources remove thekitchn.com")).toBe("I didn't remove anything: I don't have a source called thekitchn.com.");
    const catalog = loadCatalog(catalogPath);
    expect(catalog.records).toHaveLength(1);
    expect(usableRecords(catalog)).toHaveLength(0);

    // Adding the source back returns its recipes to planning.
    run("sources add https://thekitchn.com");
    expect(usableRecords(loadCatalog(catalogPath))).toHaveLength(1);
  });

  test("a removed blocked source comes back blocked", () => {
    run("sources remove allrecipes.com");
    const reply = run("sources add https://allrecipes.com");
    expect(reply).toContain("link mode, blocked; fetching stays blocked");
    expect(reply).toContain("came back with its original settings");
  });

  test("sources fetch: blocked is refused, api is always on, and the synchronous runner cannot check robots.txt", () => {
    expect(run("sources fetch allrecipes.com on")).toBe("Fetching is blocked for Allrecipes, so it stays off. Chat can't change that; I only link to it.");
    expect(run("sources fetch allrecipes.com off")).toContain("Fetching is blocked for Allrecipes");
    expect(run("sources fetch themealdb.com on")).toBe("TheMealDB is an API source, so it is always on. There is nothing to switch.");
    // Switching on needs the network (robots.txt): that is tested in recipe-site.test.ts.
    expect(run("sources fetch thekitchn.com on")).toBe("I can't check The Kitchn's robots.txt from here, so nothing changed.");
    expect(run("sources fetch nowhere.example.com on")).toBe('I don\'t have a source called nowhere.example.com. "sources" lists them.');
    // Nothing was switched on.
    expect(loadSources(sourcesPath, NOW).sources.every((source) => source.enabledAt === undefined && source.mode !== "fetch")).toBe(true);
  });

  test("recipe save works for any member, never fetches, and says where the link is from", () => {
    expect(run("recipe save https://www.thekitchn.com/recipes/chicken-tinga-tacos-9/", member())).toBe(
      [
        'Saved "Chicken Tinga Tacos" (from The Kitchn). https://www.thekitchn.com/recipes/chicken-tinga-tacos-9',
        "I only saved the link and didn't open the page. When a week that uses it locks, I'll write the ingredient list myself.",
      ].join("\n"),
    );
  });

  test("a link from a site that isn't a source is still saved, with a plain note", () => {
    const reply = run("recipe save https://pinchofyum.com/best-tacos Best tacos", member());
    expect(reply).toContain('Saved "Best tacos". https://pinchofyum.com/best-tacos');
    expect(reply).toContain('pinchofyum.com isn\'t one of my recipe sources, so I saved just the link. An admin can add the site with "sources add https://pinchofyum.com".');
    expect(loadCatalog(catalogPath).records[0]!.sourceId).toBe("unlisted-pinchofyum-com");
  });

  test("saving the same page twice says so; a bad address is refused", () => {
    run("recipe save https://www.thekitchn.com/recipes/tinga");
    expect(run("recipe save http://thekitchn.com/recipes/tinga/?utm_source=x")).toBe('"Tinga" is already saved. https://www.thekitchn.com/recipes/tinga');
    expect(run("recipe save ftp://example.com/x")).toBe("I didn't save that: only http and https web addresses work.");
    expect(loadCatalog(catalogPath).records).toHaveLength(1);
  });

  test("recipes status counts by source, including unlisted sites and removed sources", () => {
    expect(run("recipes status")).toBe('No recipes are saved yet. Save one with "recipe save <web address> [name]".');
    run("recipe save https://www.thekitchn.com/recipes/a");
    run("recipe save https://www.thekitchn.com/recipes/b");
    run("recipe save https://pinchofyum.com/c");
    expect(run("recipes status")).toBe(
      ["Saved recipes: 3.", "- The Kitchn: 2 saved links", "- pinchofyum.com: 1 saved link (not a configured source)"].join("\n"),
    );
    run("sources remove thekitchn.com");
    expect(run("recipes status")).toContain("- thekitchn.com: 2 saved links (source removed, not suggested)");
  });

  test("a damaged sources file gives a plain reply, not a crash", () => {
    writeFileSync(sourcesPath, "{ broken");
    expect(run("sources")).toContain("isn't valid JSON");
  });
});
