// The Friday tick, the retry and lateness policy, conversation outages, and the auth
// stop, and the heartbeat and reply markers the health check reads. The clock is fake; the brain is a
// stub; group sends and Telegram are recorded, never sent. Expected values are written by hand.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  alertStatePath,
  heartbeatPath,
  ReplyTracker,
  touchHeartbeat,
  unansweredPath,
} from "../src/ops/heartbeat.ts";
import { fridayErrorPath, nextDraftAttempt, OUTAGE_LINE, OUTAGE_LINE_NO_ALERTS, outagePath, REPEAT_LINE } from "../src/ops/scheduler.ts";
import { loadWeek, saveWeek } from "../src/week/state.ts";
import { postedMarkerPath, sendUnknownMarkerPath } from "../src/week/worker.ts";
import { CHICAGO_SCHEDULE } from "./fixtures/config-fixtures.ts";
import { runChecker } from "./fixtures/health-harness.ts";
import { draftAnswer, fail, queueMany, setupOps, type OpsHarness } from "./fixtures/ops-harness.ts";
import { draftedWeek } from "./fixtures/week-fixtures.ts";
import { answer, FRIDAY_4PM, message, THURSDAY_10AM } from "./fixtures/worker-harness.ts";

const COMING = "2026-10-05";
const MINUTE = 60_000;

// Central daylight time is UTC-5 until Nov 1, 2026.
const FRIDAY_4_31PM = Date.parse("2026-10-02T21:31:00Z");
const FRIDAY_5_10PM = Date.parse("2026-10-02T22:10:00Z");
const SATURDAY_9AM = Date.parse("2026-10-03T14:00:00Z");
const SUNDAY_11_50AM = Date.parse("2026-10-04T16:50:00Z");
const SUNDAY_12_05PM = Date.parse("2026-10-04T17:05:00Z");

