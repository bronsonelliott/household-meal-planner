// Sending, the same way on every platform.
//
// The adapter makes one attempt and says how it ended (types.ts: SendOutcome). This file does the
// rest:
//
//   Split     a reply longer than the platform's limit is cut into parts. The cut is journaled
//             before anything is sent, so a restart carries on with the SAME parts instead of
//             splitting again and perhaps differently.
//   Fan out   in household-dms mode the "conversation" is every member's private chat. The member
//             list is snapshotted into the journal when the send starts, and each member gets
//             their own outcome.
//   Retry     only a failure the adapter marked transient is retried: at 1, 5 and 15 minutes (or
//             when the platform's Retry-After says, if that is longer and not absurd). Unknown is
//             never retried: it may have gone out and there is no way to ask. Partial is never
//             retried either: the people who got it would see it twice. (A failure marked `queued`
//             does not stop the later parts: the adapter is keeping the whole message for later.)
//   Record    each part that did not go cleanly appends a line to <stateDir>/send-failures.jsonl,
//             which the health checker reads.
//
// Journal: <stateDir>/outbox.jsonl, append-only:
//   {"type":"plan","sendId","key","target","parts":[...],"recipients":[{memberId,name}]}
//   {"type":"sending","sendId","recipient":0,"part":0}      written just before an attempt
//   {"type":"result","sendId","recipient":0,"part":0,"outcome":{...},"attempts":1}
// A "sending" line with no "result" after it means the bridge stopped mid-send: that part is
// Unknown and is never sent again. Recipients and parts with no "sending" line at all were never
// attempted, and a restart sends them.
//
// In dry-run mode nothing reaches the adapter; would-be sends go to dry-run-sends.jsonl.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationMode, Member } from "../config.ts";
import { appendLineDurably } from "../data/files.ts";
import { splitMessage } from "./split.ts";
import type { FailedMember, MessagingAdapter, PartOutcome, RecipientOutcome, SendOutcome } from "./types.ts";

// The failure-class file in the state directory. The worker appends to it too, for a send a
// crash interrupted before this sender could record how it ended.
export const SEND_FAILURES_FILE = "send-failures.jsonl";
const OUTBOX_FILE = "outbox.jsonl";

export type Target = { kind: "conversation" } | { kind: "member"; memberId: string };

interface Recipient {
  memberId: string | null; // null: the shared conversation (group mode)
  name: string;
}

interface Plan {
  sendId: string;
  key: string | null;
  target: Target;
  parts: string[];
  recipients: Recipient[];
}

interface PartResult {
  outcome: SendOutcome;
  attempts: number;
}

// What the journal says about one send, rebuilt on start-up.
interface PlanState {
  plan: Plan;
  results: Map<string, PartResult>; // "recipient:part"
  inFlight: Set<string>; // "sending" written, no result yet
}

export interface SenderOptions {
  adapter: MessagingAdapter;
  mode: ConversationMode;
  members: Member[];
  stateDir: string;
  dryRun: boolean;
  retryDelaysMs: number[];
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

const slot = (recipient: number, part: number) => `${recipient}:${part}`;

export class MessageSender {
  private plans = new Map<string, PlanState>();
  private byKey = new Map<string, string>();
  private counter = 0;

  constructor(private options: SenderOptions) {
    this.loadOutbox();
  }

  // `key` names the send (the worker passes its own journal ID). A second call with the same key
  // carries on from the journal: parts already sent, or already unknown, are not sent again.
  async send(text: string, target: Target, key?: string): Promise<SendOutcome> {
    const state = (key !== undefined ? this.existing(key) : undefined) ?? this.startPlan(text, target, key ?? null);
    const plan = state.plan;

    if (this.options.dryRun) return this.dryRun(plan);

    const results: RecipientOutcome[] = [];
    const delivered: Array<{ outcome: SendOutcome; recipient: Recipient }> = [];
    for (let r = 0; r < plan.recipients.length; r++) {
      const recipient = plan.recipients[r]!;
      const parts = await this.sendParts(state, r);
      const summary = summarizeParts(parts, plan.parts.length);
      const detail = describeOutcome(summary);
      results.push({
        memberId: recipient.memberId,
        kind: summary.kind,
        ...(detail ? { detail } : {}),
        ...(summary.queued ? { queued: true as const } : {}),
        parts: partDetail(parts, plan.parts.length),
      });
      delivered.push({ outcome: summary, recipient });
    }
    return { ...combineRecipients(delivered), recipients: results };
  }

  // ----- Plans and the journal -----

  private existing(key: string): PlanState | undefined {
    const id = this.byKey.get(key);
    return id === undefined ? undefined : this.plans.get(id);
  }

