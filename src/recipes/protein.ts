// Guessing a recipe's main protein from its name and ingredient lines, so the planner can keep
// variety (no protein on too many nights). It is a plain word list, not cleverness: when it
// finds nothing it says UNKNOWN_PROTEIN and the recipe simply isn't counted against a cap.
//
// The words it returns match what the household's own profile uses ("chicken", "beef", "fish").

import { UNKNOWN_PROTEIN } from "./types.ts";

// ----- The one list of seafood species -----
// Guessing a recipe's protein, the protein groups ("seafood") and the per-protein cap all read
// these two lists, so a species added here is understood everywhere. Singular names only: the
// plural spellings are made from them.

const FISH_SPECIES = [
  "salmon", "tuna", "cod", "tilapia", "halibut", "trout", "haddock", "mackerel", "sardine", "anchovy",
  "snapper", "bass", "monkfish", "catfish", "mahi-mahi", "swordfish",
];
const SHELLFISH_SPECIES = ["shrimp", "prawn", "crab", "lobster", "scallop", "mussel", "clam", "oyster", "squid", "calamari", "octopus"];

// "clam" -> ["clam", "clams"], "anchovy" -> ["anchovy", "anchovies"], "bass" -> ["bass", "basses"].
function withPlural(word: string): string[] {
  if (word.endsWith("y")) return [word, `${word.slice(0, -1)}ies`];
  if (word.endsWith("s")) return [word, `${word}es`];
  return [word, `${word}s`];
}

const FISH_WORDS = ["fish", ...FISH_SPECIES.flatMap(withPlural)];
const SHELLFISH_WORDS = ["shellfish", ...SHELLFISH_SPECIES.flatMap(withPlural)];

// A protein as the table spells it: lowercase, and a plural turned back into its singular
// when the table knows it ("Clams" -> "clam"). Anything the table does not know comes back as is.
function normalizeProtein(protein: string | null): string {
  const wanted = (protein ?? "").trim().toLowerCase();
  if (FISH_WORDS.includes(wanted) || SHELLFISH_WORDS.includes(wanted)) {
    const singular = [...FISH_SPECIES, ...SHELLFISH_SPECIES].find((species) => withPlural(species).includes(wanted));
    return singular ?? wanted;
  }
  return wanted;
}

// protein word -> the words that signal it. Matched as whole words, case-insensitive.
const KEYWORDS: Array<[protein: string, words: string[]]> = [
  ["chicken", ["chicken", "hen"]],
  ["beef", ["beef", "steak", "brisket", "sirloin", "ribeye", "chuck", "veal"]],
  ["pork", ["pork", "bacon", "ham", "sausage", "sausages", "chorizo", "prosciutto", "pancetta", "gammon"]],
  ["lamb", ["lamb", "mutton"]],
  ["goat", ["goat"]],
  ["turkey", ["turkey"]],
  ["duck", ["duck"]],
  ["shellfish", SHELLFISH_WORDS],
  ["fish", FISH_WORDS],
  ["tofu", ["tofu", "tempeh"]],
  ["beans", ["beans", "lentils", "chickpeas", "dal"]],
  ["eggs", ["egg", "eggs"]],
];

// Which category a source already names ("Chicken", "Seafood") is a strong hint.
const CATEGORY_HINTS: Record<string, string> = { beef: "beef", chicken: "chicken", lamb: "lamb", pork: "pork", goat: "goat", seafood: "fish" };

function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z]+/).filter((word) => word !== "");
}

// The protein word for a recipe: the recipe's name decides first ("Chicken tinga"), then a
// category hint, then whichever protein appears in the most ingredient lines. Ties go to the
// order of the list above.
export function guessProtein(name: string, ingredients: string[], categories: string[] = []): string {
  const fromName = firstMatch(wordsOf(name));
  if (fromName) return fromName;
  for (const category of categories) {
    const hint = CATEGORY_HINTS[category.trim().toLowerCase()];
    if (hint) return hint;
  }

  // Meat and fish first. Tofu, beans and eggs are in many dishes, so they only count when no
  // meat or fish turned up.
  const MEATLESS = ["tofu", "beans", "eggs"];
  for (const group of [KEYWORDS.filter(([protein]) => !MEATLESS.includes(protein)), KEYWORDS.filter(([protein]) => MEATLESS.includes(protein))]) {
    let best = UNKNOWN_PROTEIN;
    let bestLines = 0;
    for (const [protein, words] of group) {
      const lines = ingredients.filter((line) => wordsOf(line).some((word) => words.includes(word))).length;
      if (lines > bestLines) {
        best = protein;
        bestLines = lines;
      }
    }
    if (best !== UNKNOWN_PROTEIN) return best;
  }
  return UNKNOWN_PROTEIN;
}

function firstMatch(words: string[]): string | null {
  for (const [protein, list] of KEYWORDS) {
    if (protein === "eggs" || protein === "beans") continue; // "egg fried rice" is not an egg night the way a steak is a beef night
    if (words.some((word) => list.includes(word))) return protein;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Protein groups
// ---------------------------------------------------------------------------------------------
// Rules talk in families ("red-meat", "seafood"), but dishes name one protein ("beef", "salmon").
// This small table says which proteins belong to which family, so a beef dish counts for a
// "max red-meat 2" rule even when nobody tagged it. Explicit tags keep working as before.

const FISH = ["fish", ...FISH_SPECIES.flatMap(withPlural)];
const SHELLFISH = ["shellfish", ...SHELLFISH_SPECIES.flatMap(withPlural)];

export const PROTEIN_GROUPS: Record<string, string[]> = {
  "red-meat": ["beef", "pork", "lamb", "goat", "veal", "venison", "bison"],
  fish: FISH,
  shellfish: SHELLFISH,
  seafood: [...FISH, ...SHELLFISH],
  poultry: ["chicken", "turkey", "duck"],
};

// The groups a protein belongs to ("beef" -> ["red-meat"], "salmon" -> ["fish", "seafood"]).
export function groupsOfProtein(protein: string | null): string[] {
  const wanted = (protein ?? "").trim().toLowerCase(); // the seafood lists hold singular and plural
  if (wanted === "") return [];
  return Object.entries(PROTEIN_GROUPS).filter(([, members]) => members.includes(wanted)).map(([group]) => group);
}

// Does a dish with this protein and these tags count for a rule about `tag`? Yes if the tag is
// its protein, one of its tags, or a group its protein belongs to.
export function dishCountsFor(protein: string | null, tags: readonly string[], tag: string): boolean {
  const wanted = tag.trim().toLowerCase();
  if ((protein ?? "").trim().toLowerCase() === wanted || normalizeProtein(protein) === normalizeProtein(wanted)) return true;
  if (tags.some((t) => t.trim().toLowerCase() === wanted)) return true;
  return groupsOfProtein(protein).includes(wanted);
}

// What the "no protein on more than N nights" cap counts a protein as: all fish species are one
// protein, all shellfish are one protein, and everything else is itself.
export function capGroupOf(protein: string): string {
  const wanted = protein.trim().toLowerCase();
  if (FISH.includes(wanted)) return "fish";
  if (SHELLFISH.includes(wanted)) return "shellfish";
  return wanted;
}
