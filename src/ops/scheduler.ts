// The bridge's clock-driven work and its failure policy.
//
// Scheduler: the draft tick and its retries (Friday 4 PM by default), plus the weekly rollover. The
// bridge calls tick() once a minute and once at start. Between the draft time and the catch-up
// deadline (Sunday noon by default), in the household's time zone, while the coming week has
// neither a posted nor a send-unknown marker, it asks the worker for the draft:
//
//   first try       at the first tick in the window: the draft time, or at start-up if the
//                   bridge was down then (the catch-up)
//   after a failure retry in 10 minutes while that is 5 minutes ahead of the late mark, otherwise
//                   in 30
//   late            a draft posted lateAfterMinutes or more after the draft time carries "(late)"
//   past deadline   no more tries: the week is skipped
//
// Each failure's error class goes to friday-error-<week>.json in the state directory; the
// scheduler never alerts. The health check (src/ops/check-health.ts) reads that file once the
// draft is late and names the class, and it sends the one "skipped" alert when the file says the
// week was skipped.
//
// FailurePolicy: sits between the worker and the real brain (it is the Brain the worker calls).
//
//   outage   a failed reply call: the group gets one fixed line per outage (not a reply), the
//         batch is held and retried every 10 minutes, and a message not answered within 3
//         hours gets one line asking to repeat it instead of an answer.
//   auth-stop   an auth- or billing-shaped failure stops every model call inside the running bridge
//         (polling and the heartbeat carry on): one alert (the only one the bridge
//         ever sends), the same fixed group line, and one minimal call every 30 minutes to
//         re-check auth. Success resumes, clears the alert, and retries the held batch.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrainError } from "../brain/claude.ts";
import { writeFileAtomically } from "../data/files.ts";
import type { SendOutcome } from "../messaging/types.ts";
import type { IngredientFill, IngredientRequest } from "../week/changeset.ts";
import type { ScheduleConfig } from "../config.ts";
import { NIGHTS } from "../data/profile.ts";
import { addDays, describeCatchUp, instantOfLocalTime, localDate, localTime, mondayOf } from "../week/state.ts";
import {
  postedMarkerPath,
  sendUnknownMarkerPath,
  type Brain,
  type BrainRequest,
  type BrainResult,
  type FridayDraftResult,
  type MissedDraftResult,
  type Timers,
} from "../week/worker.ts";
import { clearAlert, hasAlerted, recordAlert, type ReplyTracker } from "./heartbeat.ts";

const MINUTE = 60_000;

// The fixed line. It is not a reply, so it never clears the unanswered-message marker.
export const OUTAGE_LINE = "Can't think right now. The admin's been pinged; I'll answer when I'm back.";
// The same line when no alert channel is set up: it must not say anyone was pinged.
export const OUTAGE_LINE_NO_ALERTS = "Can't think right now. The admin will see it in the logs; I'll answer when I'm back.";
// The give-up line, for a message not answered within 3 hours.
export const REPEAT_LINE = "Sorry, I couldn't answer for over 3 hours. Can you send that again?";

// The error class of anything the brain or worker threw. BrainError carries one of
// "rate-limit", "auth", "parse", or "other"; anything else counts as "other".
export function errorClassOf(error: unknown): string {
  return error instanceof BrainError ? error.errorClass : "other";
}