  private startPlan(text: string, target: Target, key: string | null): PlanState {
    const { adapter, mode, members } = this.options;
    const platform = adapter.platform;
    const parts = splitMessage(text, adapter.capabilities.maxMessageChars);

    let recipients: Recipient[];
    if (target.kind === "member") {
      const member = members.find((candidate) => candidate.id === target.memberId);
      recipients = [{ memberId: target.memberId, name: member?.name ?? target.memberId }];
    } else if (mode === "household-dms") {
      // The member list as it is right now. A later change to the config does not change who a
      // send already under way is for.
      recipients = members.filter((member) => member.identities[platform] !== undefined).map((member) => ({ memberId: member.id, name: member.name }));
    } else {
      recipients = [{ memberId: null, name: "the group" }];
    }

    const sendId = `${this.options.now()}-${++this.counter}-${Math.random().toString(36).slice(2, 8)}`;
    const plan: Plan = { sendId, key, target, parts, recipients };
    const state: PlanState = { plan, results: new Map(), inFlight: new Set() };
    this.plans.set(sendId, state);
    if (key !== null) this.byKey.set(key, sendId);
    if (!this.options.dryRun) this.append({ type: "plan", ...plan });
    return state;
  }

  private loadOutbox(): void {
    const path = join(this.options.stateDir, OUTBOX_FILE);
    if (!existsSync(path)) return;
    const content = readFileSync(path, "utf8");
    if (content !== "" && !content.endsWith("\n")) appendFileSync(path, "\n");
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      let record: any;
      try {
        record = JSON.parse(line);
      } catch {
        this.options.log("outbox journal: skipped an unreadable line");
        continue;
      }
      if (record.type === "plan") {
        const { type: _type, ...plan } = record;
        this.plans.set(plan.sendId, { plan, results: new Map(), inFlight: new Set() });
        if (plan.key) this.byKey.set(plan.key, plan.sendId);
      } else if (record.type === "sending") {
        this.plans.get(record.sendId)?.inFlight.add(slot(record.recipient, record.part));
      } else if (record.type === "result") {
        const state = this.plans.get(record.sendId);
        state?.results.set(slot(record.recipient, record.part), { outcome: record.outcome, attempts: record.attempts });
        state?.inFlight.delete(slot(record.recipient, record.part));
      }
    }
  }

  private append(record: object): void {
    appendLineDurably(join(this.options.stateDir, OUTBOX_FILE), { at: new Date(this.options.now()).toISOString(), ...record });
  }

  // ----- Sending one recipient's parts, in order -----

  // Returns the outcome of each part tried or found in the journal. Stops at the first part that
  // failed or is unknown: a later part would arrive out of context.
  private async sendParts(state: PlanState, r: number): Promise<PartResult[]> {
    const { plan } = state;
    const recipient = plan.recipients[r]!;
    const done: PartResult[] = [];

    for (let p = 0; p < plan.parts.length; p++) {
      const stored = state.results.get(slot(r, p));
      if (stored) {
        done.push(stored);
        if (stopsTheMessage(stored.outcome)) break;
        continue;
      }

      let result: PartResult;
      if (state.inFlight.has(slot(r, p))) {
        // The bridge stopped during this part's send. It may have gone out, so it is not re-sent.
        const detail = "the bridge stopped during the send";
        result = { outcome: { kind: "unknown", detail }, attempts: 1 };
        this.recordFailure(plan, recipient, p, result);
      } else {
        this.append({ type: "sending", sendId: plan.sendId, recipient: r, part: p });
        result = await this.attempt(plan, recipient, p);
        this.recordFailure(plan, recipient, p, result);
      }
      this.append({ type: "result", sendId: plan.sendId, recipient: r, part: p, outcome: result.outcome, attempts: result.attempts });
      state.results.set(slot(r, p), result);
      state.inFlight.delete(slot(r, p));

      done.push(result);
      if (stopsTheMessage(result.outcome)) break;
    }
    return done;
  }

