// The house profile: a hand-editable markdown file whose `##` headings are the parse contract.
//
// The admin edits it by hand from another computer, and the agent edits
// it when someone in the group uses explicit rule words. Two design choices follow from that:
//
// 1. Every agent write touches only the lines it adds or removes. The rest of the file is kept
//    byte for byte, so notes, comments, and unknown headings the admin wrote are never lost.
// 2. Every write is read-modify-write with a modification-time check and one retry, and lands
//    with temp-and-rename, so a hand edit that syncs in mid-write is not overwritten.

import { readFileSync, statSync, existsSync, rmSync } from "node:fs";
import { writeFileAtomically } from "./files.ts";

// ---------------------------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------------------------

// The grocery sections used when profile.md has no "## Grocery Sections" heading, in the
// order the list is printed. A household lists its own store layout under that heading.
export const DEFAULT_GROCERY_SECTIONS: readonly string[] = [
  "Fruits",
  "Vegetables",
  "Canned Goods",
  "Frozen Foods",
  "Meat & Fish",
  "Deli",
  "Spices",
  "Condiments",
  "Sauces & Oils",
  "Vegetarian",
  "Snacks",
  "Breads",
  "Beverages",
  "Dairy",
  "Pasta & Rice",
  "Baking",
  "Cereal",
];

// The listed section that matches `name` ignoring case and outer spaces, spelled as listed, or
// undefined when the name is not one of them.
export function matchGrocerySection(sections: readonly string[], name: string): string | undefined {
  const wanted = name.trim().toLowerCase();
  return sections.find((section) => section.toLowerCase() === wanted);
}

export const NIGHTS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Night = (typeof NIGHTS)[number];

// What "weeknights" covers is a household setting (planning.weeknights in config.toml).
export type NightTarget = Night | "weeknights";

// The typed form of a rule. Code can check every kind except "advisory", which only
// rides along in the prompt and is named as unchecked in each draft.
export type RuleCheck =
  | { kind: "min"; tag: string; count: number }
  | { kind: "max"; tag: string; count: number }
  | { kind: "fixed"; night: Night; value: string }
  | { kind: "require"; tag: string; nights: NightTarget }
  | { kind: "forbid"; tag: string; nights: NightTarget }
  | { kind: "advisory" };

export interface Rule {
  prose: string;
  check: RuleCheck;
}

export interface IngredientLine {
  section: string; // one of the profile's grocery sections
  text: string; // e.g. "chicken thighs, 2 lb"
}

export interface Dish {
  name: string;
  protein: string;
  tags: string[];
  ingredients: IngredientLine[];
  // True when the entry has no ingredient lines yet; the model fills them in at lock.
  needsModelIngredients: boolean;
}

export interface Dislike {
  person: string;
  what: string;
}

export interface Thresholds {
  maxUsualDishesPerWeek: number;
  maxNightsPerProtein: number;
  repeatWindowWeeks: number;
  batchingWindowSeconds: number;
}

export interface HouseProfile {
  rules: Rule[]; // in file order; the bottom rule is the first one dropped
  usualDishes: Dish[];
  alsoLikeDishes: Dish[];
  staples: string[];
  dislikes: Dislike[];
  vetoes: string[];
  lockWords: string[];
  thresholds: Thresholds;
  // The store sections an ingredient line may use, in print order.
  grocerySections: string[];
}

