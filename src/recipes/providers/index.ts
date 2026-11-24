// Puts the three providers behind one door: given a source, build the client and settings from
// config.toml and the environment, and run the right provider.

import type { RecipesConfig } from "../../config.ts";
import { cleanCredential } from "../../secrets.ts";
import { PoliteClient, type PoliteClientOptions } from "../http.ts";
import type { FetchedRecord, RecipeSource } from "../types.ts";
import { refreshMealie } from "./mealie.ts";
import { ProviderError, type ProviderRun } from "./shared.ts";
import { refreshTandoor } from "./tandoor.ts";
import { PUBLIC_TEST_KEY, refreshTheMealDb, themealdbBaseUrl } from "./themealdb.ts";

type Env = Record<string, string | undefined>;

// Things a test replaces. Real runs pass none of these.
export interface ProviderDeps {
  fetch?: typeof fetch;
  resolve?: PoliteClientOptions["resolve"];
  sleep?: PoliteClientOptions["sleep"];
  now?: () => number;
  allowLoopbackForTests?: boolean;
  themealdbBaseUrl?: string; // a fake TheMealDB server
}

export function themealdbKey(recipes: RecipesConfig, env: Env): { key: string; isPublicTestKey: boolean } {
  const key = cleanCredential(env[recipes.themealdb.apiKeyEnv]) || PUBLIC_TEST_KEY;
  return { key, isPublicTestKey: key === PUBLIC_TEST_KEY };
}

// One client for one run. The servers named in config.toml are the only private addresses it may
// open; every request waits its turn per host.
export function makeProviderClient(recipes: RecipesConfig, env: Env, deps: ProviderDeps = {}): PoliteClient {
  const { key } = themealdbKey(recipes, env);
  const pause = recipes.providerSecondsBetweenRequests * 1000;
  const hostSpacingMs: Record<string, number> = {};
  const privateHosts: string[] = [];
  const baseOfMealDb = new URL(deps.themealdbBaseUrl ?? themealdbBaseUrl(key));
  hostSpacingMs[baseOfMealDb.host] = pause;
  for (const own of [recipes.mealie, recipes.tandoor]) {
    if (!own) continue;
    hostSpacingMs[new URL(own.url).host] = pause;
    privateHosts.push(own.url); // the exact endpoint, port included
  }
  // The same cleaned values that are sent in requests (see runProvider), so what is blanked out
  // is exactly what could leak.
  const secrets = [key, ...[recipes.mealie, recipes.tandoor].map((own) => (own ? cleanCredential(env[own.tokenEnv]) : ""))].filter((secret) => secret !== "");
  return new PoliteClient({
    userAgent: recipes.userAgent,
    spacingMs: recipes.secondsBetweenRequests * 1000,
    hostSpacingMs,
    privateHosts,
    redact: secrets,
    ...deps,
  });
}

// Runs one source's provider. Throws ProviderError (plain words) when it cannot.
export async function runProvider(
  source: RecipeSource,
  previous: FetchedRecord[],
  recipes: RecipesConfig,
  env: Env,
  nowIso: string,
  deps: ProviderDeps = {},
): Promise<ProviderRun> {
  const client = makeProviderClient(recipes, env, deps);
  const input = { source, previous, client, nowIso };

  switch (source.provider) {
    case "themealdb": {
      const baseUrl = deps.themealdbBaseUrl ?? themealdbBaseUrl(themealdbKey(recipes, env).key);
      return refreshTheMealDb(input, { baseUrl, lookupsPerRefresh: recipes.themealdb.lookupsPerRefresh });
    }
    case "mealie": {
      const own = recipes.mealie;
      if (!own) throw new ProviderError("Mealie is not set up in config.toml any more, so it was not refreshed.");
      const token = cleanCredential(env[own.tokenEnv]);
      if (!token) throw new ProviderError(`The environment variable ${own.tokenEnv} is not set, so I cannot log in to Mealie.`);
      return refreshMealie(input, { baseUrl: own.url, token, maxRecipes: own.maxRecipes });
    }
    case "tandoor": {
      const own = recipes.tandoor;
      if (!own) throw new ProviderError("Tandoor is not set up in config.toml any more, so it was not refreshed.");
      const token = cleanCredential(env[own.tokenEnv]);
      if (!token) throw new ProviderError(`The environment variable ${own.tokenEnv} is not set, so I cannot log in to Tandoor.`);
      return refreshTandoor(input, { baseUrl: own.url, token, maxRecipes: own.maxRecipes });
    }
    default:
      throw new ProviderError(`${source.name} has no connector.`);
  }
}
