// The week state machine, one test per transition in the plan's state diagram, plus the
// date helpers and the provenance word checks the transitions depend on.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addHave,
  applyDraft,
  changeNight,
  loadWeek,
  localDate,
  lockWeek,
  mondayOf,
  nightDate,
  promoteIfComplete,
  readWeekFile,
  rolloverWeek,
  saveWeek,
  skipWeek,
  unskipWeek,
} from "../src/week/state.ts";
import {
  containsLockWord,
  hasExplicitRuleLanguage,
  inMessageOrder,
  provenanceProblem,
  saysHomeAfterAll,
  saysSkipTheWeek,
  type Operation,
} from "../src/week/changeset.ts";
import { BRISKET, BURGERS, draftedWeek, emptyWeekFile, LEMON_PASTA, night, OUT, SPAGHETTI, TACOS } from "./fixtures/week-fixtures.ts";

const CHICAGO = "America/Chicago";
const THURSDAY = "2026-10-01";
const FRIDAY = "2026-10-02";

describe("dates in the household time zone", () => {
  test("the local date follows Chicago, not UTC", () => {
    // 2026-10-05 03:30 UTC is Sunday Oct 4, 10:30 PM in Chicago (CDT).
    expect(localDate(Date.parse("2026-10-05T03:30:00Z"), CHICAGO)).toBe("2026-10-04");
    // Friday 4:00 PM CDT.
    expect(localDate(Date.parse("2026-10-02T21:00:00Z"), CHICAGO)).toBe("2026-10-02");
    // After the switch to CST: 2026-11-09 05:30 UTC is Sunday Nov 8, 11:30 PM.
    expect(localDate(Date.parse("2026-11-09T05:30:00Z"), CHICAGO)).toBe("2026-11-08");
  });

  test("Monday of a week, and each night's date", () => {
    expect(mondayOf("2026-10-04")).toBe("2026-09-28");
    expect(mondayOf("2026-10-05")).toBe("2026-10-05");
    expect(mondayOf(THURSDAY)).toBe("2026-09-28");
    expect(nightDate("2026-10-05", "sunday")).toBe("2026-10-11");
  });
});

