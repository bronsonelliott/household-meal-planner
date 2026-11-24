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

// Words after the name that change what you put in the cart, so lines that differ in them stay
// separate items ("chicken thighs, bone-in" is not "chicken thighs, boneless"). Anything not in
// this list ("chopped", "diced", "minced", "sliced") is only about preparing it, and is dropped
// when lines are merged.
const QUALIFIERS = new Set([
  "boneless", "bone-in", "skinless", "skin-on",
  "ground", "whole",
  "fresh", "frozen", "canned", "dried", "raw", "cooked", "smoked",
  "low-sodium", "reduced-sodium", "unsalted", "salted", "unsweetened", "sweetened",
  "low-fat", "fat-free", "lean",
]);

// Two-word spellings of the hyphenated qualifiers above.
const QUALIFIER_SPELLINGS: Array<[RegExp, string]> = [
  [/\bbone in\b/g, "bone-in"],
  [/\bskin on\b/g, "skin-on"],
  [/\blow sodium\b/g, "low-sodium"],
  [/\breduced sodium\b/g, "reduced-sodium"],
  [/\blow fat\b/g, "low-fat"],
  [/\bfat free\b/g, "fat-free"],
];

// Whole names that mean the same shopping item, mapped to one name.
const SAME_ITEM: Record<string, string> = {
  "black pepper": "pepper",
  "ground black pepper": "pepper",
  "ground pepper": "pepper",
  "cracked black pepper": "pepper",
};