// What a drafting call sees of each profile dish: never the ingredient lines.
export interface DishIndexEntry {
  name: string;
  protein: string;
  tags: string[];
  pool: "usual" | "also-like";
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

// The fixed headings. Changing one of these strings changes the file format.
const HEADINGS = {
  rules: "Rules",
  usualDishes: "Usual Dishes",
  alsoLikeDishes: "Also-Like Dishes",
  staples: "Staples",
  dislikes: "Dislikes",
  vetoes: "Vetoes",
  lockWords: "Lock Words",
  thresholds: "Thresholds",
  grocerySections: "Grocery Sections", // optional: the default list is used when it is absent
} as const;

// Threshold keys as written in the file, mapped to their field names. A profile written for an
// older version may still carry other keys (such as an export-staleness one); unknown keys are
// ignored, so those profiles keep parsing.
const THRESHOLD_KEYS: Record<string, keyof Thresholds> = {
  "max-usual-dishes-per-week": "maxUsualDishesPerWeek",
  "max-nights-per-protein": "maxNightsPerProtein",
  "repeat-window-weeks": "repeatWindowWeeks",
  "batching-window-seconds": "batchingWindowSeconds",
};

const UNDO_WINDOW_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

export function readProfile(profilePath: string): HouseProfile {
  return parseProfile(readFileSync(profilePath, "utf8"));
}

// What the profile file says about the household's setup, shared by the bridge, the doctor and
// the house-rules interview:
//   setup-needed  there is no file, or it holds only whitespace
//   ready         it parses
//   error         it has text but cannot be read; the message says why. The file is never touched.
export type ProfileStatus =
  | { kind: "setup-needed" }
  | { kind: "ready"; profile: HouseProfile; text: string }
  | { kind: "error"; message: string };

export function readProfileStatus(profilePath: string): ProfileStatus {
  if (!existsSync(profilePath)) return { kind: "setup-needed" };
  let text: string;
  try {
    text = readFileSync(profilePath, "utf8");
  } catch (error) {
    return { kind: "error", message: `I couldn't read the profile at ${profilePath}: ${(error as Error).message}` };
  }
  if (text.trim() === "") return { kind: "setup-needed" };
  try {
    return { kind: "ready", profile: parseProfile(text), text };
  } catch (error) {
    return { kind: "error", message: error instanceof ProfileError ? error.message : (error as Error).message };
  }
}

export function parseProfile(text: string): HouseProfile {
  const lines = text.split("\n");
  const body = (heading: string): string[] => {
    const range = findSection(lines, heading);
    if (!range) {
      throw new ProfileError(`The house profile is missing the "## ${heading}" heading.`);
    }
    return lines.slice(range.start + 1, range.end);
  };

  // Read every section first so a missing heading is reported before anything else.
  const rulesBody = body(HEADINGS.rules);
  const usualBody = body(HEADINGS.usualDishes);
  const alsoLikeBody = body(HEADINGS.alsoLikeDishes);
  const staplesBody = body(HEADINGS.staples);
  const dislikesBody = body(HEADINGS.dislikes);
  const vetoesBody = body(HEADINGS.vetoes);
  const lockWordsBody = body(HEADINGS.lockWords);
  const thresholdsBody = body(HEADINGS.thresholds);

  const grocerySections = parseGrocerySections(lines);

  return {
    rules: listItems(rulesBody).map(parseRule),
    usualDishes: parseDishes(usualBody, grocerySections),
    alsoLikeDishes: parseDishes(alsoLikeBody, grocerySections),
    staples: listItems(staplesBody),
    dislikes: listItems(dislikesBody).map(parseDislike),
    vetoes: listItems(vetoesBody),
    lockWords: listItems(lockWordsBody),
    thresholds: parseThresholds(listItems(thresholdsBody)),
    grocerySections,
  };
}

// The optional "## Grocery Sections" list, one "- Section" per line. Absent means the default list;
// present but empty or repeating a name is a mistake worth stopping for.
function parseGrocerySections(lines: string[]): string[] {
  const range = findSection(lines, HEADINGS.grocerySections);
  if (!range) return [...DEFAULT_GROCERY_SECTIONS];
  const sections = listItems(lines.slice(range.start + 1, range.end));
  if (sections.length === 0) {
    throw new ProfileError(`The "## ${HEADINGS.grocerySections}" heading has no sections under it. List one "- Section" per line, or remove the heading to use the default list.`);
  }
  const seen = new Set<string>();
  for (const section of sections) {
    const key = section.toLowerCase();
    if (seen.has(key)) throw new ProfileError(`The grocery section "${section}" is listed twice under "## ${HEADINGS.grocerySections}".`);
    seen.add(key);
  }
  return sections;
}

export function compactDishIndex(profile: HouseProfile): DishIndexEntry[] {
  const index: DishIndexEntry[] = [];
  for (const dish of profile.usualDishes) {
    index.push({ name: dish.name, protein: dish.protein, tags: dish.tags, pool: "usual" });
  }
  for (const dish of profile.alsoLikeDishes) {
    index.push({ name: dish.name, protein: dish.protein, tags: dish.tags, pool: "also-like" });
  }
  return index;
}

// Finds a `## Heading` (case-insensitive) and returns the line range it owns:
// from the heading line up to, not including, the next `## ` heading.
function findSection(lines: string[], heading: string): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const name = level2Heading(lines[i]!);
    if (name === null) continue;
    if (start === -1) {
      if (name.toLowerCase() === heading.toLowerCase()) start = i;
    } else {
      return { start, end: i };
    }
  }
  return start === -1 ? null : { start, end: lines.length };
}

