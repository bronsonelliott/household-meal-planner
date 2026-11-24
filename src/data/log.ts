// The dinner log: an append-only markdown file with one entry per week.
//
// The admin reads it from another computer; the agent reads the recent weeks back for the repeat
// window. Each entry is a `## Week of YYYY-MM-DD` heading followed by "- Key: value"
// lines. Post-lock reports and post-lock changes are added under their week's entry.

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomically } from "./files.ts";

export interface LoggedNight {
  day: string; // "Monday"
  dish: string;
  protein: string;
  swappedFromDraft: boolean;
  // The catalog recipe this night came from, when it had one. Optional so older logs still read.
  // A provider may rename a recipe; its id stays, so this is how a repeat is still recognised.
  recipeId?: string;
}

export interface LoggedChange {
  day: string;
  dish: string;
  protein: string;
  recipeId?: string;
}

export type LoggedWeekStatus = "locked" | "not locked";

export interface LogEntry {
  weekOf: string; // first night, YYYY-MM-DD
  endDate: string; // last night, YYYY-MM-DD
  status: LoggedWeekStatus;
  nights: LoggedNight[];
  changedAfterLock: LoggedChange[];
  reports: string[];
}

export interface WeekToLog {
  weekOf: string;
  status: LoggedWeekStatus;
  nights: LoggedNight[]; // empty for a week that lapsed without a lock
}

export class LogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogError";
  }
}

const LOG_HEADER = "# Dinner Log\n";
const SWAPPED_MARK = " (swapped from draft)";
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

export function appendWeek(logPath: string, week: WeekToLog): void {
  const entry = [
    `## Week of ${week.weekOf}`,
    `- Dates: ${week.weekOf} to ${addDays(week.weekOf, 6)}`,
    `- Status: ${week.status}`,
  ];
  for (const night of week.nights) {
    const mark = night.swappedFromDraft ? SWAPPED_MARK : "";
    entry.push(`- ${night.day}: ${night.dish} (${night.protein})${recipeTag(night.recipeId)}${mark}`);
  }

  let text = existsSync(logPath) ? readFileSync(logPath, "utf8") : LOG_HEADER;
  if (!text.endsWith("\n")) text += "\n";
  text += "\n" + entry.join("\n") + "\n";
  writeFileAtomically(logPath, text);
}

// " [recipe rcp-1a2b3c4d5e]" after the protein, or nothing. Ids are made of letters, digits and
// dashes; anything else is left out rather than written, so it cannot break the line.
const RECIPE_TAG = /\s*\[recipe ([A-Za-z0-9_-]+)\]$/;
function recipeTag(recipeId: string | undefined): string {
  return recipeId && /^[A-Za-z0-9_-]+$/.test(recipeId) ? ` [recipe ${recipeId}]` : "";
}

// Takes a trailing recipe tag off the text. Returns the rest and the id (if there was one).
function splitRecipeTag(text: string): { rest: string; recipeId?: string } {
  const match = text.match(RECIPE_TAG);
  if (!match) return { rest: text };
  return { rest: text.slice(0, match.index).trim(), recipeId: match[1]! };
}

// "we did pizza instead" -> "- Report: we did pizza instead" under that week.
export function appendReport(logPath: string, weekOf: string, report: string): void {
  appendUnderWeek(logPath, weekOf, `- Report: ${report.trim()}`);
}

// A future night changed after lock.
export function appendChangeAfterLock(logPath: string, weekOf: string, change: LoggedChange): void {
  appendUnderWeek(logPath, weekOf, `- Changed after lock: ${change.day}: ${change.dish} (${change.protein})${recipeTag(change.recipeId)}`);
}

function appendUnderWeek(logPath: string, weekOf: string, line: string): void {
  // A report is the group's own words, passed on by the model. A line break in it could slip in
  // a "## Week of ..." heading and split or fake an entry, so the line must stay one line and
  // must not be a heading. (brain/schema.ts already rejects these; this is the backstop.)
  if (/[\r\n\u2028\u2029]/.test(line)) {
    throw new LogError(`I can't add ${JSON.stringify(line)} to the log: it has a line break in it, so I saved nothing.`);
  }
  if (line.startsWith("#")) {
    throw new LogError(`I can't add ${JSON.stringify(line)} to the log: it would start a heading, so I saved nothing.`);
  }
  const text = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const lines = text.split("\n");

  const start = lines.findIndex((l) => l.trim() === `## Week of ${weekOf}`);
  if (start === -1) {
    throw new LogError(`The log has no entry for the week of ${weekOf}.`);
  }
  // The entry runs until the next `## ` heading or the end of the file.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) {
      end = i;
      break;
    }
  }
  // Insert right after the entry's last non-blank line.
  let last = start;
  for (let i = start + 1; i < end; i++) {
    if (lines[i]!.trim() !== "") last = i;
  }
  lines.splice(last + 1, 0, line);
  writeFileAtomically(logPath, lines.join("\n"));
}

// "2026-10-05" + 6 -> "2026-10-11". Done in UTC so time zones and DST can't shift the date.
function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

export function readLog(logPath: string): LogEntry[] {
  if (!existsSync(logPath)) return [];
  return parseLog(readFileSync(logPath, "utf8"));
}

export function parseLog(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  let current: LogEntry | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();

    const heading = line.match(/^## Week of (\d{4}-\d{2}-\d{2})$/);
    if (heading) {
      current = {
        weekOf: heading[1]!,
        endDate: addDays(heading[1]!, 6),
        status: "locked",
        nights: [],
        changedAfterLock: [],
        reports: [],
      };
      entries.push(current);
      continue;
    }
    if (!current || !line.startsWith("- ")) continue;

    // Split "- Key: rest" at the first colon.
    const item = line.slice(2);
    const colon = item.indexOf(":");
    if (colon === -1) continue;
    const key = item.slice(0, colon).trim();
    const value = item.slice(colon + 1).trim();

    if (key === "Status") {
      current.status = value === "not locked" ? "not locked" : "locked";
    } else if (key === "Report") {
      current.reports.push(value);
    } else if (key === "Changed after lock") {
      // value is "Saturday: Burgers (beef)"
      const dayColon = value.indexOf(":");
      if (dayColon === -1) continue;
      const { rest, recipeId } = splitRecipeTag(value.slice(dayColon + 1).trim());
      const { dish, protein } = splitDishAndProtein(rest);
      current.changedAfterLock.push({ day: value.slice(0, dayColon).trim(), dish, protein, ...(recipeId ? { recipeId } : {}) });
    } else if (DAYS.includes(key)) {
      let dishText = value;
      const swappedFromDraft = dishText.endsWith(SWAPPED_MARK.trim());
      if (swappedFromDraft) dishText = dishText.slice(0, -SWAPPED_MARK.trim().length).trim();
      const { rest, recipeId } = splitRecipeTag(dishText);
      const { dish, protein } = splitDishAndProtein(rest);
      current.nights.push({ day: key, dish, protein, swappedFromDraft, ...(recipeId ? { recipeId } : {}) });
    }
    // "Dates" and any other key are for reading only.
  }
  return entries;
}

// "Honey garlic salmon (fish)" -> { dish: "Honey garlic salmon", protein: "fish" }.
// The protein is the last parenthesized part, so a dish name may contain its own parentheses.
function splitDishAndProtein(text: string): { dish: string; protein: string } {
  const match = text.match(/^(.*)\(([^()]*)\)$/);
  if (!match) return { dish: text, protein: "unknown" };
  return { dish: match[1]!.trim(), protein: match[2]!.trim() };
}
