// What `bun run doctor` says about the recipe providers.
//
// Offline (no network): which providers are configured and whether their token variables are set.
// Online (`--online`): one cheap read per configured provider, to show the address and the
// login work. Nothing is saved and no token is printed.

import { cleanCredential } from "../../secrets.ts";
import type { RecipesConfig } from "../../config.ts";
import { HttpError } from "../http.ts";
import { makeProviderClient, themealdbKey, type ProviderDeps } from "./index.ts";
import { themealdbBaseUrl } from "./themealdb.ts";

type Env = Record<string, string | undefined>;

export function providerNotes(recipes: RecipesConfig, env: Env): string[] {
  const { isPublicTestKey } = themealdbKey(recipes, env);
  const lines = [
    isPublicTestKey
      ? `  Recipe API TheMealDB: using the public test key. TheMealDB asks public or production apps to use a supporter key (set ${recipes.themealdb.apiKeyEnv}).`
      : `  Recipe API TheMealDB: using your key from ${recipes.themealdb.apiKeyEnv}.`,
  ];
  for (const [name, own] of [["Mealie", recipes.mealie], ["Tandoor", recipes.tandoor]] as const) {
    if (!own) {
      lines.push(`  Recipe API ${name}: not set up (optional).`);
      continue;
    }
    lines.push(`  Recipe API ${name}: ${own.url}, token in ${own.tokenEnv} (${env[own.tokenEnv] ? "set" : "NOT SET"}).`);
  }
  lines.push(`  Recipe APIs refresh every ${recipes.refreshHours} hours, in the background.`);
  return lines;
}

// One read per provider. Returns plain lines and problems.
export async function diagnoseProviders(recipes: RecipesConfig, env: Env, deps: ProviderDeps = {}): Promise<{ lines: string[]; problems: string[] }> {
  const lines: string[] = [];
  const problems: string[] = [];
  const client = makeProviderClient(recipes, env, deps);

  const probe = async (label: string, url: string, headers: Record<string, string>, loginHint: string) => {
    try {
      const answer = await client.get(url, headers);
      if (answer.status === 401 || answer.status === 403) problems.push(`recipes: ${label} refused the login (HTTP ${answer.status}). ${loginHint}`);
      else if (answer.status < 200 || answer.status >= 300) problems.push(`recipes: ${label} answered HTTP ${answer.status}. Is the address right?`);
      else lines.push(`${label}: reachable${headers.authorization ? ", token accepted" : ""}`);
    } catch (error) {
      problems.push(`recipes: could not reach ${label} (${error instanceof HttpError ? error.message : "unexpected problem"}).`);
    }
  };

  await probe("TheMealDB", `${deps.themealdbBaseUrl ?? themealdbBaseUrl(themealdbKey(recipes, env).key)}categories.php`, {}, `Check ${recipes.themealdb.apiKeyEnv}.`);
  if (recipes.mealie) {
    // Mealie's about page needs no login, so this proves the address, not the token.
    await probe("Mealie", `${recipes.mealie.url}/api/app/about`, {}, "");
    lines.push("Mealie: the token is checked the first time recipes are refreshed.");
  }
  if (recipes.tandoor) {
    const token = cleanCredential(env[recipes.tandoor.tokenEnv]);
    if (!token) problems.push(`recipes: ${recipes.tandoor.tokenEnv} is not set, so Tandoor cannot be checked.`);
    else await probe("Tandoor", `${recipes.tandoor.url}/api/recipe/?page=1&page_size=1`, { authorization: `Bearer ${token}` }, `Check ${recipes.tandoor.tokenEnv}.`);
  }
  return { lines, problems };
}
