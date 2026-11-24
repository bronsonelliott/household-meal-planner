// The two small files the iMessage adapter keeps in the state folder.
//
//   imessage-cursor.json  how far reading has got: the time of the newest message handled, and the
//                         guids of recent messages. Each poll re-reads a few minutes before the
//                         cursor, so a message that shares a timestamp with an earlier one, or that
//                         shows up late, is not missed; the guid list stops those re-reads from
//                         being handled twice.
//   imessage-sent.json    the guids of recent messages the bot sent, to tell "a reply to the bot".
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
    return null; // a damaged file reads as "nothing saved"; the inbox's duplicate check covers a replay
  }
}

export class CursorStore {
  private path: string;
  private cursor: number | null = null;
  private seen = new Map<string, number>(); // guid -> the message's dateCreated

  constructor(stateDir: string) {
    this.path = join(stateDir, "imessage-cursor.json");
    const saved = readJson(this.path);
    if (saved && Number.isFinite(saved.cursor)) {
      this.cursor = saved.cursor;
      for (const [guid, at] of Object.entries<any>(saved.seen ?? {})) if (Number.isFinite(at)) this.seen.set(guid, at);
    }
  }

  // null until the first poll has ever happened.
  get(): number | null {
    return this.cursor;
  }

  hasSeen(guid: string): boolean {
    return this.seen.has(guid);
  }

  // Sets the starting point on the very first run.
  start(at: number): void {
    this.cursor = at;
    this.save();
  }

  // This message is done with (journaled, or deliberately ignored). Moves the cursor forward and
  // forgets guids too old to be re-read any more.
  advance(guid: string, at: number, overlapMs: number): void {
    this.seen.set(guid, at);
    this.cursor = Math.max(this.cursor ?? 0, at);
    for (const [seenGuid, seenAt] of this.seen) if (seenAt < this.cursor - overlapMs) this.seen.delete(seenGuid);
    this.save();
  }

  private save(): void {
    writeFileAtomically(this.path, JSON.stringify({ cursor: this.cursor, seen: Object.fromEntries(this.seen) }));
  }
}

const MAX_SENT = 200;

export class SentGuidStore {
  private path: string;
  private guids: string[] = [];

  constructor(stateDir: string) {
    this.path = join(stateDir, "imessage-sent.json");
    const saved = readJson(this.path);
    if (Array.isArray(saved)) this.guids = saved.filter((guid) => typeof guid === "string");
  }

  has(guid: string): boolean {
    return this.guids.includes(guid);
  }

  add(guid: string): void {
    if (this.has(guid)) return;
    this.guids.push(guid);
    if (this.guids.length > MAX_SENT) this.guids.splice(0, this.guids.length - MAX_SENT);
    writeFileAtomically(this.path, JSON.stringify(this.guids));
  }
}
