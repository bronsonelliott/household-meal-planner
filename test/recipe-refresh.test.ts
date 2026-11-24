// The background refresh: when it is due, what it publishes, what it keeps when something fails,
// how Mealie and Tandoor become sources, and what `recipes status` and `doctor` say about it.
// Fake servers on this computer only.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, REPO_DIR, missingSecrets, parseConfig } from "../src/config.ts";
import { runDoctor, runOnlineChecks } from "../src/doctor.ts";
import { loadCatalog, saveCatalog, withBookmark } from "../src/recipes/catalog.ts";
import { parseRecipeCommand, runRecipeCommand } from "../src/recipes/commands.ts";
import { registerConfiguredProviders, withConfiguredProviders } from "../src/recipes/providers/register.ts";
import type { ProviderDeps } from "../src/recipes/providers/index.ts";
import { BACKLOG_HOURS, RETRY_AFTER_FAILURE_HOURS, RecipeRefresher, isDue, loadRefreshStatus, validateRecords, type SourceStatus } from "../src/recipes/refresh.ts";
import { loadSources, saveSources } from "../src/recipes/sources.ts";
import type { FetchedRecord } from "../src/recipes/types.ts";
import { exampleConfig, exampleConfigText } from "./fixtures/config-fixtures.ts";
import { fetchedRecipe } from "./fixtures/brain-fixtures.ts";
import { MEALIE_TOKEN, SAMPLE_MEALS, meal, startFakeMealDb, startFakeMealie, startFakeTandoor, TANDOOR_TOKEN, type FakeServer } from "./fixtures/fake-recipe-apis.ts";

const HOUR = 3_600_000;
const START = Date.parse("2026-11-24T12:00:00Z");

let dir: string;
let sourcesPath: string;
let catalogPath: string;
let statusPath: string;
let now: number;
let logs: string[];
const stoppers: Array<() => void> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "refresh-test-"));
  sourcesPath = join(dir, "recipe-sources.json");
  catalogPath = join(dir, "recipe-catalog.json");
  statusPath = join(dir, "recipe-refresh.json");
  now = START;
  logs = [];
});
afterEach(() => {
  while (stoppers.length > 0) stoppers.pop()!();
});
function track<T extends FakeServer>(server: T): T {
  stoppers.push(server.stop);
  return server;
}

function refresher(options: { fake?: { baseUrl: string }; recipes?: Partial<ReturnType<typeof exampleConfig>["recipes"]>; env?: Record<string, string>; deps?: ProviderDeps } = {}): RecipeRefresher {
  return new RecipeRefresher({
    sourcesPath,
    catalogPath,
    statusPath,
    recipes: { ...exampleConfig().recipes, providerSecondsBetweenRequests: 0, secondsBetweenRequests: 0, ...options.recipes },
    env: options.env ?? {},
    now: () => now,
    log: (line) => logs.push(line),
    deps: { sleep: async () => {}, allowLoopbackForTests: true, ...(options.fake ? { themealdbBaseUrl: options.fake.baseUrl } : {}), ...options.deps },
  });
}

// A TheMealDB that answers 401 to the key we use (the fake only knows "other").
function refusing(): FakeServer & { baseUrl: string } {
  const fake = track(startFakeMealDb({ key: "other" }));
  return { ...fake, baseUrl: `${fake.url}/api/json/v1/1/` };
}

const nowIso = () => new Date(now).toISOString();
const catalogText = () => readFileSync(catalogPath, "utf8");
const status = (id: string): SourceStatus => loadRefreshStatus(statusPath).sources[id]!;

// ---------------------------------------------------------------------------------------------

describe("when a refresh is due", () => {
  const worked = (hoursAgo: number, extra: Partial<SourceStatus> = {}): SourceStatus => ({
    lastAttemptAt: new Date(START - hoursAgo * HOUR).toISOString(),
    lastSuccessAt: new Date(START - hoursAgo * HOUR).toISOString(),
    count: 10,
    lastError: null,
    backlog: false,
    skipped: 0,
    ...extra,
  });

  test("never refreshed: due now. Otherwise after refreshHours, sooner for a backlog, and a failure waits", () => {
    expect(isDue(undefined, START, 168)).toBe(true);
    expect(isDue(worked(167), START, 168)).toBe(false);
    expect(isDue(worked(168), START, 168)).toBe(true);
    expect(isDue(worked(BACKLOG_HOURS - 1, { backlog: true }), START, 168)).toBe(false);
    expect(isDue(worked(BACKLOG_HOURS, { backlog: true }), START, 168)).toBe(true);
    expect(isDue(worked(RETRY_AFTER_FAILURE_HOURS - 1, { lastError: "down" }), START, 168)).toBe(false);
    expect(isDue(worked(RETRY_AFTER_FAILURE_HOURS, { lastError: "down" }), START, 168)).toBe(true);
    // A short refreshHours also shortens a backlog wait.
    expect(isDue(worked(3, { backlog: true }), START, 2)).toBe(true);
    expect(isDue({ ...worked(1), lastAttemptAt: "garbage" }, START, 168)).toBe(true);
  });
});

