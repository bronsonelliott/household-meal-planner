// What the site fetcher needs to remember between runs, and the one web client it shares.
//
// The memory lives in data/recipe-site-state.json, apart from the catalog and the refresh
// status. Per source it holds: the cached robots.txt, the sitemap and page queues (so a big
// site is worked through a little each day), today's request budget, and what happened to each
// page we looked at (so a page is not asked for again and again, and a changed page can be
// re-checked with ETag / Last-Modified).
//
// One SiteContext is shared by the background refresh and the chat commands, so both draw on
// the same budget and wait their turn at the same web client. Its state is read from the file
// once and then kept in memory; `save()` writes it back atomically.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RecipesConfig } from "../../config.ts";
import { writeFileAtomically } from "../../data/files.ts";
import { HttpError, PoliteClient, type GetOptions, type HttpResponse, type PoliteClientOptions } from "../http.ts";
import type { RecipeSource } from "../types.ts";
import { hostMatches, normalizeHost } from "../url.ts";
import { parseRobots, type RobotsInfo, type RobotsRules } from "./robots.ts";
import { siteHopRule } from "./hops.ts";

export const SITE_STATE_VERSION = 1;
export const ROBOTS_CACHE_HOURS = 24;
// A sitemap file can be larger than a recipe page, so this client reads more than the default.
const MAX_BYTES = 5_000_000;

export type PageOutcome = "recipe" | "not-recipe" | "gone" | "failed";

export interface PageState {
  outcome: PageOutcome;
  checkedAt: string; // ISO time
  recipeId?: string; // the catalog record this page produced
  etag?: string;
  lastModified?: string;
  failures?: number;
}

export interface SourceSiteState {
  robots?: RobotsInfo;
  sitemapQueue: string[]; // sitemap files still to read
  pageQueue: string[]; // recipe-looking pages still to fetch
  discoveredAt: string | null; // when the sitemap queue was last started from the top
  budget: { day: string; sitemaps: number; pages: number }; // requests used on this UTC day
  pages: Record<string, PageState>;
}

export interface SiteStateFile {
  version: typeof SITE_STATE_VERSION;
  sources: Record<string, SourceSiteState>;
}

// Where the state file lives: next to the catalog.
export function siteStatePathFor(catalogPath: string): string {
  return join(dirname(catalogPath), "recipe-site-state.json");
}

function emptySourceState(): SourceSiteState {
  return { sitemapQueue: [], pageQueue: [], discoveredAt: null, budget: { day: "", sitemaps: 0, pages: 0 }, pages: {} };
}

function loadStateFile(path: string): SiteStateFile {
  const empty: SiteStateFile = { version: SITE_STATE_VERSION, sources: {} };
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SiteStateFile>;
    if (parsed.version !== SITE_STATE_VERSION || typeof parsed.sources !== "object" || parsed.sources === null) return empty;
    return { version: SITE_STATE_VERSION, sources: parsed.sources };
  } catch {
    return empty; // only a memory of what was looked at: starting it again is harmless
  }
}

// Things a test replaces. Real runs pass none of these.
export type SiteDeps = Pick<PoliteClientOptions, "fetch" | "resolve" | "sleep" | "now" | "allowLoopbackForTests">;

export interface SiteContextOptions {
  statePath: string;
  recipes: RecipesConfig;
  deps?: SiteDeps;
  now?: () => number;
  log?: (line: string) => void;
}

export class SiteContext {
  readonly client: PoliteClient;
  readonly recipes: RecipesConfig;
  readonly now: () => number;
  private file: SiteStateFile | null = null;

  constructor(private readonly options: SiteContextOptions) {
    this.recipes = options.recipes;
    this.now = options.now ?? options.deps?.now ?? Date.now;
    this.client = new PoliteClient({
      userAgent: options.recipes.userAgent,
      spacingMs: options.recipes.secondsBetweenRequests * 1000,
      maxBytes: MAX_BYTES,
      ...options.deps,
    });
  }

  nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  // One page, sitemap or robots.txt, politely. Throws HttpError for our own refusals.
  get(url: string, headers: Record<string, string> = {}, options: GetOptions = {}): Promise<HttpResponse> {
    return this.client.get(url, headers, options);
  }

  // ----- the remembered state -----