describe("transitions", () => {
  test("Empty -> Seeding: an adult pins a night", () => {
    const { week, refused } = changeNight(emptyWeekFile("2026-10-05"), "tuesday", TACOS, { mode: "pin", who: "Sam", today: THURSDAY });
    expect(refused).toBeNull();
    expect(week.status).toBe("seeding");
    expect(week.nights.tuesday).toEqual(night(TACOS, { pinnedBy: "Sam", changedBy: "Sam" }));
  });

  // "skip next week" works any time before lock, so a trip that
  // comes up after Friday's draft can still cancel the week.
  test("Empty, Seeding, or Drafted -> Skipped on skip; skip is refused once the week is locked", () => {
    expect(skipWeek(emptyWeekFile("2026-10-05")).week.status).toBe("skipped");
    const seeding = skipWeek({ ...draftedWeek(), status: "seeding" });
    expect(seeding.refused).toBeNull();
    expect(seeding.week.status).toBe("skipped");
    const drafted = skipWeek(draftedWeek());
    expect(drafted.refused).toBeNull();
    expect(drafted.week.status).toBe("skipped");
    const locked = skipWeek({ ...draftedWeek(), status: "locked" });
    expect(locked.week.status).toBe("locked");
    expect(locked.refused).toBe(`The week of Oct 5 is already locked, so I didn't skip it. Change the nights to "away" instead.`);
  });

  test("Skipped -> Empty on unskip; Skipped -> Seeding on a pin, with a one-line confirmation", () => {
    const skipped = skipWeek(emptyWeekFile("2026-10-05")).week;
    const unskipped = unskipWeek(skipped);
    expect(unskipped.refused).toBeNull();
    expect(unskipped.week).toEqual(emptyWeekFile("2026-10-05"));

    const pinned = changeNight(skipped, "sunday", BRISKET, { mode: "pin", who: "Alex", today: THURSDAY });
    expect(pinned.week.status).toBe("seeding");
    expect(pinned.note).toBe("The week of Oct 5 is back on.");
    expect(pinned.week.nights.sunday?.pinnedBy).toBe("Alex");

    expect(unskipWeek(emptyWeekFile("2026-10-05")).refused).not.toBeNull();
  });

  test("a swap on a skipped week is refused", () => {
    const skipped = skipWeek(emptyWeekFile("2026-10-05")).week;
    const result = changeNight(skipped, "sunday", BRISKET, { mode: "swap", who: "Sam", today: THURSDAY });
    expect(result.refused).not.toBeNull();
    expect(result.week).toEqual(skipped);
  });

  // A week that started without a plan would lapse at the very next job (rollover lapses any
  // empty or seeding week whose Monday has come), so a pin there would silently vanish. Refuse
  // it up front instead. THURSDAY is in the week of Sep 28.
  test("a pin on an empty week that has already started is refused and the week stays empty", () => {
    const empty = emptyWeekFile("2026-09-28");
    const result = changeNight(empty, "friday", TACOS, { mode: "pin", who: "Sam", today: THURSDAY });
    expect(result.refused).toBe(
      "The week of Sep 28 already started without a plan, so I'm not tracking it. Send changes for next week instead.",
    );
    expect(result.week).toEqual(emptyWeekFile("2026-09-28"));
  });

  test("a pin on a skipped week that has already started is refused and the week stays skipped", () => {
    const skipped = skipWeek(emptyWeekFile("2026-09-28")).week;
    const result = changeNight(skipped, "friday", TACOS, { mode: "pin", who: "Sam", today: THURSDAY });
    expect(result.refused).toBe(
      "The week of Sep 28 already started without a plan, so I'm not tracking it. Send changes for next week instead.",
    );
    expect(result.week).toEqual({ ...emptyWeekFile("2026-09-28"), status: "skipped" });
  });

  test("a pin on an empty coming week still starts seeding", () => {
    const result = changeNight(emptyWeekFile("2026-10-05"), "monday", TACOS, { mode: "pin", who: "Sam", today: THURSDAY });
    expect(result.refused).toBeNull();
    expect(result.week.status).toBe("seeding");
  });

  // "we're home after all" always un-skips the coming week, so it can't help a skipped week
  // that is already under way.
  test("a swap on a skipped week that has already started does not suggest home after all", () => {
    const skipped = skipWeek(emptyWeekFile("2026-09-28")).week;
    const result = changeNight(skipped, "friday", TACOS, { mode: "swap", who: "Sam", today: THURSDAY });
    expect(result.refused).toBe("The week of Sep 28 was skipped and is already under way, so I can't change it.");
    expect(result.week).toEqual(skipped);
  });

  test("Seeding -> Drafted: the Friday draft keeps the pins and fills the rest", () => {
    const seeded = changeNight(emptyWeekFile("2026-10-05"), "tuesday", TACOS, { mode: "pin", who: "Sam", today: THURSDAY }).week;
    const drafted = applyDraft(seeded, {
      monday: SPAGHETTI,
      tuesday: BURGERS, // the model tried to fill a pinned night: ignored
      wednesday: LEMON_PASTA,
      thursday: SPAGHETTI,
      friday: OUT,
      saturday: BURGERS,
      sunday: BRISKET,
    });
    expect(drafted.status).toBe("drafted");
    expect(drafted.nights.tuesday).toEqual(night(TACOS, { pinnedBy: "Sam", changedBy: "Sam" }));
    expect(drafted.nights.monday).toEqual(night(SPAGHETTI));
  });

  test("Empty -> Drafted: the Friday draft on an empty week", () => {
    const drafted = applyDraft(emptyWeekFile("2026-10-05"), { monday: TACOS });
    expect(drafted.status).toBe("drafted");
  });

  test("Drafted -> Drafted: a swap changes one night and marks it swapped from the draft", () => {
    const before = draftedWeek();
    const { week, refused } = changeNight(before, "tuesday", LEMON_PASTA, { mode: "swap", who: "Sam", today: FRIDAY });
    expect(refused).toBeNull();
    expect(week.status).toBe("drafted");
    expect(week.nights.tuesday).toEqual(night(LEMON_PASTA, { changedBy: "Sam", swappedFromDraft: true }));
    expect(week.nights.monday).toEqual(before.nights.monday);
    expect(before.nights.tuesday?.dish).toBe("Spaghetti and meatballs"); // the input is not mutated
  });

  test("Drafted -> Locked on lock; a second lock reports already-locked; lock with no draft does nothing", () => {
    const locked = lockWeek(draftedWeek(), "2026-10-02T22:00:00.000Z");
    expect(locked.result).toBe("locked");
    expect(locked.week.status).toBe("locked");
    expect(locked.week.lockedAt).toBe("2026-10-02T22:00:00.000Z");

    const again = lockWeek(locked.week, "2026-10-02T23:00:00.000Z");
    expect(again.result).toBe("already-locked");
    expect(again.week.lockedAt).toBe("2026-10-02T22:00:00.000Z");

    const empty = emptyWeekFile("2026-10-05");
    const nothing = lockWeek(empty, "2026-10-02T22:00:00.000Z");
    expect(nothing.result).toBe("nothing-to-lock");
    expect(nothing.week).toEqual(empty);

    const seeded = changeNight(empty, "tuesday", TACOS, { mode: "pin", who: "Sam", today: THURSDAY }).week;
    expect(lockWeek(seeded, "2026-10-02T22:00:00.000Z").result).toBe("nothing-to-lock");
  });

  test("Locked -> Locked: a night changed before the week starts is marked changed after lock", () => {
    const locked = lockWeek(draftedWeek(), "2026-10-02T22:00:00.000Z").week;
    const { week } = changeNight(locked, "saturday", TACOS, { mode: "pin", who: "Alex", today: "2026-10-03" });
    expect(week.status).toBe("locked");
    expect(week.nights.saturday).toEqual(night(TACOS, { pinnedBy: "Alex", changedBy: "Alex", changedAfterLock: true }));
  });

  test("Current -> Current: a future night changes, a past night is refused", () => {
    const current = { ...draftedWeek(), status: "current" as const };
    const future = changeNight(current, "thursday", TACOS, { mode: "pin", who: "Sam", today: "2026-10-07" });
    expect(future.refused).toBeNull();
    expect(future.week.nights.thursday?.changedAfterLock).toBe(true);

    const past = changeNight(current, "monday", SPAGHETTI, { mode: "pin", who: "Sam", today: "2026-10-07" });
    expect(past.refused).not.toBeNull();
    expect(past.week).toEqual(current);
  });

  test("Lapsed and done weeks refuse night changes", () => {
    for (const status of ["lapsed", "done"] as const) {
      const week = { ...draftedWeek(), status };
      expect(changeNight(week, "sunday", TACOS, { mode: "pin", who: "Sam", today: "2026-10-01" }).refused).not.toBeNull();
    }
  });

  test("Monday rollover: drafted and seeding weeks lapse, locked becomes current, current ends, skipped stays", () => {
    const thisMonday = "2026-10-05";
    expect(rolloverWeek(draftedWeek(), thisMonday)).toEqual({ week: { ...draftedWeek(), status: "lapsed" }, lapsed: true });

    const seeded = changeNight(emptyWeekFile("2026-10-05"), "tuesday", TACOS, { mode: "pin", who: "Sam", today: THURSDAY }).week;
    expect(rolloverWeek(seeded, thisMonday).week.status).toBe("lapsed");
    expect(rolloverWeek(seeded, thisMonday).lapsed).toBe(true);

    const locked = lockWeek(draftedWeek(), "2026-10-02T22:00:00.000Z").week;
    expect(rolloverWeek(locked, thisMonday)).toEqual({ week: { ...locked, status: "current" }, lapsed: false });

    const current = { ...locked, status: "current" as const };
    expect(rolloverWeek(current, "2026-10-12").week.status).toBe("done");
    expect(rolloverWeek(current, thisMonday).week.status).toBe("current");

    const skipped = skipWeek(emptyWeekFile("2026-10-05")).week;
    expect(rolloverWeek(skipped, thisMonday)).toEqual({ week: skipped, lapsed: false });

    // A week that has not started yet is left alone.
    expect(rolloverWeek(draftedWeek(), "2026-09-28")).toEqual({ week: draftedWeek(), lapsed: false });
  });

  test("a swap that fills every night of a pre-draft week drafts it on request", () => {
    let week = emptyWeekFile("2026-10-05");
    const values = [TACOS, SPAGHETTI, LEMON_PASTA, TACOS, OUT, BURGERS, BRISKET];
    const nights = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
    nights.forEach((name, i) => {
      week = changeNight(week, name, values[i]!, { mode: "swap", who: "Sam", today: THURSDAY }).week;
    });
    expect(week.status).toBe("seeding");
    expect(promoteIfComplete(week).status).toBe("drafted");
    expect(promoteIfComplete(emptyWeekFile("2026-10-05")).status).toBe("empty");
  });

  test("the have-list gains items once each", () => {
    const week = addHave(addHave(draftedWeek(), ["ground beef"]), ["Ground beef", "tortillas"]);
    expect(week.have).toEqual(["ground beef", "tortillas"]);
  });

  test("an out or away night carries no protein", () => {
    const { week } = changeNight(draftedWeek(), "saturday", { ...OUT, kind: "away", dish: "Away", rule: null }, { mode: "pin", who: "Sam", today: FRIDAY });
    expect(week.nights.saturday?.protein).toBeNull();
    expect(week.nights.saturday?.ingredients).toEqual([]);
  });
});

