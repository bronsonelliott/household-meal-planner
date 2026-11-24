// Shared setup for the worker tests: a temp data folder with the example profile, a fake
// clock whose timers fire only when the test advances it (no real waiting), a stub brain
// that returns canned answers, and a fake sender that records what would be posted.

import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHICAGO_SCHEDULE } from "./config-fixtures.ts";
import type { InboundEvent, SendOutcome } from "../../src/messaging/types.ts";
import type { OnboardingExtractOutcome, OnboardingExtractRequest } from "../../src/onboarding/state.ts";
import type { IngredientFill, IngredientRequest, Operation } from "../../src/week/changeset.ts";
import { Worker, type Brain, type BrainRequest, type BrainResult, type WorkerPaths } from "../../src/week/worker.ts";

export const SAM_ID = "aaaaaaaa-0000-4000-8000-000000000001";
export const ALEX_ID = "aaaaaaaa-0000-4000-8000-000000000002";
export const GROUP_TARGET = { conversation: "dinner-group-id" };

// In these tests Alex is the household admin and Sam is an adult.
export const isTestAdmin = (memberId: string): boolean => memberId === "alex";

// Instants used across the tests (Central daylight time is UTC-5 until Nov 1, 2026).
export const THURSDAY_10AM = Date.parse("2026-10-01T15:00:00Z"); // Thu Oct 1, 10:00 AM
export const FRIDAY_4PM = Date.parse("2026-10-02T21:00:00Z"); // Fri Oct 2, 4:00 PM
export const FRIDAY_6PM = Date.parse("2026-10-02T23:00:00Z"); // Fri Oct 2, 6:00 PM
export const MONDAY_9AM = Date.parse("2026-10-05T14:00:00Z"); // Mon Oct 5, 9:00 AM
export const WEDNESDAY_NOON = Date.parse("2026-10-07T17:00:00Z"); // Wed Oct 7, noon

export class FakeClock {
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;

  constructor(public nowMs: number) {}

  now = (): number => this.nowMs;

  set = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + ms, fn });
    return id;
  };

  clear = (id: unknown): void => {
    this.timers.delete(id as number);
  };

  // Moves time forward, firing each timer that comes due, in order.
  advance(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      let dueId: number | null = null;
      let dueAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueId = id;
          dueAt = timer.at;
        }
      }
      if (dueId === null) break;
      const timer = this.timers.get(dueId)!;
      this.timers.delete(dueId);
      this.nowMs = timer.at;
      timer.fn();
    }
    this.nowMs = target;
  }
}

type Handler = (request: BrainRequest) => BrainResult;

export class StubBrain implements Brain {
  handled: BrainRequest[] = [];
  fillRequests: IngredientRequest[][] = [];
  // Set by the interview tests: how the stub reads the household's setup answers.
  extractOnboarding?: (request: OnboardingExtractRequest) => Promise<OnboardingExtractOutcome>;
  private handlers: Handler[] = [];
  private fills: IngredientFill[][] = [];

  // Queue the answer to the next handle() call.
  next(handler: Handler): void {
    this.handlers.push(handler);
  }

  // Queue the answer to the next fillIngredients() call.
  nextFill(fill: IngredientFill[]): void {
    this.fills.push(fill);
  }

  async handle(request: BrainRequest): Promise<BrainResult> {
    this.handled.push(request);
    const handler = this.handlers.shift();
    if (!handler) throw new Error("the stub brain was called with no answer queued");
    return handler(request);
  }

  async fillIngredients(requests: IngredientRequest[]): Promise<IngredientFill[]> {
    this.fillRequests.push(requests);
    const fill = this.fills.shift();
    if (!fill) throw new Error("the stub brain was asked for ingredients with none queued");
    return fill;
  }
}

// Answers with the given operations and reply text.
export function answer(operations: Operation[], text: string | null = null): Handler {
  return () => ({
    changeSet: { operations },
    reply: text === null ? { kind: "silent", reason: "nothing to say" } : { kind: "text", text },
  });
}

export function message(who: "Sam" | "Alex", text: string, atMs: number): InboundEvent {
  const identity = who === "Sam" ? SAM_ID : ALEX_ID;
  return { id: `signal/dinner-group-id/${identity}:${atMs}`, kind: "text", memberId: who.toLowerCase(), memberName: who, text, timestamp: atMs, mentionsBot: false, repliesToBot: false };
}

export interface Harness {
  paths: WorkerPaths;
  clock: FakeClock;
  brain: StubBrain;
  sent: string[];
  // The key each send was given (the worker's journal ID), parallel to `sent`.
  sendKeys: string[];
  handled: string[];
  logs: string[];
  // Outcomes the fake sender returns, in order; "sent" once the queue is empty.
  outcomes: SendOutcome[];
  // When set, sends never finish: the process "dies" mid-send.
  hangSends: boolean;
  makeWorker(): Worker;
}

export function setupHarness(startMs: number): Harness {
  const dir = mkdtempSync(join(tmpdir(), "worker-test-"));
  const dataDir = join(dir, "data");
  const stateDir = join(dir, "state");
  mkdirSync(dataDir);
  mkdirSync(stateDir);
  copyFileSync(join(import.meta.dir, "..", "..", "data.example", "profile.md"), join(dataDir, "profile.md"));

  const paths: WorkerPaths = {
    weeksDir: join(dataDir, "weeks"),
    logPath: join(dataDir, "log.md"),
    profileFiles: { profilePath: join(dataDir, "profile.md"), lastChangePath: join(stateDir, "profile-last-change.json") },
    sourcesPath: join(dataDir, "recipe-sources.json"),
    catalogPath: join(dataDir, "recipe-catalog.json"),
    stateDir,
  };

  const harness: Harness = {
    paths,
    clock: new FakeClock(startMs),
    brain: new StubBrain(),
    sent: [],
    sendKeys: [],
    handled: [],
    logs: [],
    outcomes: [],
    hangSends: false,
    makeWorker: () =>
      new Worker({
        paths,
        brain: harness.brain,
        isAdmin: isTestAdmin,
        send: async (text, key) => {
          if (harness.hangSends) return new Promise<SendOutcome>(() => {});
          harness.sent.push(text);
          harness.sendKeys.push(key);
          return harness.outcomes.shift() ?? { kind: "sent", timestamp: harness.clock.now() };
        },
        markHandled: (id) => harness.handled.push(id),
        now: harness.clock.now,
        schedule: CHICAGO_SCHEDULE,
        quietWindowMs: 15_000,
        timers: { set: harness.clock.set, clear: harness.clock.clear },
        log: (line) => harness.logs.push(line),
      }),
  };
  return harness;
}
