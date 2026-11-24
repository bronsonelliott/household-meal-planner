// The two small files the Telegram adapter keeps in the state folder.
//
//   telegram-offset.json   the next update number to ask Telegram for. Telegram forgets updates
//                          below it, so it moves forward only after a message is safely journaled.
//   telegram-chat.json     set when Telegram upgrades the household group to a supergroup, which
//                          gives the group a new chat ID. Remembers the new ID until the config
//                          file is updated.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomically } from "../../data/files.ts";

function readJson(path: string): any {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // a damaged file reads as "nothing saved"; the journal's duplicate check covers a replay
  }
}

export class OffsetStore {
  private path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, "telegram-offset.json");
  }

  get(): number {
    const saved = readJson(this.path);
    return Number.isInteger(saved?.offset) ? saved.offset : 0;
  }

  set(offset: number): void {
    writeFileAtomically(this.path, JSON.stringify({ offset }));
  }
}

export interface MigratedChat {
  configured: string; // the chat ID in config.toml when the move was noticed
  current: string; // the supergroup's new ID
}

export class ChatMigrationStore {
  private path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, "telegram-chat.json");
  }

  get(): MigratedChat | null {
    const saved = readJson(this.path);
    return typeof saved?.configured === "string" && typeof saved?.current === "string" ? saved : null;
  }

  set(value: MigratedChat): void {
    writeFileAtomically(this.path, JSON.stringify(value, null, 2));
  }
}