function describeError(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

// ---------------------------------------------------------------------------------------------
// The draft window. Everything here reads the household's own clock (config.toml, [schedule]).
// ---------------------------------------------------------------------------------------------

// "drafting" runs from the draft time on the draft day to the catch-up deadline; "past-deadline"
// is the rest of the deadline's day.
export type DraftPhase = "outside" | "drafting" | "past-deadline";

// Position in the week as minutes since Monday 00:00 local time. Comparing positions (never
// "equal to") is what makes clock changes safe: a draft time that clocks skip over becomes due
// at the first minute after the gap, and one that happens twice is due from its first pass on.
// The posted marker keeps the second pass from drafting again.
function weekPosition(nowMs: number, schedule: ScheduleConfig): number {
  const { weekday, minutes } = localTime(nowMs, schedule.timeZone);
  return weekday * 1440 + minutes;
}

export function draftPhase(nowMs: number, schedule: ScheduleConfig): DraftPhase {
  const position = weekPosition(nowMs, schedule);
  const start = NIGHTS.indexOf(schedule.draftDay) * 1440 + schedule.draftMinutes;
  const end = NIGHTS.indexOf(schedule.catchUpDay) * 1440 + schedule.catchUpMinutes;
  if (position >= start && position < end) return "drafting";
  const { weekday } = localTime(nowMs, schedule.timeZone);
  if (position >= end && weekday === NIGHTS.indexOf(schedule.catchUpDay)) return "past-deadline";
  return "outside";
}

// When the most recent draft time was, as an instant: on the draft day this week or the week before.
export function lastDraftInstant(nowMs: number, schedule: ScheduleConfig): number {
  const { date, weekday } = localTime(nowMs, schedule.timeZone);
  const daysSince = (weekday - NIGHTS.indexOf(schedule.draftDay) + 7) % 7;
  return instantOfLocalTime(addDays(date, -daysSince), schedule.draftMinutes, schedule.timeZone);
}

// A draft posted lateAfterMinutes or more after the draft time is late (the health check has
// already alerted by then).
export function isLateDraft(nowMs: number, schedule: ScheduleConfig): boolean {
  return nowMs >= lastDraftInstant(nowMs, schedule) + schedule.lateAfterMinutes * MINUTE;
}

// When to try again after a failed try that ended at `failedAtMs`: in 10 minutes while that is
// still 5 minutes ahead of the late mark, otherwise in 30.
export function nextDraftAttempt(failedAtMs: number, schedule: ScheduleConfig): number {
  const lastRetryBy = lastDraftInstant(failedAtMs, schedule) + Math.max(schedule.lateAfterMinutes - 5, 0) * MINUTE;
  if (failedAtMs + 10 * MINUTE <= lastRetryBy) return failedAtMs + 10 * MINUTE;
  return failedAtMs + 30 * MINUTE;
}

function readableTime(nowMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(nowMs));
}

// ---------------------------------------------------------------------------------------------
// The Friday error file the checker reads
// ---------------------------------------------------------------------------------------------

export function fridayErrorPath(stateDir: string, weekOf: string): string {
  return join(stateDir, `friday-error-${weekOf}.json`);
}

export interface FridayErrorFile {
  weekOf: string;
  errorClass: string; // a BrainError class, "draft-incomplete", "send-failed", or "no-attempt"
  detail: string;
  attempts: number;
  at: string; // ISO time of the last failed try
  when: string; // the same, readable, for the alert line ("Fri 4:20 PM")
  skipped: boolean; // past the catch-up deadline the week was skipped: the checker alerts once
}

function readFridayError(stateDir: string, weekOf: string): FridayErrorFile | null {
  const path = fridayErrorPath(stateDir, weekOf);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as FridayErrorFile) : null;
}

function writeFridayError(stateDir: string, record: FridayErrorFile): void {
  writeFileAtomically(fridayErrorPath(stateDir, record.weekOf), JSON.stringify(record, null, 2) + "\n");
}

// ---------------------------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------------------------

// The parts of the worker the scheduler drives.
export interface ScheduledWorker {
  enqueueFridayDraft(options: { late: boolean }): Promise<FridayDraftResult>;
  enqueueMissedDraftSkip(): Promise<MissedDraftResult>;
  enqueueRollover(): Promise<void>;
}

export interface SchedulerOptions {
  stateDir: string;
  worker: ScheduledWorker;
  schedule: ScheduleConfig;
  now: () => number;
  log: (line: string) => void;
}

export class Scheduler {
  private busy = false;
  private lastMonday: string | null = null;
  // When the next draft try is due, per coming week. Kept in memory only: after a restart the
  // first tick in the window tries at once, which is the catch-up.
  private nextAttemptAt = new Map<string, number>();
  // Set by the worker's onFailure during a draft try, so the error class survives the worker's
  // plain "draft-failed" result.
  private draftError: unknown = null;

  constructor(private options: SchedulerOptions) {}

  // The bridge routes the worker's onFailure(error, "friday-draft") here.
  noteDraftError(error: unknown): void {
    this.draftError = error;
  }

