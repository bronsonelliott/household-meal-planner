// Reading a recipe out of a web page.
//
// Recipe sites describe their recipes in a machine-readable block in the page:
//   <script type="application/ld+json"> { "@type": "Recipe", "name": ..., ... } </script>
// We read only that block, as plain data (JSON.parse). We never run a page's scripts and never
// fetch the "@context" address a block mentions.
//
// A page counts as a recipe only when it has a name and at least three ingredient lines.

import { parse } from "node-html-parser";
import { hostMatches, hostOf } from "../url.ts";

export const MIN_INGREDIENTS = 3;
const MAX_LINES = 100; // ingredient or instruction lines kept
const MAX_LINE_LENGTH = 1000;
const MAX_CATEGORIES = 15;

export interface ParsedRecipe {
  name: string;
  ingredients: string[];
  instructions: string[];
  categories: string[];
  totalMinutes?: number;
}

export interface ParsedPage {
  recipe: ParsedRecipe | null;
  // The page's own preferred address when it names one on the same site, else null.
  canonical: string | null;
}

export function parseRecipePage(html: string, pageUrl: string): ParsedPage {
  let root;
  try {
    root = parse(html, { blockTextElements: { script: true, noscript: false, style: false } });
  } catch {
    return { recipe: null, canonical: null };
  }

  let recipe: ParsedRecipe | null = null;
  for (const script of root.querySelectorAll("script")) {
    if (!/ld\+json/i.test(script.getAttribute("type") ?? "")) continue;
    const data = parseJson(script.rawText);
    if (data === undefined) continue; // malformed: skip this block, others may be fine
    for (const node of recipeNodes(data)) {
      recipe = readRecipe(node);
      if (recipe) break;
    }
    if (recipe) break;
  }

  return { recipe, canonical: canonicalOf(root.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null, pageUrl) };
}

function parseJson(raw: string): unknown {
  // Some sites wrap the JSON in a comment or CDATA marker.
  const cleaned = raw.trim().replace(/^<!--/, "").replace(/-->$/, "").replace(/^\/\*\s*<!\[CDATA\[\s*\*\//, "").replace(/\/\*\s*\]\]>\s*\*\/$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

function canonicalOf(href: string | null, pageUrl: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, pageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    const page = new URL(pageUrl);
    return hostMatches(hostOf(url), hostOf(page)) || hostMatches(hostOf(page), hostOf(url)) ? url.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Finding Recipe objects in the JSON
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

// Every Recipe object in a block: at the top, in an array, in "@graph", or as a "mainEntity".
function recipeNodes(data: unknown, depth = 0): Json[] {
  if (depth > 4) return [];
  if (Array.isArray(data)) return data.flatMap((item) => recipeNodes(item, depth + 1));
  if (!isObject(data)) return [];
  const found = isRecipe(data) ? [data] : [];
  return [...found, ...recipeNodes(data["@graph"], depth + 1), ...recipeNodes(data["mainEntity"], depth + 1)];
}

// "@type" can be "Recipe", ["Recipe", "Thing"], or carry a prefix ("schema:Recipe").
function isRecipe(node: Json): boolean {
  const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
  return types.some((type) => typeof type === "string" && /(^|[:/#])recipe$/i.test(type.trim()));
}

function readRecipe(node: Json): ParsedRecipe | null {
  const name = oneLine(plainText(node["name"]));
  const ingredients = lines(node["recipeIngredient"] ?? node["ingredients"]);
  if (name === "" || ingredients.length < MIN_INGREDIENTS) return null;

  const categories = unique([...words(node["recipeCategory"]), ...words(node["recipeCuisine"]), ...words(node["keywords"])]).slice(0, MAX_CATEGORIES);
  const total = durationMinutes(node["totalTime"]) ?? sumOf(durationMinutes(node["prepTime"]), durationMinutes(node["cookTime"]));
  return {
    name: name.slice(0, MAX_LINE_LENGTH),
    ingredients,
    instructions: instructionLines(node["recipeInstructions"]),
    categories,
    ...(total !== undefined ? { totalMinutes: total } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", frac12: "1/2", frac14: "1/4", frac34: "3/4", deg: "°" };

// Page text can contain tags and character references ("&amp;", "&#189;"). Both are cleaned.
function plainText(value: unknown): string {
  const raw = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (whole, code: string) => {
      if (code[0] === "#") {
        const point = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isInteger(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : whole;
      }
      return ENTITIES[code.toLowerCase()] ?? whole;
    });
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

// A string or an array of strings, as clean non-empty lines.
function lines(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((item) => (typeof item === "string" ? [item] : []))
    .map((item) => oneLine(plainText(item)).slice(0, MAX_LINE_LENGTH))
    .filter((item) => item !== "")
    .slice(0, MAX_LINES);
}

// Comma-separated words ("a, b") or an array of them.
function words(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((item) => (typeof item === "string" ? plainText(item).split(",") : []))
    .map((item) => oneLine(item))
    .filter((item) => item !== "" && item.length <= 60);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Instructions come as one string, a list of strings, a list of HowToStep objects, or
// HowToSection objects that hold steps. Everything becomes a flat list of step texts.
function instructionLines(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === undefined || value === null) return [];
  if (typeof value === "string") {
    return plainText(value)
      .split(/\r\n|\r|\n/)
      .map((line) => oneLine(line).slice(0, MAX_LINE_LENGTH))
      .filter((line) => line !== "")
      .slice(0, MAX_LINES);
  }
  if (Array.isArray(value)) return value.flatMap((item) => instructionLines(item, depth + 1)).slice(0, MAX_LINES);
  if (!isObject(value)) return [];
  if (value["itemListElement"] !== undefined) return instructionLines(value["itemListElement"], depth + 1); // a section
  const text = oneLine(plainText(value["text"] ?? value["name"]));
  return text === "" ? [] : [text.slice(0, MAX_LINE_LENGTH)];
}

// ---------------------------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------------------------

// "PT1H30M" -> 90, "P0DT45M" -> 45, "P1DT2H" -> 1560. Undefined when it is not a duration or is zero.
export function durationMinutes(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!match) return undefined;
  const [, weeks, days, hours, minutes, seconds] = match.map((part) => (part === undefined ? 0 : Number(part))) as number[];
  const total = Math.round(weeks! * 10080 + days! * 1440 + hours! * 60 + minutes! + seconds! / 60);
  return total > 0 ? total : undefined;
}

function sumOf(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}
