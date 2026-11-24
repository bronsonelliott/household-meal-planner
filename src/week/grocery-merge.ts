// Tidying the grocery list: what counts as "the same item", how amounts add up, and which amounts
// are really pantry amounts that nobody shops for ("1 tsp", "a pinch").
//
// An ingredient line looks like "soy sauce, 1 tbsp" or "chicken thighs, boneless, 2 lb": a name,
// then optionally some descriptor words, then an amount. The helpers here work on those lines
// one piece at a time, with plain word lists so the rules are easy to read and change.

// ----- Names -----

// Words that describe how an item is prepared or sized, not what it is. Dropped when deciding
// whether two lines are the same item ("coarse black pepper" and "black pepper"). Deliberately
// short: "fresh" and "dried" change what you buy, so they stay.
const DESCRIPTORS = new Set(["coarse", "fine", "finely", "freshly", "cracked", "kosher", "large", "medium", "small", "extra"]);

// Whole names that mean the same shopping item, mapped to one name.
const SAME_ITEM: Record<string, string> = {
  "black pepper": "pepper",
  "ground black pepper": "pepper",
  "ground pepper": "pepper",
  "cracked black pepper": "pepper",
};

// Words that, if a name is made of nothing else, make it plain water or ice (not "coconut water").
const WATER_WORDS = new Set(["water", "ice", "cold", "hot", "warm", "boiling", "cubes", "cube", "tap", "filtered", "lukewarm", "of"]);

// The first part of a line, before the first comma.
export function nameOf(text: string): string {
  return text.split(",")[0]!.trim();
}

// The words of a name, lowercased, with a plain plural "s" dropped so "tortilla" and "tortillas"
// match. Descriptor words are kept: use tidyWords when they should not count.
export function nameWords(text: string): string[] {
  return nameOf(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
}

// The name's words without descriptors: "Coarse black pepper" -> ["black", "pepper"].
// "freshly ground" goes as a pair, but a plain "ground" stays ("ground beef").
function plainWords(text: string): string[] {
  const words = nameOf(text).toLowerCase().replace(/freshly ground/g, "freshly");
  return nameWords(words).filter((word) => !DESCRIPTORS.has(word));
}

// The words used to decide "same item": descriptors dropped, and a few names unified.
export function itemWords(text: string): string[] {
  const words = plainWords(text);
  const unified = SAME_ITEM[words.join(" ")];
  return unified ? unified.split(" ") : words;
}

// The name to show for an item: descriptors dropped, original spelling kept.
function displayName(text: string): string {
  const name = nameOf(text).replace(/freshly ground/gi, "freshly");
  return name
    .split(/\s+/)
    .filter((word) => !DESCRIPTORS.has(word.toLowerCase().replace(/[^a-z]/g, "")))
    .join(" ");
}

// True for water and ice, which nobody puts on a shopping list.
export function isWaterOrIce(text: string): boolean {
  const words = nameOf(text).toLowerCase().split(/[^a-z]+/).filter((word) => word !== "");
  return words.length > 0 && words.some((word) => word === "water" || word === "ice") && words.every((word) => WATER_WORDS.has(word));
}

// True when all of `item`'s words appear, in order and side by side, in the ingredient's name:
// "tortillas" matches "corn tortillas, 1 pack"; "olive oil" does not match "sesame oil".
// Also compares with descriptors dropped, so a staple "pepper" matches "coarse black pepper".
export function nameContains(ingredient: string, item: string): boolean {
  return wordsContain(nameWords(ingredient), nameWords(item)) || wordsContain(itemWords(ingredient), itemWords(item));
}

function wordsContain(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return false;
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((word, i) => haystack[start + i] === word)) return true;
  }
  return false;
}

// ----- Amounts -----

// Spoon-sized measures: what you already have in the pantry, not something you buy.
const SPOON_UNITS = new Set(["tsp", "tbsp", "pinch", "dash"]);

// Spellings of a unit -> the one we use.
const UNIT_SPELLINGS: Record<string, string> = {
  tsp: "tsp", tsps: "tsp", teaspoon: "tsp", teaspoons: "tsp",
  tbsp: "tbsp", tbsps: "tbsp", tbs: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  oz: "oz", ounce: "oz", ounces: "oz",
  g: "g", gram: "g", grams: "g",
  kg: "kg", kilogram: "kg", kilograms: "kg",
  ml: "ml", l: "l",
  cup: "cup", cups: "cup",
  clove: "clove", cloves: "clove",
  can: "can", cans: "can",
  package: "package", packages: "package", pkg: "package", pkgs: "package",
  pack: "pack", packs: "pack",
  bottle: "bottle", bottles: "bottle",
  jar: "jar", jars: "jar",
  bag: "bag", bags: "bag",
  bunch: "bunch", bunches: "bunch",
  head: "head", heads: "head",
  pinch: "pinch", pinches: "pinch",
  dash: "dash", dashes: "dash",
};

// Units written the same whether there is one or many.
const ABBREVIATIONS = new Set(["tsp", "tbsp", "lb", "oz", "g", "kg", "ml", "l", "pinch", "dash"]);

const UNICODE_FRACTIONS: Record<string, string> = { "½": "1/2", "¼": "1/4", "¾": "3/4", "⅓": "1/3", "⅔": "2/3", "⅛": "1/8" };

// One amount, understood: 1 1/2 tbsp -> { number: 1.5, unit: "tbsp", rest: "" }.
// `rest` is whatever follows the unit ("minced", "(20 oz)"); only amounts with the same rest add up.
interface Amount {
  number: number;
  unit: string;
  rest: string;
}