function comingStatus(ops: OpsHarness): string {
  return loadWeek(ops.h.paths.weeksDir, COMING).status;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Minutes after Friday 4:00 PM at which the brain was asked for the Friday draft.
function draftAttemptMinutes(ops: OpsHarness): number[] {
  return ops.h.brain.handled.filter((request) => request.kind === "friday-draft").map((request) => (request.context.now - FRIDAY_4PM) / MINUTE);
}

// Ticks once a minute (as the bridge does) until `untilMs`.
async function tickEveryMinute(ops: OpsHarness, untilMs: number): Promise<void> {
  while (ops.h.clock.now() <= untilMs) {
    await ops.scheduler.tick();
    ops.h.clock.nowMs += MINUTE;
  }
}

// ---------------------------------------------------------------------------------------------
// The Friday tick and its retries
// ---------------------------------------------------------------------------------------------

describe("the Friday tick", () => {
  test("Friday 4:00 PM with an empty coming week posts one draft; later ticks post nothing", async () => {
    const ops = setupOps(FRIDAY_4PM);
    ops.h.brain.next(draftAnswer);

    await ops.scheduler.tick();
    ops.h.clock.nowMs += 10 * MINUTE;
    await ops.scheduler.tick();

    expect(ops.sent.length).toBe(1);
    expect(ops.sent[0]!.text.startsWith("Here's the draft for Oct 5 to Oct 11:")).toBe(true);
    expect(comingStatus(ops)).toBe("drafted");
    expect(readJson(postedMarkerPath(ops.h.paths.stateDir, COMING)).outcome).toBe("sent");
    expect(ops.h.brain.handled.length).toBe(1);
  });

  test("a tick before Friday 4:00 PM does nothing", async () => {
    const ops = setupOps(FRIDAY_4PM - MINUTE);
    await ops.scheduler.tick();
    expect(ops.h.brain.handled.length).toBe(0);
    expect(existsSync(postedMarkerPath(ops.h.paths.stateDir, COMING))).toBe(false);
  });

  test("the same tick with a locked week posts nothing and sets posted", async () => {
    const ops = setupOps(FRIDAY_4PM);
    saveWeek(ops.h.paths.weeksDir, { ...draftedWeek(), status: "locked", lockedAt: "2026-10-01T15:00:00.000Z" });

    await ops.scheduler.tick();

    expect(ops.sent.length).toBe(0);
    expect(ops.h.brain.handled.length).toBe(0);
    expect(readJson(postedMarkerPath(ops.h.paths.stateDir, COMING)).outcome).toBe("nothing-to-post");
  });
});

describe("a late or failed Friday draft", () => {
  test("retry times: 10 minutes apart until 4:25, then every 30 minutes", () => {
    expect(nextDraftAttempt(FRIDAY_4PM, CHICAGO_SCHEDULE)).toBe(FRIDAY_4PM + 10 * MINUTE);
    expect(nextDraftAttempt(FRIDAY_4PM + 10 * MINUTE, CHICAGO_SCHEDULE)).toBe(FRIDAY_4PM + 20 * MINUTE);
    expect(nextDraftAttempt(FRIDAY_4PM + 20 * MINUTE, CHICAGO_SCHEDULE)).toBe(FRIDAY_4PM + 50 * MINUTE);
    expect(nextDraftAttempt(SATURDAY_9AM, CHICAGO_SCHEDULE)).toBe(SATURDAY_9AM + 30 * MINUTE);
  });

  test("a failing brain retries at 4:10 and 4:20, then every 30 minutes; the error class goes to a file, and only the checker alerts", async () => {
    const ops = setupOps(FRIDAY_4PM);
    queueMany(ops.h, 10, fail("rate-limit"));

    await tickEveryMinute(ops, FRIDAY_4PM + 90 * MINUTE);

    expect(draftAttemptMinutes(ops)).toEqual([0, 10, 20, 50, 80]);
    const errorFile = readJson(fridayErrorPath(ops.h.paths.stateDir, COMING));
    expect(errorFile.errorClass).toBe("rate-limit");
    expect(errorFile.attempts).toBe(5);
    expect(errorFile.skipped).toBe(false);
    // The bridge sent nothing: no group line for a Friday failure, and no Telegram.
    expect(ops.sent.length).toBe(0);
    expect(ops.alerts.length).toBe(0);
    expect(existsSync(postedMarkerPath(ops.h.paths.stateDir, COMING))).toBe(false);

    // The checker's first run after 4:30 sends one line naming the class; its next run sends none.
    touchHeartbeat(ops.h.paths.stateDir, FRIDAY_4_31PM);
    const first = await runChecker({ stateDir: ops.h.paths.stateDir, nowMs: FRIDAY_4_31PM });
    expect(first.messages.length).toBe(1);
    expect(first.messages[0]).toContain("week of 2026-10-05");
    expect(first.messages[0]).toContain("rate-limit");
    const second = await runChecker({ stateDir: ops.h.paths.stateDir, nowMs: FRIDAY_4_31PM + MINUTE });
    expect(second.messages.length).toBe(0);
  });

  test("a success at Saturday 9:00 AM posts a draft marked late", async () => {
    const ops = setupOps(FRIDAY_4PM);
    ops.h.brain.next(fail("other"));
    await ops.scheduler.tick();

    ops.h.clock.nowMs = SATURDAY_9AM;
    ops.h.brain.next(draftAnswer);
    await ops.scheduler.tick();

    expect(ops.sent.length).toBe(1);
    expect(ops.sent[0]!.text.startsWith("(late) Here's the draft for Oct 5 to Oct 11:")).toBe(true);
    expect(existsSync(postedMarkerPath(ops.h.paths.stateDir, COMING))).toBe(true);
  });

  test("the last retry before Sunday noon still posts, marked late", async () => {
    const ops = setupOps(SUNDAY_11_50AM);
    ops.h.brain.next(draftAnswer);
    await ops.scheduler.tick();
    expect(ops.sent[0]!.text.startsWith("(late) ")).toBe(true);
  });

  test("past Sunday noon the week is skipped without calling the brain, and the checker alerts once", async () => {
    const ops = setupOps(FRIDAY_4PM);
    ops.h.brain.next(fail("rate-limit"));
    await ops.scheduler.tick();

    // The next retry comes due after noon on Sunday; a success is waiting, but it is too late.
    ops.h.clock.nowMs = SUNDAY_12_05PM;
    ops.h.brain.next(draftAnswer);
    await ops.scheduler.tick();
    ops.h.clock.nowMs += MINUTE;
    await ops.scheduler.tick();

    expect(ops.h.brain.handled.length).toBe(1);
    expect(ops.sent.length).toBe(0);
    expect(comingStatus(ops)).toBe("skipped");
    expect(readJson(postedMarkerPath(ops.h.paths.stateDir, COMING)).outcome).toBe("skipped-no-draft");
    const errorFile = readJson(fridayErrorPath(ops.h.paths.stateDir, COMING));
    expect(errorFile.skipped).toBe(true);
    expect(errorFile.errorClass).toBe("rate-limit");
    expect(ops.alerts.length).toBe(0);

    touchHeartbeat(ops.h.paths.stateDir, SUNDAY_12_05PM);
    const first = await runChecker({ stateDir: ops.h.paths.stateDir, nowMs: SUNDAY_12_05PM + MINUTE });
    expect(first.messages.length).toBe(1);
    expect(first.messages[0]).toContain("skipped");
    expect(first.messages[0]).toContain("rate-limit");
    expect((await runChecker({ stateDir: ops.h.paths.stateDir, nowMs: SUNDAY_12_05PM + 2 * MINUTE })).messages.length).toBe(0);
  });

  test("a bridge down all weekend skips the week on its first tick after Sunday noon, naming no attempt", async () => {
    const ops = setupOps(SUNDAY_12_05PM);
    await ops.scheduler.tick();
    expect(ops.h.brain.handled.length).toBe(0);
    expect(comingStatus(ops)).toBe("skipped");
    const errorFile = readJson(fridayErrorPath(ops.h.paths.stateDir, COMING));
    expect(errorFile.errorClass).toBe("no-attempt");
    expect(errorFile.skipped).toBe(true);
  });

  test("a restart between 4:00 and 4:30 does not re-post, because the marker lives in the state folder", async () => {
    const ops = setupOps(FRIDAY_4PM);
    ops.h.brain.next(draftAnswer);
    await ops.scheduler.tick();

    ops.restart();
    ops.h.clock.nowMs = FRIDAY_4PM + 20 * MINUTE;
    await ops.scheduler.tick();

    expect(ops.sent.length).toBe(1);
    expect(ops.h.brain.handled.length).toBe(1);
  });

  test("a bridge first started Friday 5:10 PM with an empty coming week drafts on its first tick, marked late", async () => {
    const ops = setupOps(FRIDAY_5_10PM);
    ops.h.brain.next(draftAnswer);
    await ops.scheduler.tick();
    expect(ops.sent.length).toBe(1);
    expect(ops.sent[0]!.text.startsWith("(late) Here's the draft")).toBe(true);
  });

  test("a bridge started at 4:05 PM drafts at once, not marked late", async () => {
    const ops = setupOps(FRIDAY_4PM + 5 * MINUTE);
    ops.h.brain.next(draftAnswer);
    await ops.scheduler.tick();
    expect(ops.sent[0]!.text.startsWith("Here's the draft")).toBe(true);
  });

  test("an Unknown send at 4:00 writes the send-unknown marker; neither the 4:10 retry nor a restart posts again", async () => {
    const ops = setupOps(FRIDAY_4PM);
    ops.h.brain.next(draftAnswer);
    ops.h.outcomes.push({ kind: "unknown", detail: "no answer from signal-cli before the timeout" });
    await ops.scheduler.tick();

    ops.h.clock.nowMs = FRIDAY_4PM + 10 * MINUTE;
    await ops.scheduler.tick();
    ops.restart();
    ops.h.clock.nowMs = FRIDAY_4PM + 11 * MINUTE;
    await ops.scheduler.tick();

    expect(existsSync(sendUnknownMarkerPath(ops.h.paths.stateDir, COMING))).toBe(true);
    expect(ops.sent.length).toBe(1);
    expect(ops.h.brain.handled.length).toBe(1);
  });

  test("a Partial send is marked posted and never re-posted", async () => {
    const ops = setupOps(FRIDAY_4PM);
    ops.h.brain.next(draftAnswer);
    ops.h.outcomes.push({ kind: "partial", timestamp: FRIDAY_4PM, failedMembers: [{ member: "aaaaaaaa-0000-4000-8000-000000000001", type: "UNREGISTERED_FAILURE" }] });
    await ops.scheduler.tick();

    await tickEveryMinute(ops, SATURDAY_9AM);

    expect(readJson(postedMarkerPath(ops.h.paths.stateDir, COMING)).outcome).toBe("partial");
    expect(ops.sent.length).toBe(1);
    expect(ops.h.brain.handled.length).toBe(1);
  });

  // WhatsApp keeps a draft for people whose 24-hour window is closed. That is the draft the
  // household will read, so the week is saved as drafted, written down as queued (not posted), and
  // the next ticks must not write a different draft.
  test("a draft kept for replies (Failed + queued) is saved as the drafted week once; later ticks and restarts draft nothing", async () => {
    const ops = setupOps(FRIDAY_4PM);
    ops.h.brain.next(draftAnswer);
    ops.h.outcomes.push({ kind: "failed", detail: "alex: waiting for a reply; sam: waiting for a reply", queued: true });
    await ops.scheduler.tick();

    expect(comingStatus(ops)).toBe("drafted");
    const marker = readJson(postedMarkerPath(ops.h.paths.stateDir, COMING));
    expect(marker.outcome).toBe("queued"); // not "sent": nobody has read it yet
    expect(existsSync(fridayErrorPath(ops.h.paths.stateDir, COMING))).toBe(false);
    const saved = readFileSync(join(ops.h.paths.weeksDir, `${COMING}.json`), "utf8");

    ops.restart();
    await tickEveryMinute(ops, SATURDAY_9AM);

    expect(ops.sent.length).toBe(1);
    expect(ops.h.brain.handled.length).toBe(1);
    expect(readFileSync(join(ops.h.paths.weeksDir, `${COMING}.json`), "utf8")).toBe(saved);
  });

  test("a draft that reached one person and is kept for another (Partial + queued) is also saved once and marked queued", async () => {
    const ops = setupOps(FRIDAY_4PM);
    ops.h.brain.next(draftAnswer);
    ops.h.outcomes.push({ kind: "partial", timestamp: FRIDAY_4PM, failedMembers: [{ member: "sam", type: "QUEUED" }], queued: true });
    await ops.scheduler.tick();
    await tickEveryMinute(ops, SATURDAY_9AM);

    expect(comingStatus(ops)).toBe("drafted");
    expect(readJson(postedMarkerPath(ops.h.paths.stateDir, COMING)).outcome).toBe("queued");
    expect(ops.sent.length).toBe(1);
    expect(ops.h.brain.handled.length).toBe(1);
  });

  test("a Failed send that is not queued still leaves the week undrafted (the queued rule does not swallow real failures)", async () => {
    const ops = setupOps(FRIDAY_4PM);
    ops.h.brain.next(draftAnswer);
    ops.h.outcomes.push({ kind: "failed", detail: "WhatsApp rejected it" });
    await ops.scheduler.tick();
    expect(comingStatus(ops)).toBe("empty");
    expect(existsSync(postedMarkerPath(ops.h.paths.stateDir, COMING))).toBe(false);
  });

  test("a send that came back Failed after its three retries leaves the week undrafted, and the next retry posts it marked late", async () => {
    const ops = setupOps(FRIDAY_4PM);
    ops.h.brain.next(draftAnswer);
    ops.h.outcomes.push({ kind: "failed", detail: "signal-cli error -5: rate limited" });
    await ops.scheduler.tick(); // the send's own retries end at 4:21

    expect(comingStatus(ops)).toBe("empty");
    expect(readJson(fridayErrorPath(ops.h.paths.stateDir, COMING)).errorClass).toBe("send-failed");

    ops.h.brain.next(draftAnswer);
    await tickEveryMinute(ops, FRIDAY_4PM + 60 * MINUTE);

    // 4:21 + 10 minutes is past 4:25, so the retry waits 30 minutes: 4:51.
    expect(draftAttemptMinutes(ops)).toEqual([0, 51]);
    expect(ops.sent.length).toBe(2);
    expect(ops.sent[1]!.text.startsWith("(late) Here's the draft")).toBe(true);
    expect(comingStatus(ops)).toBe("drafted");
  });

  test("Monday's first tick rolls the weeks over", async () => {
    const ops = setupOps(Date.parse("2026-10-05T14:00:00Z")); // Mon Oct 5, 9:00 AM
    saveWeek(ops.h.paths.weeksDir, { ...draftedWeek(), status: "locked", lockedAt: "2026-10-02T23:00:00.000Z" });
    await ops.scheduler.tick();
    expect(comingStatusOf(ops, "2026-10-05")).toBe("current");
  });
});

function comingStatusOf(ops: OpsHarness, weekOf: string): string {
  return loadWeek(ops.h.paths.weeksDir, weekOf).status;
}

// ---------------------------------------------------------------------------------------------
// A model outage during conversation, and the auth stop
// ---------------------------------------------------------------------------------------------

function unansweredIds(ops: OpsHarness): string[] {
  const path = unansweredPath(ops.h.paths.stateDir);
  if (!existsSync(path)) return [];
  return readJson(path).messages.map((entry: { id: string }) => entry.id);
}

describe("a model outage during conversation", () => {
  test("a rate-limited reply: one fixed line, the batch held and retried, and the reply when the call succeeds", async () => {
    const T = THURSDAY_10AM;
    const ops = setupOps(T);
    const m = message("Sam", "can we do tacos Tuesday?", T);
    ops.h.brain.next(fail("rate-limit"));
    ops.h.brain.next(fail("rate-limit"));
    ops.h.brain.next(answer([], "Tuesday is tacos."));

    ops.deliver(m);
    ops.h.clock.advance(15_000); // the quiet window: first try fails
    await ops.settle();
    expect(ops.sent.map((s) => s.text)).toEqual([OUTAGE_LINE]);
    expect(unansweredIds(ops)).toEqual([m.id]); // the fixed line is not a reply
    expect(ops.h.handled).toEqual([]);

    ops.h.clock.advance(10 * MINUTE); // second try fails: no second line
    await ops.settle();
    expect(ops.sent.length).toBe(1);

    // The checker, 16 minutes after the message, sends one line; the bridge sent no Telegram.
    ops.h.clock.nowMs = T + 16 * MINUTE;
    touchHeartbeat(ops.h.paths.stateDir, ops.h.clock.now());
    const run = await runChecker({ stateDir: ops.h.paths.stateDir, nowMs: ops.h.clock.now() });
    expect(run.messages.length).toBe(1);
    expect(run.messages[0]).toContain("no reply");
    expect(ops.alerts.length).toBe(0);

    ops.h.clock.advance(5 * MINUTE); // third try, at 20:15 after the message, succeeds
    await ops.settle();
    expect(ops.sent.map((s) => s.text)).toEqual([OUTAGE_LINE, "Tuesday is tacos."]);
    expect(ops.h.handled).toEqual([m.id]);
    expect(unansweredIds(ops)).toEqual([]);
    expect(existsSync(outagePath(ops.h.paths.stateDir))).toBe(false);
    expect(ops.h.brain.handled.length).toBe(3);
  });

  test("the fixed line is sent once per outage, and again for a new outage", async () => {
    const T = THURSDAY_10AM;
    const ops = setupOps(T);
    ops.h.brain.next(fail("other"));
    ops.h.brain.next(answer([], "Sure."));
    ops.h.brain.next(fail("other"));

    ops.deliver(message("Sam", "hi", T));
    ops.h.clock.advance(15_000);
    await ops.settle();
    ops.h.clock.advance(10 * MINUTE);
    await ops.settle();
    ops.deliver(message("Sam", "and again", ops.h.clock.now()));
    ops.h.clock.advance(15_000);
    await ops.settle();

    expect(ops.sent.map((s) => s.text)).toEqual([OUTAGE_LINE, "Sure.", OUTAGE_LINE]);
  });

  test("a restart during an outage does not repeat the fixed line", async () => {
    const T = THURSDAY_10AM;
    const ops = setupOps(T);
    queueMany(ops.h, 3, fail("rate-limit"));
    ops.deliver(message("Sam", "hi", T));
    ops.h.clock.advance(15_000);
    await ops.settle();

    ops.restart();
    ops.deliver(message("Sam", "hi", T)); // the inbox replays the unhandled message
    ops.h.clock.advance(15_000);
    await ops.settle();

    expect(ops.sent.map((s) => s.text)).toEqual([OUTAGE_LINE]);
  });

  test("not answered within 3 hours: one line asking to repeat, sent at the 3-hour mark without calling the model", async () => {
    const T = THURSDAY_10AM;
    const ops = setupOps(T);
    const m = message("Alex", "what's Wednesday?", T);
    queueMany(ops.h, 40, fail("rate-limit"));

    ops.deliver(m);
    ops.h.clock.advance(15_000);
    await ops.settle();
    for (let i = 0; i < 17; i++) {
      ops.h.clock.advance(10 * MINUTE); // retries through 2:50:15
      await ops.settle();
    }
    ops.h.clock.advance(9 * MINUTE + 45_000); // the 3-hour mark
    await ops.settle();
    ops.h.clock.advance(30 * MINUTE); // and nothing after it
    await ops.settle();

    expect(ops.sent.map((s) => s.text)).toEqual([OUTAGE_LINE, REPEAT_LINE]);
    expect(ops.sent[1]!.atMs).toBe(T + 3 * 60 * MINUTE);
    // Tries at 0:00:15, then every 10 minutes through 2:50:15; none after the give-up.
    expect(ops.h.brain.handled.length).toBe(18);
    expect(ops.h.handled).toEqual([m.id]);
    expect(unansweredIds(ops)).toEqual([]);
  });

  test("a logged deliberate silence clears the unanswered marker, so the checker stays quiet", async () => {
    const T = THURSDAY_10AM;
    const ops = setupOps(T);
    ops.h.brain.next(answer([], null)); // silent: adult-to-adult chatter
    ops.deliver(message("Sam", "running late, home at 7", T));
    ops.h.clock.advance(15_000);
    await ops.settle();

    expect(ops.sent.length).toBe(0);
    expect(unansweredIds(ops)).toEqual([]);
    ops.h.clock.nowMs = T + 16 * MINUTE;
    touchHeartbeat(ops.h.paths.stateDir, ops.h.clock.now());
    const run = await runChecker({ stateDir: ops.h.paths.stateDir, nowMs: ops.h.clock.now() });
    expect(run.messages.length).toBe(0);
  });
});

describe("the auth stop", () => {
  test("an auth failure stops every call, alerts once, posts one line, re-checks every 30 minutes, and resumes on success", async () => {
    const T = THURSDAY_10AM;
    const ops = setupOps(T);
    const first = message("Sam", "swap Tuesday", T);
    ops.h.brain.next(fail("auth"));

    ops.deliver(first);
    ops.h.clock.advance(15_000);
    await ops.settle();

    expect(ops.sent.map((s) => s.text)).toEqual([OUTAGE_LINE]);
    expect(ops.alerts.length).toBe(1);
    expect(ops.alerts[0]).toContain("Anthropic API key");
    expect(existsSync(alertStatePath(ops.h.paths.stateDir, "auth-stop"))).toBe(true);

    // A second message: no model call, no second line, no second alert.
    const second = message("Alex", "and Wednesday too", T + MINUTE);
    ops.deliver(second);
    ops.h.clock.advance(MINUTE);
    await ops.settle();
    expect(ops.h.brain.handled.length).toBe(1);

    // 30 minutes after the stop, one minimal call re-checks auth; it still fails.
    ops.h.clock.advance(29 * MINUTE);
    await ops.settle();
    expect(ops.authChecks).toBe(1);
    expect(ops.h.brain.handled.length).toBe(1);

    // Auth comes back: the next re-check resumes, clears the alert, and answers the held batch.
    ops.authOk = true;
    ops.h.brain.next(answer([], "Done: Tuesday and Wednesday swapped."));
    ops.h.clock.advance(30 * MINUTE);
    await ops.settle();

    expect(ops.authChecks).toBe(2);
    expect(existsSync(alertStatePath(ops.h.paths.stateDir, "auth-stop"))).toBe(false);
    expect(ops.h.brain.handled.length).toBe(2);
    const resumed = ops.h.brain.handled[1]!;
    expect(resumed.kind === "messages" ? resumed.messages.map((event) => event.id) : []).toEqual([first.id, second.id]);
    expect(ops.sent.map((s) => s.text)).toEqual([OUTAGE_LINE, "Done: Tuesday and Wednesday swapped."]);
    expect(ops.alerts.length).toBe(1);
    expect(unansweredIds(ops)).toEqual([]);
  });

  test("the Friday draft during an auth stop does not call the model and records the auth class", async () => {
    const ops = setupOps(FRIDAY_4PM - MINUTE);
    ops.h.brain.next(fail("auth"));
    ops.deliver(message("Sam", "hi", ops.h.clock.now()));
    ops.h.clock.advance(15_000);
    await ops.settle();

    ops.h.clock.nowMs = FRIDAY_4PM;
    await ops.scheduler.tick();
    expect(ops.h.brain.handled.length).toBe(1);
    expect(readJson(fridayErrorPath(ops.h.paths.stateDir, COMING)).errorClass).toBe("auth");
  });

  test("a restart while still logged out does not send the Telegram alert again", async () => {
    const T = THURSDAY_10AM;
    const ops = setupOps(T);
    ops.h.brain.next(fail("auth"));
    ops.deliver(message("Sam", "hi", T));
    ops.h.clock.advance(15_000);
    await ops.settle();

    ops.restart();
    ops.h.brain.next(fail("auth"));
    ops.deliver(message("Sam", "hi", T));
    ops.h.clock.advance(15_000);
    await ops.settle();

    expect(ops.alerts.length).toBe(1);
    expect(ops.sent.map((s) => s.text)).toEqual([OUTAGE_LINE]);
  });
});

// ---------------------------------------------------------------------------------------------
// The heartbeat, the reply markers, and the bridge's one Telegram send
// ---------------------------------------------------------------------------------------------

describe("heartbeat and reply markers", () => {
  test("touching the heartbeat sets the file's time to now", () => {
    const ops = setupOps(THURSDAY_10AM);
    touchHeartbeat(ops.h.paths.stateDir, THURSDAY_10AM);
    expect(statSync(heartbeatPath(ops.h.paths.stateDir)).mtimeMs).toBe(THURSDAY_10AM);
    touchHeartbeat(ops.h.paths.stateDir, THURSDAY_10AM + 5 * MINUTE);
    expect(statSync(heartbeatPath(ops.h.paths.stateDir)).mtimeMs).toBe(THURSDAY_10AM + 5 * MINUTE);
  });

  test("the reply tracker keeps a message's first-seen time across a restart and drops it when answered", () => {
    const ops = setupOps(THURSDAY_10AM);
    const stateDir = ops.h.paths.stateDir;
    let now = THURSDAY_10AM;
    const tracker = new ReplyTracker(stateDir, () => now);
    tracker.arrived("sam:1");
    now += MINUTE;
    tracker.arrived("alex:2");

    now += MINUTE;
    const reloaded = new ReplyTracker(stateDir, () => now);
    reloaded.arrived("sam:1"); // a replay after a restart keeps the first time
    expect(reloaded.firstSeen("sam:1")).toBe(THURSDAY_10AM);
    reloaded.answered("sam:1");

    expect(readJson(unansweredPath(stateDir))).toEqual({
      messages: [{ id: "alex:2", firstSeenMs: THURSDAY_10AM + MINUTE }],
      lastAnsweredMs: THURSDAY_10AM + 2 * MINUTE,
    });
  });
});

describe("the outage line", () => {
  test("says the admin was pinged only when an alert channel is set up", async () => {
    for (const alertsConfigured of [true, false]) {
      const ops = setupOps(THURSDAY_10AM, { alertsConfigured });
      ops.h.brain.next(fail("other"));
      ops.deliver(message("Sam", "what's for dinner", THURSDAY_10AM));
      ops.h.clock.advance(15_000);
      await ops.settle();
      expect(ops.sent.map((s) => s.text)).toEqual([alertsConfigured ? OUTAGE_LINE : OUTAGE_LINE_NO_ALERTS]);
    }
    expect(OUTAGE_LINE_NO_ALERTS).not.toContain("pinged");
    expect(OUTAGE_LINE_NO_ALERTS).toContain("logs");
  });
});
