import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loggedNights } from "../src/week/plan.ts";
import type { WeekFile } from "../src/week/state.ts";
import { appendWeek, appendReport, appendChangeAfterLock, readLog, parseLog, type LoggedNight } from "../src/data/log.ts";

const EXAMPLE_LOG = join(import.meta.dir, "..", "data.example", "log.md");

let logPath: string;
beforeEach(() => {
  logPath = join(mkdtempSync(join(tmpdir(), "log-test-")), "log.md");
});

const weekOneNights: LoggedNight[] = [
  { day: "Monday", dish: "Chicken tacos", protein: "chicken", swappedFromDraft: false },
  { day: "Tuesday", dish: "Honey garlic salmon", protein: "fish", swappedFromDraft: true },
  { day: "Wednesday", dish: "Black bean enchiladas", protein: "vegetarian", swappedFromDraft: false },
  { day: "Thursday", dish: "Spaghetti and meatballs", protein: "beef", swappedFromDraft: false },
  { day: "Friday", dish: "Eating out", protein: "none", swappedFromDraft: false },
  { day: "Saturday", dish: "Pork carnitas", protein: "pork", swappedFromDraft: false },
  { day: "Sunday", dish: "Smoked brisket", protein: "beef", swappedFromDraft: false },
];

describe("the recipe id in the log", () => {
  test("a night that came from a catalog recipe keeps its id through write and read, and old lines still parse", () => {
    appendWeek(logPath, {
      weekOf: "2026-10-05",
      status: "locked",
      nights: [
        { day: "Monday", dish: "Lemon orzo soup (spring)", protein: "chicken", swappedFromDraft: true, recipeId: "rcp-1a2b3c4d5e" },
        { day: "Tuesday", dish: "Chicken tacos", protein: "chicken", swappedFromDraft: false },
      ],
    });
    appendChangeAfterLock(logPath, "2026-10-05", { day: "Wednesday", dish: "Pepper beef stew", protein: "beef", recipeId: "rcp-9z8y7x6w5v" });
    const text = readFileSync(logPath, "utf8");
    expect(text).toContain("- Monday: Lemon orzo soup (spring) (chicken) [recipe rcp-1a2b3c4d5e] (swapped from draft)\n");
    expect(text).toContain("- Tuesday: Chicken tacos (chicken)\n");

    const [entry] = readLog(logPath);
    expect(entry!.nights).toEqual([
      { day: "Monday", dish: "Lemon orzo soup (spring)", protein: "chicken", swappedFromDraft: true, recipeId: "rcp-1a2b3c4d5e" },
      { day: "Tuesday", dish: "Chicken tacos", protein: "chicken", swappedFromDraft: false },
    ]);
    expect(entry!.changedAfterLock).toEqual([{ day: "Wednesday", dish: "Pepper beef stew", protein: "beef", recipeId: "rcp-9z8y7x6w5v" }]);

    // A log written before ids existed reads the same as it always did.
    expect(parseLog("## Week of 2026-09-28\n- Monday: Chili (beef)\n")[0]!.nights).toEqual([{ day: "Monday", dish: "Chili", protein: "beef", swappedFromDraft: false }]);
  });

  test("a locked week's log lines carry the id of the catalog recipe each night came from", () => {
    const night = { kind: "dish", dish: "Pepper beef stew", rule: null, protein: "beef", tags: [], pool: "catalog", ingredients: [], pinnedBy: null, changedBy: null, swappedFromDraft: false, changedAfterLock: false, recipe: { origin: "fetched", recipeId: "rcp-aaaaaaaaaa", url: "https://x.example/a", sourceId: "s", sourceName: "S", ingredientProvenance: "publisher" } };
    const home = { ...night, dish: "Chicken tacos", pool: "usual", recipe: null };
    const week = { weekOf: "2026-10-05", status: "locked", nights: { monday: night, tuesday: home, wednesday: null, thursday: null, friday: null, saturday: null, sunday: null }, have: [], lockedAt: null, postedList: null } as unknown as WeekFile;
    expect(loggedNights(week).map((logged) => logged.recipeId)).toEqual(["rcp-aaaaaaaaaa", undefined]);
  });
});

describe("the dinner log", () => {
  test("locking a week appends an entry with its dates, dishes, proteins, and swapped nights", () => {
    appendWeek(logPath, { weekOf: "2026-10-05", status: "locked", nights: weekOneNights });

    const text = readFileSync(logPath, "utf8");
    expect(text).toStartWith("# Dinner Log");
    expect(text).toContain("## Week of 2026-10-05\n- Dates: 2026-10-05 to 2026-10-11\n- Status: locked\n");
    expect(text).toContain("- Tuesday: Honey garlic salmon (fish) (swapped from draft)\n");

    const [entry] = readLog(logPath);
    expect(entry).toEqual({
      weekOf: "2026-10-05",
      endDate: "2026-10-11",
      status: "locked",
      nights: weekOneNights,
      changedAfterLock: [],
      reports: [],
    });
  });

  test("a later week appends after the earlier one, and a lapsed week logs as not locked", () => {
    appendWeek(logPath, { weekOf: "2026-10-05", status: "locked", nights: weekOneNights });
    const afterFirst = readFileSync(logPath, "utf8");
    appendWeek(logPath, { weekOf: "2026-10-12", status: "not locked", nights: [] });

    expect(readFileSync(logPath, "utf8")).toStartWith(afterFirst);
    const entries = readLog(logPath);
    expect(entries.map((e) => [e.weekOf, e.status])).toEqual([
      ["2026-10-05", "locked"],
      ["2026-10-12", "not locked"],
    ]);
    expect(entries[1]!.nights).toEqual([]);
  });

  test("a post-lock report and a post-lock change go under that week's entry, not at the end", () => {
    appendWeek(logPath, { weekOf: "2026-10-05", status: "locked", nights: weekOneNights });
    appendWeek(logPath, { weekOf: "2026-10-12", status: "locked", nights: weekOneNights });

    appendReport(logPath, "2026-10-05", "we did pizza instead on Thursday");
    appendChangeAfterLock(logPath, "2026-10-05", { day: "Saturday", dish: "Burgers", protein: "beef" });

    const text = readFileSync(logPath, "utf8");
    expect(text.indexOf("- Report: we did pizza instead on Thursday")).toBeLessThan(text.indexOf("## Week of 2026-10-12"));

    const [first, second] = readLog(logPath);
    expect(first!.reports).toEqual(["we did pizza instead on Thursday"]);
    expect(first!.changedAfterLock).toEqual([{ day: "Saturday", dish: "Burgers", protein: "beef" }]);
    expect(second!.reports).toEqual([]);
    expect(second!.changedAfterLock).toEqual([]);
  });

  test("the example log parses", () => {
    const [entry] = parseLog(readFileSync(EXAMPLE_LOG, "utf8"));
    expect(entry!.weekOf).toBe("2026-10-05");
    expect(entry!.nights).toEqual(weekOneNights);
    expect(entry!.changedAfterLock).toEqual([{ day: "Saturday", dish: "Burgers", protein: "beef" }]);
    expect(entry!.reports).toEqual(["we did pizza instead on Thursday"]);
  });
});