// Returns the heading text if the line is a `## ` heading (not `###`), otherwise null.
function level2Heading(line: string): string | null {
  const match = line.match(/^##(?!#)\s+(.+?)\s*$/);
  return match ? match[1]! : null;
}

// Returns the text of a markdown list item ("- x", "* x", or "1. x"), or null for any other line.
// A trailing HTML comment is dropped so notes like "<!-- why -->" can sit beside a value.
function listItemText(line: string): string | null {
  const withoutComment = line.replace(/<!--.*?-->/g, "").trim();
  const match = withoutComment.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
  return match ? match[1]!.trim() : null;
}

function listItems(bodyLines: string[]): string[] {
  const items: string[] = [];
  for (const line of bodyLines) {
    const item = listItemText(line);
    if (item !== null) items.push(item);
  }
  return items;
}

// "Friday is eating out. [fixed friday out]" -> prose plus typed check.
// A rule with no bracketed check is treated as advisory.
function parseRule(item: string): Rule {
  const match = item.match(/^(.*?)\s*\[([^\]]*)\]\s*$/);
  if (!match) return { prose: item, check: { kind: "advisory" } };
  return { prose: match[1]!, check: parseRuleCheck(match[2]!, item) };
}

function parseRuleCheck(spec: string, ruleText: string): RuleCheck {
  const words = spec.trim().toLowerCase().split(/\s+/);
  const [kind, first, second] = words;
  const unreadable = () =>
    new ProfileError(
      `The rule "${ruleText}" has a check I can't read: [${spec}]. ` +
        `Use [min TAG N], [max TAG N], [fixed DAY VALUE], [require TAG NIGHTS], [forbid TAG NIGHTS], or [advisory].`,
    );

  if (kind === "advisory" && words.length === 1) return { kind: "advisory" };
  if (words.length !== 3 || first === undefined || second === undefined) throw unreadable();

  if (kind === "min" || kind === "max") {
    const count = Number(second);
    if (!Number.isInteger(count) || count < 0) throw unreadable();
    return { kind, tag: first, count };
  }
  if (kind === "fixed") {
    if (!isNight(first)) throw unreadable();
    return { kind, night: first, value: second };
  }
  if (kind === "require" || kind === "forbid") {
    if (second !== "weeknights" && !isNight(second)) throw unreadable();
    return { kind, tag: first, nights: second as NightTarget };
  }
  throw unreadable();
}

function isNight(word: string): word is Night {
  return (NIGHTS as readonly string[]).includes(word);
}

// Dishes are `### Name` blocks; each list item under one is "Protein: x", "Tags: a, b",
// or "<Grocery Section>: <ingredient>".
function parseDishes(bodyLines: string[], sections: readonly string[]): Dish[] {
  const dishes: Dish[] = [];
  let current: { name: string; protein: string | null; tags: string[]; ingredients: IngredientLine[] } | null = null;

  const finish = () => {
    if (!current) return;
    if (!current.protein) {
      throw new ProfileError(`The dish "${current.name}" has no "Protein:" line.`);
    }
    dishes.push({
      name: current.name,
      protein: current.protein,
      tags: current.tags,
      ingredients: current.ingredients,
      needsModelIngredients: current.ingredients.length === 0,
    });
  };

  for (const line of bodyLines) {
    const dishHeading = line.match(/^###\s+(.+?)\s*$/);
    if (dishHeading) {
      finish();
      current = { name: dishHeading[1]!, protein: null, tags: [], ingredients: [] };
      continue;
    }
    const item = listItemText(line);
    if (item === null || current === null) continue; // prose between entries is ignored

    const colon = item.indexOf(":");
    if (colon === -1) {
      throw new ProfileError(`The dish "${current.name}" has a line without a "Section: item" form: "${item}".`);
    }
    const key = item.slice(0, colon).trim();
    const value = item.slice(colon + 1).trim();

    if (key.toLowerCase() === "protein") {
      current.protein = value.toLowerCase();
    } else if (key.toLowerCase() === "tags") {
      current.tags = splitTags(value);
    } else {
      const section = matchGrocerySection(sections, key);
      if (!section) {
        throw new ProfileError(
          `The dish "${current.name}" has an ingredient line whose section is not one of the grocery sections: "${item}". ` +
            `Sections are: ${sections.join(", ")}.`,
        );
      }
      current.ingredients.push({ section, text: value });
    }
  }
  finish();
  return dishes;
}

function splitTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0);
}

