// The recipe catalog: every recipe the household has saved (or had fetched
// from an API or a site that was switched on for it), kept in data/recipe-catalog.json.
//
// Planning never reads the file while it works. Each job takes one snapshot (loadCatalog) and
// uses that, so a recipe saved in the middle of a job shows up in the next one.

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomically } from "../data/files.ts";
import { UNKNOWN_PROTEIN, type BookmarkRecord, type Catalog, type CatalogRecord, type RecipeSource } from "./types.ts";
import { canonicalUrl, checkWebUrl, hostMatches, hostOf, nameFromUrl, recipeIdFor } from "./url.ts";
import { unlistedSourceId } from "./sources.ts";

export const CATALOG_VERSION = 1;

// How many recipes a week's planning call sees.
export const SHORTLIST_SIZE = 150;

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

// ---------------------------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------------------------

export function emptyCatalog(): Catalog {
  return { version: CATALOG_VERSION, excludedSourceIds: [], records: [] };
}

export function loadCatalog(path: string): Catalog {
  if (!existsSync(path)) return emptyCatalog();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CatalogError(`The recipe catalog (${path}) isn't valid JSON, so I left it alone.`);
  }
  const file = parsed as Partial<Catalog>;
  if (typeof parsed !== "object" || parsed === null || file.version !== CATALOG_VERSION || !Array.isArray(file.records)) {
    throw new CatalogError(`The recipe catalog (${path}) isn't in a form this version understands (expected version ${CATALOG_VERSION}), so I left it alone.`);
  }
  return {
    version: CATALOG_VERSION,
    excludedSourceIds: Array.isArray(file.excludedSourceIds) ? file.excludedSourceIds : [],
    records: file.records,
  };
}

export function saveCatalog(path: string, catalog: Catalog): void {
  writeFileAtomically(path, JSON.stringify(catalog, null, 2) + "\n");
}

// ---------------------------------------------------------------------------------------------
// Changes (pure: a catalog in, a catalog out)
// ---------------------------------------------------------------------------------------------

export type BookmarkResult =
  | { ok: true; catalog: Catalog; record: CatalogRecord; created: boolean; configuredSource: RecipeSource | null }
  | { ok: false; reason: string };

// Saves a link. The name is the words given, or the end of the address made readable. The same
// page saved again (with or without "www.", a tracking tail or a trailing slash) is the same
// record and is not added twice. A link from a site that isn't a configured source is still
// saved; `configuredSource` is null so the reply can say so. Nothing is fetched.
export function withBookmark(catalog: Catalog, sources: RecipeSource[], rawUrl: string, name: string | null): BookmarkResult {
  const checked = checkWebUrl(rawUrl);
  if (!checked.ok) return { ok: false, reason: checked.reason };

  const id = recipeIdFor(checked.url);
  const existing = catalog.records.find((record) => record.id === id);
  const host = hostOf(checked.url);
  const configuredSource = sources.find((source) => hostMatches(host, source.host)) ?? null;
  if (existing) return { ok: true, catalog, record: existing, created: false, configuredSource };

  const record: BookmarkRecord = {
    kind: "bookmark",
    id,
    name: name !== null && name.trim() !== "" ? name.trim() : nameFromUrl(checked.url),
    url: canonicalUrl(checked.url),
    // A site that is not a source still gets an id of its own, so its links can be counted.
    sourceId: configuredSource ? configuredSource.id : unlistedSourceId(host),
    ingredientProvenance: "generated",
  };
  return { ok: true, catalog: { ...catalog, records: [...catalog.records, record] }, record, created: true, configuredSource };
}

// An admin removed a source: its records stay on file but leave planning.
export function withSourceExcluded(catalog: Catalog, sourceId: string): Catalog {
  if (catalog.excludedSourceIds.includes(sourceId)) return catalog;
  return { ...catalog, excludedSourceIds: [...catalog.excludedSourceIds, sourceId] };
}

// A source was added back: its records return to planning.
export function withSourceIncluded(catalog: Catalog, sourceId: string): Catalog {
  if (!catalog.excludedSourceIds.includes(sourceId)) return catalog;
  return { ...catalog, excludedSourceIds: catalog.excludedSourceIds.filter((id) => id !== sourceId) };
}

