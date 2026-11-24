// The household clock: the draft window, lateness, retries and the catch-up deadline all follow
// the configured time zone and times. Covers a zone with a half-hour offset, a southern-hemisphere
// zone, a changed schedule, and both daylight-saving transitions.

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftPhase, isLateDraft, nextDraftAttempt, Scheduler, type ScheduledWorker } from "../src/ops/scheduler.ts";
import { beforeDraftDeadline, describeCatchUp, describeMinutes, instantOfLocalTime, localDate, localTime } from "../src/week/state.ts";
import { postedMarkerPath, type FridayDraftResult, type MissedDraftResult } from "../src/week/worker.ts";
import { CHICAGO_SCHEDULE, scheduleWith } from "./fixtures/config-fixtures.ts";

const MINUTE = 60_000;
const at = (iso: string) => Date.parse(iso);

describe("local time in other zones", () => {
  test("a zone with a half-hour offset (Asia/Kolkata, UTC+5:30, no daylight saving)", () => {
    // 2026-10-02 22:00 UTC is Saturday 03:30 in Kolkata.
    expect(localTime(at("2026-10-02T22:00:00Z"), "Asia/Kolkata")).toEqual({ date: "2026-10-03", weekday: 5, minutes: 3 * 60 + 30 });
    expect(localDate(at("2026-10-02T18:29:00Z"), "Asia/Kolkata")).toBe("2026-10-02");
    expect(localDate(at("2026-10-02T18:30:00Z"), "Asia/Kolkata")).toBe("2026-10-03");
  });

  test("midnight reads as 00:00, not 24:00", () => {
    expect(localTime(at("2026-10-02T04:00:00Z"), "America/New_York")).toEqual({ date: "2026-10-02", weekday: 4, minutes: 0 });
  });

  test("a date far from the Atlantic (Pacific/Auckland) is a day ahead of UTC", () => {
    expect(localDate(at("2026-10-02T20:00:00Z"), "Pacific/Auckland")).toBe("2026-10-03");
  });

  test("times in words", () => {
    expect(describeMinutes(12 * 60)).toBe("noon");
    expect(describeMinutes(16 * 60 + 30)).toBe("4:30 PM");
    expect(describeMinutes(0)).toBe("12:00 AM");
    expect(describeMinutes(9 * 60 + 5)).toBe("9:05 AM");
    expect(describeCatchUp(CHICAGO_SCHEDULE)).toBe("Sunday noon");
    expect(describeCatchUp(scheduleWith({ catchUpDay: "saturday", catchUpMinutes: 18 * 60 }))).toBe("Saturday 6:00 PM");
  });
});

