// The two small files the WhatsApp adapter keeps in the state folder.
//
//   whatsapp-window.json    per member: when they last wrote to the bot (WhatsApp only lets the bot
//                           send ordinary messages for 24 hours after that), when we last sent them
//                           the approved template, and the texts waiting for them to reply.
//   whatsapp-statuses.json  the latest delivery status Meta reported for each message we sent
//                           (sent, delivered, read, failed). For the record only; no decision reads it.
//
// Both are rewritten whole, atomically, on every change. They are small.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomically } from "../../data/files.ts";

function readJson(path: string): any {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // a damaged file reads as "nothing saved"
  }
}

export const WINDOW_MS = 24 * 60 * 60 * 1000;
// Stop counting the window a minute early, so a reply sent right at the edge does not race Meta's clock.
const WINDOW_MARGIN_MS = 60_000;
// A text still waiting after this long is stale (a weekly plan from last week), so it is dropped.
export const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// A text waiting for a person to reply. `id` is stable, so the attempt and its outcome can be
// recorded against this exact text. Before each try, `attemptedAt` is written to disk; after the
// answer, `outcome` is. A text found at start-up with an attempt but no outcome may have been
// delivered (the bridge stopped between posting and noting the answer), so it is never sent again.
export interface PendingText {
  id: string;
  text: string;
  queuedAt: number;
  attemptedAt?: number;
  outcome?: PendingOutcome;
}

// sent: delivered. gave-up: refused for good, or it may already have gone out. stays: could not be
// delivered yet (a rate limit, or the window is still closed), so it keeps waiting.
export type PendingOutcome = "sent" | "gave-up" | "stays";

interface MemberWindow {
  lastInboundAt: number; // epoch ms; 0 when they have never written, or when Meta said the window is shut
  templateSentAt: number | null;
  pending: PendingText[];
}

export class WindowStore {
  private path: string;
  private members: Record<string, MemberWindow> = {};

  constructor(stateDir: string) {
    this.path = join(stateDir, "whatsapp-window.json");
    const saved = readJson(this.path);
    if (saved && typeof saved.members === "object" && saved.members !== null) {
      for (const [id, entry] of Object.entries<any>(saved.members)) {
        this.members[id] = {
          lastInboundAt: Number.isFinite(entry?.lastInboundAt) ? entry.lastInboundAt : 0,
          templateSentAt: Number.isFinite(entry?.templateSentAt) ? entry.templateSentAt : null,
          pending: Array.isArray(entry?.pending)
            ? entry.pending
                .filter((item: any) => typeof item?.text === "string" && Number.isFinite(item?.queuedAt))
                // A text saved before ids existed gets one now.
                .map((item: any) => ({ ...item, id: typeof item.id === "string" && item.id !== "" ? item.id : crypto.randomUUID() }))
            : [],
        };
      }
    }
  }

  private entry(memberId: string): MemberWindow {
    return (this.members[memberId] ??= { lastInboundAt: 0, templateSentAt: null, pending: [] });
  }

  private save(): void {
    writeFileAtomically(this.path, JSON.stringify({ members: this.members }, null, 2));
  }

  isOpen(memberId: string, now: number): boolean {
    const last = this.members[memberId]?.lastInboundAt ?? 0;
    return last > 0 && now - last < WINDOW_MS - WINDOW_MARGIN_MS;
  }

  recordInbound(memberId: string, at: number): void {
    const entry = this.entry(memberId);
    // Never move backwards: a late redelivery of an old message must not shrink the window.
    entry.lastInboundAt = Math.max(entry.lastInboundAt, at);
    entry.templateSentAt = null;
    this.save();
  }

  // Meta said the window is shut (error 131047) although our clock thought it was open.
  markClosed(memberId: string): void {
    this.entry(memberId).lastInboundAt = 0;
    this.save();
  }

  lastInboundAt(memberId: string): number {
    return this.members[memberId]?.lastInboundAt ?? 0;
  }

  templateSentAt(memberId: string): number | null {
    return this.members[memberId]?.templateSentAt ?? null;
  }