// "Riley: mushrooms" -> { person: "Riley", what: "mushrooms" }
function parseDislike(item: string): Dislike {
  const colon = item.indexOf(":");
  if (colon === -1) {
    throw new ProfileError(`The dislike "${item}" needs the form "Person: what they won't eat".`);
  }
  return { person: item.slice(0, colon).trim(), what: item.slice(colon + 1).trim() };
}

function parseThresholds(items: string[]): Thresholds {
  const found: Partial<Thresholds> = {};
  for (const item of items) {
    const colon = item.indexOf(":");
    if (colon === -1) continue;
    const field = THRESHOLD_KEYS[item.slice(0, colon).trim().toLowerCase()];
    if (!field) continue; // unknown keys are ignored, like unknown headings
    const value = Number(item.slice(colon + 1).trim());
    if (!Number.isFinite(value) || value < 0) {
      throw new ProfileError(`The threshold "${item}" needs a number.`);
    }
    found[field] = value;
  }
  for (const [key, field] of Object.entries(THRESHOLD_KEYS)) {
    if (found[field] === undefined) {
      throw new ProfileError(`The "## ${HEADINGS.thresholds}" section is missing "${key}".`);
    }
  }
  return found as Thresholds;
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

// Where the profile lives, and where the record of its last change is kept for "undo".
export interface ProfileFiles {
  profilePath: string;
  lastChangePath: string;
}

// Every change returns one line for the group. `changed` is false when nothing was written.
export interface ProfileChangeResult {
  changed: boolean;
  confirmation: string;
}

export interface NewDish {
  name: string;
  protein: string;
  tags: string[];
  ingredients: IngredientLine[];
}

// What "undo" needs: the whole file before and after the last agent change.
interface LastChange {
  at: string; // ISO time of the change
  who: string;
  description: string;
  before: string;
  after: string;
}

// Read-modify-write with a modification-time check. If the file changed between our read and
// our write (a hand edit syncing in), the edit is re-applied once to the fresh text. The result
// must still parse, so the agent never writes a profile it could not read back.
export function updateProfileText(
  profilePath: string,
  edit: (current: string) => string,
): { before: string; after: string } {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const mtimeAtRead = statSync(profilePath).mtimeMs;
    const current = readFileSync(profilePath, "utf8");
    const next = edit(current);
    parseProfile(next);

    if (statSync(profilePath).mtimeMs !== mtimeAtRead) continue; // changed underneath: try again

    writeFileAtomically(profilePath, next);
    return { before: current, after: next };
  }
  throw new ProfileError("The profile changed twice while I was writing to it, so I saved nothing. Try again.");
}

export function addRule(files: ProfileFiles, who: string, prose: string, check: RuleCheck, now = new Date()): ProfileChangeResult {
  const line = `- ${prose.trim()} [${formatRuleCheck(check)}]`;
  const checkNote =
    check.kind === "advisory" ? "advisory, so I won't check it" : `checked as: ${formatRuleCheck(check)}`;
  const description = `added the rule "${prose.trim()}" (${checkNote})`;
  commitChange(files, who, now, description, (text) => appendListItem(text, HEADINGS.rules, line));
  return confirm(who, description);
}

export function removeRule(files: ProfileFiles, who: string, prose: string, now = new Date()): ProfileChangeResult {
  const matches = (item: string) => sameWords(parseRule(item).prose, prose);
  const existing = readProfile(files.profilePath).rules.find((rule) => sameWords(rule.prose, prose));
  if (!existing) {
    return { changed: false, confirmation: `I couldn't find a rule matching "${prose}", so nothing changed.` };
  }
  const description = `dropped the rule "${existing.prose}"`;
  commitChange(files, who, now, description, (text) => removeListItem(text, HEADINGS.rules, matches));
  return confirm(who, description);
}