describe("the draft window follows the configured zone", () => {
  const kolkata = scheduleWith({ timeZone: "Asia/Kolkata" });

  test("Friday 16:00 in Kolkata is 10:30 UTC", () => {
    expect(draftPhase(at("2026-10-02T10:29:00Z"), kolkata)).toBe("outside");
    expect(draftPhase(at("2026-10-02T10:30:00Z"), kolkata)).toBe("drafting");
    // The same instant is still Friday morning in Chicago: outside the window there.
    expect(draftPhase(at("2026-10-02T10:30:00Z"), CHICAGO_SCHEDULE)).toBe("outside");
  });

  test("Sunday 12:00 in Kolkata (06:30 UTC) ends drafting; the rest of that day is past the deadline", () => {
    expect(draftPhase(at("2026-10-04T06:29:00Z"), kolkata)).toBe("drafting");
    expect(draftPhase(at("2026-10-04T06:30:00Z"), kolkata)).toBe("past-deadline");
    expect(draftPhase(at("2026-10-04T18:29:00Z"), kolkata)).toBe("past-deadline"); // 23:59 Sunday
    expect(draftPhase(at("2026-10-04T18:30:00Z"), kolkata)).toBe("outside"); // Monday 00:00
  });

  test("Saturday is inside the window in the middle, and Thursday is never inside it", () => {
    expect(draftPhase(at("2026-10-03T12:00:00Z"), CHICAGO_SCHEDULE)).toBe("drafting");
    expect(draftPhase(at("2026-10-01T18:00:00Z"), CHICAGO_SCHEDULE)).toBe("outside");
  });

  test("with Friday 16:00 and Sunday 12:00 in Chicago the phases are what the old code had", () => {
    expect(draftPhase(at("2026-10-02T20:59:00Z"), CHICAGO_SCHEDULE)).toBe("outside"); // Fri 3:59 PM CDT
    expect(draftPhase(at("2026-10-02T21:00:00Z"), CHICAGO_SCHEDULE)).toBe("drafting"); // Fri 4:00 PM
    expect(draftPhase(at("2026-10-04T16:59:00Z"), CHICAGO_SCHEDULE)).toBe("drafting"); // Sun 11:59 AM
    expect(draftPhase(at("2026-10-04T17:00:00Z"), CHICAGO_SCHEDULE)).toBe("past-deadline"); // Sun noon
  });

  test("a different schedule: Thursday 18:30 to Saturday 09:00, late after 20 minutes", () => {
    const schedule = scheduleWith({
      timeZone: "Europe/London",
      draftDay: "thursday",
      draftTime: "18:30",
      draftMinutes: 18 * 60 + 30,
      catchUpDay: "saturday",
      catchUpTime: "09:00",
      catchUpMinutes: 9 * 60,
      lateAfterMinutes: 20,
    });
    // 2026-10-01 is a Thursday; London is on summer time (UTC+1) until Oct 25.
    expect(draftPhase(at("2026-10-01T17:29:00Z"), schedule)).toBe("outside");
    expect(draftPhase(at("2026-10-01T17:30:00Z"), schedule)).toBe("drafting");
    expect(draftPhase(at("2026-10-03T07:59:00Z"), schedule)).toBe("drafting");
    expect(draftPhase(at("2026-10-03T08:00:00Z"), schedule)).toBe("past-deadline");

    const draftTime = at("2026-10-01T17:30:00Z");
    expect(isLateDraft(draftTime + 19 * MINUTE, schedule)).toBe(false);
    expect(isLateDraft(draftTime + 20 * MINUTE, schedule)).toBe(true);
    // Retries: 10 minutes apart while that is 5 minutes ahead of the late mark (here 15 minutes), then 30.
    expect(nextDraftAttempt(draftTime, schedule)).toBe(draftTime + 10 * MINUTE);
    expect(nextDraftAttempt(draftTime + 10 * MINUTE, schedule)).toBe(draftTime + 40 * MINUTE);
  });

  test("late marks and retry spacing with the default schedule, anywhere", () => {
    const draftTime = at("2026-10-02T10:30:00Z"); // Friday 16:00 in Kolkata
    expect(isLateDraft(draftTime + 29 * MINUTE, kolkata)).toBe(false);
    expect(isLateDraft(draftTime + 30 * MINUTE, kolkata)).toBe(true);
    expect(isLateDraft(draftTime + 17 * 60 * MINUTE, kolkata)).toBe(true); // Saturday morning
    expect(nextDraftAttempt(draftTime, kolkata)).toBe(draftTime + 10 * MINUTE);
    expect(nextDraftAttempt(draftTime + 10 * MINUTE, kolkata)).toBe(draftTime + 20 * MINUTE);
    expect(nextDraftAttempt(draftTime + 20 * MINUTE, kolkata)).toBe(draftTime + 50 * MINUTE);
  });

  test("the draft deadline for a week is the catch-up time in the week before it", () => {
    const week = "2026-10-05";
    expect(beforeDraftDeadline(week, at("2026-10-04T16:59:00Z"), CHICAGO_SCHEDULE)).toBe(true); // Sun 11:59 AM CDT
    expect(beforeDraftDeadline(week, at("2026-10-04T17:00:00Z"), CHICAGO_SCHEDULE)).toBe(false);
    expect(beforeDraftDeadline(week, at("2026-09-30T12:00:00Z"), CHICAGO_SCHEDULE)).toBe(true);
    const saturdayEvening = scheduleWith({ catchUpDay: "saturday", catchUpMinutes: 18 * 60 });
    expect(beforeDraftDeadline(week, at("2026-10-03T22:59:00Z"), saturdayEvening)).toBe(true); // Sat 5:59 PM CDT
    expect(beforeDraftDeadline(week, at("2026-10-03T23:00:00Z"), saturdayEvening)).toBe(false);
  });
});

describe("the first instant a local time is reached", () => {
  test("an ordinary time", () => {
    expect(instantOfLocalTime("2026-10-02", 16 * 60, "America/Chicago")).toBe(at("2026-10-02T21:00:00Z"));
    expect(instantOfLocalTime("2026-10-02", 16 * 60, "Asia/Kolkata")).toBe(at("2026-10-02T10:30:00Z"));
  });

  test("a time clocks skip over is reached at the first minute after the gap", () => {
    // New York, 2027-03-14: 02:00 EST jumps to 03:00 EDT (07:00 UTC). 02:30 does not exist.
    expect(instantOfLocalTime("2027-03-14", 2 * 60 + 30, "America/New_York")).toBe(at("2027-03-14T07:00:00Z"));
  });

  test("a time that happens twice is reached the first time", () => {
    // New York, 2026-11-01: 02:00 EDT falls back to 01:00 EST. 01:30 happens at 05:30 UTC and 06:30 UTC.
    expect(instantOfLocalTime("2026-11-01", 60 + 30, "America/New_York")).toBe(at("2026-11-01T05:30:00Z"));
  });
});

// A worker that posts the draft the way the real one marks it, and counts how often it was asked.
class FakeWorker implements ScheduledWorker {
  drafts: Array<{ atMs: number; late: boolean }> = [];
  skips = 0;
  now = 0;

  constructor(private stateDir: string) {}

  async enqueueFridayDraft(options: { late: boolean }): Promise<FridayDraftResult> {
    this.drafts.push({ atMs: this.now, late: options.late });
    writeFileSync(postedMarkerPath(this.stateDir, this.weekOf), "{}\n");
    return { kind: "posted", weekOf: this.weekOf, outcome: "sent" };
  }
  async enqueueMissedDraftSkip(): Promise<MissedDraftResult> {
    this.skips++;
    return { kind: "skipped", weekOf: this.weekOf, previousStatus: "empty" };
  }
  async enqueueRollover(): Promise<void> {}