  // One part to one recipient, with the retry rules.
  private async attempt(plan: Plan, recipient: Recipient, part: number): Promise<PartResult> {
    const { adapter, retryDelaysMs, log } = this.options;
    const text = plan.parts[part]!;
    const where = describeRecipient(recipient, adapter.conversationId);
    const longest = retryDelaysMs.length > 0 ? Math.max(...retryDelaysMs) : 0;

    let attempt = 0;
    while (true) {
      let outcome: SendOutcome;
      try {
        outcome = recipient.memberId === null ? await adapter.sendToConversation(text) : await adapter.sendToMember(recipient.memberId, text);
      } catch (error) {
        // An adapter that throws gives no clue whether anything went out.
        outcome = { kind: "unknown", detail: `the ${adapter.platform} adapter threw: ${(error as Error)?.message ?? error}` };
      }

      if (outcome.kind === "failed" && outcome.transient === true && attempt < retryDelaysMs.length) {
        let delay = retryDelaysMs[attempt]!;
        // Honour a Retry-After that fits in our retry window; one that asks for hours or days
        // would only hold the worker up, so the send is given up and recorded instead.
        if (outcome.retryAfterMs !== undefined) {
          if (outcome.retryAfterMs > longest) return this.finish(outcome, attempt + 1, where, text, "the platform asked us to wait longer than we retry");
          delay = Math.max(delay, outcome.retryAfterMs);
        }
        log(`send to ${where} failed (${outcome.detail}); retry ${attempt + 1} in ${delay / 60_000} min`);
        attempt += 1;
        await this.options.sleep(delay);
        continue;
      }
      return this.finish(outcome, attempt + 1, where, text);
    }
  }

  private finish(outcome: SendOutcome, attempts: number, where: string, text: string, note?: string): PartResult {
    const { log } = this.options;
    switch (outcome.kind) {
      case "sent":
        log(`sent to ${where} (timestamp ${outcome.timestamp})`);
        break;
      case "partial":
        log(`sent to ${where} but not to: ${outcome.failedMembers.map((failed) => failed.member).join(", ")}`);
        break;
      case "failed":
        log(`undelivered reply to ${where} after ${attempts} attempts (${outcome.detail}${note ? `; ${note}` : ""}): ${text}`);
        break;
      case "unknown":
        log(`send to ${where} outcome unknown (${outcome.detail}); not retried: ${text}`);
        break;
    }
    return { outcome, attempts };
  }

  // ----- The failure records the checker reads -----

  private recordFailure(plan: Plan, recipient: Recipient, part: number, result: PartResult): void {
    const { outcome, attempts } = result;
    if (outcome.kind === "sent") return;
    const target = recipient.memberId === null ? { conversation: this.options.adapter.conversationId } : { member: recipient.memberId };
    const where = plan.parts.length > 1 ? { part: part + 1, of: plan.parts.length } : {};

    switch (outcome.kind) {
      case "partial":
        this.appendRecord(SEND_FAILURES_FILE, { outcome: "partial", class: "partial-send", target, ...where, timestamp: outcome.timestamp, failedMembers: outcome.failedMembers });
        return;
      case "failed":
        this.appendRecord(SEND_FAILURES_FILE, {
          outcome: "failed",
          class: outcome.failureClass ?? "send-failed",
          target,
          ...where,
          attempts,
          detail: outcome.detail,
          ...(outcome.failureExtra ?? {}),
        });
        return;
      case "unknown":
        this.appendRecord(SEND_FAILURES_FILE, { outcome: "unknown", class: "send-unknown", target, ...where, detail: outcome.detail });
        return;
    }
  }

  private dryRun(plan: Plan): SendOutcome {
    const { log, adapter } = this.options;
    const recipients: RecipientOutcome[] = [];
    for (const recipient of plan.recipients) {
      const target = recipient.memberId === null ? { conversation: adapter.conversationId } : { member: recipient.memberId };
      for (const text of plan.parts) {
        this.appendRecord("dry-run-sends.jsonl", { target, text });
        log(`DRY RUN: would send to ${describeRecipient(recipient, adapter.conversationId)}: ${text}`);
      }
      recipients.push({ memberId: recipient.memberId, kind: "sent", parts: plan.parts.map((_, index) => ({ part: index + 1, kind: "sent" as const })) });
    }
    return { kind: "sent", timestamp: this.options.now(), dryRun: true, recipients };
  }

  private appendRecord(fileName: string, record: object): void {
    const line = JSON.stringify({ at: new Date(this.options.now()).toISOString(), ...record });
    appendFileSync(join(this.options.stateDir, fileName), line + "\n");
  }
}

// ---------------------------------------------------------------------------------------
// Putting the answers together

function describeRecipient(recipient: Recipient, conversationId: string | null): string {
  return recipient.memberId === null ? `conversation ${conversationId}` : `member ${recipient.memberId}`;
}

function describeOutcome(outcome: SendOutcome): string | undefined {
  if (outcome.kind === "sent") return undefined;
  return "detail" in outcome ? outcome.detail : undefined;
}

// A failed or unknown part ends the message (a later part would arrive out of context), unless the
// adapter queued it to deliver later with the rest.
function stopsTheMessage(outcome: SendOutcome): boolean {
  if (outcome.kind === "failed") return outcome.queued !== true;
  return outcome.kind === "unknown";
}