export function addVeto(files: ProfileFiles, who: string, dish: string, now = new Date()): ProfileChangeResult {
  const description = `vetoed "${dish.trim()}"; it won't be drafted again`;
  commitChange(files, who, now, description, (text) => appendListItem(text, HEADINGS.vetoes, `- ${dish.trim()}`));
  return confirm(who, description);
}

export function removeVeto(files: ProfileFiles, who: string, dish: string, now = new Date()): ProfileChangeResult {
  const existing = readProfile(files.profilePath).vetoes.find((veto) => sameWords(veto, dish));
  if (!existing) {
    return { changed: false, confirmation: `"${dish}" isn't on the veto list, so nothing changed.` };
  }
  const description = `took "${existing}" off the veto list`;
  commitChange(files, who, now, description, (text) =>
    removeListItem(text, HEADINGS.vetoes, (item) => sameWords(item, dish)),
  );
  return confirm(who, description);
}

// Dislikes are information, never bans: recording one changes nothing else.
export function addDislike(files: ProfileFiles, who: string, person: string, what: string, now = new Date()): ProfileChangeResult {
  const description = `noted that ${person.trim()} doesn't like ${what.trim()} (just noted; it can still be drafted)`;
  commitChange(files, who, now, description, (text) =>
    appendListItem(text, HEADINGS.dislikes, `- ${person.trim()}: ${what.trim()}`),
  );
  return confirm(who, description);
}

// Adds a dish entry with its (model-proposed) ingredient lines. The confirmation lists them
// so the admin can see them and hand-edit the profile if they're wrong.
export function addDish(
  files: ProfileFiles,
  who: string,
  pool: "usual" | "also-like",
  dish: NewDish,
  now = new Date(),
): ProfileChangeResult {
  const heading = pool === "usual" ? HEADINGS.usualDishes : HEADINGS.alsoLikeDishes;
  const block = [`### ${dish.name.trim()}`, `- Protein: ${dish.protein.trim().toLowerCase()}`];
  if (dish.tags.length > 0) block.push(`- Tags: ${dish.tags.join(", ")}`);
  for (const ingredient of dish.ingredients) block.push(`- ${ingredient.section}: ${ingredient.text}`);

  const ingredientSummary =
    dish.ingredients.length > 0
      ? dish.ingredients.map((i) => `${i.section}: ${i.text}`).join("; ")
      : "no ingredient lines yet";
  const description = `added "${dish.name.trim()}" to the ${heading.toLowerCase()} (${ingredientSummary})`;
  commitChange(files, who, now, description, (text) => appendBlock(text, heading, block));
  return confirm(who, description);
}

// Reverses the most recent agent change to the profile if it is under 30 minutes old and the
// file has not changed since (no later agent change and no hand edit), so undo is safe.
export function undoLastChange(files: ProfileFiles, who: string, now = new Date()): ProfileChangeResult {
  if (!existsSync(files.lastChangePath)) {
    return { changed: false, confirmation: "There's no recent profile change to undo." };
  }
  const last = JSON.parse(readFileSync(files.lastChangePath, "utf8")) as LastChange;

  if (now.getTime() - Date.parse(last.at) > UNDO_WINDOW_MS) {
    return {
      changed: false,
      confirmation: `The last profile change (${last.who} ${last.description}) is over 30 minutes old, so I left it. Ask me to drop or remove it instead.`,
    };
  }
  if (readFileSync(files.profilePath, "utf8") !== last.after) {
    return { changed: false, confirmation: "The profile has changed since that edit, so I left it as it is." };
  }

  updateProfileText(files.profilePath, (current) => {
    if (current !== last.after) {
      throw new ProfileError("The profile changed while I was undoing, so I left it as it is.");
    }
    return last.before;
  });
  rmSync(files.lastChangePath);
  return { changed: true, confirmation: `${who} undid the last change (${last.who} ${last.description}).` };
}

// Runs the edit and records what "undo" needs.
function commitChange(files: ProfileFiles, who: string, now: Date, description: string, edit: (text: string) => string): void {
  const { before, after } = updateProfileText(files.profilePath, edit);
  const record: LastChange = { at: now.toISOString(), who, description, before, after };
  writeFileAtomically(files.lastChangePath, JSON.stringify(record, null, 2));
}

