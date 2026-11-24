// Fetching recipe pages from a site an admin switched on. Same shape as the API providers: a
// run reads what it needs, returns the COMPLETE list of recipes the source should have, and the
// refresher publishes it (or, when something fails, keeps what was there).
//
// One run, in order:
//   1. robots.txt (cached up to 24 hours). Unreadable, or the site now says no: stop and keep
//      what we have.
//   2. sitemaps: read queued sitemap files (an index adds more to the queue) until today's
//      sitemap budget is spent. Addresses that look like recipes go in the page queue.
//   3. pages: re-check recipes not looked at for 7 days (a cheap "has it changed?" request using
//      ETag / Last-Modified), then fetch new pages from the queue, until today's page budget is
//      spent. Every page is checked against robots.txt first.
// What is left in the queues waits for the next day. Nothing here follows a link on a page.

import { HttpError, type HttpResponse } from "../http.ts";
import { guessProtein } from "../protein.ts";
import { FailureStreak, ProviderError } from "../providers/shared.ts";
import type { FetchedRecord, RecipeSource } from "../types.ts";
import { canonicalUrl, hostMatches, normalizeHost, recipeIdFor } from "../url.ts";
import type { PageState, SiteContext, SourceSiteState } from "./context.ts";
import { looksLikeRecipe, parseSitemap, sitemapText } from "./discovery.ts";
import { siteHopRule } from "./hops.ts";
import { parseRecipePage } from "./recipe-page.ts";
import type { RobotsRules } from "./robots.ts";

export const REVALIDATE_DAYS = 7;
// Pages that were not recipes, are gone or kept failing are forgotten after this long, and may be tried again.
const FORGET_DAYS = 30;
const MAX_PAGE_QUEUE = 5000;
const MAX_SITEMAP_QUEUE = 200;
const GIVE_UP_AFTER_FAILURES = 3;
const DAY_MS = 86_400_000;

export interface SiteRun {
  records: FetchedRecord[]; // everything this source should have after the run
  backlog: boolean; // more is waiting for tomorrow's budget
  skipped: number; // pages that could not be read this run
  stopped: string | null; // why the run ended early, in plain words
}

// ---------------------------------------------------------------------------------------------
// One page
// ---------------------------------------------------------------------------------------------

export type PageResult =
  | { kind: "recipe"; record: FetchedRecord; etag?: string; lastModified?: string }
  | { kind: "not-modified" }
  | { kind: "not-recipe"; why: string }
  | { kind: "gone" }
  | { kind: "disallowed" }
  | { kind: "failed"; message: string; transient: boolean };

// Fetches one page and reads the recipe on it. The caller has already spent the budget. `known`
// carries the validators from the last visit, which turn this into a conditional request.
export async function readPage(
  ctx: SiteContext,
  source: RecipeSource,
  rules: RobotsRules,
  address: string,
  known: Pick<PageState, "etag" | "lastModified"> | null,
  nowIso: string,
): Promise<PageResult> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { kind: "not-recipe", why: "not a web address" };
  }
  if (!isOurSite(url, source) || !rules.allows(url.pathname + url.search)) return { kind: "disallowed" };

  const headers: Record<string, string> = { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" };
  if (known?.etag) headers["if-none-match"] = known.etag;
  if (known?.lastModified) headers["if-modified-since"] = known.lastModified;

  let response: HttpResponse;
  try {
    response = await ctx.get(url.toString(), headers, { allowRedirect: siteHopRule(source, rules) });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    // A redirect we would not follow: the destination was never requested.
    if (error.kind === "redirect-refused") return { kind: "failed", message: error.message, transient: false };
    // Our own address rule, or a page that is too big: this page is not usable, nothing to retry.
    if (error.kind === "blocked-address" || error.kind === "bad-address" || error.kind === "too-large" || error.kind === "too-many-redirects") {
      return { kind: "failed", message: error.message, transient: false };
    }
    return { kind: "failed", message: error.message, transient: true };
  }

  if (response.status === 304) return { kind: "not-modified" };
  if (response.status === 404 || response.status === 410) return { kind: "gone" };
  if (response.status < 200 || response.status >= 300) {
    return { kind: "failed", message: `${url.host} answered HTTP ${response.status} for ${url.pathname}.`, transient: response.status >= 500 || response.status === 429 || response.status === 403 };
  }

  // A redirect may have taken us somewhere else: it must still be this site, and still allowed.
  const final = new URL(response.finalUrl);
  if (!isOurSite(final, source)) return { kind: "not-recipe", why: "it redirected to a different site" };
  if (final.pathname + final.search !== url.pathname + url.search && !rules.allows(final.pathname + final.search)) return { kind: "disallowed" };
  if (!/html|xml/i.test(response.headers.get("content-type") ?? "html")) return { kind: "not-recipe", why: "not a web page" };

  const page = parseRecipePage(response.text, response.finalUrl);
  if (!page.recipe) return { kind: "not-recipe", why: "no recipe data on the page" };

  const where = new URL(page.canonical ?? response.finalUrl);
  const recipe = page.recipe;
  const record: FetchedRecord = {
    kind: "fetched",
    id: recipeIdFor(where),
    name: recipe.name,
    url: canonicalUrl(where),
    sourceId: source.id,
    ingredients: recipe.ingredients,
    instructions: recipe.instructions,
    categories: recipe.categories,
    protein: guessProtein(recipe.name, recipe.ingredients, recipe.categories),
    ingredientProvenance: "publisher",
    fetchedAt: nowIso,
    ...(recipe.totalMinutes !== undefined ? { totalMinutes: recipe.totalMinutes } : {}),
  };
  const etag = response.headers.get("etag") ?? undefined;
  const lastModified = response.headers.get("last-modified") ?? undefined;
  return { kind: "recipe", record, ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) };
}

