// While the first interview has not produced a profile, the scheduler waits (one reminder a week,
// no failed drafts, no skipped weeks) and the health check stays quiet; once the profile is saved
// the schedule is looked at again from now, never replaying old weeks.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { touchHeartbeat } from "../src/ops/heartbeat.ts";
import { awaitingProfileMarkerPath } from "../src/ops/scheduler.ts";
import { awaitingProfileReminder } from "../src/onboarding/questions.ts";
import { runChecker } from "./fixtures/health-harness.ts";
import { InterviewHarness } from "./fixtures/interview-harness.ts";
import { reachProposal, start } from "./fixtures/interview-scenarios.ts";
import { draftAnswer } from "./fixtures/ops-harness.ts";
import { FRIDAY_4PM, FRIDAY_6PM } from "./fixtures/worker-harness.ts";

const SUNDAY_1PM = Date.parse("2026-10-04T18:00:00Z"); // after the catch-up deadline (Sunday noon, Central)
const MONDAY_9AM = Date.parse("2026-10-05T14:00:00Z");
const COMING = "2026-10-05";

const harnesses: InterviewHarness[] = [];
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.stop();
});
const household = (options: ConstructorParameters<typeof InterviewHarness>[0] = {}) => start(options, harnesses);

function reminders(h: InterviewHarness): number {
  return h.texts.filter((text) => text === awaitingProfileReminder()).length;
}

function markers(h: InterviewHarness): string[] {
  return readdirSync(h.stateDir).filter((name) => /^friday-/.test(name));
}

// Finishes the whole interview: the usual answers, then the confirm question and its answer.
async function finishInterview(h: InterviewHarness): Promise<void> {
  await reachProposal(h);
  await h.say("Sam", "save it");
  await h.say("Alex", "save it");
}

describe("awaiting profile", () => {
  test("at the draft time: no draft try, no failure or skipped-week records, and one reminder for the week", async () => {
    const h = await household({ start: FRIDAY_4PM });
    await h.scheduler.tick();
    await h.settle();
    expect(h.brain.handled).toHaveLength(0);
    expect(reminders(h)).toBe(1);
    expect(existsSync(awaitingProfileMarkerPath(h.stateDir, COMING))).toBe(true);
    expect(markers(h)).toEqual([]); // no friday-error, friday-posted or friday-send-unknown files

    // Later ticks, and a restart, stay quiet.
    for (let i = 0; i < 3; i++) {
      h.clock.advance(60_000);
      await h.scheduler.tick();
    }
    await h.restart();
    h.clock.advance(60_000);
    await h.scheduler.tick();
    await h.settle();
    expect(reminders(h)).toBe(1);
    expect(h.brain.handled).toHaveLength(0);
  });

  test("a cancelled setup still waits (and still reminds once)", async () => {
    const h = await household({ start: FRIDAY_4PM });
    await h.say("Alex", "cancel setup");
    await h.scheduler.tick();
    await h.settle();
    expect(reminders(h)).toBe(1);
    expect(h.brain.handled).toHaveLength(0);
    expect(markers(h)).toEqual([]);
  });

  test("saved inside the draft window: the draft is made at once (the catch-up), from the new rules", async () => {
    const h = await household({ start: FRIDAY_4PM });
    await h.scheduler.tick();
    await h.settle();
    h.clock.nowMs = FRIDAY_6PM;
    h.brain.next(draftAnswer);
    await finishInterview(h);
    await h.eventually(() => h.lastText.includes("(late)"));
    const draft = h.brain.handled.at(-1)!;
    expect(draft.kind).toBe("friday-draft");
    expect(draft.kind === "friday-draft" && draft.late).toBe(true);
    expect(draft.context.profile.rules.map((rule) => rule.prose)).toContain("Friday is eating out.");
    expect(h.lastText).toContain("(late)");
  });

  test("saved after the window closed: nothing is skipped or alerted, and the chat is told when the next draft is", async () => {
    const h = await household({ start: FRIDAY_4PM });
    await h.scheduler.tick();
    await h.settle();
    h.clock.nowMs = SUNDAY_1PM;
    await h.scheduler.tick(); // still waiting: no skip
    await h.settle();
    expect(markers(h)).toEqual([]);

    await finishInterview(h);
    await h.settle();
    expect(h.lastText).toBe("Your house rules are saved. The next dinner draft is Friday at 4:00 PM.");
    await h.scheduler.tick();
    await h.settle();
    expect(h.brain.handled).toHaveLength(0); // the old week is not drafted after the fact
    expect(markers(h)).toEqual([]); // and not skipped either, so nobody is alerted about it

    touchHeartbeat(h.stateDir, SUNDAY_1PM);
    const check = await runChecker({ stateDir: h.stateDir, nowMs: SUNDAY_1PM + 60_000, dataDir: h.dataDir });
    expect(check.problems).toEqual([]);
  });

  test("saved on a Monday: nothing is drafted for the week that went by", async () => {
    const h = await household({ start: FRIDAY_4PM });
    await h.scheduler.tick();
    h.clock.nowMs = MONDAY_9AM;
    await finishInterview(h);
    await h.settle();
    expect(h.brain.handled).toHaveLength(0);
    expect(h.lastText).toContain("The next dinner draft is Friday at 4:00 PM.");
    expect(reminders(h)).toBe(1);
  });
});

