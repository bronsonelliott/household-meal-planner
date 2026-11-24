// Keeping the catalog's API-sourced recipes (TheMealDB, Mealie, Tandoor) up to date.
//
// This runs in the background, never inside a planning call: the bridge asks `tick()` once at
// start and then every minute, and tick() only does work for a source that is due. Planning
// reads a snapshot of the catalog file, so a refresh in progress changes nothing it sees; the
// new recipes appear when the refresh publishes.
//
// One source's refresh, in order:
//   1. ask the provider for the COMPLETE list of recipes the source should have
//   2. check every record (and drop the ones that are not usable)
//   3. build a candidate catalog: the current file with this source's records swapped
//   4. write it in one atomic step (a temp file renamed into place)
// If step 1 fails, nothing is written: the source keeps the recipes it had, and the failure is
// recorded so "recipes status" can say so. Only this source's records are ever replaced, so
// recipes saved from chat, and other sources, are never touched.
//
// The record of what happened lives in data/recipe-refresh.json, apart from the catalog, so a
// failed refresh can be written down without touching the recipes.

import { existsSync, readFileSync } from "node:fs";
import type { RecipesConfig } from "../config.ts";
import { blankOut, cleanCredential } from "../secrets.ts";
import { writeFileAtomically } from "../data/files.ts";
import { CatalogError, loadCatalog, saveCatalog } from "./catalog.ts";
import { HttpError } from "./http.ts";
import { runProvider, type ProviderDeps } from "./providers/index.ts";
import { ProviderError } from "./providers/shared.ts";
import { loadSources, SourcesError } from "./sources.ts";
import { SiteContext, siteStatePathFor } from "./site/context.ts";
import { refreshSite } from "./site/fetcher.ts";
import type { Catalog, CatalogRecord, FetchedRecord, RecipeSource } from "./types.ts";

export const REFRESH_FILE_VERSION = 1;

// After a failed refresh, wait this long before trying again (so a server that is down is not
// asked every minute).
export const RETRY_AFTER_FAILURE_HOURS = 6;
// When a refresh could not finish everything (TheMealDB's lookup budget), carry on after this.
export const BACKLOG_HOURS = 24;

export interface SourceStatus {
  lastAttemptAt: string; // ISO time
  lastSuccessAt: string | null;
  count: number; // recipes this source has after the last successful refresh
  lastError: string | null; // plain words; null when the last attempt worked
  backlog: boolean; // more to fetch than one refresh allows
  skipped: number; // recipes that could not be read in the last attempt
}

export interface RefreshFile {
  version: typeof REFRESH_FILE_VERSION;
  sources: Record<string, SourceStatus>;
}

export function loadRefreshStatus(path: string): RefreshFile {
  const empty: RefreshFile = { version: REFRESH_FILE_VERSION, sources: {} };
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RefreshFile>;
    if (parsed.version !== REFRESH_FILE_VERSION || typeof parsed.sources !== "object" || parsed.sources === null) return empty;
    return { version: REFRESH_FILE_VERSION, sources: parsed.sources };
  } catch {
    return empty; // only a note about past refreshes: starting it again is harmless
  }
}

function saveRefreshStatus(path: string, file: RefreshFile): void {
  writeFileAtomically(path, JSON.stringify(file, null, 2) + "\n");
}

// Is this source's refresh due? Normally `refreshHours` after the last attempt; sooner for a
// backlog, and a failure waits a while before the next try.
export function isDue(status: SourceStatus | undefined, nowMs: number, refreshHours: number): boolean {
  if (!status) return true;
  const last = Date.parse(status.lastAttemptAt);
  if (Number.isNaN(last)) return true;
  const hours = status.lastError !== null ? RETRY_AFTER_FAILURE_HOURS : status.backlog ? Math.min(BACKLOG_HOURS, refreshHours) : refreshHours;
  return nowMs - last >= hours * 3_600_000;
}

// Only sources the program may ask: API mode, a known provider, not blocked.
export function isProviderSource(source: RecipeSource): boolean {
  return source.mode === "api" && source.provider !== undefined && source.policy !== "blocked";
}

// Sources an admin switched on for page fetching (never a blocked one).
export function isFetchSource(source: RecipeSource): boolean {
  return source.mode === "fetch" && source.policy !== "blocked";
}

// Everything the background refresh looks after.
export function isRefreshedSource(source: RecipeSource): boolean {
  return isProviderSource(source) || isFetchSource(source);
}

