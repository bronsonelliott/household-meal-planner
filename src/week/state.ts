// The week: one JSON file per target Monday, the transitions between its states, and the
// renderer for the seven lines and the grocery list.
//
// The state diagram this file implements (from the plan):
//
//   Empty    -> Seeding   an adult pins a night
//   Empty    -> Skipped   "skip next week"
//   Empty    -> Drafted   the scheduled draft time (Friday 4 PM by default)
//   Seeding  -> Drafted   the scheduled draft time, pins kept
//   Drafted  -> Drafted   swap, or an answer to the one question
//   Drafted  -> Locked    lock word
//   Locked   -> Locked    night changed before the week starts
//   Locked   -> Current   Monday rollover, the week is being eaten
//   Current  -> Current   future night changed (a past night report goes to the log)
//   Drafted  -> Lapsed    Monday arrives, never locked
//   Seeding  -> Lapsed    Monday arrives, never drafted
//   Skipped  -> Empty     "we're home after all"
//   Skipped  -> Seeding   a pin on the skipped week
//   Current  -> Done      the next Monday rollover
//
// Every transition function here is pure: it takes a week and returns a new one, and never
// touches a file. The worker decides when to save.
//
// The renderer's promise: a night's line depends only on that night's stored data, so
// a night nobody touched renders byte-for-byte the same as last time.

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomically } from "../data/files.ts";
import type { ScheduleConfig } from "../config.ts";
import { NIGHTS, type IngredientLine, type Night } from "../data/profile.ts";
import type { RecipeSnapshot } from "../recipes/types.ts";
import { capitalize } from "./changeset.ts";
import { isWaterOrIce, itemKey, mergeItem, nameContains } from "./grocery-merge.ts";

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type WeekStatus = "empty" | "seeding" | "skipped" | "drafted" | "locked" | "current" | "lapsed" | "done";

// Where a night's dish came from: the household's own lists, a saved or fetched recipe in the
// catalog, a model-suggested dish tied to a link source, or a plain new dish.
export type DishPool = "usual" | "also-like" | "catalog" | "source" | "new";

// What a night holds. "out" and "away" carry no protein and no list items.
export interface NightValue {
  kind: "dish" | "out" | "away";
  dish: string;
  rule: string | null; // the house rule shown on the draft line
  protein: string | null;
  tags: string[];
  pool: DishPool | null;
  ingredients: IngredientLine[]; // each tagged with its grocery section
  // The recipe or link this night came from, copied in when the night was set. Absent for the
  // household's own dishes and plain new dishes.
  recipe?: RecipeSnapshot | null;
}

// A night as stored in the week file: the value plus who put it there and when.
export interface WeekNight extends NightValue {
  pinnedBy: string | null; // an adult named this dish; the Friday draft keeps it
  changedBy: string | null;
  swappedFromDraft: boolean; // changed after the draft posted (logged at lock)
  changedAfterLock: boolean;
}

// One line of the grocery list as last posted, kept so a later change can post a delta.
export interface GroceryLine {
  section: string; // one of the household's grocery sections, or CHECK_SECTION
  key: string; // the ingredient name, normalized, for matching across lists
  text: string; // the line as shown, without the leading "- "
}

export interface WeekFile {
  weekOf: string; // the Monday, YYYY-MM-DD
  status: WeekStatus;
  nights: Record<Night, WeekNight | null>;
  have: string[]; // things the house already has; kept off the list
  lockedAt: string | null;
  postedList: GroceryLine[] | null; // the list as last posted, for deltas after lock
}

export const CHECK_SECTION = "Check before you buy";
export const DRAFT_QUESTION = "Anything to use up, or anything you want different this week?";

// ---------------------------------------------------------------------------------------------
// Dates. The household's clock is its configured time zone; all date math is on YYYY-MM-DD
// strings in UTC so daylight saving can never shift a day.
// ---------------------------------------------------------------------------------------------

// Building a formatter is slow and the scheduler asks every minute, so each zone's is kept.
const clockFormatters = new Map<string, Intl.DateTimeFormat>();

function clockFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = clockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    clockFormatters.set(timeZone, formatter);
  }
  return formatter;
}