function isOurSite(url: URL, source: RecipeSource): boolean {
  return (url.protocol === "http:" || url.protocol === "https:") && hostMatches(normalizeHost(url.hostname), source.host);
}

// ---------------------------------------------------------------------------------------------
// A whole run
// ---------------------------------------------------------------------------------------------

export async function refreshSite(ctx: SiteContext, source: RecipeSource, previous: FetchedRecord[], nowIso: string): Promise<SiteRun> {
  const state = ctx.source(source.id);
  const keep = (stopped: string): SiteRun => ({ records: previous, backlog: hasWaiting(state), skipped: 0, stopped });

  // 1. robots.txt
  const { info, rules } = await ctx.robots(source);
  if (info.status === "unavailable") return keep(`I could not read robots.txt for ${source.host} (${info.error}), so I paused fetching from ${source.name} and will try again later.`);
  if (!rules.allows("/")) return keep(`robots.txt for ${source.host} now disallows fetching, so I stopped fetching from ${source.name}.`);
  if (rules.aiInputBlocked) return keep(`robots.txt for ${source.host} now says ai-input=no, so I stopped fetching from ${source.name}.`);

  const records = new Map(previous.map((record) => [record.id, record]));
  const streak = new FailureStreak(GIVE_UP_AFTER_FAILURES);
  let skipped = 0;
  let stopped: string | null = null;
  const nowMs = Date.parse(nowIso);

  forgetOldOutcomes(state, nowMs);

  try {
    // 2. sitemaps
    seedSitemapQueue(ctx, source, state, rules, nowIso);
    while (state.sitemapQueue.length > 0 && ctx.take(source.id, "sitemaps")) {
      const address = state.sitemapQueue.shift()!;
      if (!rules.sitemaps.includes(address)) {
        const url = safeUrl(address);
        if (!url || !rules.allows(url.pathname + url.search)) continue;
      }
      try {
        readSitemap(source, state, await ctx.get(address, { accept: "application/xml, text/xml, */*;q=0.5" }, { allowRedirect: siteHopRule(source, rules) }), address);
        streak.ok();
      } catch (error) {
        skipped++;
        streak.failed(error instanceof HttpError || error instanceof ProviderError ? error : new ProviderError(`I could not read the sitemap ${address}.`));
      }
    }

    // 3. pages: re-checks first (up to half of the budget), then new pages
    const stale = Object.entries(state.pages)
      .filter(([, page]) => page.outcome === "recipe" && nowMs - Date.parse(page.checkedAt) >= REVALIDATE_DAYS * DAY_MS)
      .sort(([, a], [, b]) => a.checkedAt.localeCompare(b.checkedAt))
      .map(([address]) => address);
    const recheckLimit = state.pageQueue.length === 0 ? Infinity : Math.ceil(ctx.left(source.id, "pages") / 2);
    let rechecked = 0;
    for (const address of stale) {
      if (rechecked >= recheckLimit) break;
      if (!robotsAllows(rules, source, address)) {
        applyResult({ kind: "disallowed" }, address, state, records, nowIso, true); // robots.txt changed its mind: drop it
        continue;
      }
      if (!ctx.take(source.id, "pages")) break;
      rechecked++;
      const page = state.pages[address]!;
      const have = page.recipeId ? records.get(page.recipeId) : undefined;
      const result = await readPage(ctx, source, rules, address, have ? page : null, nowIso);
      const outcome = applyResult(result, address, state, records, nowIso, have !== undefined);
      if (outcome === "failed") {
        skipped++;
        streak.failed(new ProviderError((result as { message: string }).message));
      } else streak.ok();
    }

    while (state.pageQueue.length > 0) {
      const address = state.pageQueue[0]!;
      const known = state.pages[address];
      if (known && !(known.outcome === "failed" && (known.failures ?? 0) < GIVE_UP_AFTER_FAILURES)) {
        state.pageQueue.shift(); // already looked at
        continue;
      }
      if (!robotsAllows(rules, source, address)) {
        state.pageQueue.shift(); // no request, no budget spent
        applyResult({ kind: "disallowed" }, address, state, records, nowIso, false);
        continue;
      }
      if (!ctx.take(source.id, "pages")) break;
      state.pageQueue.shift();
      const result = await readPage(ctx, source, rules, address, null, nowIso);
      const outcome = applyResult(result, address, state, records, nowIso, false);
      if (outcome === "failed") {
        skipped++;
        const failures = state.pages[address]?.failures ?? 1;
        if (failures < GIVE_UP_AFTER_FAILURES && result.kind === "failed" && result.transient) state.pageQueue.push(address); // try again on a later run
        streak.failed(new ProviderError((result as { message: string }).message));
      } else streak.ok();
    }
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    stopped = error.message;
  }

  return { records: [...records.values()], backlog: hasWaiting(state), skipped, stopped };
}

