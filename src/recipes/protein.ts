// Guessing a recipe's main protein from its name and ingredient lines, so the planner can keep
// variety (no protein on too many nights). It is a plain word list, not cleverness: when it
// finds nothing it says UNKNOWN_PROTEIN and the recipe simply isn't counted against a cap.
//
// The words it returns match what the household's own profile uses ("chicken", "beef", "fish").

import { UNKNOWN_PROTEIN } from "./types.ts";

// protein word -> the words that signal it. Matched as whole words, case-insensitive.
const KEYWORDS: Array<[protein: string, words: string[]]> = [
  ["chicken", ["chicken", "hen"]],
  ["beef", ["beef", "steak", "brisket", "sirloin", "ribeye", "chuck", "veal"]],
  ["pork", ["pork", "bacon", "ham", "sausage", "sausages", "chorizo", "prosciutto", "pancetta", "gammon"]],
  ["lamb", ["lamb", "mutton"]],
  ["goat", ["goat"]],
  ["turkey", ["turkey"]],
  ["duck", ["duck"]],
  ["shellfish", ["shrimp", "prawn", "prawns", "scallop", "scallops", "crab", "lobster", "mussels", "clams", "squid", "calamari"]],
  ["fish", ["fish", "salmon", "cod", "tuna", "haddock", "trout", "halibut", "tilapia", "mackerel", "sardines", "anchovies", "snapper", "bass", "monkfish"]],
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