describe("refreshing TheMealDB", () => {
  test("the first tick publishes the meals beside what is already saved; the next tick, an hour later, does nothing", async () => {
    // A link saved from chat, and a recipe from another source: neither may be touched.
    const sources = loadSources(sourcesPath, nowIso());
    const saved = withBookmark({ version: 1, excludedSourceIds: [], records: [fetchedRecipe("Other source dish", "pork", { id: "rcp-other0001", sourceId: "mealie" })] }, sources.sources, "https://www.thekitchn.com/recipes/tinga", "Tinga");
    if (!saved.ok) throw new Error("setup failed");
    saveCatalog(catalogPath, saved.catalog);

    const fake = track(startFakeMealDb());
    const r = refresher({ fake });
    const results = await r.tick();
    expect(results).toEqual([{ sourceId: "themealdb", ok: true, count: 4, error: null }]);

    const catalog = loadCatalog(catalogPath);
    expect(catalog.records.length).toBe(6);
    expect(catalog.records.filter((rec) => rec.sourceId === "themealdb").length).toBe(4);
    expect(catalog.records.find((rec) => rec.id === "rcp-other0001")).toBeDefined();
    expect(catalog.records.find((rec) => rec.kind === "bookmark")!.name).toBe("Tinga");
    expect(status("themealdb")).toMatchObject({ lastError: null, count: 4, backlog: false, lastSuccessAt: nowIso() });

    const askedBefore = fake.requests.length;
    now += HOUR;
    expect(await r.tick()).toEqual([]);
    expect(fake.requests.length).toBe(askedBefore);

    now += 168 * HOUR;
    expect((await r.tick()).map((x) => x.ok)).toEqual([true]);
    expect(fake.requests.length).toBeGreaterThan(askedBefore);
  });

  test("publishing is atomic: no temp files are left and the file is whole JSON", async () => {
    const fake = track(startFakeMealDb());
    await refresher({ fake }).tick();
    expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(() => JSON.parse(catalogText())).not.toThrow();
    expect(() => JSON.parse(readFileSync(statusPath, "utf8"))).not.toThrow();
  });

  test("a failed refresh keeps the previous recipes byte for byte, records why, and waits before trying again", async () => {
    const good = track(startFakeMealDb());
    await refresher({ fake: good }).tick();
    const before = catalogText();

    now += 169 * HOUR;
    const bad = refusing();
    const r = refresher({ fake: bad });
    const results = await r.tick();
    expect(results[0]).toMatchObject({ ok: false, count: 4 });
    expect(catalogText()).toBe(before);
    expect(status("themealdb").lastError).toContain("refused the login");
    expect(status("themealdb").count).toBe(4);
    expect(status("themealdb").lastSuccessAt).not.toBeNull();

    const asked = bad.requests.length;
    now += HOUR;
    expect(await r.tick()).toEqual([]); // not every minute
    expect(bad.requests.length).toBe(asked);
    now += RETRY_AFTER_FAILURE_HOURS * HOUR;
    expect((await r.tick()).length).toBe(1);
  });

  test("a failure on a never-refreshed source leaves the catalog alone and says it has not worked yet", async () => {
    const r = refresher({ fake: track(startFakeMealDb({ meals: [] })) });
    const results = await r.tick();
    expect(results[0]!.ok).toBe(false);
    expect(existsSync(catalogPath)).toBe(false);
    expect(status("themealdb")).toMatchObject({ lastSuccessAt: null, count: 0 });
  });

  test("a partial refresh publishes what it got, flags the backlog, and comes back sooner than a week", async () => {
    const fake = track(startFakeMealDb({ failLookups: ["102"] }));
    const r = refresher({ fake });
    expect((await r.tick())[0]).toMatchObject({ ok: true, count: 3 });
    expect(status("themealdb")).toMatchObject({ backlog: true, skipped: 1 });
    now += BACKLOG_HOURS * HOUR;
    expect((await r.tick()).length).toBe(1);
  });

  test("a recipe sharing a link with something already saved does not become a second record", async () => {
    const sources = loadSources(sourcesPath, nowIso());
    const saved = withBookmark({ version: 1, excludedSourceIds: [], records: [] }, sources.sources, "https://recipes.example.org/pepper-beef-stew", "My stew link");
    if (!saved.ok) throw new Error("setup failed");
    saveCatalog(catalogPath, saved.catalog);

    const r = refresher({ fake: track(startFakeMealDb()) });
    expect((await r.tick())[0]).toMatchObject({ ok: true, count: 3 });
    const records = loadCatalog(catalogPath).records;
    expect(records.filter((rec) => rec.url === "https://recipes.example.org/pepper-beef-stew").map((rec) => rec.kind)).toEqual(["bookmark"]);
    expect(new Set(records.map((rec) => rec.id)).size).toBe(records.length);
  });

  test("a saved link with the same id as a fetched recipe stays exactly as it was; the fetched copy is dropped and counted", async () => {
    const fake = track(startFakeMealDb());
    const r = refresher({ fake });
    await r.tick();
    const fetched = loadCatalog(catalogPath).records.filter((rec): rec is FetchedRecord => rec.kind === "fetched" && rec.sourceId === "themealdb");
    expect(fetched.length).toBe(4);
    // The household saved a link to one of these recipes, under the same id.
    const target = fetched[0]!;
    const bookmark = { kind: "bookmark" as const, id: target.id, name: "Our own name for it", url: target.url, sourceId: "themealdb", ingredientProvenance: "generated" as const };
    const catalog = loadCatalog(catalogPath);
    saveCatalog(catalogPath, { ...catalog, records: [...catalog.records.filter((rec) => rec.id !== target.id), bookmark] });
    const before = loadCatalog(catalogPath).records.find((rec) => rec.id === target.id);

    now += 8 * 24 * HOUR;
    await r.tick();
    const after = loadCatalog(catalogPath).records.filter((rec) => rec.id === target.id);
    expect(after).toEqual([before!]);
    expect(after[0]!.kind).toBe("bookmark");
    expect(status("themealdb").skipped).toBe(1);
    expect(status("themealdb").count).toBe(3);
  });

  test("a source an admin removes stops being refreshed, and one removed mid-refresh publishes nothing", async () => {
    const fake = track(startFakeMealDb());
    const realFetch = fetch;
    let removed = false;
    const r = refresher({
      fake,
      deps: {
        fetch: (async (url: string, init: RequestInit) => {
          if (!removed) {
            // The admin removes TheMealDB while the first request is in flight.
            removed = true;
            const file = loadSources(sourcesPath, nowIso());
            saveSources(sourcesPath, { ...file, sources: file.sources.filter((s) => s.id !== "themealdb") });
          }
          return realFetch(url, init);
        }) as unknown as typeof fetch,
      },
    });
    const results = await r.tick();
    expect(results[0]).toMatchObject({ ok: false, error: "the source was removed" });
    expect(existsSync(catalogPath)).toBe(false);

    const asked = fake.requests.length;
    now += 1000 * HOUR;
    expect(await r.tick()).toEqual([]);
    expect(fake.requests.length).toBe(asked);
  });

  test("two ticks at once never run two refreshes", async () => {
    const r = refresher({ fake: track(startFakeMealDb()) });
    const [first, second] = await Promise.all([r.tick(), r.tick()]);
    expect(first.length).toBe(1);
    expect(second).toEqual([]);
  });

  test("a recipe set where nothing can be used does not wipe what was there", async () => {
    const config = (fake: FakeServer) => ({ mealie: { url: fake.url, tokenEnv: "MEALIE_API_TOKEN", maxRecipes: 300 } });
    const env = { MEALIE_API_TOKEN: MEALIE_TOKEN };
    const good = track(startFakeMealie({ count: 3 }));
    registerConfiguredProviders(sourcesPath, { ...exampleConfig().recipes, ...config(good) }, nowIso());
    // Leave only Mealie to refresh.
    const file = loadSources(sourcesPath, nowIso());
    saveSources(sourcesPath, { ...file, sources: file.sources.filter((source) => source.id === "mealie") });

    expect((await refresher({ recipes: config(good), env }).tick())[0]).toMatchObject({ sourceId: "mealie", ok: true, count: 3 });

    now += 169 * HOUR;
    const noIngredients = { recipeIngredient: [] };
    const empty = track(startFakeMealie({ count: 3, overrides: { "recipe-1": noIngredients, "recipe-2": noIngredients, "recipe-3": noIngredients } }));
    const before = catalogText();
    expect((await refresher({ recipes: config(empty), env }).tick())[0]).toMatchObject({ sourceId: "mealie", ok: false });
    expect(catalogText()).toBe(before);
    expect(status("mealie").lastError).toContain("kept the 3 I already had");
  });
});

