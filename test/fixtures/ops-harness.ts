// Shared setup for the scheduler and failure-policy tests: the worker harness's temp data folder,
// fake clock, and stub brain, wired the way src/bridge.ts wires them, with a fake group sender, a
// fake Telegram, and a fake auth re-check. Nothing here waits in real time or leaves the process.

import { BrainError, type BrainErrorClass } from "../../src/brain/claude.ts";
import { ReplyTracker } from "../../src/ops/heartbeat.ts";
import { FailurePolicy, Scheduler } from "../../src/ops/scheduler.ts";
import type { InboundEvent, SendOutcome } from "../../src/messaging/types.ts";
import { Worker, type BrainRequest, type BrainResult } from "../../src/week/worker.ts";
import { CHICAGO_SCHEDULE } from "./config-fixtures.ts";
import { GROUP_TARGET, isTestAdmin, setupHarness, type Harness } from "./worker-harness.ts";

// How long the real sender spends retrying a Failed send before giving up (1 + 5 + 15 minutes).
export const FAILED_SEND_MS = 21 * 60_000;

export interface Sent {
  text: string;
  atMs: number;
}

export interface OpsHarness {
  h: Harness; // paths, clock, and the stub brain
  worker: Worker;
  policy: FailurePolicy;
  scheduler: Scheduler;
  replies: ReplyTracker;
  sent: Sent[]; // every group send, in order
  alerts: string[]; // every Telegram line the bridge sent
  authOk: boolean; // what the auth re-check answers
  authChecks: number;
  // The bridge's onEvent: note the arrival, then hand the message to the worker.
  deliver(event: InboundEvent): void;
  // A fresh worker, policy, and scheduler on the same folders: a bridge restart.
  restart(): void;
  // Waits until the worker and the policy have nothing running.
  settle(): Promise<void>;
}

// A brain answer that fails with the given class.
export function fail(errorClass: BrainErrorClass): (request: BrainRequest) => BrainResult {
  return () => {
    throw new BrainError(errorClass, `test ${errorClass} failure`);
  };
}

// Queues the same answer `times` times.
export function queueMany(h: Harness, times: number, handler: (request: BrainRequest) => BrainResult): void {
  for (let i = 0; i < times; i++) h.brain.next(handler);
}

// A Friday draft of seven nights of chicken tacos, answering the tick's own trigger ID.
export function draftAnswer(request: BrainRequest): BrainResult {
  const nights = (["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const).map((night) => ({
    night,
    rule: null,
    dish: { kind: "profile" as const, name: "Chicken tacos" },
  }));
  return {
    changeSet: { operations: [{ sourceMessageId: request.triggerId, action: "swap", nights }] },
    reply: { kind: "silent", reason: "draft" },
  };
}

export function setupOps(startMs: number, options: { alertsConfigured?: boolean } = {}): OpsHarness {
  const h = setupHarness(startMs);
  const stateDir = h.paths.stateDir;

  const ops = {
    h,
    sent: [] as Sent[],
    alerts: [] as string[],
    authOk: false,
    authChecks: 0,
  } as OpsHarness;

  // Fake group send. A "failed" outcome stands for the real sender's last answer after its three
  // retries, so the clock moves on by the time those retries take.
  const send = async (text: string): Promise<SendOutcome> => {
    ops.sent.push({ text, atMs: h.clock.now() });
    const outcome = h.outcomes.shift() ?? { kind: "sent", timestamp: h.clock.now() };
    if (outcome.kind === "failed") h.clock.nowMs += FAILED_SEND_MS;
    return outcome;
  };

  const build = () => {
    const replies = new ReplyTracker(stateDir, h.clock.now);
    let worker: Worker;
    let scheduler: Scheduler;
    const timers = { set: h.clock.set, clear: h.clock.clear };

    const policy = new FailurePolicy({
      stateDir,
      brain: h.brain,
      sendToConversation: send,
      flush: () => worker.flush(),
      checkAuth: async () => {
        ops.authChecks += 1;
        if (!ops.authOk) throw new BrainError("auth", "test: still logged out");
      },
      alert: async (text) => {
        ops.alerts.push(text);
        return true;
      },
      alertsConfigured: options.alertsConfigured,
      replies,
      now: h.clock.now,
      timers,
      log: (line: string) => { if (process.env.OPS_DEBUG) console.log(`[${new Date(h.clock.now()).toISOString()}] ${line}`); },
    });

    worker = new Worker({
      paths: h.paths,
      brain: policy,
      isAdmin: isTestAdmin,
      send,
      markHandled: (id) => {
        h.handled.push(id);
        replies.answered(id);
      },
      now: h.clock.now,
      quietWindowMs: 15_000,
      schedule: CHICAGO_SCHEDULE,
      timers,
      log: (line: string) => { if (process.env.OPS_DEBUG) console.log(`[${new Date(h.clock.now()).toISOString()}] ${line}`); },
      onFailure: (error, what) => {
        if (what === "friday-draft") scheduler.noteDraftError(error);
        else policy.onMessageFailure(error);
      },
    });

    scheduler = new Scheduler({ stateDir, worker, schedule: CHICAGO_SCHEDULE, now: h.clock.now, log: (line: string) => { if (process.env.OPS_DEBUG) console.log(`[${new Date(h.clock.now()).toISOString()}] ${line}`); } });

    ops.worker = worker;
    ops.policy = policy;
    ops.scheduler = scheduler;
    ops.replies = replies;
  };

  ops.deliver = (event) => {
    ops.replies.arrived(event.id);
    ops.worker.enqueueMessage(event);
  };
  ops.restart = build;
  ops.settle = async () => {
    // A retry the policy starts can queue worker jobs, and a worker failure can start policy work.
    for (let i = 0; i < 5; i++) {
      await ops.worker.idle();
      await ops.policy.idle();
    }
  };

  build();
  return ops;
}