// Yellow and brown onions are what a recipe means by plain "onion". Red, white, sweet and green
// onions, scallions and shallots are different things to buy, so they are not listed. Kept apart
// from SAME_ITEM so a staple "onion" still matches "red onion" the way it always did.
const SAME_ITEM_FOR_MERGING: Record<string, string> = {
  "yellow onion": "onion",
  "brown onion": "onion",
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
  const unified = SAME_ITEM[words.join(" ")] ?? SAME_ITEM_FOR_MERGING[words.join(" ")];
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
//
// Names with a "same item" alias ("black pepper" is just "pepper") are compared exactly instead:
// once collapsed, "pepper" is too short a word to search inside other names, and a "black pepper"
// staple must not hide "red pepper".
export function nameContains(ingredient: string, item: string): boolean {
  if (isAliased(item)) return sameWords(itemWords(ingredient), itemWords(item));
  return wordsContain(nameWords(ingredient), nameWords(item)) || wordsContain(itemWords(ingredient), itemWords(item));
}

// True when the name is one of the "same item" spellings, or the plain name they collapse to.
function isAliased(text: string): boolean {
  const collapsed = itemWords(text).join(" ");
  return Object.values(SAME_ITEM).includes(collapsed);
}

function sameWords(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((word, i) => word === b[i]);
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

// Every vulgar fraction character, written as plain "top/bottom".
const UNICODE_FRACTIONS: Record<string, string> = {
  "½": "1/2", "⅓": "1/3", "⅔": "2/3", "¼": "1/4", "¾": "3/4",
  "⅕": "1/5", "⅖": "2/5", "⅗": "3/5", "⅘": "4/5", "⅙": "1/6", "⅚": "5/6",
  "⅐": "1/7", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8", "⅑": "1/9", "⅒": "1/10",
};
const FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join("");
const STARTS_WITH_NUMBER = new RegExp(`^(\\d|[${FRACTION_CHARS}])`);

// A number as people write it in a recipe: 2, 1.5, 1/2, 1 1/2.
const NUMBER = String.raw`\d+\/\d+|\d+(?:\.\d+)?(?:\s+\d+\/\d+)?`;
const RANGE = new RegExp(String.raw`^(${NUMBER})\s*(?:-|–|—|to)\s*(${NUMBER})\s*([a-z]+)?\s*(.*)$`);
const SINGLE = new RegExp(String.raw`^(${NUMBER})\s*([a-z]+)?\s*(.*)$`);

// One amount, understood: 1 1/2 tbsp -> { number: 1.5, unit: "tbsp", rest: "" }.
// `rest` is whatever follows the unit ("minced", "(20 oz)"); only amounts with the same rest add up.
// A range ("1-2", "1 to 2") keeps its top end in `high`; adding two amounts adds both ends.
interface Amount {
  number: number;
  high?: number;
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
  for (const [symbol, plain] of Object.entries(UNICODE_FRACTIONS)) clean = clean.split(symbol).join(` ${plain} `);
  clean = clean.replace(/\s+/g, " ").trim();

  const range = clean.match(RANGE);
  if (range) {
    const low = parseNumber(range[1]!);
    const high = parseNumber(range[2]!);
    if (low === null || high === null || low <= 0 || high < low) return null;
    const rawUnit = range[3] ?? "";
    return { number: low, high, unit: UNIT_SPELLINGS[rawUnit] ?? rawUnit, rest: (range[4] ?? "").trim() };
  }

  const match = clean.match(SINGLE);
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
  for (const denominator of [2, 3, 4, 5, 6, 8]) {
    for (let top = 1; top < denominator; top++) {
      if (Math.abs(left - top / denominator) < 0.01) return whole > 0 ? `${whole} ${top}/${denominator}` : `${top}/${denominator}`;
    }
  }
  return String(Math.round(value * 100) / 100);
}

function formatAmount(amount: Amount): string {
  const top = amount.high ?? amount.number;
  const unit = amount.unit === "" || ABBREVIATIONS.has(amount.unit) || top <= 1 ? amount.unit : plural(amount.unit);
  const shown = top !== amount.number ? `${formatNumber(amount.number)}-${formatNumber(top)}` : formatNumber(top);
  return [shown, unit, amount.rest].filter((part) => part !== "").join(" ");
}

// The amount part of a line: everything from the first comma-separated piece that starts with a
// number ("chicken thighs, boneless, 2 lb" -> "2 lb"). With no such piece, whatever follows the
// first comma ("to taste", "a splash"), or nothing.
export function amountOf(text: string): string {
  const pieces = text.split(",").slice(1).map((piece) => piece.trim());
  const start = pieces.findIndex((piece) => STARTS_WITH_NUMBER.test(piece));
  if (start !== -1) return pieces.slice(start).join(", ");
  return pieces.join(", ");
}

// ----- Merging lines for one item -----

// The qualifier words between the name and the amount, in the order written:
// "chicken thighs, boneless skinless, 2 lb" -> ["boneless", "skinless"]. Prep words are ignored,
// and so is a qualifier the name already carries ("ground beef, ground").
export function qualifiersOf(text: string): string[] {
  const pieces = text.split(",").slice(1).map((piece) => piece.trim());
  const amountStart = pieces.findIndex((piece) => STARTS_WITH_NUMBER.test(piece));
  const before = amountStart === -1 ? pieces : pieces.slice(0, amountStart);
  let words = before.join(" ").toLowerCase().replace(/freshly ground/g, " ");
  for (const [spelling, standard] of QUALIFIER_SPELLINGS) words = words.replace(spelling, standard);
  const found: string[] = words.match(/[a-z]+(?:-[a-z]+)*/g) ?? [];
  const inName = nameWords(text);
  return found.filter((word, i) => QUALIFIERS.has(word) && found.indexOf(word) === i && !inName.includes(word));
}

// The key two lines share when they are the same item: the name, plus any qualifier that
// changes what you buy (so boneless and bone-in thighs never merge).
export function itemKey(text: string): string {
  const name = itemWords(text).join(" ");
  const qualifiers = qualifiersOf(text).sort();
  return qualifiers.length === 0 ? name : `${name} (${qualifiers.join(" ")})`;
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

  const qualifiers = qualifiersOf(texts[0]!);
  const baseName = onlyOne ? nameOf(texts[0]!) : shortestDisplayName(texts);
  const name = qualifiers.length > 0 && !onlyOne ? `${baseName}, ${qualifiers.join(" ")}` : baseName;
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

// Adds same-unit amounts together, in first-seen order. Amounts that are not "number unit" are
// never merged away: each stays as written, and identical ones are counted ("juice of 1 lemon (x2)").
function addUp(amounts: string[]): string[] {
  const totals = new Map<string, Amount>();
  const shown: Array<string | Amount> = [];
  const unparsed = new Map<string, number>();
  for (const text of amounts) {
    const amount = parseAmount(text);
    if (!amount) {
      unparsed.set(text, (unparsed.get(text) ?? 0) + 1);
      if (unparsed.get(text) === 1) shown.push(text);
      continue;
    }
    const key = `${amount.unit}|${amount.rest}`;
    const seen = totals.get(key);
    if (seen) {
      seen.high = (seen.high ?? seen.number) + (amount.high ?? amount.number);
      seen.number += amount.number;
    } else {
      totals.set(key, amount);
      shown.push(amount);
    }
  }
  return shown.map((entry) => {
    if (typeof entry !== "string") return formatAmount(entry);
    const count = unparsed.get(entry) ?? 1;
    return count > 1 ? `${entry} (x${count})` : entry;
  });
}