describe("week files", () => {
  test("a missing week file reads as an empty week; a saved one reads back", () => {
    const dir = mkdtempSync(join(tmpdir(), "weeks-"));
    expect(loadWeek(dir, "2026-10-05")).toEqual(emptyWeekFile("2026-10-05"));
    saveWeek(dir, draftedWeek());
    expect(loadWeek(dir, "2026-10-05")).toEqual(draftedWeek());
    expect(JSON.parse(readFileSync(join(dir, "2026-10-05.json"), "utf8")).status).toBe("drafted");
  });

  test("the example week file in data.example parses as a week", () => {
    const week = readWeekFile(join(import.meta.dir, "..", "data.example", "week.json"));
    expect(week.status).toBe("drafted");
    expect(Object.values(week.nights).every((n) => n !== null)).toBe(true);
  });
});

describe("provenance word checks", () => {
  const LOCK_WORDS = ["lock it", "lock the week"];

  test("lock words count only outside a negation", () => {
    expect(containsLockWord("lock it", LOCK_WORDS)).toBe(true);
    expect(containsLockWord("Looks good, lock it!", LOCK_WORDS)).toBe(true);
    expect(containsLockWord("No, lock the week", LOCK_WORDS)).toBe(true);
    expect(containsLockWord("don't lock it yet", LOCK_WORDS)).toBe(false);
    expect(containsLockWord("Don’t lock it yet", LOCK_WORDS)).toBe(false);
    expect(containsLockWord("let's not lock it", LOCK_WORDS)).toBe(false);
    expect(containsLockWord("looks good", LOCK_WORDS)).toBe(false);
    expect(containsLockWord("Tuesday tacos, we have tortillas, lock it", LOCK_WORDS)).toBe(true);
  });

  test("profile changes need explicit rule words", () => {
    expect(hasExplicitRuleLanguage("add a rule: no fish on weeknights")).toBe(true);
    expect(hasExplicitRuleLanguage("never again with that casserole")).toBe(true);
    expect(hasExplicitRuleLanguage("From now on, Friday is pizza")).toBe(true);
    expect(hasExplicitRuleLanguage("add fish tacos to the usual dishes")).toBe(true);
    expect(hasExplicitRuleLanguage("swap Tuesday for tacos")).toBe(false);
  });

  test("skip and home-after-all language", () => {
    expect(saysSkipTheWeek("skip next week, we're traveling")).toBe(true);
    expect(saysSkipTheWeek("don't skip next week")).toBe(false);
    expect(saysSkipTheWeek("skip Tuesday")).toBe(false);
    expect(saysHomeAfterAll("we're home after all")).toBe(true);
    expect(saysHomeAfterAll("don't skip next week")).toBe(true);
    expect(saysHomeAfterAll("sounds good")).toBe(false);
  });

  test("an operation citing a message outside the batch is dropped; undo needs the word", () => {
    const lock: Operation = { sourceMessageId: "x", action: "lock" };
    expect(provenanceProblem(lock, undefined, LOCK_WORDS)).not.toBeNull();
    expect(provenanceProblem(lock, "lock it", LOCK_WORDS)).toBeNull();
    expect(provenanceProblem({ sourceMessageId: "x", action: "undo" }, "take that back", LOCK_WORDS)).not.toBeNull();
    expect(provenanceProblem({ sourceMessageId: "x", action: "undo" }, "undo", LOCK_WORDS)).toBeNull();
    expect(provenanceProblem({ sourceMessageId: "x", action: "have", items: ["rice"] }, "we have rice", LOCK_WORDS)).toBeNull();
  });

  test("operations run in message order, with a lock last within its message", () => {
    const ops: Operation[] = [
      { sourceMessageId: "b", action: "none" },
      { sourceMessageId: "a", action: "lock" },
      { sourceMessageId: "a", action: "pin", nights: [] },
      { sourceMessageId: "a", action: "have", items: ["tortillas"] },
    ];
    expect(inMessageOrder(ops, ["a", "b"]).map((op) => `${op.sourceMessageId}:${op.action}`)).toEqual([
      "a:pin",
      "a:have",
      "a:lock",
      "b:none",
    ]);
  });
});
