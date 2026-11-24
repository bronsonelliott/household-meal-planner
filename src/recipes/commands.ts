// The recipe chat commands. They are answered by code, never by the model:
//
//   sources                          list the sources and what the program does with each
//   sources add <url>                (admin) add a source, link mode
//   sources remove <host>            (admin) remove a source
//   sources fetch <host> on|off      (admin) switch page fetching for a site on or off
//   recipe save <url> [name]         save a link to the catalog (any member)
//   recipes status                   how many recipes are saved, by source
//
// A leading "/" is optional, and case doesn't matter. A message counts as a command only when
// the WHOLE message is one: a command mixed into other talk ("sources add x.com and also swap
// Tuesday") goes to the model like any other message, which cannot run commands. That is the
// simpler of the two safe choices, and it means a command never half-runs.
//
// Two commands need the network: `sources fetch <site> on` (it reads the site's robots.txt) and
// `recipe save` on a site that is switched on for fetching (it reads the page). They go through
// runRecipeCommandAsync; everything else is the plain synchronous runRecipeCommand.

import { CatalogError, loadCatalog, recordsBySource, saveCatalog, withBookmark, withSourceExcluded, withSourceIncluded } from "./catalog.ts";
import { checkSiteAllowsFetching, fetchOneRecipe } from "./site/actions.ts";
import type { SiteContext } from "./site/context.ts";
import { describeSource, findSourceByHost, findSourceByName, loadSources, saveSources, SourcesError, withSourceAdded, withSourceRemoved } from "./sources.ts";
import type { CatalogRecord, RecipeSource } from "./types.ts";
import { isRefreshedSource, loadRefreshStatus, type SourceStatus } from "./refresh.ts";
import { checkWebUrl, hostOf, recipeIdFor } from "./url.ts";

export type RecipeCommand =
  | { kind: "sources" }
  | { kind: "sources-add"; url: string }
  | { kind: "sources-remove"; host: string }
  | { kind: "sources-fetch"; host: string; setting: "on" | "off" }
  | { kind: "recipe-save"; url: string; name: string | null }
  | { kind: "recipes-status" }
  | { kind: "usage"; text: string }; // looked like a command but was incomplete

const USAGE = [
  "Recipe commands:",
  "- sources: list the recipe sources",
  "- sources add <web address>: add a source (admin)",
  "- sources remove <site>: remove a source (admin)",
  "- sources fetch <site> on|off: site fetching (admin)",
  "- recipe save <web address> [name]: save a recipe link",
  "- recipes status: how many recipes are saved",
].join("\n");

const MAX_NAME_LENGTH = 100;

// The command a message is, or null when it is anything else.
export function parseRecipeCommand(text: string): RecipeCommand | null {
  const trimmed = text.trim();
  if (trimmed === "" || /[\r\n]/.test(trimmed)) return null;
  const slashed = trimmed.startsWith("/");
  const words = trimmed.replace(/^\/+/, "").split(/\s+/);
  const head = words[0]!.toLowerCase();
  const sub = (words[1] ?? "").toLowerCase();
  const usage = (line: string): RecipeCommand => ({ kind: "usage", text: `That command needs more: ${line}\n\n${USAGE}` });

  if (head === "sources") {
    if (words.length === 1) return { kind: "sources" };
    // Too few words: say what is missing. Too many: it is a sentence that happens to start this
    // way, so it goes to the model like any other talk.
    if (sub === "add") {
      if (words.length > 3) return null;
      return words.length === 3 ? { kind: "sources-add", url: words[2]! } : usage("sources add <web address>");
    }
    if (sub === "remove") {
      if (words.length > 3) return null;
      return words.length === 3 ? { kind: "sources-remove", host: words[2]! } : usage("sources remove <site>");
    }
    if (sub === "fetch") {
      if (words.length > 4) return null;
      const setting = (words[3] ?? "").toLowerCase();
      if (words.length === 4 && (setting === "on" || setting === "off")) return { kind: "sources-fetch", host: words[2]!, setting };
      return usage("sources fetch <site> on|off");
    }
    return slashed ? { kind: "usage", text: USAGE } : null; // "sources of inspiration" is just talk
  }
  if (head === "recipe" && sub === "save") {
    if (words.length < 3) return usage("recipe save <web address> [name]");
    // The name is everything after the address, in the words the person used.
    const afterUrl = trimmed.replace(/^\/+/, "").replace(/^\S+\s+\S+\s+\S+\s*/, "").trim();
    return { kind: "recipe-save", url: words[2]!, name: afterUrl === "" ? null : afterUrl.slice(0, MAX_NAME_LENGTH) };
  }
  if (head === "recipes" && sub === "status" && words.length === 2) return { kind: "recipes-status" };
  if (slashed && (head === "recipe" || head === "recipes")) return { kind: "usage", text: USAGE };
  return null;
}