describe("records are checked before they are published", () => {
  const good = fetchedRecipe("Ok dish", "beef", { id: "rcp-good00001", sourceId: "mealie", url: "http://192.168.1.5:9000/recipe/ok" });
  test("unusable and repeated records are dropped, private server links are fine", () => {
    const noIngredients = { ...good, id: "rcp-bad000001", ingredients: [] };
    const wrongSource = { ...good, id: "rcp-bad000002", sourceId: "themealdb" };
    const badLink = { ...good, id: "rcp-bad000003", url: "javascript:alert(1)" };
    const withLogin = { ...good, id: "rcp-bad000004", url: "https://u:p@example.org/x" };
    const repeated = { ...good };
    const taken = { ...good, id: "rcp-taken0001" };
    const result = validateRecords([good, noIngredients, wrongSource, badLink, withLogin, repeated, taken] as FetchedRecord[], "mealie", new Set(["rcp-taken0001"]));
    expect(result.valid.map((rec) => rec.id)).toEqual(["rcp-good00001"]);
    expect(result.dropped).toBe(6);
  });
});

// ---------------------------------------------------------------------------------------------

describe("Mealie and Tandoor as sources", () => {
  const recipes = () => ({
    ...exampleConfig().recipes,
    mealie: { url: "http://192.168.1.20:9000", tokenEnv: "MEALIE_API_TOKEN", maxRecipes: 300 },
    tandoor: { url: "http://tandoor.lan:8080/app", tokenEnv: "TANDOOR_API_TOKEN", maxRecipes: 300 },
  });

  test("they are added once, as api sources, policy allowed, and show up in the list", () => {
    const file = registerConfiguredProviders(sourcesPath, recipes(), nowIso());
    const mealie = file.sources.find((s) => s.id === "mealie")!;
    expect(mealie).toMatchObject({ name: "Mealie", host: "192.168.1.20", mode: "api", policy: "allowed", provider: "mealie" });
    expect(file.sources.find((s) => s.id === "tandoor")).toMatchObject({ host: "tandoor.lan", provider: "tandoor" });
    expect(file.registeredProviders).toEqual(["mealie@http://192.168.1.20:9000", "tandoor@http://tandoor.lan:8080/app"]);

    const again = registerConfiguredProviders(sourcesPath, recipes(), nowIso());
    expect(again.sources.length).toBe(file.sources.length);
    const listing = runRecipeCommand(parseRecipeCommand("sources")!, { sourcesPath, catalogPath, admin: false, nowIso: nowIso() });
    expect(listing).toContain("- Mealie (192.168.1.20): api mode, allowed. recipes come from your own server, refreshed in the background.");
  });

  test("an admin removes one by name, its recipes leave planning, and a restart does not bring it back", () => {
    registerConfiguredProviders(sourcesPath, recipes(), nowIso());
    saveCatalog(catalogPath, { version: 1, excludedSourceIds: [], records: [fetchedRecipe("Home stew", "beef", { id: "rcp-home00001", sourceId: "mealie", url: "http://192.168.1.20:9000/recipe/stew" })] });
    const admin = { sourcesPath, catalogPath, admin: true, nowIso: nowIso() };

    const reply = runRecipeCommand(parseRecipeCommand("sources remove mealie")!, admin);
    expect(reply).toContain("Removed Mealie.");
    expect(loadCatalog(catalogPath).excludedSourceIds).toEqual(["mealie"]);
    expect(runRecipeCommand(parseRecipeCommand("sources remove mealie")!, { ...admin, admin: false })).toBe("Only an admin can remove recipe sources.");

    registerConfiguredProviders(sourcesPath, recipes(), nowIso()); // the next start
    expect(loadSources(sourcesPath, nowIso()).sources.some((s) => s.id === "mealie")).toBe(false);
    expect(loadSources(sourcesPath, nowIso()).sources.some((s) => s.id === "tandoor")).toBe(true);

    // A different address in config.toml is a new setup, so it is added again.
    const moved = { ...recipes(), mealie: { url: "http://192.168.1.99:9000", tokenEnv: "MEALIE_API_TOKEN", maxRecipes: 300 } };
    expect(registerConfiguredProviders(sourcesPath, moved, nowIso()).sources.find((s) => s.id === "mealie")!.host).toBe("192.168.1.99");
  });

  test("a Mealie source is refreshed from the configured server with the token from the environment", async () => {
    const mealie = track(startFakeMealie({ count: 4 }));
    const tandoor = track(startFakeTandoor({ count: 2 }));
    const config = {
      mealie: { url: mealie.url, tokenEnv: "MEALIE_API_TOKEN", maxRecipes: 300 },
      tandoor: { url: tandoor.url, tokenEnv: "TANDOOR_API_TOKEN", maxRecipes: 300 },
    };
    registerConfiguredProviders(sourcesPath, { ...exampleConfig().recipes, ...config }, nowIso());
    const r = refresher({ recipes: config, env: { MEALIE_API_TOKEN: MEALIE_TOKEN, TANDOOR_API_TOKEN: TANDOOR_TOKEN }, fake: track(startFakeMealDb()) });
    const results = await r.tick();
    expect(results.map((x) => [x.sourceId, x.ok, x.count])).toEqual([["themealdb", true, 4], ["mealie", true, 4], ["tandoor", true, 2]]);
    expect(loadCatalog(catalogPath).records.length).toBe(10);
  });

  test("tokens never reach the log or the status file, even when the server refuses them", async () => {
    const mealie = track(startFakeMealie());
    const config = { mealie: { url: mealie.url, tokenEnv: "MEALIE_API_TOKEN", maxRecipes: 300 } };
    registerConfiguredProviders(sourcesPath, { ...exampleConfig().recipes, ...config }, nowIso());
    const wrong = "wrong-mealie-token-ABCDEF";
    await refresher({ recipes: config, env: { MEALIE_API_TOKEN: wrong }, fake: track(startFakeMealDb({ meals: [] })) }).tick();
    const everything = logs.join("\n") + readFileSync(statusPath, "utf8");
    expect(everything).toContain("refused the login");
    expect(everything).not.toContain(wrong);
    expect(everything).not.toContain(MEALIE_TOKEN);
  });
});