// The local date, weekday (Monday = 0 ... Sunday = 6), and minutes since local midnight at the
// given instant, in the household's zone. Minutes are wall-clock minutes, so on the day clocks
// jump forward the skipped hour simply never appears, and on the day they fall back the repeated
// hour appears twice.
export function localTime(nowMs: number, timeZone: string): { date: string; weekday: number; minutes: number } {
  const parts = clockFormatter(timeZone).formatToParts(new Date(nowMs));
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return { date, weekday: weekdayIndex(date), minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

// The calendar date in the household's zone at the given instant.
export function localDate(nowMs: number, timeZone: string): string {
  return localTime(nowMs, timeZone).date;
}

// The first instant at which the household's wall clock reads `minutes` or later on `date`.
// When that time does not exist (clocks jumped over it), it is the first minute after the gap;
// when it happens twice (clocks fell back), it is the first of the two.
export function instantOfLocalTime(date: string, minutes: number, timeZone: string): number {
  const reached = (ms: number): boolean => {
    const local = localTime(ms, timeZone);
    return local.date > date || (local.date === date && local.minutes >= minutes);
  };
  // No zone is more than 15 hours from UTC, so a walk starting there begins before the target.
  let at = Date.parse(`${date}T00:00:00Z`) - 15 * 60 * MINUTE_MS;
  while (!reached(at)) at += 15 * MINUTE_MS;
  // The first minute is somewhere in the 15 minutes before this step.
  for (let back = 0; back < 14 && reached(at - MINUTE_MS); back++) at -= MINUTE_MS;
  return at;
}

const MINUTE_MS = 60_000;

// The draft deadline for a week's draft is the schedule's catch-up time in the week before it
// starts (Sunday noon by default). Past it the scheduler skips a week with no draft rather than
// post one.
export function beforeDraftDeadline(weekOf: string, nowMs: number, schedule: ScheduleConfig): boolean {
  const deadlineDay = addDays(weekOf, NIGHTS.indexOf(schedule.catchUpDay) - 7);
  const { date, minutes } = localTime(nowMs, schedule.timeZone);
  if (date !== deadlineDay) return date < deadlineDay;
  return minutes < schedule.catchUpMinutes;
}

// "noon" or "4:30 PM": a time of day in words, for messages and logs.
export function describeMinutes(minutes: number): string {
  if (minutes === 12 * 60) return "noon";
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  return `${shown}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

// "Sunday noon", the catch-up deadline in words.
export function describeCatchUp(schedule: ScheduleConfig): string {
  return `${capitalize(schedule.catchUpDay)} ${describeMinutes(schedule.catchUpMinutes)}`;
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Monday = 0 ... Sunday = 6, matching NIGHTS.
export function weekdayIndex(isoDate: string): number {
  const sundayFirst = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return (sundayFirst + 6) % 7;
}

export function mondayOf(isoDate: string): string {
  return addDays(isoDate, -weekdayIndex(isoDate));
}

export function nightDate(weekOf: string, night: Night): string {
  return addDays(weekOf, NIGHTS.indexOf(night));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-10-05" -> "Oct 5"
export function shortDate(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${MONTHS[Number(month) - 1]} ${Number(day)}`;
}

function weekSpan(weekOf: string): string {
  return `${shortDate(weekOf)} to ${shortDate(addDays(weekOf, 6))}`;
}

// ---------------------------------------------------------------------------------------------
// Week files: <weeksDir>/<weekOf>.json, written with temp-and-rename
// ---------------------------------------------------------------------------------------------

export function emptyWeek(weekOf: string): WeekFile {
  return {
    weekOf,
    status: "empty",
    nights: { monday: null, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null, sunday: null },
    have: [],
    lockedAt: null,
    postedList: null,
  };
}

export function weekPath(weeksDir: string, weekOf: string): string {
  return join(weeksDir, `${weekOf}.json`);
}

export function readWeekFile(path: string): WeekFile {
  return JSON.parse(readFileSync(path, "utf8")) as WeekFile;
}

// A week with no file yet is an empty week: the Monday rollover "opens" next week simply by
// the calendar moving on.
export function loadWeek(weeksDir: string, weekOf: string): WeekFile {
  const path = weekPath(weeksDir, weekOf);
  return existsSync(path) ? readWeekFile(path) : emptyWeek(weekOf);
}

export function saveWeek(weeksDir: string, week: WeekFile): void {
  mkdirSync(weeksDir, { recursive: true });
  writeFileAtomically(weekPath(weeksDir, week.weekOf), JSON.stringify(week, null, 2) + "\n");
}

// The Mondays of every stored week, oldest first.
export function storedWeeks(weeksDir: string): string[] {
  if (!existsSync(weeksDir)) return [];
  return readdirSync(weeksDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.slice(0, 10))
    .sort();
}

// ---------------------------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------------------------

function copyWeek(week: WeekFile): WeekFile {
  return structuredClone(week);
}

export interface NightChangeOptions {
  mode: "pin" | "swap";
  who: string;
  today: string; // the local date, to refuse changes to nights already past
}

export interface NightChangeResult {
  week: WeekFile;
  refused: string | null; // why nothing changed, for the reply
  note: string | null; // a one-line confirmation, e.g. a skipped week coming back on
}

// A pin or a swap on one night. A pin records the adult's name so the Friday draft keeps it.
export function changeNight(week: WeekFile, night: Night, value: NightValue, options: NightChangeOptions): NightChangeResult {
  const refuse = (reason: string): NightChangeResult => ({ week, refused: reason, note: null });
  const span = `the week of ${shortDate(week.weekOf)}`;

  if (week.status === "lapsed" || week.status === "done") {
    return refuse(`${capitalize(span)} is over, so I can't change it. If you want something logged, tell me what you had.`);
  }
  // A week whose Monday has already come. An empty or skipped week like this has no plan, and
  // the next job's Monday rollover lapses any empty or seeding week that has started, so a pin
  // here would quietly disappear. Refuse it now instead.
  const started = week.weekOf <= mondayOf(options.today);

  if (week.status === "skipped" && options.mode === "swap") {
    // "we're home after all" only ever un-skips the coming week, so don't suggest it once the
    // skipped week is under way.
    if (started) return refuse(`${capitalize(span)} was skipped and is already under way, so I can't change it.`);
    return refuse(`${capitalize(span)} is skipped. Say "we're home after all" to put it back on.`);
  }
  if ((week.status === "empty" || week.status === "skipped") && started) {
    return refuse(`${capitalize(span)} already started without a plan, so I'm not tracking it. Send changes for next week instead.`);
  }
  if (week.status === "current" && nightDate(week.weekOf, night) < options.today) {
    return refuse(`${capitalize(night)} has already passed. If you had something else, tell me and I'll log it.`);
  }

  const next = copyWeek(week);
  let note: string | null = null;

  // Skipped -> Seeding: a pin brings the week back, starting from empty.
  if (week.status === "skipped") {
    next.nights = emptyWeek(week.weekOf).nights;
    next.status = "seeding";
    note = `${capitalize(span)} is back on.`;
  }
  if (next.status === "empty") next.status = "seeding";

  next.nights[night] = {
    ...structuredClone(value),
    pinnedBy: options.mode === "pin" ? options.who : null,
    changedBy: options.who,
    swappedFromDraft: week.status === "drafted",
    changedAfterLock: week.status === "locked" || week.status === "current",
  };
  return { week: next, refused: null, note };
}

// The Friday draft: fills every night except the ones an adult pinned.
export function applyDraft(week: WeekFile, values: Partial<Record<Night, NightValue>>): WeekFile {
  const next = copyWeek(week);
  for (const night of NIGHTS) {
    const value = values[night];
    if (!value) continue;
    if (next.nights[night]?.pinnedBy) continue; // pins win over the draft
    next.nights[night] = {
      ...structuredClone(value),
      pinnedBy: null,
      changedBy: null,
      swappedFromDraft: false,
      changedAfterLock: false,
    };
  }
  next.status = "drafted";
  return next;
}

export function isComplete(week: WeekFile): boolean {
  return NIGHTS.every((night) => week.nights[night] !== null);
}

// A week filled on request before Friday ("draft it now") counts as drafted, so the Friday
// tick then posts nothing for it.
export function promoteIfComplete(week: WeekFile): WeekFile {
  if ((week.status === "empty" || week.status === "seeding") && isComplete(week)) {
    return { ...copyWeek(week), status: "drafted" };
  }
  return week;
}

export type LockResult = "locked" | "already-locked" | "nothing-to-lock";

export function lockWeek(week: WeekFile, atIso: string): { week: WeekFile; result: LockResult } {
  if (week.status === "drafted") {
    return { week: { ...copyWeek(week), status: "locked", lockedAt: atIso }, result: "locked" };
  }
  if (week.status === "locked" || week.status === "current") return { week, result: "already-locked" };
  return { week, result: "nothing-to-lock" };
}

// "skip next week" works any time before lock, so a trip that
// comes up after Friday's draft can still cancel the week. A skipped week keeps no nights.
export function skipWeek(week: WeekFile): { week: WeekFile; refused: string | null } {
  if (week.status === "skipped") return { week, refused: null };
  if (week.status !== "empty" && week.status !== "seeding" && week.status !== "drafted") {
    return {
      week,
      refused: `The week of ${shortDate(week.weekOf)} is already locked, so I didn't skip it. Change the nights to "away" instead.`,
    };
  }
  return { week: { ...emptyWeek(week.weekOf), status: "skipped" }, refused: null };
}

export function unskipWeek(week: WeekFile): { week: WeekFile; refused: string | null } {
  if (week.status !== "skipped") return { week, refused: `The week of ${shortDate(week.weekOf)} isn't skipped.` };
  return { week: emptyWeek(week.weekOf), refused: null };
}

export function addHave(week: WeekFile, items: string[]): WeekFile {
  const next = copyWeek(week);
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed === "") continue;
    if (next.have.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) continue;
    next.have.push(trimmed);
  }
  return next;
}

