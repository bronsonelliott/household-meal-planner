// Snapshots: the copy of a recipe or link a planned night keeps, so later changes to sources or
// the catalog cannot change a week that is already planned.

import { findUsableRecord } from "./catalog.ts";
import { findSourceById } from "./sources.ts";
import type { CatalogRecord, RecipeContext, RecipeSnapshot, RecipeSource } from "./types.ts";
import { checkWebUrl, hostOf, searchLink } from "./url.ts";

// A site name for a record whose source is gone or was never configured: its host.
function sourceNameFor(record: CatalogRecord, sources: RecipeSource[]): string {
  const source = findSourceById(sources, record.sourceId);
  if (source) return source.name;
  const checked = checkWebUrl(record.url);
  return checked.ok ? hostOf(checked.url) : record.sourceId;
}

export function snapshotOfRecord(record: CatalogRecord, sources: RecipeSource[]): RecipeSnapshot {
  const base = { recipeId: record.id, url: record.url, sourceId: record.sourceId, sourceName: sourceNameFor(record, sources) };
  if (record.kind === "bookmark") return { ...base, origin: "bookmark", ingredientProvenance: "generated" };
  return {
    ...base,
    origin: "fetched",
    ingredientProvenance: "publisher",
    ingredients: [...record.ingredients],
    instructions: [...record.instructions],
  };
}

// A dish the model suggested for a link source: no recipe exists, only the site's search link.
export function snapshotOfSuggestion(source: RecipeSource, dishName: string): RecipeSnapshot {
  return {
    origin: "source",
    recipeId: null,
    url: searchLink(source, dishName),
    sourceId: source.id,
    sourceName: source.name,
    ingredientProvenance: "generated",
  };
}

// The catalog record a snapshot was taken from, if it is still there and still usable.
export function currentRecord(recipes: RecipeContext, snapshot: RecipeSnapshot): CatalogRecord | undefined {
  return snapshot.recipeId ? findUsableRecord(recipes.catalog, snapshot.recipeId) : undefined;
}
