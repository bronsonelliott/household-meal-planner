// Tandoor Recipes: a self-hosted recipe manager (https://tandoor.dev). The household's own
// recipes.
//
// A refresh pages through GET /api/recipe/?page=N&page_size=50 (names and ids), then reads each
// recipe with GET /api/recipe/{id}/. The login is an API token sent as "Authorization: Bearer".
//
// Written against Tandoor 1.5.x (2026-11). NOT tested against a live server: the field names in
// mapTandoorRecipe come from Tandoor's published API. If an update renames something, that one
// function is where to look.
//
// The link saved for a recipe is <url>/view/recipe/<id>, a link for people; the bot never opens it.

import { guessProtein } from "../protein.ts";
import { canonicalUrl, recipeIdFor } from "../url.ts";
import type { FetchedRecord } from "../types.ts";
import { asArray, asObject, FailureStreak, getJson, text, uniqueWords, type ProviderInput, type ProviderRun } from "./shared.ts";

export interface TandoorSettings {
  baseUrl: string; // no trailing slash
  token: string;
  maxRecipes: number;
}

const PAGE_SIZE = 50;

export async function refreshTandoor(input: ProviderInput, settings: TandoorSettings): Promise<ProviderRun> {
  const { client, previous, nowIso, source } = input;
  const headers = { authorization: `Bearer ${settings.token}` };
  const authHelp = "Check the token in the environment variable named in recipes.tandoor.tokenEnv.";
  const get = (path: string) => getJson(client, settings.baseUrl + path, headers, authHelp);

  // 1. The list of ids.
  const ids: string[] = [];
  const maxPages = Math.ceil(settings.maxRecipes / PAGE_SIZE) + 1;
  for (let page = 1; page <= maxPages && ids.length < settings.maxRecipes; page++) {
    const answer = asObject(await get(`/api/recipe/?page=${page}&page_size=${PAGE_SIZE}`));
    const results = asArray(answer.results);
    for (const row of results) {
      const id = text(asObject(row).id);
      if (id !== "" && !ids.includes(id)) ids.push(id);
    }
    // "next" is null on the last page. (Its text is not followed: behind a proxy it can name the wrong host.)
    if (results.length === 0 || !answer.next) break;
  }

  // 2. Each recipe. One that cannot be read keeps its previous copy.
  const before = new Map(previous.filter((record) => record.providerId !== undefined).map((record) => [record.providerId!, record]));
  const records: FetchedRecord[] = [];
  let skipped = 0;
  const streak = new FailureStreak();
  for (const id of ids.slice(0, settings.maxRecipes)) {
    try {
      const detail = asObject(await get(`/api/recipe/${encodeURIComponent(id)}/`));
      const record = mapTandoorRecipe(detail, id, settings.baseUrl, source.id, nowIso);
      if (record) records.push(record);
      else skipped++;
      streak.ok();
    } catch (error) {
      streak.failed(error);
      const kept = before.get(id);
      if (kept) records.push(kept);
      skipped++;
    }
  }
  return { records, backlog: false, skipped };
}

// ONE recipe as Tandoor 1.5.x describes it -> a catalog record. Null when it has no name or no
// ingredient lines.
export function mapTandoorRecipe(detail: Record<string, unknown>, id: string, baseUrl: string, sourceId: string, nowIso: string): FetchedRecord | null {
  const name = text(detail.name);
  if (name === "") return null;

  const steps = asArray(detail.steps).map(asObject);
  const ingredients: string[] = [];
  for (const step of steps) {
    for (const row of asArray(step.ingredients)) {
      const line = ingredientLine(asObject(row));
      if (line !== "") ingredients.push(line);
    }
  }
  if (ingredients.length === 0) return null;

  const instructions = steps.map((step) => text(step.instruction)).filter((line) => line !== "");
  const categories = uniqueWords(asArray(detail.keywords).map((keyword) => text(asObject(keyword).name) || text(asObject(keyword).label)));

  const url = new URL(`${baseUrl}/view/recipe/${encodeURIComponent(id)}`);
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
    providerId: id,
  };
}

// "2 cup flour (sifted)" from amount, unit.name, food.name and note. Section headings are skipped.
function ingredientLine(row: Record<string, unknown>): string {
  if (row.is_header === true) return "";
  const amount = typeof row.amount === "number" && row.amount > 0 && row.no_amount !== true ? String(Math.round(row.amount * 100) / 100) : "";
  const unit = text(asObject(row.unit).name);
  const food = text(asObject(row.food).name);
  const note = text(row.note);
  const main = [amount, unit, food].filter((part) => part !== "").join(" ");
  if (main === "") return note;
  return note === "" ? main : `${main} (${note})`;
}