function isDelivered(outcome: SendOutcome): boolean {
  return outcome.kind === "sent" || outcome.kind === "partial";
}

function partDetail(parts: PartResult[], total: number): PartOutcome[] {
  const shown: PartOutcome[] = parts.map((result, index) => {
    const detail = describeOutcome(result.outcome);
    const queued = result.outcome.kind === "failed" && result.outcome.queued === true;
    return { part: index + 1, kind: result.outcome.kind, ...(detail ? { detail } : {}), ...(queued ? { queued: true as const } : {}), attempts: result.attempts };
  });
  for (let index = parts.length; index < total; index++) shown.push({ part: index + 1, kind: "not-attempted" });
  return shown;
}

// One recipient's parts, as one outcome. Every part delivered is Sent (or Partial if the platform
// said some people missed one). A later part failing after an earlier one got through is Partial:
// the recipient has the start of the message. A first part that fails is Failed, or Unknown.
function summarizeParts(parts: PartResult[], total: number): SendOutcome {
  const summary = summarizeUnflagged(parts, total);
  // A part the adapter is keeping for later makes the whole answer "waiting for a reply", unless
  // everything got through.
  const keptForLater = parts.some((result) => result.outcome.kind === "failed" && result.outcome.queued === true);
  if (keptForLater && (summary.kind === "failed" || summary.kind === "partial")) return { ...summary, queued: true };
  return summary;
}

function summarizeUnflagged(parts: PartResult[], total: number): SendOutcome {
  const delivered = parts.filter((result) => isDelivered(result.outcome));
  const last = parts[parts.length - 1]!;

  if (delivered.length === total) {
    const failedMembers: FailedMember[] = delivered.flatMap((result) => (result.outcome.kind === "partial" ? result.outcome.failedMembers : []));
    const timestamp = (last.outcome as { timestamp: number }).timestamp;
    return failedMembers.length > 0 ? { kind: "partial", timestamp, failedMembers } : { kind: "sent", timestamp };
  }

  const stopped = last.outcome;
  if (delivered.length === 0) return stopped;

  const timestamp = (delivered[delivered.length - 1]!.outcome as { timestamp: number }).timestamp;
  const why = "detail" in stopped ? stopped.detail : stopped.kind;
  return {
    kind: "partial",
    timestamp,
    failedMembers: [],
    detail: `${delivered.length} of ${total} parts sent; part ${parts.length} ${stopped.kind}: ${why}`,
  };
}

// Every recipient's outcome, as the one outcome the worker sees.
function combineRecipients(all: Array<{ outcome: SendOutcome; recipient: Recipient }>): SendOutcome {
  if (all.length === 1) return all[0]!.outcome;

  const got = all.filter((entry) => isDelivered(entry.outcome));
  const missed = all.filter((entry) => !isDelivered(entry.outcome));
  const timestamps = got.map((entry) => (entry.outcome as { timestamp: number }).timestamp);

  if (missed.length === 0 && got.every((entry) => entry.outcome.kind === "sent")) {
    return { kind: "sent", timestamp: Math.max(...timestamps) };
  }

  const failedMembers: FailedMember[] = [];
  for (const entry of all) {
    const name = entry.recipient.memberId ?? "conversation";
    if (entry.outcome.queued === true) {
      failedMembers.push({ member: name, type: "QUEUED" });
    } else if (entry.outcome.kind === "partial") {
      failedMembers.push(...(entry.outcome.failedMembers.length > 0 ? entry.outcome.failedMembers : [{ member: name, type: "PARTIAL" }]));
    } else if (entry.outcome.kind === "failed" || entry.outcome.kind === "unknown") {
      failedMembers.push({ member: name, type: entry.outcome.kind === "failed" ? "FAILED" : "UNKNOWN" });
    }
  }

  // Waiting for a reply is not a failure, as long as nobody else truly missed it: every person who
  // did not get it yet has the text kept for them.
  const waiting = all.some((entry) => entry.outcome.queued === true) && missed.every((entry) => entry.outcome.queued === true);
  const waitingFlag = waiting ? { queued: true as const } : {};

  if (got.length > 0) return { kind: "partial", timestamp: Math.max(...timestamps), failedMembers, ...waitingFlag };

  // Nobody got it. If any answer is Unknown it may have reached someone, so say Unknown.
  const detail = all.map((entry) => `${entry.recipient.memberId ?? "conversation"}: ${describeOutcome(entry.outcome)}`).join("; ");
  if (missed.some((entry) => entry.outcome.kind === "unknown")) return { kind: "unknown", detail };
  return { kind: "failed", detail, ...waitingFlag };
}