  weekOf = "";
}

describe("clock changes (daylight saving)", () => {
  let stateDir: string;
  let worker: FakeWorker;
  let clock: number;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "schedule-test-"));
    worker = new FakeWorker(stateDir);
  });

  // Ticks once a minute from `from` to `to`, like the bridge does, for a schedule and coming week.
  async function tickEveryMinute(schedule: typeof CHICAGO_SCHEDULE, weekOf: string, from: number, to: number): Promise<void> {
    worker.weekOf = weekOf;
    const scheduler = new Scheduler({ stateDir, worker, schedule, now: () => clock, log: () => {} });
    for (clock = from; clock <= to; clock += MINUTE) {
      worker.now = clock;
      await scheduler.tick();
    }
  }

  test("spring forward: a draft time that does not exist fires at the first minute after the gap, once, and not late", async () => {
    // New York, Sunday 2027-03-14. Draft 02:30, which the clocks skip: 01:59 EST is followed by 03:00 EDT.
    const schedule = scheduleWith({ timeZone: "America/New_York", draftDay: "sunday", draftTime: "02:30", draftMinutes: 150, lateAfterMinutes: 30 });
    await tickEveryMinute(schedule, "2027-03-15", at("2027-03-14T06:30:00Z"), at("2027-03-14T09:00:00Z"));

    expect(worker.drafts).toEqual([{ atMs: at("2027-03-14T07:00:00Z"), late: false }]); // 03:00 EDT
    expect(existsSync(postedMarkerPath(stateDir, "2027-03-15"))).toBe(true);
  });

  test("spring forward: nothing fires in the minutes before the gap", async () => {
    const schedule = scheduleWith({ timeZone: "America/New_York", draftDay: "sunday", draftTime: "02:30", draftMinutes: 150 });
    await tickEveryMinute(schedule, "2027-03-15", at("2027-03-14T06:00:00Z"), at("2027-03-14T06:59:00Z")); // 01:00 to 01:59 EST
    expect(worker.drafts).toEqual([]);
  });

  test("fall back: a repeated hour fires once, at its first pass, and not again at the second", async () => {
    // New York, Sunday 2026-11-01. Draft 01:30, which happens at 05:30 UTC (EDT) and again at 06:30 UTC (EST).
    const schedule = scheduleWith({ timeZone: "America/New_York", draftDay: "sunday", draftTime: "01:30", draftMinutes: 90, lateAfterMinutes: 30 });
    await tickEveryMinute(schedule, "2026-11-02", at("2026-11-01T05:00:00Z"), at("2026-11-01T08:00:00Z"));

    expect(worker.drafts).toEqual([{ atMs: at("2026-11-01T05:30:00Z"), late: false }]);
  });

  test("fall back: a failed first pass is retried on the schedule, not re-fired by the repeated hour", async () => {
    const schedule = scheduleWith({ timeZone: "America/New_York", draftDay: "sunday", draftTime: "01:30", draftMinutes: 90, lateAfterMinutes: 30 });
    // The first pass fails: the worker answers draft-failed and leaves no marker.
    let calls = 0;
    worker.enqueueFridayDraft = async (options) => {
      calls++;
      worker.drafts.push({ atMs: worker.now, late: options.late });
      if (calls === 1) return { kind: "draft-failed", weekOf: "2026-11-02", reason: "model down" };
      writeFileSync(postedMarkerPath(stateDir, "2026-11-02"), "{}\n");
      return { kind: "posted", weekOf: "2026-11-02", outcome: "sent" };
    };
    await tickEveryMinute(schedule, "2026-11-02", at("2026-11-01T05:30:00Z"), at("2026-11-01T08:00:00Z"));

    // First try 05:30 UTC (01:30 EDT), retry 10 minutes later; nothing at the second 01:30.
    expect(worker.drafts.map((d) => d.atMs)).toEqual([at("2026-11-01T05:30:00Z"), at("2026-11-01T05:40:00Z")]);
  });

  test("a week with no clock change behaves the same: one draft at the draft time", async () => {
    await tickEveryMinute(CHICAGO_SCHEDULE, "2026-10-05", at("2026-10-02T20:50:00Z"), at("2026-10-02T22:00:00Z"));
    expect(worker.drafts).toEqual([{ atMs: at("2026-10-02T21:00:00Z"), late: false }]);
  });

  test("the catch-up deadline in a southern-hemisphere zone follows that zone's own clock change", () => {
    const schedule = scheduleWith({ timeZone: "Australia/Sydney" });
    // Sydney moves to summer time (UTC+11) at 02:00 on Sunday 2026-10-04, so Sunday noon there is 01:00 UTC.
    const noonSunday = at("2026-10-04T01:00:00Z");
    expect(draftPhase(noonSunday - MINUTE, schedule)).toBe("drafting");
    expect(draftPhase(noonSunday, schedule)).toBe("past-deadline");
  });
});