// Writes the "undo" record for a change made some other way (the interview replacing the whole file).
export function recordLastChange(files: ProfileFiles, who: string, description: string, before: string, after: string, at: Date): void {
  const record: LastChange = { at: at.toISOString(), who, description, before, after };
  writeFileAtomically(files.lastChangePath, JSON.stringify(record, null, 2));
}

function confirm(who: string, description: string): ProfileChangeResult {
  return { changed: true, confirmation: `${who} ${description}. Say "undo" within 30 minutes to take it back.` };
}

export function formatRuleCheck(check: RuleCheck): string {
  switch (check.kind) {
    case "min":
    case "max":
      return `${check.kind} ${check.tag} ${check.count}`;
    case "fixed":
      return `fixed ${check.night} ${check.value}`;
    case "require":
    case "forbid":
      return `${check.kind} ${check.tag} ${check.nights}`;
    case "advisory":
      return "advisory";
  }
}

// Compares two phrases ignoring case, extra spaces, and trailing punctuation.
// Same text, ignoring case, spacing, and trailing punctuation.
export function sameWords(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
  return normalize(a) === normalize(b);
}

// --- Line-level edits. Each one changes only the lines it adds or removes. ---

function requireSection(lines: string[], heading: string): { start: number; end: number } {
  const range = findSection(lines, heading);
  if (!range) throw new ProfileError(`The house profile is missing the "## ${heading}" heading.`);
  return range;
}

// Index of the last non-blank line in a section (the heading itself if the section is empty).
function lastContentLine(lines: string[], range: { start: number; end: number }): number {
  let last = range.start;
  for (let i = range.start + 1; i < range.end; i++) {
    if (lines[i]!.trim() !== "") last = i;
  }
  return last;
}

// Defense in depth behind the schema check in brain/schema.ts. Each inserted line must stay one
// line and must not start a heading: a veto like "Liver\n## Lock Words\n- ok" would otherwise
// add a second "## Lock Words" section above the real one, and findSection reads the first match.
// The parse check in updateProfileText can't catch that, because the result still parses.
function checkInsertedLine(line: string, options: { mayBeHeading: boolean }): void {
  if (/[\r\n\u2028\u2029]/.test(line)) {
    throw new ProfileError(`I can't add ${JSON.stringify(line)} to the profile: it has a line break in it, so I saved nothing.`);
  }
  if (line.startsWith("#") && !options.mayBeHeading) {
    throw new ProfileError(`I can't add ${JSON.stringify(line)} to the profile: it would start a heading, so I saved nothing.`);
  }
}

// Adds one list item after the section's last line. If that last line is prose or the heading,
// a blank line goes first so the list stays readable.
function appendListItem(text: string, heading: string, itemLine: string): string {
  checkInsertedLine(itemLine, { mayBeHeading: false });
  const lines = text.split("\n");
  const last = lastContentLine(lines, requireSection(lines, heading));
  const followsListItem = listItemText(lines[last]!) !== null;
  const toInsert = followsListItem ? [itemLine] : ["", itemLine];
  lines.splice(last + 1, 0, ...toInsert);
  return lines.join("\n");
}

// Adds a `###` dish block after the section's last line, separated by a blank line.
function appendBlock(text: string, heading: string, blockLines: string[]): string {
  // The block's first line is its own `### Name` heading; no other line may be a heading.
  blockLines.forEach((line, i) => checkInsertedLine(line, { mayBeHeading: i === 0 }));
  const lines = text.split("\n");
  const last = lastContentLine(lines, requireSection(lines, heading));
  lines.splice(last + 1, 0, "", ...blockLines);
  return lines.join("\n");
}

// Removes the first list item in the section whose text matches.
function removeListItem(text: string, heading: string, matches: (item: string) => boolean): string {
  const lines = text.split("\n");
  const range = requireSection(lines, heading);
  for (let i = range.start + 1; i < range.end; i++) {
    const item = listItemText(lines[i]!);
    if (item !== null && matches(item)) {
      lines.splice(i, 1);
      return lines.join("\n");
    }
  }
  throw new ProfileError(`Nothing under "## ${heading}" matched, so nothing changed.`);
}
