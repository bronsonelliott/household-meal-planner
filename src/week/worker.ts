// The serial worker: every change to a week, the profile, or the log goes through here, one
// job at a time (the single writer).
//
// Adult messages collect for a quiet window (about 15 seconds after the last one), then go to
// the brain as one batch. The brain returns a change set; the worker checks each operation's
// provenance, works out which week it targets, and applies it. The Friday tick and the Monday
// rollover run through the same queue.
//
// Crash safety, in the order things happen for a batch:
//
//   1. journal "batch"      the checked operations, the weeks as they were, any ingredient
//                           fills: everything needed to apply it again without the model
//   2. apply                profile and log changes (each followed by "step-done"), then the
//                           week files; every step is safe to run twice
//   3. journal "applied"    with the reply text
//   4. journal "sending"    then send, then journal "outcome"
//   5. mark the messages handled, then journal "done"
//
// On restart a journaled message never goes back to the model. A batch without "applied" is
// applied again; a reply without "sending" is sent; a reply with "sending" but no outcome may
// have gone out, so it goes back through the sender with the same key. The sender knows which
// parts and which people already got it (they are skipped), which one was cut off mid-send (that
// one is Unknown and is never sent again), and which were never tried (those are sent now).
//
// Journal: <stateDir>/batches.jsonl, append-only, one JSON object per line (journal.ts). The
// pure planning the worker applies lives in plan.ts.

import { existsSync, rmSync } from "node:fs";
import { writeFileAtomically } from "../data/files.ts";
import { join } from "node:path";
import { appendChangeAfterLock, appendReport, appendWeek, LogError, readLog, type LogEntry } from "../data/log.ts";
import {
  addDish,
  addDislike,
  addRule,
  addVeto,
  NIGHTS,
  ProfileError,
  readProfile,
  readProfileStatus,
  removeRule,
  removeVeto,
  undoLastChange,
  type HouseProfile,
  type Night,
  type ProfileFiles,
} from "../data/profile.ts";
import { parseRecipeCommand, runRecipeCommandAsync, type RecipeCommand } from "../recipes/commands.ts";
import type { SiteContext } from "../recipes/site/context.ts";
import { loadCatalog } from "../recipes/catalog.ts";
import { loadSources } from "../recipes/sources.ts";
import { emptyRecipeContext, type RecipeContext } from "../recipes/types.ts";
import type { InboundEvent, SendOutcome } from "../messaging/types.ts";
import {
  capitalize,
  describeOperation,
  inMessageOrder,
  provenanceProblem,
  type ChangeSet,
  type IngredientFill,
  type IngredientRequest,
  type Operation,
} from "./changeset.ts";
import { parseInterviewCommand } from "../onboarding/control.ts";
import { AWAITING_PROFILE_LINE, CATCHING_UP_LINE } from "../onboarding/questions.ts";
import type { OnboardingExtractOutcome, OnboardingExtractRequest } from "../onboarding/state.ts";
import { Interview, type InterviewSettings } from "./interview.ts";
import { BatchJournal, journalPath, type InterviewInput, type JournalEntry, type JournalRecord, type LogAction, type Step } from "./journal.ts";
import type { ScheduleConfig } from "../config.ts";
import { injectFills, loggedNights, nightsNeedingIngredients, planWeeks, resolveDish, resolveTargetWeek } from "./plan.ts";
import {
  addDays,
  applyDraft,
  buildGroceryList,
  describeCatchUp,
  loadWeek,
  localDate,
  mondayOf,
  nightDate,
  renderDraft,
  renderGroceryList,
  renderListDelta,
  renderRestatedWeek,
  rolloverWeek,
  saveWeek,
  shortDate,
  skipWeek,
  storedWeeks,
  type NightValue,
  type WeekFile,
  type WeekStatus,
} from "./state.ts";

// ---------------------------------------------------------------------------------------------
// The brain's interface (the brain module builds the real one; tests use a stub)
// ---------------------------------------------------------------------------------------------

// What the harness hands the brain alongside the messages.
export interface BrainContext {
  now: number;
  today: string; // local date, YYYY-MM-DD
  currentWeek: WeekFile; // the week being eaten
  comingWeek: WeekFile; // next Monday's week
  profile: HouseProfile;
  recentLog: LogEntry[]; // the repeat window plus one week
  // Sources and saved recipes as of the start of this job. Planning reads only this copy.
  recipes: RecipeContext;
}

// `triggerId` is the ID every operation must name as its source: the first message's ID for
// a message batch, and the tick's own ID for the Friday draft.
export type BrainRequest =
  | { kind: "messages"; triggerId: string; messages: InboundEvent[]; context: BrainContext }
  | { kind: "friday-draft"; triggerId: string; weekOf: string; late: boolean; context: BrainContext };

// "silent" is the explicit no-reply: adult-to-adult chatter gets nothing.
export type BrainReply = { kind: "text"; text: string } | { kind: "silent"; reason: string };

export interface BrainResult {
  changeSet: ChangeSet;
  reply: BrainReply;
}

export interface Brain {
  handle(request: BrainRequest): Promise<BrainResult>;
  // At lock, ingredient lines for the nights that have none. Only those nights.
  fillIngredients(requests: IngredientRequest[]): Promise<IngredientFill[]>;
  // The house-rules interview: read one batch of answers. Optional so test stubs need not have it.
  extractOnboarding?(request: OnboardingExtractRequest): Promise<OnboardingExtractOutcome>;
}

// ---------------------------------------------------------------------------------------------
// Options and results
// ---------------------------------------------------------------------------------------------