// Asked before a request is made, so a page robots.txt closes costs no budget.
function robotsAllows(rules: RobotsRules, source: RecipeSource, address: string): boolean {
  const url = safeUrl(address);
  return url !== null && isOurSite(url, source) && rules.allows(url.pathname + url.search);
}

function hasWaiting(state: SourceSiteState): boolean {
  return state.sitemapQueue.length > 0 || state.pageQueue.length > 0;
}

// Writes what happened to a page into the state and the record set. Returns the outcome kind.
function applyResult(result: PageResult, address: string, state: SourceSiteState, records: Map<string, FetchedRecord>, nowIso: string, hadRecord: boolean): PageResult["kind"] {
  const before = state.pages[address];
  switch (result.kind) {
    case "recipe": {
      records.set(result.record.id, result.record);
      state.pages[address] = { outcome: "recipe", checkedAt: nowIso, recipeId: result.record.id, ...(result.etag ? { etag: result.etag } : {}), ...(result.lastModified ? { lastModified: result.lastModified } : {}) };
      break;
    }
    case "not-modified":
      if (before) state.pages[address] = { ...before, checkedAt: nowIso };
      break;
    case "gone":
    case "disallowed":
    case "not-recipe": {
      // A page we had a recipe from is no longer one we may keep.
      if (before?.recipeId && hadRecord) records.delete(before.recipeId);
      state.pages[address] = { outcome: result.kind === "not-recipe" ? "not-recipe" : "gone", checkedAt: nowIso };
      break;
    }
    case "failed": {
      const failures = (before?.failures ?? 0) + 1;
      // A page we already have keeps its recipe; it is just tried again later.
      state.pages[address] = before?.outcome === "recipe" ? { ...before, failures, checkedAt: nowIso } : { outcome: "failed", checkedAt: nowIso, failures: result.transient ? failures : GIVE_UP_AFTER_FAILURES };
      break;
    }
  }
  return result.kind;
}

// Pages not worth asking about for a month are forgotten so a changed site gets another look.
function forgetOldOutcomes(state: SourceSiteState, nowMs: number): void {
  for (const [address, page] of Object.entries(state.pages)) {
    if (page.outcome !== "recipe" && nowMs - Date.parse(page.checkedAt) >= FORGET_DAYS * DAY_MS) delete state.pages[address];
  }
}

// Starts the sitemap queue from the top when there is nothing queued and it is time to look for new pages again.
function seedSitemapQueue(ctx: SiteContext, source: RecipeSource, state: SourceSiteState, rules: RobotsRules, nowIso: string): void {
  if (state.sitemapQueue.length > 0 || state.pageQueue.length > 0) return;
  const last = state.discoveredAt ? Date.parse(state.discoveredAt) : NaN;
  const due = Number.isNaN(last) || Date.parse(nowIso) - last >= ctx.recipes.refreshHours * 3_600_000;
  if (!due) return;
  const origin = state.robots?.origin ?? `https://${source.host}`;
  const declared = rules.sitemaps.map((address) => safeUrl(address)).filter((url): url is URL => url !== null && isOurSite(url, source)).map((url) => url.toString());
  state.sitemapQueue = declared.length > 0 ? [...new Set(declared)] : [`${origin}/sitemap.xml`];
  state.discoveredAt = nowIso;
}

// Adds what one sitemap file holds to the queues.
function readSitemap(source: RecipeSource, state: SourceSiteState, response: HttpResponse, address: string): void {
  if (response.status < 200 || response.status >= 300) throw new ProviderError(`The sitemap ${address} answered HTTP ${response.status}.`);
  let xml: string;
  try {
    xml = sitemapText(response.bytes);
  } catch {
    throw new ProviderError(`The sitemap ${address} could not be unpacked.`);
  }
  const parsed = parseSitemap(xml);
  const queued = new Set([...state.sitemapQueue, ...state.pageQueue]);
  for (const location of parsed.locations) {
    const url = safeUrl(location);
    if (!url || !isOurSite(url, source)) continue; // a sitemap may only name pages on its own site
    if (parsed.kind === "index") {
      if (state.sitemapQueue.length < MAX_SITEMAP_QUEUE && !queued.has(url.toString())) state.sitemapQueue.push(url.toString());
      continue;
    }
    if (state.pageQueue.length >= MAX_PAGE_QUEUE || !looksLikeRecipe(url.toString(), source.host)) continue;
    const text = url.toString();
    const seen = state.pages[text];
    if (queued.has(text) || (seen && seen.outcome !== "failed")) continue;
    state.pageQueue.push(text);
    queued.add(text);
  }
}

function safeUrl(address: string): URL | null {
  try {
    const url = new URL(address);
    return url.username === "" && url.password === "" ? url : null;
  } catch {
    return null;
  }
}
