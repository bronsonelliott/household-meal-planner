// Shared config values for tests: the household clock the existing fixtures were written against
// (Friday 4 PM, Sunday noon, Chicago), the weeknights, and the parsed example config.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrainSettings } from "../../src/brain/index.ts";
import { parseConfig, type AppConfig, type ScheduleConfig } from "../../src/config.ts";
import { DEFAULT_GROCERY_SECTIONS, type Night } from "../../src/data/profile.ts";

export const EXAMPLE_CONFIG_PATH = join(import.meta.dir, "..", "..", "config.example.toml");

// Friday 16:00 to Sunday 12:00 in Chicago, late after 30 minutes: what the old code hard-wired.
export const CHICAGO_SCHEDULE: ScheduleConfig = {
  timeZone: "America/Chicago",
  draftDay: "friday",
  draftTime: "16:00",
  draftMinutes: 16 * 60,
  catchUpDay: "sunday",
  catchUpTime: "12:00",
  catchUpMinutes: 12 * 60,
  lateAfterMinutes: 30,
};

export function scheduleWith(changes: Partial<ScheduleConfig>): ScheduleConfig {
  return { ...CHICAGO_SCHEDULE, ...changes };
}

export const MON_TO_THU: Night[] = ["monday", "tuesday", "wednesday", "thursday"];
// What the brain is told about the household in most tests.
export const BRAIN_SETTINGS: BrainSettings = {
  timeZone: "America/Chicago",
  weeknights: MON_TO_THU,
  minDiscoveryNights: 1,
  botName: "Dinner Bot",
  memberNames: ["Alex", "Sam"],
};

export const DEFAULT_SECTIONS = [...DEFAULT_GROCERY_SECTIONS];

// The example config file, parsed. `edit` can change the text first (e.g. to break one setting).
export function exampleConfigText(edit: (text: string) => string = (text) => text): string {
  return edit(readFileSync(EXAMPLE_CONFIG_PATH, "utf8"));
}

export function exampleConfig(env: Record<string, string | undefined> = {}): AppConfig {
  return parseConfig(exampleConfigText(), { baseDir: join(import.meta.dir, "..", ".."), env });
}

// For tests of `doctor --online` that are about something else (a chat app): the recipe API
// checks get a fake answer instead of the real internet.
export const FAKE_RECIPE_APIS = {
  fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
  resolve: async () => ["93.184.216.34"],
  sleep: async () => {},
};