// ---------------------------------------------------------------------------------------------

describe("recipes status", () => {
  const ask = (text = "recipes status") => runRecipeCommand(parseRecipeCommand(text)!, { sourcesPath, catalogPath, refreshStatusPath: statusPath, admin: false, nowIso: nowIso() });

  test("with nothing saved and nothing refreshed it says so, as before", () => {
    expect(ask()).toBe('No recipes are saved yet. Save one with "recipe save <web address> [name]".');
  });

  test("after a refresh it shows the count and when; a backlog and skipped recipes are mentioned", async () => {
    await refresher({ fake: track(startFakeMealDb({ failLookups: ["102"] })) }).tick();
    expect(ask()).toBe(["Saved recipes: 3.", "- TheMealDB: 3 fetched recipes. Refreshed 2026-11-24 12:00 UTC. More are still being added. 1 could not be read."].join("\n"));
  });

  test("after a failure it says what went wrong in words, that the old recipes were kept, and the last good time", async () => {
    await refresher({ fake: track(startFakeMealDb()) }).tick();
    now += 169 * HOUR;
    await refresher({ fake: refusing() }).tick();
    const reply = ask();
    expect(reply).toContain("Saved recipes: 4.");
    expect(reply).toContain("- TheMealDB: 4 fetched recipes. The refresh on 2026-12-01 13:00 UTC failed: The server refused the login (HTTP 401).");
    expect(reply).toContain("I kept the recipes it already had. The last good refresh was 2026-11-24 12:00 UTC.");
  });

  test("a source that failed before ever working is still listed, and links keep their own lines", async () => {
    const sources = loadSources(sourcesPath, nowIso());
    const saved = withBookmark({ version: 1, excludedSourceIds: [], records: [] }, sources.sources, "https://www.thekitchn.com/recipes/tinga", null);
    if (!saved.ok) throw new Error("setup failed");
    saveCatalog(catalogPath, saved.catalog);
    await refresher({ fake: track(startFakeMealDb({ meals: [] })) }).tick();
    const reply = ask();
    expect(reply).toContain("- The Kitchn: 1 saved link");
    expect(reply).toContain("- TheMealDB: no recipes. The refresh on 2026-11-24 12:00 UTC failed:");
    expect(reply).toContain("It has not worked yet.");
  });

  test("a removed source is marked as not suggested", async () => {
    await refresher({ fake: track(startFakeMealDb()) }).tick();
    runRecipeCommand(parseRecipeCommand("sources remove themealdb")!, { sourcesPath, catalogPath, admin: true, nowIso: nowIso() });
    expect(ask()).toContain("4 fetched recipes (source removed, not suggested)");
  });
});

