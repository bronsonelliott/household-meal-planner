// The recipe sources the household has configured, kept in data/recipe-sources.json.
//
// Chat commands change this file (`sources add`, `sources remove`), so it lives with the data,
// not in config.toml. It is written atomically, and it is seeded exactly once: the file records
// when that happened, so a seed an admin removed stays removed.

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomically } from "../data/files.ts";
import type { RecipeSource } from "./types.ts";
import { checkWebUrl, hostMatches, hostOf, normalizeHost } from "./url.ts";

export const SOURCES_VERSION = 1;

export interface SourcesFile {
  version: typeof SOURCES_VERSION;
  seededAt: string | null; // null until the starting sources have been added once
  sources: RecipeSource[];
  // Self-hosted providers (Mealie, Tandoor) already added from config.toml, as "mealie@<address>".
  // Remembered so a source an admin removed does not come back at the next start.
  registeredProviders?: string[];
}

export class SourcesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourcesError";
  }
}

// The starting sources. All three sites below forbid or block automated fetching, so they are
// link-only. TheMealDB publishes a free recipe API for apps; its connector comes in a later
// slice, and until then it adds nothing.
export const SEED_SOURCES: RecipeSource[] = [
  { id: "food-network", name: "Food Network", host: "foodnetwork.com", mode: "link", policy: "unverified", searchUrl: "https://www.foodnetwork.com/search/{q}-" },
  { id: "allrecipes", name: "Allrecipes", host: "allrecipes.com", mode: "link", policy: "blocked", searchUrl: "https://www.allrecipes.com/search?q={q}" },
  { id: "the-kitchn", name: "The Kitchn", host: "thekitchn.com", mode: "link", policy: "unverified", searchUrl: "https://www.thekitchn.com/search?q={q}" },
  { id: "themealdb", name: "TheMealDB", host: "themealdb.com", mode: "api", provider: "themealdb", policy: "allowed", searchUrl: "https://www.themealdb.com/browse.php?s={q}" },
];

// Used for any site an admin adds: a web search limited to that site.
const GENERIC_SEARCH = "https://duckduckgo.com/?q=site%3A{host}+{q}";

// ---------------------------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------------------------

// Reads the file. The first time (no file, or never seeded) it adds the starting sources and
// saves them, so later reads see exactly what the admins left.
export function loadSources(path: string, nowIso: string): SourcesFile {
  if (!existsSync(path)) return seed({ version: SOURCES_VERSION, seededAt: null, sources: [] }, path, nowIso);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new SourcesError(`The recipe sources file (${path}) isn't valid JSON, so I left it alone.`);
  }
  const file = parsed as Partial<SourcesFile>;
  if (typeof parsed !== "object" || parsed === null || file.version !== SOURCES_VERSION || !Array.isArray(file.sources)) {
    throw new SourcesError(`The recipe sources file (${path}) isn't in a form this version understands (expected version ${SOURCES_VERSION}), so I left it alone.`);
  }
  const loaded: SourcesFile = {
    version: SOURCES_VERSION,
    seededAt: typeof file.seededAt === "string" ? file.seededAt : null,
    sources: file.sources,
    ...(Array.isArray(file.registeredProviders) ? { registeredProviders: file.registeredProviders } : {}),
  };
  return loaded.seededAt === null ? seed(loaded, path, nowIso) : loaded;
}

function seed(file: SourcesFile, path: string, nowIso: string): SourcesFile {
  const have = new Set(file.sources.map((source) => source.id));
  const seeded: SourcesFile = {
    ...file,
    version: SOURCES_VERSION,
    seededAt: nowIso,
    sources: [...file.sources, ...SEED_SOURCES.filter((source) => !have.has(source.id)).map((source) => ({ ...source }))],
  };
  saveSources(path, seeded);
  return seeded;
}

export function saveSources(path: string, file: SourcesFile): void {
  writeFileAtomically(path, JSON.stringify(file, null, 2) + "\n");
}

// ---------------------------------------------------------------------------------------------
// Looking sources up
// ---------------------------------------------------------------------------------------------