// What a command needs to run. `admin` is decided from the configured role and journaled with
// the command, so running it again after a crash decides the same way.
export interface CommandContext {
  sourcesPath: string;
  catalogPath: string;
  // data/recipe-refresh.json: what the background refresh last did. Optional; without it
  // "recipes status" only counts what is saved.
  refreshStatusPath?: string;
  admin: boolean;
  nowIso: string;
  // Who is running it (a member id), recorded when fetching is switched on.
  by?: string;
  // The shared web client and memory for page fetching. Without it, the two commands that need
  // the network say they can't.
  site?: SiteContext;
}

// Runs one command and returns the reply. Never throws for a bad file: the reply says what is wrong.
export function runRecipeCommand(command: RecipeCommand, context: CommandContext): string {
  try {
    return run(command, context);
  } catch (error) {
    if (error instanceof SourcesError || error instanceof CatalogError) return error.message;
    throw error;
  }
}

function run(command: RecipeCommand, context: CommandContext): string {
  const { sourcesPath, catalogPath } = context;
  const adminOnly = (what: string) => `Only an admin can ${what}.`;

  switch (command.kind) {
    case "usage":
      return command.text;

    case "sources": {
      const { sources } = loadSources(sourcesPath, context.nowIso);
      if (sources.length === 0) return 'There are no recipe sources. An admin can add one with "sources add <web address>".';
      return ["Recipe sources:", ...sources.map((source) => `- ${describeSource(source)}`)].join("\n");
    }

    case "sources-add": {
      if (!context.admin) return adminOnly("add recipe sources");
      const file = loadSources(sourcesPath, context.nowIso);
      const change = withSourceAdded(file, command.url);
      if (!change.ok) return `I didn't add that source: ${change.reason}.`;
      saveSources(sourcesPath, change.file);
      saveCatalog(catalogPath, withSourceIncluded(loadCatalog(catalogPath), change.source.id));
      const back = change.restoredSeed ? " It is one of the starting sources, so it came back with its original settings." : "";
      const how = change.source.policy === "blocked" ? "fetching stays blocked" : "I only make search links to it and never open its pages";
      return `Added ${change.source.name} (${change.source.host}): ${change.source.mode} mode, ${change.source.policy}; ${how}.${back}`;
    }

    case "sources-remove": {
      if (!context.admin) return adminOnly("remove recipe sources");
      const file = loadSources(sourcesPath, context.nowIso);
      const change = withSourceRemoved(file, command.host);
      if (!change.ok) return `I didn't remove anything: ${change.reason}.`;
      saveSources(sourcesPath, change.file);
      const catalog = loadCatalog(catalogPath);
      const saved = recordsBySource(catalog, change.source.id).length;
      saveCatalog(catalogPath, withSourceExcluded(catalog, change.source.id));
      const kept = saved === 0 ? "" : saved === 1 ? " Its 1 saved recipe stays on file but I won't suggest it." : ` Its ${saved} saved recipes stay on file but I won't suggest them.`;
      return `Removed ${change.source.name}.${kept} Weeks already planned keep their dishes.`;
    }

    case "sources-fetch": {
      const found = findFetchSource(command.host, context);
      if (typeof found === "string") return found;
      const { file, source } = found;
      if (command.setting === "on") {
        // The robots.txt check needs the network, so "on" goes through runRecipeCommandAsync.
        return source.mode === "fetch" ? `Fetching is already on for ${source.name}.` : `I can't check ${source.name}'s robots.txt from here, so nothing changed.`;
      }
      if (source.mode !== "fetch") return `Fetching is already off for ${source.name}.`;
      // Back to links only. Recipes already fetched stay in the catalog and can still be suggested;
      // they just aren't refreshed any more, and the site is not contacted again.
      const { enabledBy: _by, enabledAt: _at, ...rest } = source;
      saveSources(sourcesPath, { ...file, sources: file.sources.map((candidate) => (candidate.id === source.id ? { ...rest, mode: "link" as const } : candidate)) });
      const kept = recordsBySource(loadCatalog(catalogPath), source.id).filter((record) => record.kind === "fetched").length;
      const note = kept === 0 ? "" : ` The ${kept} recipe${kept === 1 ? "" : "s"} already fetched stay${kept === 1 ? "s" : ""} on file and can still be suggested, but won't be refreshed. "sources remove ${source.host}" would hide them.`;
      return `Fetching is off for ${source.name}. I won't contact the site again; I only link to it.${note}`;
    }

    case "recipe-save": {
      const { sources } = loadSources(sourcesPath, context.nowIso);
      const result = withBookmark(loadCatalog(catalogPath), sources, command.url, command.name);
      if (!result.ok) return `I didn't save that: ${result.reason}.`;
      const { record, configuredSource } = result;
      if (!result.created) return `"${record.name}" is already saved. ${record.url}`;
      saveCatalog(catalogPath, result.catalog);

      const where = configuredSource ? ` (from ${configuredSource.name})` : "";
      const lines = [`Saved "${record.name}"${where}. ${record.url}`];
      if (!configuredSource) {
        const host = hostOf(new URL(record.url));
        lines.push(`${host} isn't one of my recipe sources, so I saved just the link. An admin can add the site with "sources add https://${host}".`);
      }
      lines.push("I only saved the link and didn't open the page. When a week that uses it locks, I'll write the ingredient list myself.");
      return lines.join("\n");
    }

    case "recipes-status": {
      const { sources } = loadSources(sourcesPath, context.nowIso);
      const catalog = loadCatalog(catalogPath);
      const refresh = context.refreshStatusPath ? loadRefreshStatus(context.refreshStatusPath).sources : {};
      if (catalog.records.length === 0 && Object.keys(refresh).length === 0) return 'No recipes are saved yet. Save one with "recipe save <web address> [name]".';

      const groups = new Map<string, CatalogRecord[]>();
      for (const record of catalog.records) groups.set(record.sourceId, [...(groups.get(record.sourceId) ?? []), record]);
      // A source that has been refreshed shows up even when it came back empty or failed.
      for (const source of sources) if (isRefreshedSource(source) && refresh[source.id] && !groups.has(source.id)) groups.set(source.id, []);

      const lines = [`Saved recipes: ${catalog.records.length}.`];
      for (const [sourceId, records] of groups) {
        const source = sources.find((candidate) => candidate.id === sourceId);
        const label = source ? source.name : records[0] ? hostLabel(records[0]) : sourceId;
        const note = catalog.excludedSourceIds.includes(sourceId) ? " (source removed, not suggested)" : source ? "" : " (not a configured source)";
        const refreshed = source && refresh[sourceId] ? `. ${describeRefresh(refresh[sourceId]!)}` : "";
        lines.push(`- ${label}: ${countWords(records)}${note}${refreshed}`);
      }
      return lines.join("\n");
    }
  }
}

