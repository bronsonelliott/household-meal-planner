// Mealie and Tandoor become recipe sources the first time they are configured, so they show up
// in "sources" and can be removed from chat like any other.
//
// "First time" is remembered in the sources file (registeredProviders), the same way the
// starting sources are: a source an admin removed stays removed after a restart. Changing the
// address in config.toml counts as a new setup, so it is added again.

import type { RecipesConfig } from "../../config.ts";
import { loadSources, saveSources, type SourcesFile } from "../sources.ts";
import type { RecipeSource } from "../types.ts";

export function withConfiguredProviders(file: SourcesFile, recipes: RecipesConfig): SourcesFile {
  const registered = new Set(file.registeredProviders ?? []);
  const sources = [...file.sources];
  let changed = false;

  for (const [provider, name, own] of [
    ["mealie", "Mealie", recipes.mealie],
    ["tandoor", "Tandoor", recipes.tandoor],
  ] as const) {
    if (!own) continue;
    const mark = `${provider}@${own.url}`;
    if (registered.has(mark)) continue;
    registered.add(mark);
    changed = true;
    const host = new URL(own.url).hostname.toLowerCase().replace(/^www\./, "");
    const source: RecipeSource = {
      id: provider,
      name,
      host,
      mode: "api",
      policy: "allowed",
      provider,
      searchUrl: `${own.url}/search?q={q}`, // only a convenience link; the program never opens it
    };
    const at = sources.findIndex((existing) => existing.id === provider);
    if (at === -1) sources.push(source);
    else sources[at] = source; // the address changed
  }
  return changed ? { ...file, sources, registeredProviders: [...registered] } : file;
}

// Reads the sources file, adds what is configured and not yet registered, saves if it changed.
export function registerConfiguredProviders(sourcesPath: string, recipes: RecipesConfig, nowIso: string): SourcesFile {
  const before = loadSources(sourcesPath, nowIso);
  const after = withConfiguredProviders(before, recipes);
  if (after !== before) saveSources(sourcesPath, after);
  return after;
}