  async tick(): Promise<void> {
    // A draft try can outlast a tick (a Failed send retries for 21 minutes); never start another.
    if (this.busy) return;
    this.busy = true;
    try {
      await this.rolloverIfNewWeek();
      await this.fridayStep();
    } catch (error) {
      this.options.log(`scheduler tick failed: ${(error as Error)?.stack ?? error}`);
    } finally {
      this.busy = false;
    }
  }

  // The worker rolls weeks over at the start of every job; this makes sure a job runs on the
  // first tick of each week (and at start-up) even when nobody writes.
  private async rolloverIfNewWeek(): Promise<void> {
    const monday = mondayOf(localDate(this.options.now(), this.options.schedule.timeZone));
    if (monday === this.lastMonday) return;
    this.lastMonday = monday;
    await this.options.worker.enqueueRollover();
  }

  private async fridayStep(): Promise<void> {
    const { stateDir, now, schedule } = this.options;
    const phase = draftPhase(now(), schedule);
    if (phase === "outside") return;

    const weekOf = addDays(mondayOf(localDate(now(), schedule.timeZone)), 7);
    // Posted (or counted as posted), or maybe on the phones already: nothing more to do.
    if (existsSync(postedMarkerPath(stateDir, weekOf)) || existsSync(sendUnknownMarkerPath(stateDir, weekOf))) return;

    if (phase === "past-deadline") {
      await this.skipMissedWeek(weekOf);
      return;
    }
    if (now() < (this.nextAttemptAt.get(weekOf) ?? 0)) return;
    await this.tryDraft(weekOf);
  }

  private async tryDraft(weekOf: string): Promise<void> {
    const { log, now, worker } = this.options;
    const late = isLateDraft(now(), this.options.schedule);
    this.draftError = null;
    log(`friday draft: trying for the week of ${weekOf}${late ? " (late)" : ""}`);

    let result: FridayDraftResult;
    try {
      result = await worker.enqueueFridayDraft({ late });
    } catch (error) {
      result = { kind: "draft-failed", weekOf, reason: describeError(error) };
      this.draftError = error;
    }

    let errorClass: string;
    let detail: string;
    switch (result.kind) {
      case "posted":
      case "queued": // kept for people until they reply: the week is drafted and is not drafted again
      case "nothing-to-post":
      case "already-posted":
      case "send-unknown":
        log(`friday draft: ${result.kind} for the week of ${result.weekOf}`);
        this.nextAttemptAt.delete(weekOf);
        return;
      case "draft-failed":
        // No brain error means the brain answered but the draft was not usable (nights left open).
        errorClass = this.draftError === null ? "draft-incomplete" : errorClassOf(this.draftError);
        detail = this.draftError === null ? result.reason : describeError(this.draftError);
        break;
      case "send-failed":
        errorClass = "send-failed";
        detail = result.detail;
        break;
    }

    // The next try counts from when this one ended: a Failed send's own retries take minutes.
    const endedAt = now();
    const previous = readFridayError(this.options.stateDir, weekOf);
    writeFridayError(this.options.stateDir, {
      weekOf,
      errorClass,
      detail,
      attempts: (previous?.attempts ?? 0) + 1,
      at: new Date(endedAt).toISOString(),
      when: readableTime(endedAt, this.options.schedule.timeZone),
      skipped: false,
    });
    const next = nextDraftAttempt(endedAt, this.options.schedule);
    this.nextAttemptAt.set(weekOf, next);
    log(`friday draft failed (${errorClass}: ${detail}); next try ${readableTime(next, this.options.schedule.timeZone)}`);
  }

