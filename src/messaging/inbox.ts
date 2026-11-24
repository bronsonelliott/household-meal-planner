// The inbox: every message an adapter hands over is written to a journal before anything else
// happens to it, so a crash or restart never loses one.
//
// Journal: <stateDir>/inbox.jsonl, append-only, one JSON object per line:
//   {"type":"received","id":"<platform>/<conversation>/<native ID>","at":"...","message":{...}}
//   {"type":"handled","id":"...","at":"...","reason":"..."}
//
// A message's journal ID is its platform, conversation and the platform's own ID for it. A second
// copy with the same ID is dropped (platforms do redeliver after a restart). Messages the router
// drops are marked handled at once. Messages handed to the worker stay unhandled until the worker
// says so, and replay on the next start if it never does.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendLineDurably } from "../data/files.ts";
import type { IncomingMessage } from "./types.ts";

export function journalId(message: Pick<IncomingMessage, "platform" | "conversationId" | "nativeId">): string {
  return `${message.platform}/${message.conversationId}/${message.nativeId}`;
}

export class Inbox {
  private path: string;
  // Every message ever journaled, in arrival order.
  private received = new Map<string, IncomingMessage>();
  private handled = new Set<string>();
  // Each message's receipt number: 1, 2, 3... in the order journaled. Written into the journal so
  // it survives a restart (older journals without numbers are numbered by their line order).
  private seqs = new Map<string, number>();
  private lastSeq = 0;

  constructor(
    stateDir: string,
    private log: (line: string) => void,
    // A practice run keeps its own journal, so messages written during practice are never picked
    // up as unanswered by the next real start.
    dryRun = false,
  ) {
    this.path = join(stateDir, dryRun ? "inbox.dry-run.jsonl" : "inbox.jsonl");
    this.loadJournal();
  }

  // Writes the message to the journal and forces it to disk. The returned promise resolves only
  // after that, which is the moment an adapter may let its platform forget the message.
  // `isNew` is false for a message already journaled (a redelivery): nothing is written again.
  async record(message: IncomingMessage): Promise<{ id: string; isNew: boolean }> {
    const id = journalId(message);
    if (this.received.has(id)) return { id, isNew: false };
    const seq = this.lastSeq + 1;
    appendLineDurably(this.path, { type: "received", id, at: new Date().toISOString(), seq, message });
    this.lastSeq = seq;
    this.seqs.set(id, seq);
    this.received.set(id, message);
    return { id, isNew: true };
  }

  // The receipt number of a journaled message.
  seqOf(id: string): number | undefined {
    return this.seqs.get(id);
  }

  // The newest receipt number handed out so far (0 before any message).
  highWater(): number {
    return this.lastSeq;
  }

  get(id: string): IncomingMessage | undefined {
    return this.received.get(id);
  }

  // Journaled messages the worker has not finished with, oldest first.
  unhandled(): Array<{ id: string; message: IncomingMessage }> {
    const found: Array<{ id: string; message: IncomingMessage }> = [];
    for (const [id, message] of this.received) {
      if (!this.handled.has(id)) found.push({ id, message });
    }
    return found;
  }

  isHandled(id: string): boolean {
    return this.handled.has(id);
  }

  markHandled(id: string, reason: string): void {
    if (this.handled.has(id)) return;
    appendLineDurably(this.path, { type: "handled", id, at: new Date().toISOString(), reason });
    this.handled.add(id);
  }

  private loadJournal(): void {
    if (!existsSync(this.path)) return;
    const content = readFileSync(this.path, "utf8");
    // After a crash mid-write the file can end in a partial line. End it here, so the next
    // record starts on a line of its own instead of being glued onto the fragment.
    if (content !== "" && !content.endsWith("\n")) appendFileSync(this.path, "\n");

    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      let record: any;
      try {
        record = JSON.parse(line);
      } catch {
        // The partial line from a crash mid-write. Skip it rather than refuse to start.
        this.log("inbox journal: skipped an unreadable line");
        continue;
      }
      if (record.type === "received") {
        this.received.set(record.id, record.message);
        const seq = typeof record.seq === "number" ? record.seq : this.lastSeq + 1;
        this.seqs.set(record.id, seq);
        this.lastSeq = Math.max(this.lastSeq, seq);
      }
      if (record.type === "handled") this.handled.add(record.id);
    }
  }
}
