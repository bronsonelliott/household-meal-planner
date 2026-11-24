// The shapes for recipe sources and the saved-recipe catalog.
//
// A SOURCE is a website (or recipe app) the household may draw dishes from. Its `mode` says how
// the program may touch it:
//   link   the program only builds search links to it. It never makes a request to the site.
//   fetch  the program may download recipe pages, once an admin has switched it on and the site's
//          robots.txt allows it (src/recipes/site).
//   api    the program asks the source's published recipe API on a schedule (src/recipes/providers).
// Its `policy` says how far the site's terms are trusted:
//   blocked     fetching is never allowed, and chat cannot turn it on.
//   unverified  nobody has checked the site's terms. Fetching can be switched on by an admin,
//               but the policy stays "unverified" so the household knows.
//   allowed     the site offers a public API or permits use, so no warning is needed.
//
// A CATALOG RECORD is one recipe the household has saved or fetched:
//   bookmark  just a link and a name. Its ingredients are written by the model when the week
//             locks, so they are marked "generated".
//   fetched   the publisher's own ingredients and instructions, copied in. Marked "publisher".
// A bookmark never turns into a fetched record by itself: trust only goes up through a fetch.

export type SourceMode = "link" | "fetch" | "api";
export type SourcePolicy = "blocked" | "unverified" | "allowed";
export type SourceProvider = "themealdb" | "mealie" | "tandoor";

export interface RecipeSource {
  id: string;
  name: string;
  host: string; // lowercase, without a leading "www."
  mode: SourceMode;
  policy: SourcePolicy;
  // A search link template; "{q}" is replaced with the dish's words.
  searchUrl: string;
  provider?: SourceProvider; // for api sources
  enabledBy?: string; // who turned fetching on (a member id)
  enabledAt?: string; // when, as an ISO time
}

export type IngredientProvenance = "generated" | "publisher";

export interface BookmarkRecord {
  kind: "bookmark";
  id: string;
  name: string;
  url: string;
  sourceId: string;
  ingredientProvenance: "generated";
}

export interface FetchedRecord {
  kind: "fetched";
  id: string;
  name: string;
  url: string;
  sourceId: string;
  ingredients: string[]; // the publisher's lines, as written
  instructions: string[];
  categories: string[];
  protein: string; // a protein word, or UNKNOWN_PROTEIN
  ingredientProvenance: "publisher";
  fetchedAt: string; // ISO time
  // The source's own id for the recipe (a TheMealDB meal number, a Mealie slug, a Tandoor id),
  // so a refresh can tell which recipes it already has.
  providerId?: string;
  totalMinutes?: number; // from the page's total time, when it gave one
}

export type CatalogRecord = BookmarkRecord | FetchedRecord;

export const UNKNOWN_PROTEIN = "unknown";

// What a night keeps about the recipe or link it came from. It is copied into the week file when
// the night is set, so changing or removing a source or a saved recipe later cannot change a week
// that is already planned or locked.
export interface RecipeSnapshot {
  origin: "bookmark" | "fetched" | "source";
  recipeId: string | null; // the catalog id; null for a model-suggested dish
  url: string; // the saved link, or for a suggested dish the site search link
  sourceId: string;
  sourceName: string;
  ingredientProvenance: IngredientProvenance;
  // Fetched recipes only: the publisher's text, so the lock-time grocery lines come from it.
  ingredients?: string[];
  instructions?: string[];
}

// What planning reads, taken once per job so a command in the middle of a job cannot change it.
export interface RecipeContext {
  sources: RecipeSource[];
  catalog: Catalog;
}

export interface Catalog {
  version: 1;
  // Sources an admin removed. Their records stay on file but are left out of planning; adding
  // the source back brings them back.
  excludedSourceIds: string[];
  records: CatalogRecord[];
}

export function emptyRecipeContext(): RecipeContext {
  return { sources: [], catalog: { version: 1, excludedSourceIds: [], records: [] } };
}