function parseNumber(text: string): number | null {
  const parts = text.trim().split(/\s+/);
  let total = 0;
  for (const part of parts) {
    const fraction = part.match(/^(\d+)\/(\d+)$/);
    if (fraction) {
      if (Number(fraction[2]) === 0) return null;
      total += Number(fraction[1]) / Number(fraction[2]);
    } else if (/^\d+(\.\d+)?$/.test(part)) {
      total += Number(part);
    } else {
      return null;
    }
  }
  return total;
}

function parseAmount(text: string): Amount | null {
  let clean = text.trim().toLowerCase().replace(/^(about|approx\.?|~)\s*/, "");
  for (const [symbol, plain] of Object.entries(UNICODE_FRACTIONS)) clean = clean.replace(symbol, ` ${plain} `);
  const match = clean.match(/^(\d+\/\d+|\d+(?:\.\d+)?(?:\s+\d+\/\d+)?)\s*([a-z]+)?\s*(.*)$/);
  if (!match) return null;
  const number = parseNumber(match[1]!);
  if (number === null || number <= 0) return null;
  const rawUnit = match[2] ?? "";
  const unit = UNIT_SPELLINGS[rawUnit] ?? rawUnit; // an unknown word ("large") stays as written
  return { number, unit, rest: (match[3] ?? "").trim() };
}

// "to taste", "a pinch of", "a dash": spoon-sized by their words, with no number.
function isSpoonWords(text: string): boolean {
  return /\bto taste\b/i.test(text) || /^(a\s+|an\s+)?(pinch|dash)\b/i.test(text.trim());
}

function isSpoonAmount(text: string): boolean {
  if (isSpoonWords(text)) return true;
  const amount = parseAmount(text);
  return amount !== null && SPOON_UNITS.has(amount.unit);
}

function plural(unit: string): string {
  return /(ch|sh|x|s)$/.test(unit) ? `${unit}es` : `${unit}s`;
}

function formatNumber(value: number): string {
  const whole = Math.floor(value + 1e-9);
  const left = value - whole;
  if (left < 0.01) return String(whole);
  for (const denominator of [2, 3, 4, 8]) {
    for (let top = 1; top < denominator; top++) {
      if (Math.abs(left - top / denominator) < 0.01) return whole > 0 ? `${whole} ${top}/${denominator}` : `${top}/${denominator}`;
    }
  }
  return String(Math.round(value * 100) / 100);
}

function formatAmount(amount: Amount): string {
  const unit = amount.unit === "" || ABBREVIATIONS.has(amount.unit) || amount.number <= 1 ? amount.unit : plural(amount.unit);
  return [formatNumber(amount.number), unit, amount.rest].filter((part) => part !== "").join(" ");
}

// The amount part of a line: everything from the first comma-separated piece that starts with a
// number ("chicken thighs, boneless, 2 lb" -> "2 lb"). With no such piece, whatever follows the
// first comma ("to taste", "a splash"), or nothing.
export function amountOf(text: string): string {
  const pieces = text.split(",").slice(1).map((piece) => piece.trim());
  const start = pieces.findIndex((piece) => /^(\d|[½¼¾⅓⅔⅛])/.test(piece));
  if (start !== -1) return pieces.slice(start).join(", ");
  return pieces.join(", ");
}

// ----- Merging lines for one item -----

// The key two lines share when they are the same item.
export function itemKey(text: string): string {
  return itemWords(text).join(" ");
}

// Whether a line, by itself, is only a pantry amount (spoon measures).
export function isPantryOnly(text: string): boolean {
  const amount = amountOf(text);
  return amount !== "" && isSpoonAmount(amount);
}

// One list line for all the ingredient lines of one item (they share an itemKey):
//   - same-unit numbers are added ("1 lb" + "1 lb" -> "2 lb"), other amounts sit side by side;
//   - spoon-sized amounts are dropped: pantry stuff shows the name alone, and next to a
//     purchasable amount ("1 bottle") only that amount stays;
//   - no amounts at all counts the lines ("white onion (x2)").
export function mergeItem(texts: string[]): string {
  const onlyOne = texts.length === 1;
  if (onlyOne && !isPantryOnly(texts[0]!)) return texts[0]!.trim();

  const name = onlyOne ? nameOf(texts[0]!) : shortestDisplayName(texts);
  const amounts = texts.map(amountOf);
  const buy = amounts.filter((amount) => amount !== "" && !isSpoonAmount(amount));
  const sawSpoon = amounts.some((amount) => amount !== "" && isSpoonAmount(amount));

  if (buy.length === 0) {
    if (sawSpoon) return name;
    return texts.length > 1 ? `${name} (x${texts.length})` : name;
  }
  const shown = addUp(buy);
  if (amounts.some((amount) => amount === "") && !sawSpoon) shown.push("as needed");
  return `${name}, ${shown.join(" + ")}`;
}

// The plainest spelling among the lines: fewest words, then first seen.
function shortestDisplayName(texts: string[]): string {
  let best = displayName(texts[0]!);
  for (const text of texts) {
    const name = displayName(text);
    if (name.split(/\s+/).length < best.split(/\s+/).length) best = name;
  }
  return best;
}

// Adds same-unit amounts together, in first-seen order. Amounts that are not "number unit" stay
// as written (once each).
function addUp(amounts: string[]): string[] {
  const totals = new Map<string, Amount>();
  const shown: Array<string | Amount> = [];
  for (const text of amounts) {
    const amount = parseAmount(text);
    if (!amount) {
      if (!shown.includes(text)) shown.push(text);
      continue;
    }
    const key = `${amount.unit}|${amount.rest}`;
    const seen = totals.get(key);
    if (seen) {
      seen.number += amount.number;
    } else {
      totals.set(key, amount);
      shown.push(amount);
    }
  }
  return shown.map((entry) => (typeof entry === "string" ? entry : formatAmount(entry)));
}
