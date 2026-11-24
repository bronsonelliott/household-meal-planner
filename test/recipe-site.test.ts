// Opt-in site fetching: robots.txt, switching it on, sitemaps, reading recipe pages, publishing,
// and saving a page from chat. The fake site is on this computer; nothing touches the network.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog } from "../src/recipes/catalog.ts";
import { parseRecipeCommand, runRecipeCommand, runRecipeCommandAsync } from "../src/recipes/commands.ts";
import { RecipeRefresher, loadRefreshStatus } from "../src/recipes/refresh.ts";
import { SiteContext, siteStatePathFor } from "../src/recipes/site/context.ts";
import { looksLikeRecipe, parseSitemap } from "../src/recipes/site/discovery.ts";
import { durationMinutes, parseRecipePage } from "../src/recipes/site/recipe-page.ts";
import { parseRobots, productToken } from "../src/recipes/site/robots.ts";
import { loadSources, saveSources, withSourceAdded } from "../src/recipes/sources.ts";
import type { FetchedRecord } from "../src/recipes/types.ts";
import { exampleConfig } from "./fixtures/config-fixtures.ts";
import { SITE_HOST, THREE_INGREDIENTS, at, pageWith, recipeJson, recipePage, sitemapIndexXml, sitemapXml, startFakeSite, type FakeSite } from "./fixtures/fake-site.ts";

const UA = "household-meal-planner/0.1 (self-hosted)";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.parse("2026-11-24T12:00:00Z");

// ---------------------------------------------------------------------------------------------
// robots.txt, parsed
// ---------------------------------------------------------------------------------------------

const rulesFor = (text: string, userAgent = UA) => parseRobots({ status: "ok", text }, userAgent);

