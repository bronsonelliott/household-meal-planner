// The change set: what the model hands back for one batch.
//
// The model never touches a file. It returns an ordered list of operations; the harness
// checks each one (the provenance checks below), works out which week it targets, and
// applies it. The brain module wraps this type in schema validation; this file stays plain types plus the
// small word checks the harness runs on the source messages.

import type { IngredientLine, NewDish, Night, RuleCheck } from "../data/profile.ts";
import type { DishPool } from "./state.ts";

// Every action the model may name (the full list is below).
export const ACTIONS = [
  "swap", // the agent picks a different dish for a night the adults asked to change
  "pin", // an adult named the dish for a night; kept through the Friday draft
  "lock",
  "rule",
  "veto",
  "dislike",
  "report", // a past night reported ("we did pizza instead"), logged under the current week
  "skip",
  "unskip",
  "undo",
  "remove", // drop a rule or take a dish off the veto list
  "have", // the house already has these; they stay off the list
  "add-dish", // add a dish to the usual or also-like list
  "none",
] as const;
export type Action = (typeof ACTIONS)[number];

// What goes on a night. Profile dishes are named exactly as in the dish index and catalog
// recipes by their id; only a new dish carries its own protein and ingredients. A "source" dish
// is one the model suggests, tied to a configured link source (the program builds the search link).
export type DishChoice =
  | { kind: "profile"; name: string }
  | { kind: "catalog"; id: string; tags: string[] }
  | { kind: "source"; sourceId: string; name: string; protein?: string; tags: string[] }
  | { kind: "new"; name: string; protein: string; tags: string[]; ingredients: IngredientLine[] }
  | { kind: "out" }
  | { kind: "away" };

export interface NightChange {
  night: Night;
  dish: DishChoice;
  // The house rule this night satisfies, as the draft line shows it, e.g. "Mexican night".
  rule: string | null;
}

// Every operation names the message it came from. For the Friday draft that "message" is
// the tick's trigger ID, which the worker hands the brain.
type Base = { sourceMessageId: string };

export type Operation =
  | (Base & { action: "swap"; nights: NightChange[] })
  | (Base & { action: "pin"; nights: NightChange[] })
  | (Base & { action: "lock" })
  | (Base & { action: "rule"; prose: string; check: RuleCheck })
  | (Base & { action: "veto"; dish: string })
  | (Base & { action: "dislike"; person: string; what: string })
  | (Base & { action: "report"; text: string })
  | (Base & { action: "skip" })
  | (Base & { action: "unskip" })
  | (Base & { action: "undo" })
  | (Base & { action: "remove"; list: "rules" | "vetoes"; text: string })
  | (Base & { action: "have"; items: string[] })
  | (Base & { action: "add-dish"; pool: "usual" | "also-like"; dish: NewDish })
  | (Base & { action: "none" });

export interface ChangeSet {
  operations: Operation[];
}

// At lock, any dinner without ingredient lines is sent back to the model for just those
// nights. These are the question and the answer.
export interface IngredientRequest {
  weekOf: string;
  night: Night;
  dish: string;
  pool: DishPool;
  // The publisher's own ingredient lines for a fetched recipe; null for every other dish.
  publisherLines: string[] | null;
}

export interface IngredientFill {
  weekOf: string;
  night: Night;
  dish: string;
  ingredients: IngredientLine[];
}

// ---------------------------------------------------------------------------------------------
// Provenance checks. The one-way actions only survive when the words are really in the
// message they cite, so a misread message or text inside a scraped recipe cannot lock a week
// or change the profile.
// ---------------------------------------------------------------------------------------------

// Curly apostrophes from phones become straight ones, and everything is lowercased.
function plain(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'");
}