// Monday rollover for one stored week. `currentMonday` is the Monday of today's week.
// `lapsed` is true when the week just lapsed and needs its "not locked" log entry.
export function rolloverWeek(week: WeekFile, currentMonday: string): { week: WeekFile; lapsed: boolean } {
  if (week.weekOf > currentMonday) return { week, lapsed: false }; // not started yet
  const ended = addDays(week.weekOf, 7) <= currentMonday;

  switch (week.status) {
    case "empty":
    case "seeding":
    case "drafted":
      return { week: { ...copyWeek(week), status: "lapsed" }, lapsed: true };
    case "locked":
      return { week: { ...copyWeek(week), status: ended ? "done" : "current" }, lapsed: false };
    case "current":
      return ended ? { week: { ...copyWeek(week), status: "done" }, lapsed: false } : { week, lapsed: false };
    default:
      return { week, lapsed: false }; // skipped, lapsed, done: nothing more happens
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering the seven lines
// ---------------------------------------------------------------------------------------------

// "Tuesday: Chicken tacos (Mexican night, Sam's pick)". `extra` is a one-reply note, such as
// the other adult's request when two adults wanted different dishes for the same night.
export function renderNightLine(night: Night, value: WeekNight | null, extra?: string): string {
  const label = capitalize(night);
  if (value === null) return `${label}: (open)`;

  const details: string[] = [];
  if (value.rule) details.push(value.rule);
  if (value.pinnedBy) details.push(`${value.pinnedBy}'s pick`);
  if (extra) details.push(extra);
  const dish = details.length > 0 ? `${value.dish} (${details.join(", ")})` : value.dish;
  // The link goes last so nothing is stuck to the end of the address.
  return value.recipe ? `${label}: ${dish} · ${describeRecipeLink(value.recipe)}` : `${label}: ${dish}`;
}

// What a night's link is, in words: a model-suggested dish points at a site search, a saved
// recipe at its page.
export function describeRecipeLink(recipe: RecipeSnapshot): string {
  switch (recipe.origin) {
    case "source":
      return `suggested dish, search ${recipe.sourceName}: ${recipe.url}`;
    case "bookmark":
      return `saved recipe: ${recipe.url}`;
    case "fetched":
      return `recipe from ${recipe.sourceName}: ${recipe.url}`;
  }
}

export function renderWeekLines(week: WeekFile, extras: Partial<Record<Night, string>> = {}): string[] {
  return NIGHTS.map((night) => renderNightLine(night, week.nights[night], extras[night]));
}

// Signal shows no Markdown, so a "* " list would print its asterisks. A bullet character and
// blank lines between blocks are what make the week easy to scan on a phone.
const BULLET = "• ";

function bulleted(lines: string[]): string[] {
  return lines.map((line) => BULLET + line);
}

// The week restated after a change.
export function renderRestatedWeek(week: WeekFile, extras: Partial<Record<Night, string>> = {}): string {
  return [`Dinners for ${weekSpan(week.weekOf)}:`, "", ...bulleted(renderWeekLines(week, extras))].join("\n");
}

// The Friday draft: the seven lines, exactly one question, then any notes (a bent rule,
// the export's age, rules that were not checked), each block set off by a blank line.
export function renderDraft(week: WeekFile, options: { late: boolean; notes: string[] }): string {
  const header = `${options.late ? "(late) " : ""}Here's the draft for ${weekSpan(week.weekOf)}:`;
  const blocks = [header, bulleted(renderWeekLines(week)).join("\n"), DRAFT_QUESTION];
  if (options.notes.length > 0) blocks.push(options.notes.join("\n"));
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------------------------
// The grocery list
// ---------------------------------------------------------------------------------------------

// Builds the list from the week's nights: the household's grocery sections in their order, then
// the staples under "check before you buy". Anything on the have-list is left off, water and ice
// never appear, and a dish ingredient that is a staple goes only in the check block.
export function buildGroceryList(week: WeekFile, staples: string[], sections: readonly string[]): GroceryLine[] {
  const isHad = (text: string) => week.have.some((item) => nameContains(text, item));
  const isStaple = (text: string) => staples.some((staple) => nameContains(text, staple));

  // section -> key -> texts, in first-seen order
  const bySection = new Map<string, Map<string, string[]>>();
  for (const night of NIGHTS) {
    const value = week.nights[night];
    if (!value || value.kind !== "dish") continue;
    for (const line of value.ingredients) {
      if (isWaterOrIce(line.text) || isHad(line.text) || isStaple(line.text)) continue;
      const key = itemKey(line.text);
      if (!bySection.has(line.section)) bySection.set(line.section, new Map());
      const entries = bySection.get(line.section)!;
      if (!entries.has(key)) entries.set(key, []);
      entries.get(key)!.push(line.text.trim());
    }
  }

  const list: GroceryLine[] = [];
  for (const section of sections) {
    const entries = bySection.get(section);
    if (!entries) continue;
    for (const [key, texts] of entries) list.push({ section, key, text: mergeItem(texts) });
  }

  const hasAnyDish = NIGHTS.some((night) => week.nights[night]?.kind === "dish");
  if (hasAnyDish) {
    for (const staple of staples) {
      if (week.have.some((item) => nameContains(staple, item))) continue;
      list.push({ section: CHECK_SECTION, key: itemKey(staple), text: staple });
    }
  }
  return list;
}

export function renderGroceryList(week: WeekFile, list: GroceryLine[]): string {
  const out = [`Grocery list for ${weekSpan(week.weekOf)} (dinners only):`];
  let section: string | null = null;
  for (const line of list) {
    if (line.section !== section) {
      out.push("", line.section);
      section = line.section;
    }
    out.push(`- ${line.text}`);
  }
  return out.join("\n");
}

// What changed between the list as last posted and the list now, or null when nothing did.
export function renderListDelta(week: WeekFile, before: GroceryLine[], after: GroceryLine[]): string | null {
  const id = (line: GroceryLine) => `${line.section}|${line.key}`;
  const beforeById = new Map(before.map((line) => [id(line), line]));
  const afterById = new Map(after.map((line) => [id(line), line]));

  const adds = after.filter((line) => !beforeById.has(id(line))).map((line) => `Add (${line.section}): ${line.text}`);
  const drops = before.filter((line) => !afterById.has(id(line))).map((line) => `Drop (${line.section}): ${line.text}`);
  const changes = after
    .filter((line) => beforeById.has(id(line)) && beforeById.get(id(line))!.text !== line.text)
    .map((line) => `Change (${line.section}): ${line.text} (was ${beforeById.get(id(line))!.text})`);

  const lines = [...adds, ...drops, ...changes];
  if (lines.length === 0) return null;
  return [`List changes for ${weekSpan(week.weekOf)}:`, ...lines].join("\n");
}