describe("the health check during setup", () => {
  test("a missing draft is not an alert while the first interview is verifiably in progress", async () => {
    const h = await household({ start: FRIDAY_4PM });
    const later = FRIDAY_4PM + 40 * 60_000; // well past the late mark
    touchHeartbeat(h.stateDir, later);
    const waiting = await runChecker({ stateDir: h.stateDir, nowMs: later, dataDir: h.dataDir });
    expect(waiting.problems).toEqual([]);
    expect(waiting.messages).toEqual([]);
  });

  test("with no interview behind the missing profile, the missing draft is still an alert", async () => {
    const h = new InterviewHarness({ start: FRIDAY_4PM });
    harnesses.push(h); // never booted: there is no interview state file
    const later = FRIDAY_4PM + 40 * 60_000;
    touchHeartbeat(h.stateDir, later);
    const check = await runChecker({ stateDir: h.stateDir, nowMs: later, dataDir: h.dataDir });
    expect(check.problems.join("\n")).toContain("has not posted");
  });

  test("a damaged interview file is an alert, once, and clears when it is fixed", async () => {
    const h = await household({ start: FRIDAY_4PM });
    const now = FRIDAY_4PM + 60_000;
    touchHeartbeat(h.stateDir, now);
    const good = h.state!;
    writeFileSync(join(h.stateDir, "onboarding.json"), "{ nope");
    const broken = await runChecker({ stateDir: h.stateDir, nowMs: now, dataDir: h.dataDir });
    expect(broken.problems.join("\n")).toContain("interview file");
    expect(broken.messages).toHaveLength(1);
    const again = await runChecker({ stateDir: h.stateDir, nowMs: now, dataDir: h.dataDir });
    expect(again.messages).toHaveLength(0); // reported once
    expect(again.problems.length).toBeGreaterThan(0);

    writeFileSync(join(h.stateDir, "onboarding.json"), JSON.stringify(good));
    const fixed = await runChecker({ stateDir: h.stateDir, nowMs: now, dataDir: h.dataDir });
    expect(fixed.problems).toEqual([]);
  });

  test("once the profile is saved, the draft alert is back in force", async () => {
    const h = await household({ start: FRIDAY_4PM });
    await finishInterview(h); // the catch-up draft fails (the stub model has no answer), so no draft is posted
    expect(existsSync(h.profilePath)).toBe(true);
    const later = FRIDAY_4PM + 40 * 60_000;
    touchHeartbeat(h.stateDir, later);
    const check = await runChecker({ stateDir: h.stateDir, nowMs: later, dataDir: h.dataDir });
    expect(check.problems.join("\n")).toContain("has not posted");
  });
});