// Words that turn "lock it" into "don't lock it". Checked only in the same clause, before the
// phrase, so "No, lock it" still locks.
const NEGATION = /\b(don't|dont|do not|not|never|won't|wont|can't|cant|cannot|shouldn't|shouldnt|wouldn't|wouldnt)\b/;

// Splits a message into clauses at punctuation and at "but".
function clauses(text: string): string[] {
  return plain(text).split(/[,.;!?\n]|\bbut\b/);
}

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// True when `phrase` appears in `text` at least once without a negation before it in its clause.
function saysWithoutNegation(text: string, phrase: RegExp): boolean {
  for (const clause of clauses(text)) {
    const match = clause.match(phrase);
    if (!match || match.index === undefined) continue;
    const before = clause.slice(0, match.index);
    if (!NEGATION.test(before)) return true;
  }
  return false;
}

// A lock word from the profile, outside a negation.
export function containsLockWord(text: string, lockWords: string[]): boolean {
  return lockWords.some((word) => {
    const phrase = new RegExp(`\\b${escapeForRegex(plain(word).trim())}\\b`);
    return saysWithoutNegation(text, phrase);
  });
}

// The explicit words that may change the profile. "never mind" is not "never".
const EXPLICIT_RULE_LANGUAGE: RegExp[] = [
  /\badd (a |the |this |that |another )?rule\b/,
  /\bnever\b(?!\s+mind\b)/,
  /\balways\b/,
  /\bfrom now on\b/,
  /\badd\b.*\bto (the )?(usual|also[- ]like)\b/,
  /\bdrop the rule\b/,
  /\bremove\b.*\bfrom the\b/,
  /\btake\b.*\boff the\b/,
];

// Each pattern must appear outside a negation, so "don't add a rule banning fish" changes nothing.
export function hasExplicitRuleLanguage(text: string): boolean {
  return EXPLICIT_RULE_LANGUAGE.some((pattern) => saysWithoutNegation(text, pattern));
}

// Short and generic words that say nothing about which dish or rule is meant. Without this
// list, "add a rule" would "name" any rule that happens to contain the word "rule".
const NOT_CONTENT = new Set([
  "the", "and", "with", "for", "our", "that", "this", "from", "now", "rule", "add", "never",
  "always", "again", "make", "have", "want", "please", "week", "night",
]);

// Lowercase words with the punctuation stripped ("don't" becomes "dont").
function words(text: string): string[] {
  return plain(text).replace(/'/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ");
}

// The words in `text` that could name a dish or a rule: three letters or more, minus the
// generic words above.
function contentWords(text: string): string[] {
  return words(text).filter((word) => word.length >= 3 && !NOT_CONTENT.has(word));
}

// True when at least one content word of `subject` (a dish name, a rule) is in the message.
function messageNames(sourceText: string, subject: string): boolean {
  const messageWords = new Set(words(sourceText));
  return contentWords(subject).some((word) => messageWords.has(word));
}

// The rule words alone are not enough: "We never have time on Tuesdays" has "never" in it
// but says nothing about tacos. The message has to name the thing that is changing.
function namesTheChange(op: Operation, sourceText: string, menuDishes: string[]): boolean {
  switch (op.action) {
    case "add-dish":
      return messageNames(sourceText, op.dish.name);
    case "remove":
      return messageNames(sourceText, op.text);
    case "rule":
      return messageNames(sourceText, op.prose);
    case "veto": {
      // "Never again" about tonight's dish rarely repeats its name, so a dish that is on
      // one of the two live weeks counts as named.
      const wanted = op.dish.trim().toLowerCase();
      const onTheMenu = menuDishes.some((dish) => dish.trim().toLowerCase() === wanted);
      return onTheMenu || messageNames(sourceText, op.dish);
    }
    default:
      return true;
  }
}

const SKIP_THE_WEEK = /\bskip\b[^,.;!?\n]*\bweek\b/;

export function saysSkipTheWeek(text: string): boolean {
  return saysWithoutNegation(text, SKIP_THE_WEEK);
}

// "we're home after all", "unskip", or a negated skip ("don't skip next week").
export function saysHomeAfterAll(text: string): boolean {
  const lower = plain(text);
  if (/\bhome after all\b/.test(lower) || /\bunskip\b/.test(lower)) return true;
  return SKIP_THE_WEEK.test(lower) && !saysSkipTheWeek(text);
}

// Why an operation must be dropped, or null when it passes. `sourceText` is undefined when
// the operation names a message that is not in this batch. `menuDishes` is the dish names on
// the nights of the current and coming weeks, so a veto can point at a dish on the menu.
export function provenanceProblem(
  op: Operation,
  sourceText: string | undefined,
  lockWords: string[],
  menuDishes: string[] = [],
): string | null {
  if (sourceText === undefined) return "it pointed at a message that isn't part of this conversation";
  switch (op.action) {
    case "lock":
      return containsLockWord(sourceText, lockWords) ? null : "the message didn't say to lock it";
    case "rule":
    case "veto":
    case "remove":
    case "add-dish":
      if (!hasExplicitRuleLanguage(sourceText)) {
        return 'house rules only change on words like "add a rule," "never," "always," or "from now on"';
      }
      return namesTheChange(op, sourceText, menuDishes) ? null : "the message didn't name what to change";
    case "undo":
      return saysWithoutNegation(sourceText, /\bundo\b/) ? null : 'the message didn\'t say "undo"';
    case "skip":
      return saysSkipTheWeek(sourceText) ? null : "the message didn't say to skip the week";
    case "unskip":
      return saysHomeAfterAll(sourceText) ? null : "the message didn't say you're home after all";
    default:
      return null;
  }
}

// A short description for "I didn't ..." lines.
export function describeOperation(op: Operation): string {
  switch (op.action) {
    case "lock":
      return "lock the week";
    case "rule":
      return `add the rule "${op.prose}"`;
    case "veto":
      return `veto "${op.dish}"`;
    case "remove":
      return `remove "${op.text}"`;
    case "add-dish":
      return `add "${op.dish.name}" to the ${op.pool} dishes`;
    case "undo":
      return "undo the last change";
    case "skip":
      return "skip next week";
    case "unskip":
      return "put next week back on";
    case "swap":
    case "pin":
      return `change ${op.nights.map((change) => capitalize(change.night)).join(" and ")}`;
    case "dislike":
      return `note that ${op.person} doesn't like ${op.what}`;
    case "report":
      return "log that report";
    case "have":
      return "note what you already have";
    case "none":
      return "do anything";
  }
}

// Puts operations in message order (the order the messages arrived in the batch). Within
// one message a lock goes last, so "Tuesday tacos, we have tortillas, lock it" lands as
// swap, have-list, then lock even if the model listed the lock first.
export function inMessageOrder(ops: Operation[], messageIds: string[]): Operation[] {
  const position = (op: Operation) => {
    const index = messageIds.indexOf(op.sourceMessageId);
    return index === -1 ? messageIds.length : index;
  };
  return ops
    .map((op, originalIndex) => ({ op, originalIndex }))
    .sort((a, b) => {
      const byMessage = position(a.op) - position(b.op);
      if (byMessage !== 0) return byMessage;
      const aLock = a.op.action === "lock" ? 1 : 0;
      const bLock = b.op.action === "lock" ? 1 : 0;
      if (aLock !== bLock) return aLock - bLock;
      return a.originalIndex - b.originalIndex;
    })
    .map((entry) => entry.op);
}

export function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