  private load(): SiteStateFile {
    this.file ??= loadStateFile(this.options.statePath);
    return this.file;
  }

  source(sourceId: string): SourceSiteState {
    const file = this.load();
    const state = (file.sources[sourceId] ??= emptySourceState());
    // Fill in anything an older or hand-edited file lacks.
    state.sitemapQueue ??= [];
    state.pageQueue ??= [];
    state.pages ??= {};
    state.discoveredAt ??= null;
    state.budget ??= { day: "", sitemaps: 0, pages: 0 };
    return state;
  }

  save(): void {
    if (this.file) writeFileAtomically(this.options.statePath, JSON.stringify(this.file, null, 2) + "\n");
  }

  // ----- the daily budget -----

  // Today's counters (UTC day), reset when the day changes.
  private budgetFor(sourceId: string): SourceSiteState["budget"] {
    const state = this.source(sourceId);
    const day = this.nowIso().slice(0, 10);
    if (state.budget.day !== day) state.budget = { day, sitemaps: 0, pages: 0 };
    return state.budget;
  }

  // Spends one request from today's budget, or says no.
  take(sourceId: string, kind: "sitemaps" | "pages"): boolean {
    const budget = this.budgetFor(sourceId);
    const limit = kind === "pages" ? this.recipes.pagesPerSourcePerDay : this.recipes.sitemapsPerSourcePerDay;
    if (budget[kind] >= limit) return false;
    budget[kind]++;
    return true;
  }

  left(sourceId: string, kind: "sitemaps" | "pages"): number {
    const limit = kind === "pages" ? this.recipes.pagesPerSourcePerDay : this.recipes.sitemapsPerSourcePerDay;
    return Math.max(0, limit - this.budgetFor(sourceId)[kind]);
  }

  // ----- robots.txt -----

  // The site's robots.txt, from the cache when it is under 24 hours old. An "unavailable" answer
  // is never cached, so the next try asks again.
  async robots(source: RecipeSource, options: { fresh?: boolean } = {}): Promise<{ info: RobotsInfo; rules: RobotsRules }> {
    const state = this.source(source.id);
    const cached = state.robots;
    const ageHours = cached ? (this.now() - Date.parse(cached.fetchedAt)) / 3_600_000 : Infinity;
    if (cached && cached.status !== "unavailable" && !options.fresh && ageHours >= 0 && ageHours < ROBOTS_CACHE_HOURS) {
      return { info: cached, rules: parseRobots(cached, this.recipes.userAgent) };
    }
    const info = await this.fetchRobots(source);
    if (info.status !== "unavailable") state.robots = info;
    const rules = parseRobots(info, this.recipes.userAgent);
    if (rules.contentSignal) this.options.log?.(`recipe fetch: ${source.host} robots.txt has Content-Signal "${rules.contentSignal}"${rules.aiInputBlocked ? "; ai-input=no, so I will not fetch" : ""}`);
    return { info, rules };
  }

  private async fetchRobots(source: RecipeSource): Promise<RobotsInfo> {
    const fetchedAt = this.nowIso();
    const origin = `https://${source.host}`;
    const unavailable = (error: string, httpStatus?: number): RobotsInfo => ({ status: "unavailable", text: "", fetchedAt, origin, error, ...(httpStatus ? { httpStatus } : {}) });
    let response: HttpResponse;
    try {
      response = await this.get(`${origin}/robots.txt`, { accept: "text/plain, */*;q=0.5" }, { allowRedirect: siteHopRule(source, null) });
    } catch (error) {
      if (error instanceof HttpError) return unavailable(error.message);
      throw error;
    }
    const final = new URL(response.finalUrl);
    if (!hostMatches(normalizeHost(final.hostname), source.host)) return unavailable("its robots.txt sent me to a different site");
    const found = { fetchedAt, origin: final.origin, httpStatus: response.status };
    if (response.status >= 200 && response.status < 300) return { status: "ok", text: response.text, ...found };
    if (response.status === 429) return unavailable("the site said to slow down (HTTP 429)", response.status);
    if (response.status >= 400 && response.status < 500) return { status: "none", text: "", ...found }; // no robots.txt: no restrictions from it
    return unavailable(`robots.txt answered HTTP ${response.status}`, response.status);
  }
}