// The checks `sources fetch` makes before anything else. A string is the reply that ends it.
function findFetchSource(host: string, context: CommandContext): string | { file: ReturnType<typeof loadSources>; source: RecipeSource } {
  if (!context.admin) return "Only an admin can change site fetching.";
  const file = loadSources(context.sourcesPath, context.nowIso);
  const source = findSourceByName(file.sources, host) ?? findSourceByHost(file.sources, host);
  if (!source) return `I don't have a source called ${host}. "sources" lists them.`;
  if (source.policy === "blocked") return `Fetching is blocked for ${source.name}, so it stays off. Chat can't change that; I only link to it.`;
  if (source.mode === "api") return `${source.name} is an API source, so it is always on. There is nothing to switch.`;
  return { file, source };
}

// ---------------------------------------------------------------------------------------------
// The two commands that use the network
// ---------------------------------------------------------------------------------------------

export async function runRecipeCommandAsync(command: RecipeCommand, context: CommandContext): Promise<string> {
  try {
    if (command.kind === "sources-fetch" && command.setting === "on") return await switchFetchingOn(command.host, context);
    if (command.kind === "recipe-save") {
      const fetched = await saveByFetching(command, context);
      if (fetched !== null) return fetched;
    }
    return run(command, context);
  } catch (error) {
    if (error instanceof SourcesError || error instanceof CatalogError) return error.message;
    throw error;
  }
}