export interface WorkerPaths {
  weeksDir: string; // <data folder>/weeks
  logPath: string;
  profileFiles: ProfileFiles;
  sourcesPath: string; // <data folder>/recipe-sources.json
  catalogPath: string; // <data folder>/recipe-catalog.json
  refreshStatusPath?: string; // <data folder>/recipe-refresh.json (what "recipes status" reports)
  stateDir: string; // machine-local: the batch journal and the Friday markers
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface WorkerOptions {
  paths: WorkerPaths;
  brain: Brain;
  // Messenger.sendToConversation. `key` names the send, so a restart can carry on a split reply.
  send: (text: string, key: string) => Promise<SendOutcome>;
  markHandled: (inboundId: string) => void; // Messenger.markHandled
  // Whether a member (by configured ID) has the admin role. Some recipe commands need it.
  isAdmin: (memberId: string) => boolean;
  // The shared web client for sites switched on for fetching. Without it those two commands say they can't.
  site?: SiteContext;
  now: () => number;
  quietWindowMs: number; // the profile's batching-window-seconds, in ms
  // The household's clock and draft deadline (config.toml, [schedule]).
  schedule: ScheduleConfig;
  timers?: Timers;
  log?: (line: string) => void;
  // Turns the house-rules interview on: with these settings, a household with no profile is
  // interviewed in the chat, and `set up house rules` can start a redo. Left out, the worker needs a profile.
  interview?: InterviewSettings;
  // The newest local receipt number so far (messenger.receiptHighWater). The interview notes it when
  // a read-back finishes going out; only a message numbered after that can approve it.
  receiptHighWater?: () => number;
  // The interview just saved the profile (the id names the save, for anything that must act once).
  onProfileSaved?: (commitId: string, mode: "first-run" | "redo") => void;
  // A brain call failed. The messages stay queued (and unhandled) until flush() is called
  // again or the next message arrives; the scheduler's failure policy decides when.
  onFailure?: (error: unknown, what: "messages" | "friday-draft") => void;
}

export type FridayDraftResult =
  | { kind: "posted"; weekOf: string; outcome: "sent" | "partial" }
  // The chat app is keeping the draft for people until they reply (WhatsApp outside its 24-hour
  // window). The week is saved as drafted, but it is not claimed as posted: nobody has it yet.
  | { kind: "queued"; weekOf: string; detail: string }
  | { kind: "send-unknown"; weekOf: string }
  | { kind: "send-failed"; weekOf: string; detail: string }
  | { kind: "nothing-to-post"; weekOf: string; status: WeekStatus } // drafted, locked, or skipped: counts as posted
  | { kind: "already-posted"; weekOf: string }
  | { kind: "draft-failed"; weekOf: string; reason: string };

// The draft deadline: past the catch-up time with no draft posted, the coming week is skipped.
export type MissedDraftResult =
  | { kind: "skipped"; weekOf: string; previousStatus: WeekStatus }
  | { kind: "nothing-to-post"; weekOf: string; status: WeekStatus } // drafted, locked, or skipped already
  | { kind: "already-posted"; weekOf: string }
  | { kind: "send-unknown"; weekOf: string };

// The Friday markers live in the state directory, never in the week file. The checker
// looks for the posted marker once the draft is late.
export function postedMarkerPath(stateDir: string, weekOf: string): string {
  return join(stateDir, `friday-posted-${weekOf}.json`);
}

export function sendUnknownMarkerPath(stateDir: string, weekOf: string): string {
  return join(stateDir, `friday-send-unknown-${weekOf}.json`);
}

// ---------------------------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------------------------

export const DEFAULT_TIMERS: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class Worker {
  private journal: BatchJournal;
  private pending: InboundEvent[] = [];
  private commandsInFlight = new Set<string>();
  private quietTimer: unknown = null;
  private chain: Promise<unknown> = Promise.resolve();
  private timers: Timers;
  private log: (line: string) => void;
  private interview: Interview | null = null;
  private lastNudgeAt = -Infinity;

  constructor(private options: WorkerOptions) {
    this.timers = options.timers ?? DEFAULT_TIMERS;
    this.log = options.log ?? ((line) => console.log(`${new Date().toISOString()} ${line}`));
    // A practice run has a journal of its own, so a real start never replays its turns.
    this.journal = new BatchJournal(journalPath(options.paths.stateDir, options.interview?.dryRun ?? false), this.log);
    if (options.interview) {
      this.interview = new Interview({
        stateDir: options.paths.stateDir,
        profileFiles: options.paths.profileFiles,
        journal: this.journal,
        extract: options.brain.extractOnboarding ? (request) => options.brain.extractOnboarding!(request) : undefined,
        send: (text, key) => options.send(text, key),
        now: options.now,
        log: this.log,
        settings: options.interview,
        receiptHighWater: () => options.receiptHighWater?.() ?? 0,
        onProfileSaved: (commitId, mode) => this.profileSaved(commitId, mode),
      });
    }
  }

  // ----- Entry points -----

  // A text from a household member (the messenger's onEvent). A message already in the journal is a
  // replay after a restart: its batch is finished, never sent to the model again.
  enqueueMessage(event: InboundEvent): void {
    const batchId = this.journal.batchIdFor(event.id);
    if (batchId !== undefined) {
      this.run(() => this.finishBatch(batchId)).catch(() => {}); // run() already logged any failure
      return;
    }
    // A message that is wholly a recipe command is answered by code, now, without the quiet
    // window or the model.
    const command = parseRecipeCommand(event.text);
    if (command) {
      if (this.commandsInFlight.has(event.id)) return;
      this.commandsInFlight.add(event.id);
      this.run(() => this.handleCommand(event, command))
        .catch(() => {}) // run() already logged any failure
        .finally(() => this.commandsInFlight.delete(event.id));
      return;
    }
    // The house-rules interview: its commands work any time; while it is under way, everything else is an answer.
    if (this.interview) {
      const control = parseInterviewCommand(event.text);
      const interviewing = this.interview.isActive();
      if (control === "setup" || control === "cancel" || control === "sample" || (control === "approve" && interviewing)) {
        if (this.commandsInFlight.has(event.id)) return;
        this.commandsInFlight.add(event.id);
        this.run(() => this.handleInterviewCommand(event, control))
          .catch(() => {})
          .finally(() => this.commandsInFlight.delete(event.id));
        return;
      }
      if (!interviewing && !this.hasProfile()) {
        if (this.commandsInFlight.has(event.id)) return;
        this.commandsInFlight.add(event.id);
        this.run(() => this.handleWithoutProfile(event))
          .catch(() => {})
          .finally(() => this.commandsInFlight.delete(event.id));
        return;
      }
    }
    if (this.pending.some((queued) => queued.id === event.id)) return;
    this.pending.push(event);

    // Restart the quiet window: the batch goes when nobody has written for a while.
    if (this.quietTimer !== null) this.timers.clear(this.quietTimer);
    this.quietTimer = this.timers.set(() => {
      this.quietTimer = null;
      this.flush().catch(() => {}); // run() already logged any failure
    }, this.options.quietWindowMs);
  }

  // Sends whatever is queued to the brain now. Also how held messages are retried.
  flush(): Promise<void> {
    if (this.quietTimer !== null) {
      this.timers.clear(this.quietTimer);
      this.quietTimer = null;
    }
    const events = this.pending.splice(0);
    if (events.length === 0) return this.idle();
    return this.run(async () => {
      await this.handleBatch(events);
    });
  }

  // The scheduled draft tick (and its retries). The scheduler calls this; `late` marks a draft posted after
  // the first attempts failed.
  enqueueFridayDraft(options: { late: boolean }): Promise<FridayDraftResult> {
    return this.run(() => this.fridayDraft(options.late));
  }

  // The draft deadline: past the catch-up time the scheduler gives up on the draft and skips the coming week.
  // The week then counts as posted, so no later tick or restart tries again.
  enqueueMissedDraftSkip(): Promise<MissedDraftResult> {
    return this.run(async () => this.missedDraftSkip());
  }

  // Monday rollover. Also runs at the start of every job, so a missed tick catches up.
  enqueueRollover(): Promise<void> {
    return this.run(async () => {});
  }

  // Finishes every batch and draft the journal shows as unfinished. Call once at start-up,
  // before the messenger goes live.
  recover(): Promise<void> {
    return this.run(async () => {
      for (const entry of this.journal.unfinished()) {
        if (entry.batch || entry.interview) await this.finishBatch(entry.id);
        else if (entry.draft) await this.recoverDraft(entry.id);
      }
    });
  }

  // Resolves once no job is running or queued.
  async idle(): Promise<void> {
    let seen: Promise<unknown>;
    do {
      seen = this.chain;
      await seen;
    } while (seen !== this.chain);
  }

  // ----- The serial queue -----

  private run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      this.rolloverIfDue();
      return job();
    });
    // One job's failure must not stop the queue.
    this.chain = result.catch((error) => this.log(`worker job failed: ${(error as Error)?.stack ?? error}`));
    return result;
  }

  private today(): string {
    return localDate(this.options.now(), this.options.schedule.timeZone);
  }

  private context(): BrainContext {
    const { paths } = this.options;
    const today = this.today();
    const currentMonday = mondayOf(today);
    const profile = readProfile(paths.profileFiles.profilePath);
    const log = readLog(paths.logPath);
    return {
      now: this.options.now(),
      today,
      currentWeek: loadWeek(paths.weeksDir, currentMonday),
      comingWeek: loadWeek(paths.weeksDir, addDays(currentMonday, 7)),
      profile,
      recentLog: log.slice(-(profile.thresholds.repeatWindowWeeks + 1)),
      recipes: this.readRecipes(),
    };
  }

  // A damaged sources or catalog file must not stop dinner planning: planning goes on without
  // that file, and the log says why.
  private readRecipes(): RecipeContext {
    const { paths } = this.options;
    const recipes = emptyRecipeContext();
    try {
      recipes.sources = loadSources(paths.sourcesPath, new Date(this.options.now()).toISOString()).sources;
    } catch (error) {
      this.log(`recipe sources not used: ${(error as Error).message}`);
    }
    try {
      recipes.catalog = loadCatalog(paths.catalogPath);
    } catch (error) {
      this.log(`recipe catalog not used: ${(error as Error).message}`);
    }
    return recipes;
  }

  // ----- A recipe command -----

  // The same journal path as a model batch, with one "command" step and no model call: the
  // command's reply is the batch's reply, and a restart finishes it without running it twice.
  private async handleCommand(event: InboundEvent, command: RecipeCommand): Promise<void> {
    const id = event.id;
    this.journal.append({
      type: "batch",
      id,
      inboundIds: [id],
      at: new Date(this.options.now()).toISOString(),
      today: this.today(),
      weeksBefore: [],
      steps: [{ kind: "command", command, admin: this.options.isAdmin(event.memberId), by: event.memberId }],
      fills: [],
      brainText: null,
    });
    await this.finishBatch(id);
  }

  // ----- The house-rules interview -----

  private hasProfile(): boolean {
    return readProfileStatus(this.options.paths.profileFiles.profilePath).kind !== "setup-needed";
  }

  // At start-up: begin the first-run interview if there is no profile (the welcome is posted once;
  // a restart does not post it again). Call after recover(), in the same queue.
  startOnboarding(): Promise<void> {
    return this.run(async () => {
      const interview = this.interview;
      if (!interview) return;
      await this.resumeInterviewTurns();
      interview.closeIfProfileAppeared();
      if (!interview.startupNeeded()) return;
      const dry = this.options.interview!.dryRun ? "dry-" : "";
      const id = `iv-start-${dry}${this.options.now()}`;
      this.appendInterviewTurn(id, [], { kind: "startup" });
      await this.finishInterviewTurn(this.journal.get(id)!);
    });
  }

  // Records the start of an interview turn, with the mode (practice or real) it begins in.
  private appendInterviewTurn(id: string, inboundIds: string[], input: InterviewInput): void {
    this.journal.append({ type: "interview", id, inboundIds, at: new Date(this.options.now()).toISOString(), input, dryRun: this.options.interview!.dryRun });
  }

  // A turn that stopped part-way (or whose last write failed) is finished before anything newer
  // changes the interview, so a later turn never builds on a state its predecessor had not finished.
  // Throws if one of them cannot be finished.
  private async resumeInterviewTurns(): Promise<void> {
    for (const entry of this.journal.unfinished()) {
      if (entry.interview) await this.finishInterviewTurn(entry);
    }
  }

  // Commands and approvals, each one a turn of its own. Answers waiting for the quiet window are read first, in order.
  private async handleInterviewCommand(event: InboundEvent, command: "setup" | "cancel" | "sample" | "approve"): Promise<void> {
    const interview = this.interview!;
    if (this.quietTimer !== null) {
      this.timers.clear(this.quietTimer);
      this.quietTimer = null;
    }
    const waiting = this.pending.splice(0);
    let held = false;
    if (waiting.length > 0) held = (await this.handleBatch(waiting)) === "held";
    // An earlier answer the model could not read yet is still waiting: an approval must not get ahead of it.
    if (command === "approve" && held) {
      await this.replyAlone(event, CATCHING_UP_LINE);
      return;
    }
    await this.resumeInterviewTurns();
    if (interview.load().kind === "corrupt") {
      await this.replyAlone(event, "I can't read my setup notes (state/onboarding.json), so I can't start or change the setup. The admin needs to look at it; bun run doctor says what is wrong.");
      return;
    }
    const input: InterviewInput =
      command === "approve"
        ? { kind: "approve", by: event.memberId, byName: event.memberName, messageId: event.id, repliesToNativeId: event.replyToNativeId ?? null, receiptSeq: event.receiptSeq ?? null }
        : { kind: "command", command, by: event.memberId, byName: event.memberName, messageId: event.id };
    this.appendInterviewTurn(`iv-${event.id}`, [event.id], input);
    await this.finishBatch(`iv-${event.id}`);
  }

  // Answers to the interview: read by the model once, recorded, then carried out. Returns "held"
  // when the model could not read them and they were put back to try again.
  private async handleInterviewAnswers(events: InboundEvent[]): Promise<"held" | "done"> {
    const interview = this.interview!;
    let input: InterviewInput;
    try {
      await this.resumeInterviewTurns();
      input = await interview.prepareAnswers(events);
    } catch (error) {
      // Nothing was recorded: put the messages back, unhandled, for the next try.
      this.pending.unshift(...events);
      this.log(`reading the interview answers failed for ${events.length} message(s); holding them: ${(error as Error)?.message ?? error}`);
      this.options.onFailure?.(error, "messages");
      return "held";
    }
    this.appendInterviewTurn(`iv-${events[0]!.id}`, events.map((event) => event.id), input);
    await this.finishBatch(`iv-${events[0]!.id}`);
    return "done";
  }

  private async finishInterviewTurn(entry: JournalEntry): Promise<void> {
    const id = entry.id;
    // A turn that is already finished is never carried out again: its saved states are older than
    // the file's by now. (Its messages are still marked handled, in case that was what was lost.)
    if (entry.done) {
      for (const inboundId of entry.interview!.inboundIds) this.options.markHandled(inboundId);
      return;
    }
    // A turn begun in the other mode (practice or real) is not ours to finish.
    if ((entry.interview!.dryRun ?? false) !== this.options.interview!.dryRun) {
      this.log(`interview turn ${id} was begun ${entry.interview!.dryRun ? "in a practice run" : "for real"}; leaving it alone`);
      return;
    }
    try {
      await this.interview!.run(id);
    } catch (error) {
      // Not marked done: the turn runs again after a restart, from its recorded steps.
      this.log(`interview turn ${id} stopped: ${(error as Error)?.stack ?? error}`);
      throw error;
    }
    for (const inboundId of entry.interview!.inboundIds) this.options.markHandled(inboundId);
    if (!entry.done) this.journal.append({ type: "done", id });
  }

  // No profile and no interview running (it was cancelled): meal requests cannot be planned.
  // The message is answered with a nudge, at most once in half an hour, and otherwise left alone.
  private async handleWithoutProfile(event: InboundEvent): Promise<void> {
    const now = this.options.now();
    const nudge = now - this.lastNudgeAt >= 30 * 60_000;
    if (nudge) this.lastNudgeAt = now;
    await this.replyAlone(event, nudge ? AWAITING_PROFILE_LINE : null);
  }

  // A one-line answer to one message through the ordinary batch path, so it is journaled like any reply.
  private async replyAlone(event: InboundEvent, text: string | null): Promise<void> {
    this.journal.append({
      type: "batch",
      id: event.id,
      inboundIds: [event.id],
      at: new Date(this.options.now()).toISOString(),
      today: this.today(),
      weeksBefore: [],
      steps: text === null ? [] : [{ kind: "say", text }],
      fills: [],
      brainText: null,
    });
    await this.finishBatch(event.id);
  }

  // The interview saved the profile: the planner reads it fresh from now on (it reads the file for every
  // job), and the quiet window follows the new profile's batching setting.
  private profileSaved(commitId: string, mode: "first-run" | "redo"): void {
    const status = readProfileStatus(this.options.paths.profileFiles.profilePath);
    if (status.kind === "ready") this.options.quietWindowMs = status.profile.thresholds.batchingWindowSeconds * 1000;
    this.options.onProfileSaved?.(commitId, mode);
  }

  // ----- Monday rollover -----

  private rolloverIfDue(): void {
    const { weeksDir, logPath } = this.options.paths;
    const currentMonday = mondayOf(this.today());
    for (const weekOf of storedWeeks(weeksDir)) {
      const before = loadWeek(weeksDir, weekOf);
      const { week, lapsed } = rolloverWeek(before, currentMonday);
      if (week === before) continue;
      // Logged before the status changes, and only once, so a crash in between is harmless.
      if (lapsed && !readLog(logPath).some((entry) => entry.weekOf === weekOf)) {
        appendWeek(logPath, { weekOf, status: "not locked", nights: loggedNights(before) });
      }
      saveWeek(weeksDir, week);
      this.log(`rollover: week of ${weekOf} ${before.status} -> ${week.status}`);
    }
  }

  // ----- A batch of messages -----

  private async handleBatch(events: InboundEvent[]): Promise<"held" | void> {
    if (this.interview?.isActive()) {
      const result = await this.handleInterviewAnswers(events);
      return result === "held" ? "held" : undefined;
    }
    const id = events[0]!.id;
    let record: Extract<JournalRecord, { type: "batch" }>;
    try {
      const context = this.context();
      const result = await this.options.brain.handle({ kind: "messages", triggerId: id, messages: events, context });
      const steps = this.planSteps(events, result.changeSet, context);

      const weeksBefore = [context.currentWeek, context.comingWeek];
      const at = new Date(this.options.now()).toISOString();
      const trial = planWeeks(weeksBefore, steps, context.today, at, this.options.schedule);
      const needed = nightsNeedingIngredients(trial);
      const fills = needed.length > 0 ? await this.options.brain.fillIngredients(needed) : [];

      record = {
        type: "batch",
        id,
        inboundIds: events.map((event) => event.id),
        at,
        today: context.today,
        weeksBefore,
        steps,
        fills,
        brainText: result.reply.kind === "text" && result.reply.text.trim() !== "" ? result.reply.text.trim() : null,
      };
      // The model's reason for staying silent is the only clue when someone expected a reply.
      if (result.reply.kind === "silent") this.log(`model chose silence for ${id}: ${result.reply.reason.replace(/\s+/g, " ").slice(0, 200)}`);
    } catch (error) {
      // Nothing was written: put the messages back, unhandled, for the next try.
      this.pending.unshift(...events);
      this.log(`brain call failed for ${events.length} message(s); holding them: ${(error as Error)?.message ?? error}`);
      this.options.onFailure?.(error, "messages");
      return;
    }

    this.journal.append(record);
    await this.finishBatch(id);
  }

  // Provenance checks, dish lookup, and target-week resolution for one change set.
  private planSteps(events: InboundEvent[], changeSet: ChangeSet, context: BrainContext): Step[] {
    const textById = new Map(events.map((event) => [event.id, event.text]));
    const whoById = new Map(events.map((event) => [event.id, event.memberName]));
    const lockWords = context.profile.lockWords;
    const currentMonday = context.currentWeek.weekOf;
    const comingMonday = context.comingWeek.weekOf;

    // The dishes on both live weeks, so "never again" about tonight's dinner can veto it
    // without repeating the dish's name. Out and away nights aren't dishes.
    const menuDishes: string[] = [];
    for (const week of [context.currentWeek, context.comingWeek]) {
      for (const night of Object.values(week.nights)) {
        if (night?.kind === "dish") menuDishes.push(night.dish);
      }
    }

    const steps: Step[] = [];
    const ambiguous: Night[] = [];

    for (const op of inMessageOrder(changeSet.operations, events.map((event) => event.id))) {
      const sourceText = textById.get(op.sourceMessageId);
      const problem = provenanceProblem(op, sourceText, lockWords, menuDishes);
      if (problem) {
        let line = `I didn't ${describeOperation(op)}: ${problem}.`;
        if (op.action === "lock") line += ` Say "${lockWords[0] ?? "lock it"}" when you're ready.`;
        steps.push({ kind: "say", text: line });
        this.log(`dropped ${op.action} from ${op.sourceMessageId}: ${problem}`);
        continue;
      }
      const who = whoById.get(op.sourceMessageId)!;

      switch (op.action) {
        case "swap":
        case "pin":
          for (const change of op.nights) {
            const resolved = resolveDish(change, context.profile, context.recipes, changeSet);
            if ("problem" in resolved) {
              steps.push({ kind: "say", text: resolved.problem });
              continue;
            }
            const target = resolveTargetWeek(change.night, sourceText!, context.today, context.comingWeek.status);
            if (target === "ambiguous") {
              if (!ambiguous.includes(change.night)) ambiguous.push(change.night);
              continue;
            }
            const weekOf = target === "current" ? currentMonday : comingMonday;
            steps.push({ kind: "night", mode: op.action, weekOf, night: change.night, value: resolved.value, who });
          }
          break;
        case "lock":
          steps.push({ kind: "lock", weekOf: comingMonday });
          break;
        case "skip":
          steps.push({ kind: "skip", weekOf: comingMonday });
          break;
        case "unskip":
          steps.push({ kind: "unskip", weekOf: comingMonday });
          break;
        case "have":
          steps.push({ kind: "have", weekOf: comingMonday, items: op.items });
          break;
        case "report":
          steps.push({ kind: "report", weekOf: currentMonday, text: op.text }); // always this week
          break;
        case "rule":
        case "veto":
        case "dislike":
        case "remove":
        case "undo":
        case "add-dish":
          steps.push({ kind: "profile", op, who });
          break;
        case "none":
          break;
      }
    }

    // The one question for nights still ahead in both weeks. Nothing changes for them.
    if (ambiguous.length > 0) {
      const options = ambiguous
        .map((night) => `${capitalize(night)} could be ${shortDate(nightDate(currentMonday, night))} or ${shortDate(nightDate(comingMonday, night))}`)
        .join("; ");
      const them = ambiguous.length === 1 ? "it" : "them";
      steps.push({ kind: "say", text: `This week or next? ${options}. I left ${them} alone for now.` });
    }
    return steps;
  }

  // Applies a journaled batch (if not yet applied), sends its reply (if not yet sent), and
  // marks its messages handled. Safe to call any number of times.
  private async finishBatch(id: string): Promise<void> {
    const entry = this.journal.get(id);
    if (entry?.interview) return this.finishInterviewTurn(entry);
    if (!entry || !entry.batch) return;
    const batch = entry.batch;

    if (!entry.applied) {
      const reply = await this.applyBatch(entry);
      this.journal.append({ type: "applied", id, reply });
    }

    const reply = entry.applied!.reply;
    if (reply === null) {
      if (!entry.done) this.log(`deliberate silence for ${batch.inboundIds.join(", ")}`);
    } else if (!entry.sending) {
      this.journal.append({ type: "sending", id });
      const outcome = await this.options.send(reply, id);
      this.journal.append({ type: "outcome", id, outcome });
    } else if (!entry.outcome) {
      this.log(`reply for ${id} was being sent when the bridge stopped; carrying on through the sender, which skips what already went out`);
      const outcome = await this.options.send(reply, id);
      this.journal.append({ type: "outcome", id, outcome });
    }

    for (const inboundId of batch.inboundIds) this.options.markHandled(inboundId);
    if (!entry.done) this.journal.append({ type: "done", id });
  }

  // Step 2: every file change for the batch. Returns the reply text, or null for silence.
  private async applyBatch(entry: JournalEntry): Promise<string | null> {
    const batch = entry.batch!;
    const { paths } = this.options;
    const plan = planWeeks(batch.weeksBefore, batch.steps, batch.today, batch.at, this.options.schedule);

    const lines: string[] = [];
    if (batch.brainText) lines.push(batch.brainText);

    // A plain loop, not forEach: a recipe command may wait on the network.
    for (const [index, step] of batch.steps.entries()) {
      let fragment = plan.fragments[index] ?? null;
      const actions = plan.logActions[index]!;
      const reopensDraft = step.kind === "unskip" && plan.reopenedForDraft.has(step.weekOf);
      const hasSideEffects = step.kind === "profile" || step.kind === "command" || actions.length > 0 || reopensDraft;

      if (hasSideEffects) {
        if (entry.stepsDone.has(index)) {
          fragment = entry.stepsDone.get(index)!;
        } else {
          if (step.kind === "profile") fragment = this.applyProfileOp(step.op, step.who, new Date(batch.at));
          if (step.kind === "command") {
            fragment = await runRecipeCommandAsync(step.command, {
              sourcesPath: paths.sourcesPath,
              catalogPath: paths.catalogPath,
              refreshStatusPath: paths.refreshStatusPath,
              admin: step.admin,
              nowIso: batch.at,
              ...(step.by ? { by: step.by } : {}),
              ...(this.options.site ? { site: this.options.site } : {}),
            });
          }
          if (reopensDraft) this.clearFridayMarkers(step.weekOf);
          for (const action of actions) {
            const override = this.applyLogAction(action);
            if (override) fragment = override;
          }
          this.journal.append({ type: "step-done", id: batch.id, index, fragment });
        }
      }
      if (fragment) lines.push(fragment);
    }

    injectFills(plan.weeks, batch.fills);

    // The restated weeks and any list, from the files as they now stand.
    const blocks: string[] = [];
    // With no profile yet (the interview has not finished) there are no lists to build either.
    const statusNow = readProfileStatus(paths.profileFiles.profilePath);
    const profileNow = statusNow.kind === "ready" ? statusNow.profile : null;
    const staples = profileNow?.staples ?? [];
    for (const week of [...plan.weeks.values()].sort((a, b) => a.weekOf.localeCompare(b.weekOf))) {
      if (plan.changedNights.has(week.weekOf)) {
        blocks.push(renderRestatedWeek(week, plan.extras.get(week.weekOf) ?? {}));
      }
      if (!plan.listTouched.has(week.weekOf)) continue;
      if (week.status !== "locked" && week.status !== "current") continue;

      if (!profileNow) continue;
      const list = buildGroceryList(week, staples, profileNow.grocerySections);
      if (plan.lockedNow.has(week.weekOf) || week.postedList === null) {
        blocks.push(renderGroceryList(week, list)); // the first list for this week
        week.postedList = list;
        continue;
      }
      const delta = renderListDelta(week, week.postedList, list);
      if (delta) {
        blocks.push(delta); // only the delta
        week.postedList = list;
      } else if (plan.relocked.has(week.weekOf)) {
        blocks.push(renderGroceryList(week, list)); // a second lock re-posts the list
        week.postedList = list;
      }
    }

    // A week just locked: say where the grocery lines for linked dishes came from, and offer the
    // recipe links.
    for (const weekOf of plan.lockedNow) {
      const nights = Object.values(plan.weeks.get(weekOf)!.nights).filter((value) => value !== null);
      const linked = nights.filter((value) => value.pool === "catalog" || value.pool === "source").map((value) => value.dish);
      const guessed = nights.filter((value) => value.recipe?.ingredientProvenance === "generated").map((value) => value.dish);
      if (guessed.length > 0) {
        blocks.push(`I wrote the ingredient lists for ${guessed.join(", ")} myself, not from a recipe, so check them against the link.`);
      }
      if (linked.length > 0) blocks.push(`Want a recipe link? Just ask for: ${linked.join(", ")}.`);
    }

    // Write only the weeks that changed.
    for (const before of batch.weeksBefore) {
      const after = plan.weeks.get(before.weekOf)!;
      if (JSON.stringify(after) !== JSON.stringify(before)) saveWeek(paths.weeksDir, after);
    }

    const parts: string[] = [];
    if (lines.length > 0) parts.push(lines.join("\n"));
    parts.push(...blocks);
    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  // An unskipped week goes back to waiting for its Friday draft. A skipped week's posted marker
  // tells the scheduler the week is done, so it has to go, along with any Friday error the
  // checker would alert on. Deleting a file that is already gone is fine, so a replay is safe.
  private clearFridayMarkers(weekOf: string): void {
    const { stateDir } = this.options.paths;
    rmSync(postedMarkerPath(stateDir, weekOf), { force: true });
    // The same name as fridayErrorPath() in ops/scheduler.ts, inlined so week/ never imports ops/.
    rmSync(join(stateDir, `friday-error-${weekOf}.json`), { force: true });
  }

  // Profile writes go through the profile module's functions. Each first checks whether the change is already
  // there, so a replay after a crash never writes a rule or veto twice.
  private applyProfileOp(op: Operation, who: string, now: Date): string {
    const files = this.options.paths.profileFiles;
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    try {
      const profile = readProfile(files.profilePath);
      switch (op.action) {
        case "rule":
          if (profile.rules.some((rule) => same(rule.prose, op.prose))) return `"${op.prose}" is already a rule.`;
          return addRule(files, who, op.prose, op.check, now).confirmation;
        case "veto":
          if (profile.vetoes.some((veto) => same(veto, op.dish))) return `"${op.dish}" is already vetoed.`;
          return addVeto(files, who, op.dish, now).confirmation;
        case "dislike":
          if (profile.dislikes.some((d) => same(d.person, op.person) && same(d.what, op.what))) {
            return `Already noted that ${op.person} doesn't like ${op.what}.`;
          }
          return addDislike(files, who, op.person, op.what, now).confirmation;
        case "remove":
          return op.list === "rules" ? removeRule(files, who, op.text, now).confirmation : removeVeto(files, who, op.text, now).confirmation;
        case "undo":
          return undoLastChange(files, who, now).confirmation;
        case "add-dish": {
          const existing = [...profile.usualDishes, ...profile.alsoLikeDishes].some((dish) => same(dish.name, op.dish.name));
          if (existing) return `"${op.dish.name}" is already on the dish lists.`;
          return addDish(files, who, op.pool, op.dish, now).confirmation;
        }
        default:
          return "";
      }
    } catch (error) {
      if (error instanceof ProfileError) return error.message;
      throw error;
    }
  }

  // Log writes, each skipped if it is already there. Returns a replacement reply line when
  // the write could not happen.
  private applyLogAction(action: LogAction): string | null {
    const { logPath } = this.options.paths;
    const entry = readLog(logPath).find((logged) => logged.weekOf === action.weekOf);
    switch (action.kind) {
      case "lock":
        if (!entry) appendWeek(logPath, { weekOf: action.weekOf, status: "locked", nights: action.nights });
        return null;
      case "change-after-lock": {
        if (!entry) return null;
        const day = capitalize(action.night);
        const lastForDay = [...entry.changedAfterLock].reverse().find((change) => change.day === day);
        if (lastForDay && lastForDay.dish === action.dish && lastForDay.protein === action.protein) return null;
        appendChangeAfterLock(logPath, action.weekOf, { day, dish: action.dish, protein: action.protein, ...(action.recipeId ? { recipeId: action.recipeId } : {}) });
        return null;
      }
      case "report":
        if (!entry) return `There's no log entry for the week of ${shortDate(action.weekOf)}, so I couldn't add that.`;
        if (entry.reports.includes(action.text.trim())) return null;
        try {
          appendReport(logPath, action.weekOf, action.text);
        } catch (error) {
          if (error instanceof LogError) return error.message;
          throw error;
        }
        return null;
    }
  }

  // ----- The Friday draft -----

  private async fridayDraft(late: boolean): Promise<FridayDraftResult> {
    const { paths } = this.options;
    const today = this.today();
    const weekOf = addDays(mondayOf(today), 7);

    if (existsSync(sendUnknownMarkerPath(paths.stateDir, weekOf))) return { kind: "send-unknown", weekOf };
    if (existsSync(postedMarkerPath(paths.stateDir, weekOf))) return { kind: "already-posted", weekOf };

    const week = loadWeek(paths.weeksDir, weekOf);
    if (week.status !== "empty" && week.status !== "seeding") {
      // Already drafted, locked, or skipped: post nothing, and the week counts as posted.
      this.writeMarker(postedMarkerPath(paths.stateDir, weekOf), { outcome: "nothing-to-post", status: week.status });
      return { kind: "nothing-to-post", weekOf, status: week.status };
    }

    const triggerId = `friday-draft:${weekOf}:${this.options.now()}`;
    let result: BrainResult;
    let context: BrainContext;
    try {
      context = this.context();
      result = await this.options.brain.handle({ kind: "friday-draft", triggerId, weekOf, late, context });
    } catch (error) {
      this.options.onFailure?.(error, "friday-draft");
      return { kind: "draft-failed", weekOf, reason: (error as Error)?.message ?? String(error) };
    }

    // Only night changes that name this tick count; pins already on the week are kept.
    const values: Partial<Record<Night, NightValue>> = {};
    for (const op of result.changeSet.operations) {
      if (op.sourceMessageId !== triggerId || (op.action !== "swap" && op.action !== "pin")) {
        this.log(`friday draft: ignored ${op.action} from ${op.sourceMessageId}`);
        continue;
      }
      for (const change of op.nights) {
        const resolved = resolveDish(change, context.profile, context.recipes, result.changeSet);
        if ("problem" in resolved) this.log(`friday draft: ${resolved.problem}`);
        else values[change.night] = resolved.value;
      }
    }
    const draft = applyDraft(week, values);
    const open = NIGHTS.filter((night) => draft.nights[night] === null);
    if (open.length > 0) {
      return { kind: "draft-failed", weekOf, reason: `the draft left ${open.map(capitalize).join(", ")} open` };
    }

    const notes = result.reply.kind === "text" && result.reply.text.trim() !== "" ? [result.reply.text.trim()] : [];
    const text = renderDraft(draft, { late, notes });

    // Journal the draft, then the send, then its outcome (recorded before anything else).
    this.journal.append({ type: "draft", id: triggerId, weekOf, week: draft, text });
    this.journal.append({ type: "sending", id: triggerId });
    const outcome = await this.options.send(text, triggerId);
    this.journal.append({ type: "outcome", id: triggerId, outcome });
    return this.settleDraft(triggerId);
  }

  private missedDraftSkip(): MissedDraftResult {
    const { paths } = this.options;
    const weekOf = addDays(mondayOf(this.today()), 7);

    if (existsSync(sendUnknownMarkerPath(paths.stateDir, weekOf))) return { kind: "send-unknown", weekOf };
    if (existsSync(postedMarkerPath(paths.stateDir, weekOf))) return { kind: "already-posted", weekOf };

    const week = loadWeek(paths.weeksDir, weekOf);
    if (week.status !== "empty" && week.status !== "seeding") {
      // Nothing to skip: the week already has its answer (it counts as posted).
      this.writeMarker(postedMarkerPath(paths.stateDir, weekOf), { outcome: "nothing-to-post", status: week.status });
      return { kind: "nothing-to-post", weekOf, status: week.status };
    }

    // The week is saved as skipped before the marker, so a crash in between skips it again next
    // time (harmless) rather than leaving a marker on a week that was never skipped.
    saveWeek(paths.weeksDir, skipWeek(week).week);
    this.writeMarker(postedMarkerPath(paths.stateDir, weekOf), { outcome: "skipped-no-draft", previousStatus: week.status });
    this.log(`friday draft: no draft by ${describeCatchUp(this.options.schedule)}, so the week of ${weekOf} is skipped`);
    return { kind: "skipped", weekOf, previousStatus: week.status };
  }

  // A draft the journal shows as unfinished after a restart.
  private async recoverDraft(id: string): Promise<void> {
    const entry = this.journal.get(id)!;
    if (!entry.sending) {
      // Journaled but never sent: drop it; the next retry drafts again from the current week.
      this.journal.append({ type: "done", id });
      return;
    }
    if (!entry.outcome) {
      // Sending when the bridge stopped. The sender carries on from its own journal: what already
      // went out is not posted again, a part that was cut off stays Unknown, the rest is sent.
      this.log(`draft ${id} was being sent when the bridge stopped; carrying on through the sender`);
      const outcome = await this.options.send(entry.draft!.text, id);
      this.journal.append({ type: "outcome", id, outcome });
    }
    await this.settleDraft(id);
  }

  // Acts on the recorded outcome: Sent or Partial -> the week is Drafted and the posted marker
  // is written; Unknown -> the week is Drafted too (the draft may be on the phones, so replies
  // must act on those nights) plus the send-unknown marker; Failed -> nothing, so a retry drafts again.
  private async settleDraft(id: string): Promise<FridayDraftResult> {
    const entry = this.journal.get(id)!;
    const { weekOf, week } = entry.draft!;
    const outcome = entry.outcome!;
    const { paths } = this.options;

    let result: FridayDraftResult;
    // Kept by the chat app until people reply: the week is the draft that was written (so replies
    // act on it), and the marker says "queued", not "posted", so nothing drafts it again and the
    // checker knows the household is being waited on rather than missed.
    if (outcome.queued === true && (outcome.kind === "failed" || outcome.kind === "partial")) {
      const detail = "detail" in outcome && outcome.detail ? outcome.detail : "waiting for replies";
      saveWeek(paths.weeksDir, week);
      this.writeMarker(postedMarkerPath(paths.stateDir, weekOf), { outcome: "queued", draftId: id, detail });
      this.log(`friday draft for the week of ${weekOf} is waiting for replies (${detail}); it has not been delivered to everyone yet`);
      if (!entry.done) this.journal.append({ type: "done", id });
      return { kind: "queued", weekOf, detail };
    }
    switch (outcome.kind) {
      case "sent":
      case "partial":
        saveWeek(paths.weeksDir, week);
        this.writeMarker(postedMarkerPath(paths.stateDir, weekOf), { outcome: outcome.kind, draftId: id });
        result = { kind: "posted", weekOf, outcome: outcome.kind };
        break;
      case "unknown":
        saveWeek(paths.weeksDir, week);
        this.writeMarker(sendUnknownMarkerPath(paths.stateDir, weekOf), { detail: outcome.detail, draftId: id });
        result = { kind: "send-unknown", weekOf };
        break;
      case "failed":
        result = { kind: "send-failed", weekOf, detail: outcome.detail };
        break;
    }
    if (!entry.done) this.journal.append({ type: "done", id });
    return result;
  }

  private writeMarker(path: string, content: object): void {
    writeFileAtomically(path, JSON.stringify({ at: new Date(this.options.now()).toISOString(), ...content }, null, 2) + "\n");
  }
}