  // Past the catch-up deadline: skip the week, and record it for the checker's one alert. The record is
  // written first, so a crash in between skips again on the next tick without losing the alert.
  private async skipMissedWeek(weekOf: string): Promise<void> {
    const { log, now, stateDir, worker, schedule } = this.options;
    const previous = readFridayError(stateDir, weekOf);
    if (!previous?.skipped) {
      const at = now();
      writeFridayError(stateDir, {
        weekOf,
        errorClass: previous?.errorClass ?? "no-attempt",
        detail: previous?.detail ?? `no draft try was made before ${describeCatchUp(schedule)} (was the bridge running?)`,
        attempts: previous?.attempts ?? 0,
        at: previous?.at ?? new Date(at).toISOString(),
        when: previous?.when ?? readableTime(at, schedule.timeZone),
        skipped: true,
      });
    }
    const result = await worker.enqueueMissedDraftSkip();
    log(`friday draft: past ${describeCatchUp(schedule)} for the week of ${weekOf}: ${result.kind}`);
  }
}

// ---------------------------------------------------------------------------------------------
// FailurePolicy: outage line and auth stop
// ---------------------------------------------------------------------------------------------

// Present while a conversation outage is under way and its fixed line has been sent. On disk,
// so a restart mid-outage does not post the line again.
export function outagePath(stateDir: string): string {
  return join(stateDir, "outage.json");
}

const AUTH_STOP_KEY = "auth-stop";

// What a call gets while the auth stop is on: no model call was made.
class CallsStoppedError extends BrainError {
  constructor() {
    super("auth", "Model calls are stopped after an auth failure; auth is re-checked every 30 minutes.");
  }
}

export interface FailurePolicyOptions {
  stateDir: string;
  brain: Brain; // the real brain
  sendToConversation: (text: string) => Promise<SendOutcome>;
  flush: () => Promise<void>; // worker.flush: retries the held batch
  checkAuth: () => Promise<void>; // one minimal model call; throws a BrainError on failure
  alert: (text: string) => Promise<boolean>; // true when the alert was handled (sent, or logged when no channel is set up)
  alertsConfigured?: boolean; // false: no alert channel, so the outage line must not say the admin was pinged (default true)
  replies: ReplyTracker;
  now: () => number;
  timers: Timers;
  log: (line: string) => void;
  retryMs?: number; // held batch retry, default 10 minutes
  authRecheckMs?: number; // default 30 minutes
  giveUpMs?: number; // default 3 hours
}

export class FailurePolicy implements Brain {
  private stopped = false;
  private retryTimer: unknown = null;
  private authTimer: unknown = null;
  private work: Promise<unknown> = Promise.resolve();
  private retryMs: number;
  private authRecheckMs: number;
  private giveUpMs: number;

  constructor(private options: FailurePolicyOptions) {
    this.retryMs = options.retryMs ?? 10 * MINUTE;
    this.authRecheckMs = options.authRecheckMs ?? 30 * MINUTE;
    this.giveUpMs = options.giveUpMs ?? 3 * 60 * MINUTE;
  }

  // ----- The Brain the worker calls -----

  async handle(request: BrainRequest): Promise<BrainResult> {
    if (request.kind === "messages" && this.pastGiveUp(request.messages.map((event) => event.id))) {
      this.options.log(`no answer within 3 hours for ${request.messages.map((event) => event.id).join(", ")}; asking to repeat`);
      return { changeSet: { operations: [] }, reply: { kind: "text", text: REPEAT_LINE } };
    }
    return this.call(() => this.options.brain.handle(request));
  }

  async fillIngredients(requests: IngredientRequest[]): Promise<IngredientFill[]> {
    return this.call(() => this.options.brain.fillIngredients(requests));
  }

  // ----- What the bridge routes here -----

  // The worker's onFailure(error, "messages"): the batch is held, unhandled.
  onMessageFailure(error: unknown): void {
    // A batch that was already on its way when auth came back was turned away by the stop.
    // The outage is over, so retry it now, with no new line.
    if (error instanceof CallsStoppedError && !this.stopped) {
      this.track(this.options.flush());
      return;
    }
    this.options.log(`reply call failed (${errorClassOf(error)}); holding the batch`);
    this.sendOutageLineOnce();
    this.scheduleRetry();
  }

  // Resolves once no alert, line, or re-check started here is still running. For tests.
  async idle(): Promise<void> {
    let seen: Promise<unknown>;
    do {
      seen = this.work;
      await seen;
    } while (seen !== this.work);
  }

