// The two things a chat command does with a site's pages: check whether it may be switched on,
// and fetch one recipe page someone asked to save.

import type { FetchedRecord, RecipeSource } from "../types.ts";
import type { SiteContext } from "./context.ts";
import { readPage } from "./fetcher.ts";

// Paths a recipe site usually keeps its recipes under. If robots.txt closes these to us, there
// is nothing for fetching to do.
const SAMPLE_RECIPE_PATHS = ["/recipe/example", "/recipes/example"];

export type SwitchOnCheck = { ok: true; robotsNote: string; contentSignal: string | null } | { ok: false; reason: string };

// Reads robots.txt fresh and says whether fetching may be switched on. This checks robots.txt
// only: a permissive robots.txt says nothing about the site's terms of use.
export async function checkSiteAllowsFetching(ctx: SiteContext, source: RecipeSource): Promise<SwitchOnCheck> {
  const { info, rules } = await ctx.robots(source, { fresh: true });
  if (info.status === "unavailable") {
    return { ok: false, reason: `I couldn't read robots.txt for ${source.host} (${info.error}), so I can't tell what it allows. Nothing changed. Try again later.` };
  }
  if (!rules.allows("/")) {
    return { ok: false, reason: `${source.name} says in its robots.txt that automated tools may not fetch its pages, so fetching stays off.` };
  }
  if (rules.aiInputBlocked) {
    return { ok: false, reason: `${source.name} says in its robots.txt (Content-Signal: ai-input=no) that its pages may not be used as input to AI, and my use feeds a model, so fetching stays off.` };
  }
  if (SAMPLE_RECIPE_PATHS.some((path) => !rules.allows(path))) {
    return { ok: false, reason: `${source.name}'s robots.txt closes its recipe pages to automated tools, so fetching stays off.` };
  }
  const robotsNote = info.status === "none" ? `it has no robots.txt (HTTP ${info.httpStatus ?? 404}), which sets no limits` : "its robots.txt allows it";
  return { ok: true, robotsNote, contentSignal: rules.contentSignal };
}

export type SaveFromSite = { ok: true; record: FetchedRecord } | { ok: false; reason: string };

// Fetches and reads one page for `recipe save`. Still bound by robots.txt and by today's page
// budget. The caller writes the record to the catalog.
export async function fetchOneRecipe(ctx: SiteContext, source: RecipeSource, address: string): Promise<SaveFromSite> {
  const nowIso = ctx.nowIso();
  const { info, rules } = await ctx.robots(source);
  if (info.status === "unavailable") return { ok: false, reason: `I couldn't read robots.txt for ${source.host}` };
  if (rules.aiInputBlocked) return { ok: false, reason: `${source.host} says ai-input=no in its robots.txt` };
  if (!ctx.take(source.id, "pages")) return { ok: false, reason: `today's page budget for ${source.name} is used up` };

  const result = await readPage(ctx, source, rules, address, null, nowIso);
  switch (result.kind) {
    case "recipe": {
      ctx.source(source.id).pages[address] = {
        outcome: "recipe",
        checkedAt: nowIso,
        recipeId: result.record.id,
        ...(result.etag ? { etag: result.etag } : {}),
        ...(result.lastModified ? { lastModified: result.lastModified } : {}),
      };
      ctx.save();
      return { ok: true, record: result.record };
    }
    case "disallowed":
      return { ok: false, reason: `${source.host}'s robots.txt does not allow fetching that page` };
    case "not-recipe":
      return { ok: false, reason: `the page has no recipe data I can read (${result.why})` };
    case "gone":
      return { ok: false, reason: "the page was not found" };
    case "failed":
      return { ok: false, reason: result.message.replace(/\.$/, "") };
    case "not-modified":
      return { ok: false, reason: "the site answered with no content" };
  }
}