// ---------------------------------------------------------------------------------------------
// Looking things up
// ---------------------------------------------------------------------------------------------

// Records planning may use: everything except records of a removed source.
export function usableRecords(catalog: Catalog): CatalogRecord[] {
  return catalog.records.filter((record) => !catalog.excludedSourceIds.includes(record.sourceId));
}

export function findUsableRecord(catalog: Catalog, id: string): CatalogRecord | undefined {
  const wanted = id.trim();
  return usableRecords(catalog).find((record) => record.id === wanted);
}

export function recordsBySource(catalog: Catalog, sourceId: string): CatalogRecord[] {
  return catalog.records.filter((record) => record.sourceId === sourceId);
}

// A record's protein: a fetched recipe knows it; a bookmark does not.
export function proteinOf(record: CatalogRecord): string {
  return record.kind === "fetched" ? record.protein : UNKNOWN_PROTEIN;
}

// ---------------------------------------------------------------------------------------------
// The weekly shortlist
// ---------------------------------------------------------------------------------------------

// A planning call cannot see thousands of recipes, so it sees a shortlist: dinner recipes mixed
// by protein, up to `size`. The pick is seeded by the week being planned, so the Friday draft
// and the replies about that week see the same list, and the next week brings a different one.

// Recipe categories and names that are never dinner, lowercase. Bookmarks have no categories,
// so the name test is what catches the plainest ones.
const NOT_DINNER_CATEGORIES = new Set([
  "desserts", "dessert", "cookies", "cake", "brownies", "bars", "drinks", "cocktails", "breakfast", "brunch", "snack",
  "appetizers", "starter", "dip", "spreads", "bread", "side", "sides", "sauces", "marinade", "gravy",
]);
const NOT_DINNER_NAME =
  /\b(cookies?|brownies?|cupcakes?|cheesecakes?|muffins?|frosting|fudge|smoothies?|cocktails?|margaritas?|sangria|granola|pancakes?|waffles?|scones?|dips?|breakfast)\b/i;

export function isDinnerRecord(record: CatalogRecord): boolean {
  if (record.kind === "fetched" && record.categories.some((tag) => NOT_DINNER_CATEGORIES.has(tag.toLowerCase()))) return false;
  return !NOT_DINNER_NAME.test(record.name);
}

export function weeklyShortlist(catalog: Catalog, weekOf: string, size: number = SHORTLIST_SIZE): CatalogRecord[] {
  const dinners = usableRecords(catalog).filter(isDinnerRecord);

  // Grouped by protein, each group in this week's shuffled order.
  const groups = new Map<string, CatalogRecord[]>();
  for (const record of dinners) {
    const protein = proteinOf(record);
    const group = groups.get(protein) ?? [];
    group.push(record);
    groups.set(protein, group);
  }
  // Groups in a fixed order too, so the pick never depends on the order records were saved in.
  const queues = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group);
  for (const group of queues) group.sort((a, b) => weekRank(weekOf, a.id) - weekRank(weekOf, b.id) || a.id.localeCompare(b.id));

  // One from each protein in turn until the list is full or every group is used up.
  const picked: CatalogRecord[] = [];
  for (let round = 0; picked.length < size && queues.some((group) => round < group.length); round++) {
    for (const group of queues) {
      if (picked.length >= size) break;
      if (round < group.length) picked.push(group[round]!);
    }
  }
  return picked;
}

// A stable pseudo-random rank for a recipe in a given week (32-bit FNV-1a hash).
function weekRank(weekOf: string, id: string): number {
  let hash = 0x811c9dc5;
  for (const char of `${weekOf}|${id}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

// What a planning call sees of each record. Full text is only used for locked dishes and
// link requests.
const KEY_INGREDIENT_COUNT = 5;

export interface CompactRecord {
  id: string;
  name: string;
  kind: CatalogRecord["kind"];
  protein: string;
  keyIngredients: string[];
}

export function compactRecords(records: CatalogRecord[]): CompactRecord[] {
  return records.map((record) => ({
    id: record.id,
    name: record.name,
    kind: record.kind,
    protein: proteinOf(record),
    keyIngredients: record.kind === "fetched" ? record.ingredients.slice(0, KEY_INGREDIENT_COUNT) : [],
  }));
}