async function switchFetchingOn(host: string, context: CommandContext): Promise<string> {
  const found = findFetchSource(host, context);
  if (typeof found === "string") return found;
  const { file, source } = found;
  if (source.mode === "fetch") return `Fetching is already on for ${source.name}.`;
  if (!context.site) return `Fetching isn't available in this setup, so nothing changed.`;

  const check = await checkSiteAllowsFetching(context.site, source);
  context.site.save(); // the robots.txt just read is kept for a day
  if (!check.ok) return check.reason;

  // The policy is left exactly as it was: a permissive robots.txt never upgrades "unverified".
  const turnedOn: RecipeSource = { ...source, mode: "fetch", enabledAt: context.nowIso, ...(context.by ? { enabledBy: context.by } : {}) };
  saveSources(context.sourcesPath, { ...file, sources: file.sources.map((candidate) => (candidate.id === source.id ? turnedOn : candidate)) });
  const { pagesPerSourcePerDay, sitemapsPerSourcePerDay } = context.site.recipes;
  const lines = [
    `Fetching is on for ${source.name}: ${check.robotsNote}.`,
    `I did NOT check ${source.name}'s terms of use. Its policy stays "${source.policy}", and making sure fetching is acceptable under those terms is the household's responsibility.`,
    `I'll read at most ${sitemapsPerSourcePerDay} sitemap files and ${pagesPerSourcePerDay} recipe pages a day, slowly, so the recipes appear over the next few days. "sources fetch ${source.host} off" turns it back off.`,
  ];
  if (check.contentSignal) lines.push(`Its robots.txt also says: ${check.contentSignal}.`);
  return lines.join("\n");
}

// `recipe save` on a site that is switched on for fetching: fetch and read the page, and reply
// only after the recipe is on file. If the page can't be read (robots.txt, no recipe data, the
// site is down, today's budget is used) the plain link is saved as before and the reply says so;
// nothing is queued for later. Null means "not a fetch site, do the usual".
async function saveByFetching(command: Extract<RecipeCommand, { kind: "recipe-save" }>, context: CommandContext): Promise<string | null> {
  const site = context.site;
  if (!site) return null;
  const checked = checkWebUrl(command.url);
  if (!checked.ok) return null;
  const { sources } = loadSources(context.sourcesPath, context.nowIso);
  const source = findSourceByHost(sources, hostOf(checked.url));
  if (!source || source.mode !== "fetch" || source.policy === "blocked") return null;
  if (loadCatalog(context.catalogPath).records.some((record) => record.id === recipeIdFor(checked.url))) return null; // already saved (a link stays a link): the usual reply

  const result = await fetchOneRecipe(site, source, checked.url.toString());
  if (result.ok) {
    // Read the catalog again now: the page took a while to arrive.
    const catalog = loadCatalog(context.catalogPath);
    // If a link to this page was saved while we were reading it, that link stays as it is.
    if (catalog.records.some((record) => record.id === result.record.id && record.kind === "bookmark")) return run(command, context);
    const others = catalog.records.filter((record) => record.id !== result.record.id);
    saveCatalog(context.catalogPath, { ...catalog, records: [...others, result.record] });
    return `Saved "${result.record.name}" (from ${source.name}) with the recipe's own ingredients and steps. ${result.record.url}`;
  }
  const plain = run(command, context).split("\n").filter((line) => !line.startsWith("I only saved the link")).join("\n");
  return `${plain}\nI couldn't read the recipe from the page (${result.reason}), so it's only the link.`;
}

// "2026-11-24 10:05 UTC", for a refresh time.
function whenText(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function describeRefresh(status: SourceStatus): string {
  if (status.lastError !== null) {
    const good = status.lastSuccessAt ? ` The last good refresh was ${whenText(status.lastSuccessAt)}.` : " It has not worked yet.";
    return `The refresh on ${whenText(status.lastAttemptAt)} failed: ${status.lastError} I kept the recipes it already had.${good}`;
  }
  const parts = [`Refreshed ${whenText(status.lastAttemptAt)}.`];
  if (status.backlog) parts.push("More are still being added.");
  if (status.skipped > 0) parts.push(`${status.skipped} could not be read.`);
  return parts.join(" ");
}

function hostLabel(record: CatalogRecord): string {
  const checked = checkWebUrl(record.url);
  return checked.ok ? hostOf(checked.url) : record.sourceId;
}

function countWords(records: CatalogRecord[]): string {
  const links = records.filter((record) => record.kind === "bookmark").length;
  const fetched = records.length - links;
  const parts: string[] = [];
  if (records.length === 0) return "no recipes";
  if (links > 0) parts.push(`${links} saved link${links === 1 ? "" : "s"}`);
  if (fetched > 0) parts.push(`${fetched} fetched recipe${fetched === 1 ? "" : "s"}`);
  return parts.join(", ");
}