  markTemplateSent(memberId: string, at: number): void {
    this.entry(memberId).templateSentAt = at;
    this.save();
  }

  pending(memberId: string): PendingText[] {
    return [...(this.members[memberId]?.pending ?? [])];
  }

  addPending(memberId: string, text: string, at: number): void {
    this.entry(memberId).pending.push({ id: crypto.randomUUID(), text, queuedAt: at });
    this.save();
  }

  // Written to disk before the text is posted.
  recordAttempt(memberId: string, id: string, at: number): void {
    const item = this.find(memberId, id);
    if (!item) return;
    item.attemptedAt = at;
    delete item.outcome;
    this.save();
  }

  // Written to disk as soon as the answer is known, before the text is dropped or kept.
  recordOutcome(memberId: string, id: string, outcome: PendingOutcome): void {
    const item = this.find(memberId, id);
    if (!item) return;
    item.outcome = outcome;
    this.save();
  }

  // Removes one waiting text (after it was delivered or given up on).
  dropPending(memberId: string, id: string): void {
    const entry = this.entry(memberId);
    entry.pending = entry.pending.filter((item) => item.id !== id);
    this.save();
  }

  // A text that stays waiting is ready for a fresh attempt next time.
  clearAttempt(memberId: string, id: string): void {
    const item = this.find(memberId, id);
    if (!item) return;
    delete item.attemptedAt;
    delete item.outcome;
    this.save();
  }

  // Start-up: settles what a stopped bridge left half done. A text with an attempt and no outcome
  // may have gone out, so it is dropped (never sent again) and reported. One whose outcome was
  // recorded is finished: dropped if it was delivered or given up on, kept if it was only waiting.
  settleInterrupted(): Array<{ memberId: string; item: PendingText; what: "unknown" | "sent" | "gave-up" }> {
    const settled: Array<{ memberId: string; item: PendingText; what: "unknown" | "sent" | "gave-up" }> = [];
    for (const [memberId, entry] of Object.entries(this.members)) {
      const keep: PendingText[] = [];
      for (const item of entry.pending) {
        if (item.attemptedAt === undefined) {
          keep.push(item);
        } else if (item.outcome === undefined) {
          settled.push({ memberId, item, what: "unknown" });
        } else if (item.outcome === "stays") {
          delete item.attemptedAt;
          delete item.outcome;
          keep.push(item);
        } else {
          settled.push({ memberId, item, what: item.outcome });
        }
      }
      entry.pending = keep;
    }
    if (settled.length > 0) this.save();
    return settled;
  }

  private find(memberId: string, id: string): PendingText | undefined {
    return this.members[memberId]?.pending.find((item) => item.id === id);
  }
}

// What Meta has told us about one message: each status it reported, and when. Statuses can arrive
// out of order or twice (Meta retries), so each is kept under its own name instead of "the latest".
export interface RecordedMessage {
  seen: Record<string, number>; // status -> Meta's timestamp, epoch ms
  error?: string; // for "failed": Meta's code and title
}

const MAX_MESSAGES = 500;

export class StatusStore {
  private path: string;
  private messages: Record<string, RecordedMessage> = {};

  constructor(stateDir: string) {
    this.path = join(stateDir, "whatsapp-statuses.json");
    const saved = readJson(this.path);
    if (saved && typeof saved === "object") this.messages = saved;
  }

  // Idempotent: a status already recorded for that message changes nothing. Returns true when it was new.
  record(messageId: string, status: string, at: number, error?: string): boolean {
    const known = this.messages[messageId];
    if (known && status in known.seen) return false;
    const entry: RecordedMessage = { seen: { ...(known?.seen ?? {}), [status]: at }, ...(error ?? known?.error ? { error: error ?? known?.error } : {}) };
    delete this.messages[messageId]; // re-inserting puts it last, so the oldest are the ones dropped
    this.messages[messageId] = entry;
    const ids = Object.keys(this.messages);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_MESSAGES))) delete this.messages[id];
    writeFileAtomically(this.path, JSON.stringify(this.messages));
    return true;
  }

  get(messageId: string): RecordedMessage | undefined {
    return this.messages[messageId];
  }
}