// ---------------------------------------------------------------------------------------------
// Checking records before they are published
// ---------------------------------------------------------------------------------------------

// Keeps the usable records; says how many were dropped. A record is usable when it has the
// fields planning relies on, a web link, and an id nobody else in the catalog already has.
export function validateRecords(records: FetchedRecord[], sourceId: string, idsTakenElsewhere: Set<string>): { valid: FetchedRecord[]; dropped: number } {
  const valid: FetchedRecord[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (!isUsable(record, sourceId) || seen.has(record.id) || idsTakenElsewhere.has(record.id)) continue;
    seen.add(record.id);
    valid.push(record);
  }
  return { valid, dropped: records.length - valid.length };
}

function isUsable(record: FetchedRecord, sourceId: string): boolean {
  const text = (value: unknown) => typeof value === "string" && value.trim() !== "";
  const lines = (value: unknown) => Array.isArray(value) && value.every((line) => typeof line === "string");
  if (record.kind !== "fetched" || record.sourceId !== sourceId || record.ingredientProvenance !== "publisher") return false;
  if (!text(record.id) || !text(record.name) || !text(record.protein)) return false;
  if (!lines(record.ingredients) || record.ingredients.length === 0 || !record.ingredients.every(text)) return false;
  if (!lines(record.instructions) || !lines(record.categories)) return false;
  try {
    const url = new URL(record.url);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// The refresher
// ---------------------------------------------------------------------------------------------

export interface RefresherOptions {
  sourcesPath: string;
  catalogPath: string;
  statusPath: string;
  recipes: RecipesConfig;
  env: Record<string, string | undefined>;
  now: () => number;
  log: (line: string) => void;
  // The shared web client and memory for page fetching. The bridge passes the one it also gives
  // the chat commands, so both draw on the same daily budget; without it one is made here.
  site?: SiteContext;
  deps?: ProviderDeps; // tests only
}

export interface RefreshResult {
  sourceId: string;
  ok: boolean;
  count: number;
  error: string | null;
}

export class RecipeRefresher {
  private busy = false;
  private readonly site: SiteContext;

  constructor(private readonly options: RefresherOptions) {
    this.site = options.site ?? new SiteContext({ statePath: siteStatePathFor(options.catalogPath), recipes: options.recipes, deps: options.deps, now: options.now, log: options.log });
  }

  // Refreshes every source that is due. Safe to call every minute: it does nothing when nothing
  // is due, and a second call while one is running returns at once.
  async tick(): Promise<RefreshResult[]> {
    if (this.busy) return [];
    this.busy = true;
    try {
      const results: RefreshResult[] = [];
      for (const source of this.dueSources()) results.push(await this.refreshSource(source));
      return results;
    } catch (error) {
      this.options.log(`recipe refresh stopped: ${this.safe(error)}`);
      return [];
    } finally {
      this.busy = false;
    }
  }

  private dueSources(): RecipeSource[] {
    const { sourcesPath, statusPath, recipes, now } = this.options;
    let sources: RecipeSource[];
    try {
      sources = loadSources(sourcesPath, new Date(now()).toISOString()).sources;
    } catch (error) {
      if (error instanceof SourcesError) {
        this.options.log(`recipe refresh skipped: ${error.message}`);
        return [];
      }
      throw error;
    }
    const status = loadRefreshStatus(statusPath);
    return sources.filter((source) => isRefreshedSource(source) && isDue(status.sources[source.id], now(), recipes.refreshHours));
  }

  // One source, start to finish. Never throws: the outcome is written to the status file.
  async refreshSource(source: RecipeSource): Promise<RefreshResult> {
    const { catalogPath, recipes, env, now } = this.options;
    const nowIso = new Date(now()).toISOString();
    try {
      const previous = loadCatalog(catalogPath).records.filter((record): record is FetchedRecord => record.kind === "fetched" && record.sourceId === source.id);
      if (source.mode === "fetch") {
        const run = await refreshSite(this.site, source, previous, nowIso);
        return this.publish(source, run.records, previous.length, run.backlog, run.skipped, nowIso, run.stopped);
      }
      const run = await runProvider(source, previous, recipes, env, nowIso, this.options.deps);
      return this.publish(source, run.records, previous.length, run.backlog, run.skipped, nowIso, null);
    } catch (error) {
      return this.recordFailure(source, error, nowIso);
    }
  }

  // Steps 2 to 4. There is no waiting between reading the catalog and writing it, so a chat
  // command in the same process cannot slip in between.
  // `stopped` is set when a fetch run ended early (robots.txt said no, or the site kept failing):
  // what was gathered is still published, and the reason is recorded as the last problem.
  private publish(source: RecipeSource, records: FetchedRecord[], hadBefore: number, backlog: boolean, skipped: number, nowIso: string, stopped: string | null): RefreshResult {
    const { sourcesPath, catalogPath, statusPath } = this.options;

    // The source may have been removed while the provider was working. Then there is nothing to publish.
    if (!loadSources(sourcesPath, nowIso).sources.some((candidate) => candidate.id === source.id)) {
      this.options.log(`recipe refresh: ${source.name} was removed while it was refreshing; nothing published`);
      return { sourceId: source.id, ok: false, count: 0, error: "the source was removed" };
    }

    const current = loadCatalog(catalogPath);
    // An id is taken when another source has it, or when a saved link (bookmark) has it, even one
    // from this same source: a bookmark stays exactly as it was and never becomes a fetched
    // recipe. The fetched copy is dropped and counted with the ones that could not be used.
    const takenElsewhere = new Set(current.records.filter((record) => record.sourceId !== source.id || record.kind === "bookmark").map((record) => record.id));
    const { valid, dropped } = validateRecords(records, source.id, takenElsewhere);
    if (valid.length === 0 && hadBefore > 0 && (skipped > 0 || dropped > 0)) {
      throw new ProviderError(`None of the ${records.length + skipped} recipes it sent could be used, so I kept the ${hadBefore} I already had.`);
    }

    // This source's fetched records are swapped for the new set. Links someone saved by hand
    // always stay.
    const stays = (record: CatalogRecord) => record.sourceId !== source.id || record.kind === "bookmark";
    const candidate: Catalog = { ...current, records: [...current.records.filter(stays), ...valid] };
    saveCatalog(catalogPath, candidate);
    this.site.save(); // the queues and budget, after the recipes they produced are safely on file

    const file = loadRefreshStatus(statusPath);
    const earlier = file.sources[source.id];
    file.sources[source.id] = { lastAttemptAt: nowIso, lastSuccessAt: stopped === null ? nowIso : earlier?.lastSuccessAt ?? null, count: valid.length, lastError: stopped, backlog, skipped: skipped + dropped };
    saveRefreshStatus(statusPath, file);
    this.options.log(`recipe refresh: ${source.name} now has ${valid.length} recipes${skipped + dropped > 0 ? ` (${skipped + dropped} could not be used)` : ""}${backlog ? "; more to fetch next time" : ""}`);
    return { sourceId: source.id, ok: stopped === null, count: valid.length, error: stopped };
  }

  private recordFailure(source: RecipeSource, error: unknown, nowIso: string): RefreshResult {
    const message = this.safe(error);
    const file = loadRefreshStatus(this.options.statusPath);
    const earlier = file.sources[source.id];
    try {
      file.sources[source.id] = {
        lastAttemptAt: nowIso,
        lastSuccessAt: earlier?.lastSuccessAt ?? null,
        count: earlier?.count ?? 0, // the recipes it had are still there
        lastError: message,
        backlog: earlier?.backlog ?? false,
        skipped: earlier?.skipped ?? 0,
      };
      saveRefreshStatus(this.options.statusPath, file);
    } catch (writeError) {
      this.options.log(`recipe refresh: could not write the status file: ${this.safe(writeError)}`);
    }
    this.options.log(`recipe refresh: ${source.name} failed: ${message}`);
    return { sourceId: source.id, ok: false, count: earlier?.count ?? 0, error: message };
  }

  // A message in plain words that cannot contain a token.
  private safe(error: unknown): string {
    const known = error instanceof ProviderError || error instanceof HttpError || error instanceof CatalogError || error instanceof SourcesError;
    let message = known ? (error as Error).message : `Something unexpected went wrong (${error instanceof Error ? error.message : String(error)}).`;
    const { recipes, env } = this.options;
    const secrets = [recipes.mealie, recipes.tandoor].map((own) => (own ? cleanCredential(env[own.tokenEnv]) : ""));
    secrets.push(cleanCredential(env[recipes.themealdb.apiKeyEnv]));
    return blankOut(message, secrets).slice(0, 300);
  }
}