// The source for a site address, or a bare host. Subdomains belong to their site.
export function findSourceByHost(sources: RecipeSource[], hostOrUrl: string): RecipeSource | undefined {
  const host = hostFromInput(hostOrUrl);
  if (host === null) return undefined;
  return sources.find((source) => hostMatches(host, source.host));
}

// What an admin typed to name a source: its id or name ("mealie"). Self-hosted
// sources often live at an address like 192.168.1.20 that no one would type, so the name works too.
export function findSourceByName(sources: RecipeSource[], input: string): RecipeSource | undefined {
  const wanted = input.trim().toLowerCase();
  if (wanted === "") return undefined;
  return sources.find((source) => source.id === wanted || source.name.toLowerCase() === wanted);
}

export function findSourceById(sources: RecipeSource[], id: string): RecipeSource | undefined {
  const wanted = id.trim().toLowerCase();
  return sources.find((source) => source.id === wanted);
}

// Accepts "thekitchn.com", "www.thekitchn.com" or a full address; null when it is none of those.
export function hostFromInput(input: string): string | null {
  const text = input.trim();
  if (text === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  const checked = checkWebUrl(withScheme);
  return checked.ok ? hostOf(checked.url) : null;
}

// A source id from a site name: "smittenkitchen-com".
export function idFromHost(host: string): string {
  return normalizeHost(host).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// The id a saved link gets when its site is not a configured source. The prefix keeps it apart
// from a real source with the same host, so removing that source later does not hide links
// someone saved afterwards.
export function unlistedSourceId(host: string): string {
  return `unlisted-${idFromHost(host)}`;
}

// ---------------------------------------------------------------------------------------------
// Changes (pure: a file in, a file out)
// ---------------------------------------------------------------------------------------------

export type SourceChange = { ok: true; file: SourcesFile; source: RecipeSource; restoredSeed: boolean } | { ok: false; reason: string };

// A new source from a web address: link mode, unverified, with a generic site-search link.
// A site that is one of the starting sources comes back exactly as seeded, so removing and
// re-adding a blocked site can't be used to get around its policy.
export function withSourceAdded(file: SourcesFile, rawUrl: string): SourceChange {
  const checked = checkWebUrl(rawUrl);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const host = hostOf(checked.url);
  const existing = findSourceByHost(file.sources, host);
  if (existing) return { ok: false, reason: `${existing.host} is already a source` };

  const seedSource = SEED_SOURCES.find((candidate) => hostMatches(host, candidate.host));
  const source: RecipeSource = seedSource
    ? { ...seedSource }
    : { id: idFromHost(host), name: host, host, mode: "link", policy: "unverified", searchUrl: GENERIC_SEARCH.replace("{host}", host) };
  return { ok: true, file: { ...file, sources: [...file.sources, source] }, source, restoredSeed: seedSource !== undefined };
}

export function withSourceRemoved(file: SourcesFile, hostInput: string): SourceChange {
  const host = hostFromInput(hostInput);
  const source = findSourceByName(file.sources, hostInput) ?? (host === null ? undefined : file.sources.find((candidate) => candidate.host === host));
  if (!source) return { ok: false, reason: `I don't have a source called ${hostInput.trim()}` };
  return { ok: true, file: { ...file, sources: file.sources.filter((candidate) => candidate.id !== source.id) }, source, restoredSeed: false };
}

// Plain words for what a source is and what the program will do with it.
export function describeSource(source: RecipeSource): string {
  let status: string;
  if (source.mode === "api") {
    status = source.provider === "themealdb" ? "recipes come from its public API, refreshed in the background" : "recipes come from your own server, refreshed in the background";
  } else if (source.mode === "fetch") {
    status = source.policy === "unverified" ? "recipe pages may be fetched, but the site's terms are unverified" : "recipe pages may be fetched";
  } else if (source.policy === "blocked") {
    status = "links only, and fetching is blocked for this site";
  } else if (source.policy === "unverified") {
    status = "links only; the site's terms are unverified, so nothing is fetched";
  } else {
    status = "links only";
  }
  return `${source.name} (${source.host}): ${source.mode} mode, ${source.policy}. ${status}.`;
}