describe("robots.txt rules", () => {
  test("our product token is the first word of the User-Agent", () => {
    expect(productToken(UA)).toBe("household-meal-planner");
    expect(productToken("Bot/2.0")).toBe("bot");
  });

  test("a group naming us beats the * group, which is only used when no group names us", () => {
    const text = ["User-agent: *", "Disallow: /", "", "User-agent: Household-Meal-Planner", "Disallow: /private/"].join("\n");
    const rules = rulesFor(text);
    expect(rules.allows("/recipes/x")).toBe(true); // the * group's "Disallow: /" does not apply to us
    expect(rules.allows("/private/x")).toBe(false);
    expect(rulesFor("User-agent: *\nDisallow: /", "other-bot/1").allows("/anything")).toBe(false);
    expect(rulesFor("User-agent: otherbot\nDisallow: /").allows("/anything")).toBe(true); // no group for us, no * group
  });

  test("groups that name us are merged, and several User-agent lines share one group", () => {
    const text = ["User-agent: a-bot", "User-agent: household-meal-planner", "Disallow: /one/", "", "User-agent: household-meal-planner", "Disallow: /two/"].join("\n");
    const rules = rulesFor(text);
    expect(rules.allows("/one/x")).toBe(false);
    expect(rules.allows("/two/x")).toBe(false);
    expect(rules.allows("/three/x")).toBe(true);
  });

  test("the longest matching rule wins, and Allow wins a tie", () => {
    const rules = rulesFor(["User-agent: *", "Disallow: /recipes/", "Allow: /recipes/public/", "Disallow: /recipes/public/draft", "Allow: /tie", "Disallow: /tie"].join("\n"));
    expect(rules.allows("/recipes/x")).toBe(false);
    expect(rules.allows("/recipes/public/x")).toBe(true);
    expect(rules.allows("/recipes/public/draft-1")).toBe(false);
    expect(rules.allows("/tie")).toBe(true);
  });

  test("* matches any run of characters and $ means the path ends there", () => {
    const rules = rulesFor(["User-agent: *", "Disallow: /*.pdf$", "Disallow: /*?print=", "Disallow: /a*b/c"].join("\n"));
    expect(rules.allows("/menu.pdf")).toBe(false);
    expect(rules.allows("/menu.pdf?x=1")).toBe(true); // "$" anchors the end
    expect(rules.allows("/recipes/x?print=1")).toBe(false);
    expect(rules.allows("/aXXb/c/d")).toBe(false);
    expect(rules.allows("/ab")).toBe(true);
  });

  test("an empty Disallow allows everything; comments, odd case and a BOM are tolerated; rules before any group are ignored", () => {
    expect(rulesFor("User-agent: *\nDisallow:\n").allows("/x")).toBe(true);
    expect(rulesFor("﻿USER-AGENT: * # everyone\nDISALLOW: /no # not here\n").allows("/no/x")).toBe(false);
    expect(rulesFor("Disallow: /\nUser-agent: *\nAllow: /").allows("/x")).toBe(true);
  });

  test("percent escapes compare the same in either case", () => {
    expect(rulesFor("User-agent: *\nDisallow: /a%2fb").allows("/a%2Fb")).toBe(false);
  });

  test("Sitemap lines are collected wherever they are", () => {
    const rules = rulesFor("Sitemap: https://x.example/a.xml\nUser-agent: *\nDisallow: /z\nSitemap: https://x.example/b.xml.gz");
    expect(rules.sitemaps).toEqual(["https://x.example/a.xml", "https://x.example/b.xml.gz"]);
  });

  test("Content-Signal ai-input=no counts as a refusal; ai-input=yes does not; the line is kept for the log", () => {
    const no = rulesFor("User-agent: *\nContent-Signal: search=yes, ai-train=no, ai-input=no\nAllow: /");
    expect(no.aiInputBlocked).toBe(true);
    expect(no.contentSignal).toBe("search=yes, ai-train=no, ai-input=no");
    const yes = rulesFor("User-agent: *\nContent-Signal: ai-train=no, ai-input=yes");
    expect(yes.aiInputBlocked).toBe(false);
    expect(yes.contentSignal).toBe("ai-train=no, ai-input=yes");
    // A signal under a group that is not ours does not apply to us.
    expect(rulesFor("User-agent: otherbot\nContent-Signal: ai-input=no\nUser-agent: *\nAllow: /").aiInputBlocked).toBe(false);
  });

  test("no robots.txt allows everything; an unreadable one allows nothing", () => {
    expect(parseRobots({ status: "none", text: "" }, UA).allows("/x")).toBe(true);
    expect(parseRobots({ status: "unavailable", text: "" }, UA).allows("/x")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Reading pages and sitemaps
// ---------------------------------------------------------------------------------------------

describe("recipe data on a page", () => {
  const parse = (html: string, url = at("/recipes/x")) => parseRecipePage(html, url);

  test("a plain Recipe block", () => {
    const { recipe } = parse(pageWith(recipeJson("Lemon chicken", ["1 chicken", "2 lemons", "salt"], { recipeCategory: "Dinner", recipeCuisine: ["Greek"], keywords: "easy, lemon, Dinner", totalTime: "PT1H15M" })));
    expect(recipe).toEqual({
      name: "Lemon chicken",
      ingredients: ["1 chicken", "2 lemons", "salt"],
      instructions: ["Mix everything.", "Cook it."],
      categories: ["Dinner", "Greek", "easy", "lemon"],
      totalMinutes: 75,
    });
  });

  test("@graph, top-level arrays and @type arrays", () => {
    const graph = { "@context": "https://schema.org", "@graph": [{ "@type": "WebSite", name: "Site" }, { "@type": ["Recipe", "Thing"], ...recipeJson("In a graph") }] };
    expect(parse(pageWith(graph)).recipe?.name).toBe("In a graph");
    expect(parse(pageWith([{ "@type": "Organization" }, recipeJson("In an array")])).recipe?.name).toBe("In an array");
    expect(parse(pageWith({ "@type": ["Thing", "schema:Recipe"], name: "Prefixed", recipeIngredient: THREE_INGREDIENTS })).recipe?.name).toBe("Prefixed");
    expect(parse(pageWith({ "@type": "WebPage", mainEntity: recipeJson("Main entity") })).recipe?.name).toBe("Main entity");
  });

  test("instructions as one string, as steps, and as sections of steps", () => {
    const steps = (value: unknown) => parse(pageWith(recipeJson("R", THREE_INGREDIENTS, { recipeInstructions: value }))).recipe?.instructions;
    expect(steps("Chop the onion.\nFry it.\r\n\r\nServe.")).toEqual(["Chop the onion.", "Fry it.", "Serve."]);
    expect(steps(["Boil water.", { "@type": "HowToStep", text: "Add pasta." }, { "@type": "HowToStep", name: "Drain." }])).toEqual(["Boil water.", "Add pasta.", "Drain."]);
    expect(
      steps([
        { "@type": "HowToSection", name: "Sauce", itemListElement: [{ "@type": "HowToStep", text: "Simmer." }, { "@type": "HowToStep", text: "Season." }] },
        { "@type": "HowToSection", name: "Pasta", itemListElement: { "@type": "HowToStep", text: "Cook the pasta." } },
      ]),
    ).toEqual(["Simmer.", "Season.", "Cook the pasta."]);
  });

  test("markup and character references in the text are cleaned", () => {
    const { recipe } = parse(pageWith(recipeJson("Mac &amp; cheese", ["1&#189; cups <b>milk</b>", "2&nbsp;eggs", "salt &amp; pepper"], { recipeInstructions: "Stir.<br>Bake." })));
    expect(recipe?.name).toBe("Mac & cheese");
    expect(recipe?.ingredients).toEqual(["1½ cups milk", "2 eggs", "salt & pepper"]);
    expect(recipe?.instructions).toEqual(["Stir.", "Bake."]);
  });

  test("durations become minutes, and prep plus cook time stands in for a missing total", () => {
    expect([durationMinutes("PT45M"), durationMinutes("PT1H"), durationMinutes("P0DT1H30M"), durationMinutes("P1DT2H"), durationMinutes("PT90S")]).toEqual([45, 60, 90, 1560, 2]);
    expect([durationMinutes("soon"), durationMinutes(30), durationMinutes("PT0M")]).toEqual([undefined, undefined, undefined]);
    expect(parse(pageWith(recipeJson("R", THREE_INGREDIENTS, { prepTime: "PT10M", cookTime: "PT20M" }))).recipe?.totalMinutes).toBe(30);
  });

  test("a malformed block is skipped and a later good one is used; no block means no recipe", () => {
    const html = `<html><head><script type="application/ld+json">{ not json </script><script type="application/ld+json">${JSON.stringify(recipeJson("Second block"))}</script></head></html>`;
    expect(parse(html).recipe?.name).toBe("Second block");
    expect(parse(pageWith("{ broken")).recipe).toBeNull();
    expect(parse("<html><body>no data</body></html>").recipe).toBeNull();
    expect(parse(pageWith('{"@type":"Recipe","name":"x","recipeIngredient":[}')).recipe).toBeNull();
  });

  test("a recipe needs a name and at least three ingredients", () => {
    expect(parse(pageWith(recipeJson("Two things", ["a", "b"]))).recipe).toBeNull();
    expect(parse(pageWith(recipeJson("Blank lines", ["a", " ", "", "b"]))).recipe).toBeNull(); // blank lines do not count
  });

  test("a page with three real ingredients and blank extras still counts", () => {
    expect(parse(pageWith(recipeJson("Three", ["a", " ", "b", "", "c"]))).recipe?.ingredients).toEqual(["a", "b", "c"]);
    expect(parse(pageWith(recipeJson("", THREE_INGREDIENTS))).recipe).toBeNull();
  });

  test("the canonical link is used only when it is on the same site", () => {
    const page = (href: string) => parse(recipePage("R", undefined, undefined, `<link rel="canonical" href="${href}">`));
    expect(page("https://www.recipes.example.com/recipes/real-one").canonical).toBe("https://www.recipes.example.com/recipes/real-one");
    expect(page("/recipes/relative-one").canonical).toBe(at("/recipes/relative-one"));
    expect(page("https://elsewhere.example.org/recipes/x").canonical).toBeNull();
    expect(parse(recipePage("R")).canonical).toBeNull();
  });
});

describe("sitemaps and recipe-looking addresses", () => {
  test("an index and a page list are told apart, with entities and CDATA read", () => {
    expect(parseSitemap(sitemapIndexXml(["https://x.example/a.xml"]))).toEqual({ kind: "index", locations: ["https://x.example/a.xml"] });
    expect(parseSitemap("<urlset><url><loc>https://x.example/a?b=1&amp;c=2</loc></url><url><loc><![CDATA[https://x.example/d]]></loc></url></urlset>")).toEqual({
      kind: "pages",
      locations: ["https://x.example/a?b=1&c=2", "https://x.example/d"],
    });
  });

  test("path rules: recipe folders and -recipe names yes; listings, categories and other files no", () => {
    const yes = ["/recipe/lemon-pasta", "/recipes/lemon-pasta", "/2024/05/best-pasta-recipe/", "/food/chicken-recipe.html"];
    const no = ["/", "/about", "/recipes", "/recipes/", "/recipes/category/dinner", "/tag/pasta", "/recipes/page/2", "/recipes/photo.jpg", "/blog/hello", "/recipe-index"];
    for (const path of yes) expect([path, looksLikeRecipe(at(path), SITE_HOST)]).toEqual([path, true]);
    for (const path of no) expect([path, looksLikeRecipe(at(path), SITE_HOST)]).toEqual([path, false]);
  });

  test("a per-site override replaces the generic rule", () => {
    expect(looksLikeRecipe(at("/dish/pasta"), SITE_HOST)).toBe(false);
    expect(looksLikeRecipe(at("/dish/pasta"), SITE_HOST, { [SITE_HOST]: ["^/dish/"] })).toBe(true);
    expect(looksLikeRecipe(at("/recipes/pasta"), SITE_HOST, { [SITE_HOST]: ["^/dish/"] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Against a fake site
// ---------------------------------------------------------------------------------------------

let dir: string;
let sourcesPath: string;
let catalogPath: string;
let statusPath: string;
let now: number;
let logs: string[];
let site: FakeSite;
const ROBOTS_OK = "User-agent: *\nDisallow: /private/\nSitemap: https://recipes.example.com/sitemap.xml\n";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "site-test-"));
  sourcesPath = join(dir, "recipe-sources.json");
  catalogPath = join(dir, "recipe-catalog.json");
  statusPath = join(dir, "recipe-refresh.json");
  now = START;
  logs = [];
  site = startFakeSite();
  site.set("/robots.txt", { body: ROBOTS_OK, headers: { "content-type": "text/plain" } });
});
afterEach(() => site.stop());

const nowIso = () => new Date(now).toISOString();

function makeContext(changes: Partial<ReturnType<typeof exampleConfig>["recipes"]> = {}): SiteContext {
  return new SiteContext({
    statePath: siteStatePathFor(catalogPath),
    recipes: { ...exampleConfig().recipes, secondsBetweenRequests: 0, ...changes },
    deps: { fetch: site.fetch, resolve: async () => ["93.184.216.34"], sleep: async () => {} },
    now: () => now,
    log: (line) => logs.push(line),
  });
}

function makeRefresher(ctx: SiteContext): RecipeRefresher {
  // The fake fetch refuses every name but the fake site's, so even a stray API source cannot reach the network.
  const deps = { fetch: site.fetch, resolve: async () => ["93.184.216.34"], sleep: async () => {} };
  return new RecipeRefresher({ sourcesPath, catalogPath, statusPath, recipes: ctx.recipes, env: {}, now: () => now, log: (line) => logs.push(line), site: ctx, deps });
}

// The fake site as a configured source, already in fetch mode.
function addFetchSource(mode: "fetch" | "link" = "fetch") {
  const file = loadSources(sourcesPath, nowIso());
  const change = withSourceAdded(file, at("/"));
  if (!change.ok) throw new Error(change.reason);
  const source = { ...change.source, mode };
  // In fetch mode only the fake site is a source, so a refresh has nothing else to do.
  const others = mode === "fetch" ? [] : change.file.sources.filter((candidate) => candidate.id !== source.id);
  saveSources(sourcesPath, { ...change.file, sources: [...others, source] });
  return source;
}

const sourceNow = () => loadSources(sourcesPath, nowIso()).sources.find((candidate) => candidate.host === SITE_HOST)!;
const fetchedRecords = () => loadCatalog(catalogPath).records.filter((record): record is FetchedRecord => record.kind === "fetched");
// One refresh pass; the result for the fake site's source.
async function tick(refresher: RecipeRefresher) {
  const results = await refresher.tick();
  return results.find((result) => result.sourceId === sourceNow().id);
}
const statusOf = () => loadRefreshStatus(statusPath).sources[sourceNow().id]!;

function command(text: string, ctx: SiteContext | undefined, admin = true): Promise<string> {
  return runRecipeCommandAsync(parseRecipeCommand(text)!, { sourcesPath, catalogPath, refreshStatusPath: statusPath, admin, nowIso: nowIso(), by: "alex", ...(ctx ? { site: ctx } : {}) });
}

describe("robots.txt from the site", () => {
  test("a missing robots.txt (404, or any 4xx) sets no limits; 5xx, 429 and an unreachable site are 'unavailable'", async () => {
    const source = addFetchSource();
    for (const [status, expected] of [[404, "none"], [403, "none"], [500, "unavailable"], [503, "unavailable"], [429, "unavailable"]] as const) {
      site.set("/robots.txt", { status, body: "denied" });
      const { info, rules } = await makeContext().robots(source);
      expect([status, info.status]).toEqual([status, expected]);
      expect(rules.allows("/recipes/x")).toBe(expected === "none");
    }
    const down = new SiteContext({ statePath: siteStatePathFor(catalogPath), recipes: exampleConfig().recipes, deps: { fetch: (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch, resolve: async () => ["93.184.216.34"], sleep: async () => {} } });
    const { info } = await down.robots(source);
    expect(info.status).toBe("unavailable");
    expect(info.error).toContain("could not reach");
  });

  test("it is asked for with our User-Agent, kept for 24 hours, and an unavailable answer is not kept", async () => {
    const source = addFetchSource();
    const ctx = makeContext();
    await ctx.robots(source);
    await ctx.robots(source);
    expect(site.count("/robots.txt")).toBe(1);
    expect(site.requests[0]!.headers.get("user-agent")).toBe(exampleConfig().recipes.userAgent);
    now += 23 * HOUR;
    await ctx.robots(source);
    expect(site.count("/robots.txt")).toBe(1);
    now += 2 * HOUR;
    await ctx.robots(source);
    expect(site.count("/robots.txt")).toBe(2);

    site.set("/robots.txt", { status: 500 });
    const failing = makeContext();
    await failing.robots(source);
    await failing.robots(source);
    expect(site.count("/robots.txt")).toBe(4); // both unavailable answers were asked for afresh
  });
});

describe("sources fetch <site> on", () => {
  test("only an admin; blocked and API sources are refused; unknown sites are named", async () => {
    addFetchSource("link");
    const ctx = makeContext();
    expect(await command("sources fetch recipes.example.com on", ctx, false)).toBe("Only an admin can change site fetching.");
    expect(await command("sources fetch allrecipes.com on", ctx)).toContain("Fetching is blocked for Allrecipes");
    expect(await command("sources fetch themealdb.com on", ctx)).toContain("always on");
    expect(await command("sources fetch nowhere.example.org on", ctx)).toContain("I don't have a source");
    expect(site.requests.length).toBe(0); // none of those touched the site
    expect(sourceNow().mode).toBe("link");
  });

  test("it succeeds when robots.txt allows it, records who and when, and leaves the policy alone", async () => {
    addFetchSource("link");
    const reply = await command("sources fetch recipes.example.com on", makeContext());
    const source = sourceNow();
    expect(source.mode).toBe("fetch");
    expect(source.policy).toBe("unverified"); // a permissive robots.txt never upgrades it
    expect(source.enabledBy).toBe("alex");
    expect(source.enabledAt).toBe(nowIso());
    expect(reply).toContain("Fetching is on for recipes.example.com");
    expect(reply).toContain("robots.txt allows it");
    expect(reply).toContain("did NOT check");
    expect(reply).toContain("terms of use");
    expect(reply).toContain("responsibility");
    expect(await command("sources fetch recipes.example.com on", makeContext())).toBe("Fetching is already on for recipes.example.com.");
  });

  test("a site with no robots.txt can be switched on, and the reply says so", async () => {
    addFetchSource("link");
    site.set("/robots.txt", { status: 404 });
    const reply = await command("sources fetch recipes.example.com on", makeContext());
    expect(sourceNow().mode).toBe("fetch");
    expect(reply).toContain("no robots.txt");
  });

  test("it is refused when robots.txt disallows the site, its recipe pages, or says ai-input=no", async () => {
    addFetchSource("link");
    const refused = async (robots: string | { status: number }, mention: string) => {
      site.set("/robots.txt", typeof robots === "string" ? { body: robots } : robots);
      const reply = await command("sources fetch recipes.example.com on", makeContext());
      expect([reply, sourceNow().mode]).toEqual([expect.stringContaining(mention), "link"]);
      expect(sourceNow().enabledBy).toBeUndefined();
    };
    await refused("User-agent: *\nDisallow: /", "fetching stays off");
    await refused("User-agent: household-meal-planner\nDisallow: /", "fetching stays off");
    await refused("User-agent: *\nDisallow: /recipes/", "closes its recipe pages");
    await refused("User-agent: *\nDisallow: /recipe/", "closes its recipe pages");
    await refused("User-agent: *\nContent-Signal: search=yes, ai-input=no\nAllow: /", "ai-input=no");
    await refused({ status: 500 }, "couldn't read robots.txt");
    // Allowed when the more specific group lets us in.
    site.set("/robots.txt", { body: "User-agent: *\nDisallow: /\n\nUser-agent: household-meal-planner\nAllow: /\n" });
    expect(await command("sources fetch recipes.example.com on", makeContext())).toContain("Fetching is on");
  });

  test("a Content-Signal that does not forbid us is passed on in the reply", async () => {
    addFetchSource("link");
    site.set("/robots.txt", { body: "User-agent: *\nContent-Signal: search=yes, ai-train=no, ai-input=yes\nAllow: /" });
    expect(await command("sources fetch recipes.example.com on", makeContext())).toContain("ai-train=no");
  });

  test("without the shared web client the command says it can't, and changes nothing", async () => {
    addFetchSource("link");
    expect(await command("sources fetch recipes.example.com on", undefined)).toContain("isn't available");
    expect(sourceNow().mode).toBe("link");
  });

  test("off goes back to links and keeps the recipes already fetched; the site is not contacted again", async () => {
    addFetchSource("link");
    const ctx = makeContext();
    await command("sources fetch recipes.example.com on", ctx);
    site.set("/sitemap.xml", sitemapXml([at("/recipes/one")]));
    site.set("/recipes/one", recipePage("One"));
    await makeRefresher(ctx).tick();
    expect(fetchedRecords().length).toBe(1);

    const reply = runRecipeCommand(parseRecipeCommand("sources fetch recipes.example.com off")!, { sourcesPath, catalogPath, admin: true, nowIso: nowIso() });
    expect(reply).toContain("Fetching is off for recipes.example.com");
    expect(reply).toContain("1 recipe already fetched stays on file");
    expect(sourceNow().mode).toBe("link");
    expect(sourceNow().enabledBy).toBeUndefined();
    expect(sourceNow().policy).toBe("unverified");

    const before = site.requests.length;
    now += 30 * DAY;
    await makeRefresher(makeContext()).tick();
    expect(site.requests.length).toBe(before);
    expect(fetchedRecords().length).toBe(1); // still there, no longer refreshed
    expect(runRecipeCommand(parseRecipeCommand("sources fetch recipes.example.com off")!, { sourcesPath, catalogPath, admin: true, nowIso: nowIso() })).toBe("Fetching is already off for recipes.example.com.");
  });
});

describe("discovery and publishing", () => {
  function twoSitemaps() {
    site.set("/sitemap.xml", sitemapIndexXml([at("/sitemap-a.xml"), at("/sitemap-b.xml.gz")]));
    site.set("/sitemap-a.xml", {
      body: sitemapXml([at("/recipes/chicken-tacos"), at("/about"), at("/recipes/"), at("/recipes/category/dinner"), at("/private/recipes/secret"), "https://other.example.org/recipes/elsewhere"]),
      headers: { "content-type": "application/xml" },
    });
    site.set("/sitemap-b.xml.gz", { body: Bun.gzipSync(sitemapXml([at("/recipe/lemon-pasta"), at("/best-pasta-recipe"), at("/recipes/just-a-blog-post")])), headers: { "content-type": "application/gzip" } });
    site.set("/recipes/chicken-tacos", recipePage("Chicken tacos", ["1 lb chicken", "8 tortillas", "1 lime"]));
    site.set("/recipe/lemon-pasta", recipePage("Lemon pasta", ["spaghetti", "2 lemons", "parmesan"], { totalTime: "PT20M" }));
    site.set("/best-pasta-recipe", recipePage("Best pasta", ["pasta", "oil", "garlic"]));
    site.set("/recipes/just-a-blog-post", "<html><body>Just a post</body></html>");
    site.set("/private/recipes/secret", recipePage("Secret", THREE_INGREDIENTS));
  }

  test("one run walks the sitemap index (a gzip file too), keeps recipe-looking pages, confirms them by reading, and publishes", async () => {
    addFetchSource();
    twoSitemaps();
    const ctx = makeContext();
    const [result] = await makeRefresher(ctx).tick();
    expect(result).toMatchObject({ ok: true, count: 3 });

    const records = fetchedRecords();
    expect(records.map((record) => record.name).sort()).toEqual(["Best pasta", "Chicken tacos", "Lemon pasta"]);
    const pasta = records.find((record) => record.name === "Lemon pasta")!;
    expect(pasta).toMatchObject({ kind: "fetched", ingredientProvenance: "publisher", url: at("/recipe/lemon-pasta"), sourceId: sourceNow().id, totalMinutes: 20, protein: "unknown" });
    expect(records.find((record) => record.name === "Chicken tacos")!.protein).toBe("chicken");

    // Only the pages that should be asked for were asked for.
    const asked = site.requests.map((request) => request.path);
    expect(asked).not.toContain("/about");
    expect(asked).not.toContain("/private/recipes/secret"); // robots.txt disallows it
    expect(asked.some((path) => path.includes("other.example.org"))).toBe(false);
    expect(asked).toContain("/recipes/just-a-blog-post"); // looks like a recipe, confirmed by reading: not one
    expect(site.requests.every((request) => request.headers.get("user-agent") === exampleConfig().recipes.userAgent)).toBe(true);

    expect(statusOf()).toMatchObject({ count: 3, lastError: null, backlog: false });
    expect(sourceNow().policy).toBe("unverified"); // fetching a lot never changes the policy
    // The reply to "recipes status" shows it.
    const status = runRecipeCommand({ kind: "recipes-status" }, { sourcesPath, catalogPath, refreshStatusPath: statusPath, admin: false, nowIso: nowIso() });
    expect(status).toContain("recipes.example.com: 3 fetched recipes");
    expect(status).toContain("Refreshed 2026-11-24");
  });

  test("the daily budgets stop a run, and the next day carries on from the saved queue", async () => {
    addFetchSource();
    twoSitemaps();
    const ctx = makeContext({ sitemapsPerSourcePerDay: 1, pagesPerSourcePerDay: 2 });
    const refresher = makeRefresher(ctx);

    await refresher.tick(); // day 1: the sitemap budget buys only the index
    expect(site.count("/sitemap.xml")).toBe(1);
    expect(site.count("/sitemap-a.xml")).toBe(0);
    expect(fetchedRecords().length).toBe(0);
    expect(statusOf().backlog).toBe(true);

    // Not due again within the day (a backlog waits 24 hours), even when asked.
    now += 3 * HOUR;
    expect(await makeRefresher(makeContext({ sitemapsPerSourcePerDay: 1, pagesPerSourcePerDay: 2 })).tick()).toEqual([]);

    now += 22 * HOUR; // day 2
    await makeRefresher(makeContext({ sitemapsPerSourcePerDay: 1, pagesPerSourcePerDay: 2 })).tick();
    expect(site.count("/sitemap.xml")).toBe(1); // not read again: the queue was saved
    expect(site.count("/sitemap-a.xml")).toBe(1);
    expect(site.count("/sitemap-b.xml.gz")).toBe(0);
    expect(fetchedRecords().length).toBe(1); // sitemap-a has one recipe page that is not disallowed

    now += 24 * HOUR; // day 3: one sitemap (b), two pages
    await makeRefresher(makeContext({ sitemapsPerSourcePerDay: 1, pagesPerSourcePerDay: 2 })).tick();
    expect(site.count("/sitemap-b.xml.gz")).toBe(1);
    expect(fetchedRecords().length).toBe(3);
    expect(statusOf().backlog).toBe(true); // the blog-post page is still waiting for tomorrow's budget
    now += 24 * HOUR;
    await makeRefresher(makeContext({ sitemapsPerSourcePerDay: 1, pagesPerSourcePerDay: 2 })).tick();
    expect(statusOf().backlog).toBe(false);
    expect(site.count("/recipes/just-a-blog-post")).toBe(1);
  });

  test("one run never spends more than the page budget in a single day, even when run twice", async () => {
    addFetchSource();
    twoSitemaps();
    const ctx = makeContext({ pagesPerSourcePerDay: 2 });
    await makeRefresher(ctx).refreshSource(sourceNow());
    await makeRefresher(ctx).refreshSource(sourceNow());
    const pageRequests = site.requests.filter((request) => !/sitemap|robots/.test(request.path));
    expect(pageRequests.length).toBe(2);
  });

  test("a recipe's canonical link on the same site is its address; one on another site is ignored", async () => {
    addFetchSource();
    site.set("/sitemap.xml", sitemapXml([at("/recipes/tracking-version"), at("/recipes/steals-identity")]));
    site.set("/recipes/tracking-version", recipePage("Same dish", undefined, undefined, `<link rel="canonical" href="https://www.recipes.example.com/recipes/the-real-page?utm_source=x">`));
    site.set("/recipes/steals-identity", recipePage("Other dish", undefined, undefined, `<link rel="canonical" href="https://evil.example.org/recipes/steal">`));
    await makeRefresher(makeContext()).tick();
    const urls = fetchedRecords().map((record) => record.url).sort();
    expect(urls).toEqual([at("/recipes/steals-identity"), "https://www.recipes.example.com/recipes/the-real-page"]);
  });

  test("a page's @context address is never fetched, and scripts are never run", async () => {
    addFetchSource();
    site.set("/sitemap.xml", sitemapXml([at("/recipes/with-context")]));
    site.set("/recipes/with-context", pageWith({ ...recipeJson("With context"), "@context": "https://recipes.example.com/schema-context.jsonld" }, `<script>fetch("/beacon")</script>`));
    await makeRefresher(makeContext()).tick();
    expect(fetchedRecords().length).toBe(1);
    expect(site.count("/schema-context.jsonld")).toBe(0);
    expect(site.count("/beacon")).toBe(0);
  });

  test("a page with fewer than three ingredients is not a recipe, and is not asked for again", async () => {
    addFetchSource();
    site.set("/sitemap.xml", sitemapXml([at("/recipes/thin")]));
    site.set("/recipes/thin", recipePage("Thin", ["a", "b"]));
    await makeRefresher(makeContext()).tick();
    expect(fetchedRecords().length).toBe(0);
    now += 8 * DAY;
    await makeRefresher(makeContext()).tick();
    expect(site.count("/recipes/thin")).toBe(1); // remembered as not a recipe
  });

  test("a sitemap's pages on another site are ignored, and so are sitemap files that robots.txt closes", async () => {
    addFetchSource();
    site.set("/robots.txt", { body: "User-agent: *\nDisallow: /closed/\n" }); // no Sitemap line: /sitemap.xml is tried
    site.set("/sitemap.xml", sitemapIndexXml([at("/closed/sitemap-x.xml"), "https://other.example.org/sitemap.xml", at("/sitemap-ok.xml")]));
    site.set("/sitemap-ok.xml", sitemapXml([at("/recipes/fine")]));
    site.set("/recipes/fine", recipePage("Fine"));
    await makeRefresher(makeContext()).tick();
    expect(fetchedRecords().map((record) => record.name)).toEqual(["Fine"]);
    expect(site.count("/closed/sitemap-x.xml")).toBe(0);
  });

  test("an address that redirects to a private network address is refused, and the run carries on", async () => {
    addFetchSource();
    site.set("/sitemap.xml", sitemapXml([at("/recipes/evil"), at("/recipes/good")]));
    site.set("/recipes/evil", { status: 302, headers: { location: "http://10.0.0.5/admin" } });
    site.set("/recipes/good", recipePage("Good"));
    const [result] = await makeRefresher(makeContext()).tick();
    expect(result!.ok).toBe(true);
    expect(fetchedRecords().map((record) => record.name)).toEqual(["Good"]);
    expect(statusOf().skipped).toBe(1);
    // A redirect to the cloud metadata address is refused the same way.
    site.set("/recipes/evil", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
  });

  test("a redirect is checked before it is followed: another host, a closed path, or plain http is never requested", async () => {
    addFetchSource();
    const asked: string[] = [];
    const watching = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      asked.push(`${url.protocol}//${url.hostname}${url.pathname}`);
      url.hostname = url.hostname.replace(/^www\./, ""); // the fake site serves both spellings of its name
      return site.fetch(url.toString(), init);
    }) as typeof fetch;
    const ctx = new SiteContext({
      statePath: siteStatePathFor(catalogPath),
      recipes: { ...exampleConfig().recipes, secondsBetweenRequests: 0 },
      deps: { fetch: watching, resolve: async () => ["93.184.216.34"], sleep: async () => {} },
      now: () => now,
      log: (line) => logs.push(line),
    });
    site.set("/sitemap.xml", sitemapXml([at("/recipes/to-blocked"), at("/recipes/to-closed"), at("/recipes/to-www"), at("/recipes/to-http"), at("/recipes/to-nonfetch")]));
    // Another source that is blocked, one that is not in fetch mode, and an ordinary other site.
    site.set("/recipes/to-blocked", { status: 302, headers: { location: "https://allrecipes.com/recipe/1" } });
    site.set("/recipes/to-nonfetch", { status: 302, headers: { location: "https://www.thekitchn.com/recipes/2" } });
    site.set("/recipes/to-closed", { status: 302, headers: { location: "/private/recipes/hidden" } });
    site.set("/recipes/to-http", { status: 302, headers: { location: "http://recipes.example.com/recipes/plain" } });
    site.set("/recipes/to-www", { status: 302, headers: { location: "https://www.recipes.example.com/recipes/landed" } }); // the www twin is the same site
    site.set("/private/recipes/hidden", recipePage("Hidden"));
    site.set("/recipes/plain", recipePage("Plain"));
    site.set("/recipes/landed", recipePage("Landed"));
    await makeRefresher(ctx).tick();

    expect(site.count("/private/recipes/hidden")).toBe(0);
    expect(site.count("/recipes/plain")).toBe(0);
    expect(asked.filter((entry) => !entry.includes(SITE_HOST))).toEqual([]); // no request left the site
    expect(fetchedRecords().map((record) => record.name)).toEqual(["Landed"]);
    expect(statusOf().skipped).toBe(4);
  });

  test("a page redirecting to another site is not kept", async () => {
    addFetchSource();
    site.set("/sitemap.xml", sitemapXml([at("/recipes/moved")]));
    site.set("/recipes/moved", { status: 302, headers: { location: "https://other.example.org/recipes/moved" } });
    // The fake site only answers for its own name, so following the redirect fails; either way
    // nothing from the other site may become a record.
    await makeRefresher(makeContext()).tick();
    expect(fetchedRecords().length).toBe(0);
  });

  test("a link someone saved by hand stays exactly as it was through a refresh, even when the page is now a real recipe", async () => {
    addFetchSource();
    runRecipeCommand(parseRecipeCommand(`recipe save ${at("/recipes/only-a-link")}`)!, { sourcesPath, catalogPath, admin: false, nowIso: nowIso() });
    runRecipeCommand(parseRecipeCommand(`recipe save ${at("/recipes/becomes-fetched")}`)!, { sourcesPath, catalogPath, admin: false, nowIso: nowIso() });
    site.set("/sitemap.xml", sitemapXml([at("/recipes/becomes-fetched")]));
    site.set("/recipes/becomes-fetched", recipePage("Becomes fetched"));
    await makeRefresher(makeContext()).tick();
    const records = loadCatalog(catalogPath).records;
    const bookmarksBefore = records;
    expect(records.filter((record) => record.kind === "bookmark").map((record) => record.url).sort()).toEqual([at("/recipes/becomes-fetched"), at("/recipes/only-a-link")].sort());
    expect(records.filter((record) => record.kind === "fetched")).toEqual([]);
    expect(records).toEqual(bookmarksBefore);
    expect(statusOf().skipped).toBe(1); // the fetched duplicate was dropped and counted
  });
});

describe("keeping what is good", () => {
  async function oneRecipeOnFile(extra: Partial<Parameters<typeof makeContext>[0]> = {}) {
    addFetchSource();
    site.set("/sitemap.xml", sitemapXml([at("/recipes/one")]));
    let version = 1;
    site.set("/recipes/one", () => new Response(recipePage("One", ["a", "b", "c"], { description: `v${version}` }), { headers: { "content-type": "text/html", etag: `"v${version}"` } }));
    const ctx = makeContext(extra);
    await makeRefresher(ctx).tick();
    expect(fetchedRecords().length).toBe(1);
    return { ctx, bump: () => version++ };
  }

  test("after 7 days a recipe is re-checked with its ETag, and a 304 keeps it as it was", async () => {
    await oneRecipeOnFile();
    const fetchedAt = fetchedRecords()[0]!.fetchedAt;
    site.set("/recipes/one", (request) => (request.headers.get("if-none-match") === '"v1"' ? new Response(null, { status: 304 }) : new Response("changed", { status: 200 })));
    now += 8 * DAY;
    await makeRefresher(makeContext()).tick();
    const conditional = site.requests.filter((request) => request.path === "/recipes/one").at(-1)!;
    expect(conditional.headers.get("if-none-match")).toBe('"v1"');
    expect(fetchedRecords()[0]!.fetchedAt).toBe(fetchedAt);
    expect(statusOf().lastError).toBeNull();
  });

  test("a changed page replaces the record; a page that is gone removes it", async () => {
    const { bump } = await oneRecipeOnFile();
    bump();
    site.set("/recipes/one", recipePage("One, improved", ["a", "b", "c", "d"]));
    now += 8 * DAY;
    await makeRefresher(makeContext()).tick();
    expect(fetchedRecords().map((record) => [record.name, record.ingredients.length])).toEqual([["One, improved", 4]]);

    site.remove("/recipes/one");
    now += 8 * DAY;
    await makeRefresher(makeContext()).tick();
    expect(fetchedRecords().length).toBe(0);
  });

  test("a page that errors on re-check keeps its last good recipe", async () => {
    await oneRecipeOnFile();
    site.set("/recipes/one", { status: 500, body: "oops" });
    now += 8 * DAY;
    const [result] = await makeRefresher(makeContext()).tick();
    expect(result!.ok).toBe(true);
    expect(fetchedRecords().map((record) => record.name)).toEqual(["One"]);
    expect(statusOf().skipped).toBe(1);
  });

  test("a robots.txt that cannot be read pauses fetching, keeps every recipe, and says so in the status", async () => {
    await oneRecipeOnFile();
    site.set("/robots.txt", { status: 500 });
    now += 8 * DAY;
    const requestsBefore = site.requests.length;
    const [result] = await makeRefresher(makeContext()).tick();
    expect(result).toMatchObject({ ok: false, count: 1 });
    expect(result!.error).toContain("paused");
    expect(fetchedRecords().length).toBe(1);
    expect(statusOf().lastError).toContain("paused");
    expect(site.requests.length).toBe(requestsBefore + 1); // only robots.txt was asked for

    // It comes back by itself once robots.txt is readable (a failure waits 6 hours).
    site.set("/robots.txt", { body: ROBOTS_OK });
    now += 7 * HOUR;
    const [again] = await makeRefresher(makeContext()).tick();
    expect(again!.ok).toBe(true);
  });

  test("a robots.txt that now forbids the site, or says ai-input=no, stops fetching and keeps the recipes", async () => {
    await oneRecipeOnFile();
    now += 8 * DAY;
    site.set("/robots.txt", { body: "User-agent: *\nDisallow: /\n" });
    let [result] = await makeRefresher(makeContext()).tick();
    expect(result!.error).toContain("now disallows");
    site.set("/robots.txt", { body: "User-agent: *\nContent-Signal: ai-input=no\n" });
    now += 25 * HOUR; // the cached robots.txt expires after 24
    [result] = await makeRefresher(makeContext()).tick();
    expect(result!.error).toContain("ai-input=no");
    expect(logs.some((line) => line.includes("Content-Signal"))).toBe(true);
    expect(fetchedRecords().length).toBe(1);
  });

  test("a site that fails three requests in a row stops the run; what was gathered so far is kept", async () => {
    addFetchSource();
    site.set("/sitemap.xml", sitemapXml([at("/recipes/a"), at("/recipes/b"), at("/recipes/c"), at("/recipes/d"), at("/recipes/e")]));
    site.set("/recipes/a", recipePage("A"));
    for (const name of ["b", "c", "d", "e"]) site.set(`/recipes/${name}`, { status: 500 });
    const [result] = await makeRefresher(makeContext()).tick();
    expect(result!.ok).toBe(false);
    expect(result!.error).toContain("in a row");
    expect(fetchedRecords().map((record) => record.name)).toEqual(["A"]);
    expect(statusOf().backlog).toBe(true);
    expect(site.count("/recipes/e")).toBe(0); // it stopped before asking for the last one
  });

  test("a refresh that cannot be saved because the source was removed publishes nothing", async () => {
    const source = addFetchSource();
    site.set("/sitemap.xml", sitemapXml([at("/recipes/one")]));
    site.set("/recipes/one", () => {
      saveSources(sourcesPath, { ...loadSources(sourcesPath, nowIso()), sources: [] });
      return new Response(recipePage("One"), { headers: { "content-type": "text/html" } });
    });
    const result = await makeRefresher(makeContext()).refreshSource(source);
    expect(result.ok).toBe(false);
    expect(fetchedRecords().length).toBe(0);
  });
});

describe("recipe save on a site that is switched on", () => {
  test("it fetches the page and replies only once the recipe is saved with the publisher's ingredients", async () => {
    addFetchSource();
    site.set("/recipes/saved-one", recipePage("Saved one", ["x", "y", "z"], { totalTime: "PT30M" }));
    const ctx = makeContext();
    const reply = await command(`recipe save ${at("/recipes/saved-one?utm_source=chat")}`, ctx, false);
    expect(reply).toContain('Saved "Saved one"');
    expect(reply).toContain("the recipe's own ingredients");
    const [record] = fetchedRecords();
    expect(record).toMatchObject({ name: "Saved one", ingredients: ["x", "y", "z"], ingredientProvenance: "publisher", url: at("/recipes/saved-one"), totalMinutes: 30 });
    // Saved again: the usual "already saved", with no second visit to the page.
    expect(await command(`recipe save ${at("/recipes/saved-one")}`, ctx, false)).toContain("already saved");
    expect(site.count("/recipes/saved-one")).toBe(1);
    // It uses today's page budget.
    expect(ctx.left(sourceNow().id, "pages")).toBe(exampleConfig().recipes.pagesPerSourcePerDay - 1);
  });

  test("an earlier plain link to the same page stays a link: it is never upgraded", async () => {
    addFetchSource("link");
    runRecipeCommand(parseRecipeCommand(`recipe save ${at("/recipes/earlier")}`)!, { sourcesPath, catalogPath, admin: false, nowIso: nowIso() });
    expect(loadCatalog(catalogPath).records[0]!.kind).toBe("bookmark");
    saveSources(sourcesPath, { ...loadSources(sourcesPath, nowIso()), sources: loadSources(sourcesPath, nowIso()).sources.map((source) => (source.host === SITE_HOST ? { ...source, mode: "fetch" as const } : source)) });
    site.set("/recipes/earlier", recipePage("Earlier"));
    const before = loadCatalog(catalogPath).records;
    const reply = await command(`recipe save ${at("/recipes/earlier")}`, makeContext(), false);
    expect(reply).toContain("already saved");
    expect(loadCatalog(catalogPath).records).toEqual(before);
  });

  test("when the page cannot be read the link is saved as a link, and the reply says why", async () => {
    addFetchSource();
    site.set("/recipes/no-data", "<html>nothing here</html>");
    const reply = await command(`recipe save ${at("/recipes/no-data")}`, makeContext(), false);
    expect(reply).toContain("Saved");
    expect(reply).toContain("only the link");
    expect(reply).toContain("no recipe data");
    expect(reply).not.toContain("didn't open the page");
    expect(loadCatalog(catalogPath).records.map((record) => record.kind)).toEqual(["bookmark"]);
  });

  test("robots.txt still applies: a disallowed page is saved as a link and never requested", async () => {
    addFetchSource();
    site.set("/private/recipes/hidden", recipePage("Hidden"));
    const reply = await command(`recipe save ${at("/private/recipes/hidden")}`, makeContext(), false);
    expect(reply).toContain("does not allow");
    expect(site.count("/private/recipes/hidden")).toBe(0);
    expect(loadCatalog(catalogPath).records.map((record) => record.kind)).toEqual(["bookmark"]);
  });

  test("when today's page budget is used up it falls back to the link", async () => {
    addFetchSource();
    site.set("/recipes/over-budget", recipePage("Over budget"));
    const reply = await command(`recipe save ${at("/recipes/over-budget")}`, makeContext({ pagesPerSourcePerDay: 0 }), false);
    expect(reply).toContain("budget");
    expect(site.count("/recipes/over-budget")).toBe(0);
    expect(loadCatalog(catalogPath).records.map((record) => record.kind)).toEqual(["bookmark"]);
  });

  test("a redirect to a private address is refused and the link is saved", async () => {
    addFetchSource();
    site.set("/recipes/sneaky", { status: 302, headers: { location: "http://192.168.1.1/router" } });
    const reply = await command(`recipe save ${at("/recipes/sneaky")}`, makeContext(), false);
    expect(reply).toContain("plain http");
    expect(loadCatalog(catalogPath).records.map((record) => record.kind)).toEqual(["bookmark"]);
  });

  test("a site that is not in fetch mode keeps the link-only behaviour, with no request made", async () => {
    addFetchSource("link");
    const reply = await command(`recipe save ${at("/recipes/plain-link")}`, makeContext(), false);
    expect(reply).toContain("I only saved the link and didn't open the page");
    expect(site.requests.length).toBe(0);
    // And a site that is not a source at all.
    expect(await command("recipe save https://unlisted.example.net/recipes/x", makeContext(), false)).toContain("isn't one of my recipe sources");
    expect(site.requests.length).toBe(0);
  });
});