// ---------------------------------------------------------------------------------------------

describe("config.toml", () => {
  const withProviders = (extra: string) => exampleConfigText((text) => text + "\n" + extra);
  const parse = (text: string, env: Record<string, string | undefined> = {}) => parseConfig(text, { baseDir: REPO_DIR, env });
  const problems = (text: string): string[] => {
    try {
      parse(text);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as ConfigError).problems;
    }
    throw new Error("expected a refusal");
  };

  test("defaults: weekly refresh, TheMealDB's key variable, 40 lookups, and no Mealie or Tandoor", () => {
    const { recipes } = exampleConfig();
    expect(recipes).toMatchObject({ refreshHours: 168, providerSecondsBetweenRequests: 1, secondsBetweenRequests: 5, themealdb: { apiKeyEnv: "THEMEALDB_API_KEY", lookupsPerRefresh: 40 }, mealie: null, tandoor: null });
  });

  test("Mealie and Tandoor sections parse, with default token variables and a clean address", () => {
    const config = parse(exampleConfigText().replace("# [recipes.mealie]\n# url", "[recipes.mealie]\nurl").replace('# url = "http://tandoor.local:8080"', 'url = "http://tandoor.local:8080/sub/"').replace("# [recipes.tandoor]", "[recipes.tandoor]").replace('# url = "http://mealie.local:9000"', 'url = "http://mealie.local:9000"'));
    expect(config.recipes.mealie).toEqual({ url: "http://mealie.local:9000", tokenEnv: "MEALIE_API_TOKEN", maxRecipes: 300 });
    expect(config.recipes.tandoor?.url).toBe("http://tandoor.local:8080/sub");
  });

  test("a bad address, a password in it, or a pasted token is reported by key without repeating the secret", () => {
    const text = (url: string, tokenEnv = "MEALIE_API_TOKEN") => withProviders(`[recipes.mealie]\nurl = "${url}"\ntokenEnv = "${tokenEnv}"\n`);
    expect(problems(text("ftp://mealie.local"))[0]).toContain("recipes.mealie.url must start with http");
    expect(problems(text("http://admin:hunter2@mealie.local")).join("\n")).toContain("must not contain a user name or password");
    expect(problems(text("http://admin:hunter2@mealie.local")).join("\n")).not.toContain("hunter2");
    expect(problems(text("http://mealie.local?token=abc")).join("\n")).toContain("no ? or # part");
    expect(problems(text("not a url")).join("\n")).toContain("recipes.mealie.url must be a web address");
    const pasted = problems(text("http://mealie.local", "eyJhbGciOi.secret-token"));
    expect(pasted.join("\n")).toContain("NAME of an environment variable");
    expect(pasted.join("\n")).not.toContain("eyJhbGciOi");
    expect(problems(withProviders("[recipes.mealie]\ntokenEnv = \"X\"\n")).join("\n")).toContain("recipes.mealie.url is missing");
    expect(problems(withProviders("[recipes.mealie]\nurl = \"http://m.local\"\nflavour = 1\n")).join("\n")).toContain("recipes.mealie.flavour is not a setting I know");
  });

  test("a configured provider's token must be set; TheMealDB's key need not be", () => {
    const config = parse(withProviders('[recipes.mealie]\nurl = "http://mealie.local:9000"\n[recipes.tandoor]\nurl = "http://tandoor.local:8080"\n'), {});
    const text = missingSecrets(config, { ANTHROPIC_API_KEY: "x" }).join("\n");
    expect(text).toContain("MEALIE_API_TOKEN is not set");
    expect(text).toContain("TANDOOR_API_TOKEN is not set");
    expect(text).not.toContain("THEMEALDB");
    expect(missingSecrets(config, { ANTHROPIC_API_KEY: "x", MEALIE_API_TOKEN: "a", TANDOOR_API_TOKEN: "b" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("doctor", () => {
  function household(extraConfig: string, env: Record<string, string> = {}): Record<string, string> {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "config.toml"), exampleConfigText((text) => text + "\n" + extraConfig));
    copyFileSync(join(REPO_DIR, "data.example", "profile.md"), join(dir, "data", "profile.md"));
    return { HMP_CONFIG: join(dir, "config.toml"), ANTHROPIC_API_KEY: "sk-ant-doctor-DO-NOT-PRINT", ...env };
  }

  test("offline it lists the providers and whether each token variable is set, and prints no token", () => {
    const section = '[recipes.mealie]\nurl = "http://192.168.1.20:9000"\n[recipes.tandoor]\nurl = "http://tandoor.lan:8080"\n';
    const report = runDoctor(household(section, { MEALIE_API_TOKEN: "mealie-secret-DO-NOT-PRINT", TANDOOR_API_TOKEN: "tandoor-secret-DO-NOT-PRINT" }));
    const text = report.lines.join("\n");
    expect(report.ok).toBe(true);
    expect(text).toContain("Recipe API TheMealDB: using the public test key.");
    expect(text).toContain("supporter key (set THEMEALDB_API_KEY)");
    expect(text).toContain("Recipe API Mealie: http://192.168.1.20:9000, token in MEALIE_API_TOKEN (set).");
    expect(text).toContain("Recipe API Tandoor: http://tandoor.lan:8080, token in TANDOOR_API_TOKEN (set).");
    expect(text).not.toContain("DO-NOT-PRINT");

    const supporter = runDoctor(household("", { THEMEALDB_API_KEY: "supporter-DO-NOT-PRINT" })).lines.join("\n");
    expect(supporter).toContain("using your key from THEMEALDB_API_KEY");
    expect(supporter).toContain("Recipe API Mealie: not set up (optional).");
    expect(supporter).not.toContain("DO-NOT-PRINT");
  });

  test("a configured provider with no token set is a problem naming the variable", () => {
    const report = runDoctor(household('[recipes.mealie]\nurl = "http://192.168.1.20:9000"\n'));
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain("MEALIE_API_TOKEN is not set");
  });

  test("--online does one cheap read per provider and names a refused login", async () => {
    const mealDb = track(startFakeMealDb());
    const mealie = track(startFakeMealie());
    const tandoor = track(startFakeTandoor());
    const section = `[recipes.mealie]\nurl = "${mealie.url}"\n[recipes.tandoor]\nurl = "${tandoor.url}"\n`;
    const deps: ProviderDeps = { sleep: async () => {}, allowLoopbackForTests: true, themealdbBaseUrl: mealDb.baseUrl };

    const env = household(section, { MEALIE_API_TOKEN: MEALIE_TOKEN, TANDOOR_API_TOKEN: TANDOOR_TOKEN });
    const report = await runOnlineChecks(env, deps);
    const text = report.lines.join("\n");
    expect(report.ok).toBe(true);
    expect(text).toContain("TheMealDB: reachable");
    expect(text).toContain("Mealie: reachable");
    expect(text).toContain("Tandoor: reachable, token accepted");
    expect(mealDb.requests.map((r) => r.path.split("/").pop())).toEqual(["categories.php"]);
    expect(mealie.requests.map((r) => r.path)).toEqual(["/api/app/about"]);
    expect(tandoor.requests.map((r) => r.search)).toEqual(["?page=1&page_size=1"]);
    expect(text).not.toContain(TANDOOR_TOKEN);

    const refused = await runOnlineChecks({ ...env, TANDOOR_API_TOKEN: "wrong-tandoor-token-1" }, deps);
    expect(refused.ok).toBe(false);
    expect(refused.problems.join("\n")).toContain("Tandoor refused the login (HTTP 401)");
    expect(refused.lines.join("\n")).not.toContain("wrong-tandoor-token-1");

    const gone = await runOnlineChecks(env, { ...deps, themealdbBaseUrl: "http://127.0.0.1:1/api/json/v1/1/" });
    expect(gone.problems.join("\n")).toContain("could not reach TheMealDB");
  });
});
