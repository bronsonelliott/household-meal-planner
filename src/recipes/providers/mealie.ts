// Mealie: a self-hosted recipe manager (https://mealie.io). The household's own recipes.
//
// A refresh pages through GET /api/recipes?page=N&perPage=50 (names and slugs), then reads each
// recipe with GET /api/recipes/{slug}. The login is an API token sent as "Authorization: Bearer".
//
// Written against Mealie v2.x (2026-11). NOT tested against a live server: the field names in
// mapMealieRecipe come from Mealie's published API. If a Mealie update renames something, that
// one function is where to look.
//
// The link saved for a recipe is <url>/g/<group>/r/<slug> when the recipe says which group it
// is in, otherwise <url>/recipe/<slug> (older Mealie versions). Both are only links to show
// people; the bot never opens them.

import { guessProtein } from "../protein.ts";
import { canonicalUrl, recipeIdFor } from "../url.ts";
import type { FetchedRecord } from "../types.ts";
import { asArray, asObject, FailureStreak, getJson, text, uniqueWords, type ProviderInput, type ProviderRun } from "./shared.ts";

export interface MealieSettings {
  baseUrl: string; // no trailing slash
  token: string;
  maxRecipes: number;
}

const PER_PAGE = 50;

export async function refreshMealie(input: ProviderInput, settings: MealieSettings): Promise<ProviderRun> {
  const { client, previous, nowIso, source } = input;
  const headers = { authorization: `Bearer ${settings.token}` };
  const authHelp = "Check the token in the environment variable named in recipes.mealie.tokenEnv.";
  const get = (path: string) => getJson(client, settings.baseUrl + path, headers, authHelp);

  // 1. The list of slugs.
  const slugs: string[] = [];
  const maxPages = Math.ceil(settings.maxRecipes / PER_PAGE) + 1;
  for (let page = 1; page <= maxPages && slugs.length < settings.maxRecipes; page++) {
    const answer = asObject(await get(`/api/recipes?page=${page}&perPage=${PER_PAGE}`));
    const items = asArray(answer.items);
    for (const item of items) {
      const slug = text(asObject(item).slug);
      if (slug !== "" && !slugs.includes(slug)) slugs.push(slug);
    }
    const totalPages = Number(answer.total_pages ?? answer.totalPages ?? 0);
    if (items.length === 0 || (totalPages > 0 && page >= totalPages)) break;
  }

  // 2. Each recipe. One that cannot be read keeps its previous copy.
  const before = new Map(previous.filter((record) => record.providerId !== undefined).map((record) => [record.providerId!, record]));
  const records: FetchedRecord[] = [];
  let skipped = 0;
  const streak = new FailureStreak();
  for (const slug of slugs.slice(0, settings.maxRecipes)) {
    try {
      const detail = asObject(await get(`/api/recipes/${encodeURIComponent(slug)}`));
      const record = mapMealieRecipe(detail, slug, settings.baseUrl, source.id, nowIso);
      if (record) records.push(record);
      else skipped++;
      streak.ok();
    } catch (error) {
      streak.failed(error);
      const kept = before.get(slug);
      if (kept) records.push(kept);
      skipped++;
    }
  }
  return { records, backlog: false, skipped };
}

// ONE recipe as Mealie v2.x describes it -> a catalog record. Null when it has no name or no
// ingredient lines.
export function mapMealieRecipe(detail: Record<string, unknown>, slug: string, baseUrl: string, sourceId: string, nowIso: string): FetchedRecord | null {
  const name = text(detail.name);
  if (name === "") return null;

  // "display" is Mealie's finished line ("1 cup flour, sifted"); older entries only have the
  // text the person typed ("originalText") or a bare note.
  const ingredients = asArray(detail.recipeIngredient)
    .map((row) => {
      const item = asObject(row);
      return text(item.display) || text(item.originalText) || text(item.note);
    })
    .filter((line) => line !== "");
  if (ingredients.length === 0) return null;

  const instructions = asArray(detail.recipeInstructions)
    .map((step) => text(asObject(step).text))
    .filter((line) => line !== "");

  const names = (list: unknown) => asArray(list).map((entry) => text(asObject(entry).name));
  const categories = uniqueWords([...names(detail.recipeCategory), ...names(detail.tags)]);

  const group = text(detail.groupSlug) || text(asObject(detail.group).slug);
  const page = group === "" ? `${baseUrl}/recipe/${encodeURIComponent(slug)}` : `${baseUrl}/g/${encodeURIComponent(group)}/r/${encodeURIComponent(slug)}`;
  const url = new URL(page);
  return {
    kind: "fetched",
    id: recipeIdFor(url),
    name,
    url: canonicalUrl(url),
    sourceId,
    ingredients,
    instructions,
    categories,
    protein: guessProtein(name, ingredients, categories),
    ingredientProvenance: "publisher",
    fetchedAt: nowIso,
    providerId: slug,
  };
}