  // ----- Inside -----

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new CallsStoppedError();
    try {
      const result = await fn();
      this.endOutage();
      return result;
    } catch (error) {
      if (errorClassOf(error) === "auth") this.enterAuthStop(error);
      throw error;
    }
  }

  // True when any of the messages was first seen 3 hours ago or more.
  private pastGiveUp(ids: string[]): boolean {
    const now = this.options.now();
    return ids.some((id) => {
      const firstSeen = this.options.replies.firstSeen(id);
      return firstSeen !== null && now - firstSeen >= this.giveUpMs;
    });
  }

  // The earliest give-up time among the messages still waiting, if any.
  private nextGiveUpAt(): number | null {
    const oldest = this.options.replies.oldestFirstSeen();
    return oldest === null ? null : oldest + this.giveUpMs;
  }

  // Retry the held batch in 10 minutes, or sooner if a message reaches 3 hours before then.
  private scheduleRetry(): void {
    const { timers, now } = this.options;
    if (this.retryTimer !== null) timers.clear(this.retryTimer);
    let delay = this.retryMs;
    const giveUpAt = this.nextGiveUpAt();
    if (giveUpAt !== null) delay = Math.max(0, Math.min(delay, giveUpAt - now()));
    this.retryTimer = timers.set(() => {
      this.retryTimer = null;
      this.track(this.options.flush());
    }, delay);
  }

  private sendOutageLineOnce(): void {
    const path = outagePath(this.options.stateDir);
    if (existsSync(path)) return;
    // Recorded before sending, so two failures in a row never post the line twice.
    writeFileSync(path, JSON.stringify({ lineSentAt: new Date(this.options.now()).toISOString() }) + "\n");
    this.track(this.options.sendToConversation(this.options.alertsConfigured === false ? OUTAGE_LINE_NO_ALERTS : OUTAGE_LINE));
  }

  // A model call succeeded: the outage is over, and the next one gets its own line.
  private endOutage(): void {
    const path = outagePath(this.options.stateDir);
    if (!existsSync(path)) return;
    rmSync(path, { force: true });
    this.options.log("model calls are working again");
  }

  private enterAuthStop(error: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    this.options.log(`auth failure: model calls stopped until auth works again (${describeError(error)})`);
    this.sendOutageLineOnce();
    this.track(this.alertAuthStopOnce(error));
    this.scheduleAuthRecheck();
  }

  // One alert per auth outage, remembered in the shared alert state so a restart
  // during the same outage does not send it again.
  private async alertAuthStopOnce(error: unknown): Promise<void> {
    const { stateDir, now } = this.options;
    if (hasAlerted(stateDir, AUTH_STOP_KEY)) return;
    const text =
      `Dinner agent: model calls are stopped. The Anthropic API key failed (${describeError(error)}). ` +
      "Check the key and that the account has credit (see docs/model.md), then restart the bridge if you changed the key. " +
      "The bridge re-checks every 30 minutes and resumes on its own.";
    if (await this.options.alert(text)) recordAlert(stateDir, AUTH_STOP_KEY, text, now());
  }

  private scheduleAuthRecheck(): void {
    const { timers } = this.options;
    if (this.authTimer !== null) timers.clear(this.authTimer);
    this.authTimer = timers.set(() => {
      this.authTimer = null;
      this.track(this.recheckAuth());
    }, this.authRecheckMs);
  }

  private async recheckAuth(): Promise<void> {
    const { log, stateDir } = this.options;
    try {
      await this.options.checkAuth();
    } catch (error) {
      log(`auth re-check failed (${errorClassOf(error)}: ${describeError(error)}); next in 30 minutes`);
      // If the alert could not be sent when the stop began, try it again.
      await this.alertAuthStopOnce(error);
      this.scheduleAuthRecheck();
      return;
    }
    this.stopped = false;
    clearAlert(stateDir, AUTH_STOP_KEY);
    this.endOutage();
    log("auth works again: model calls resumed");
    await this.options.flush();
  }

  // Keeps background work in one chain so idle() can wait for it, and logs its failures.
  private track(promise: Promise<unknown>): void {
    const caught = promise.catch((error) => this.options.log(`failure policy: ${(error as Error)?.stack ?? error}`));
    this.work = Promise.all([this.work, caught]);
  }
}
