// The state files the health check (src/ops/check-health.ts) reads, and the alert-state folder the
// bridge and the health check share.
//
// Everything lives in the state directory:
//
//   heartbeat            touched after every healthy adapter health check. The health check alerts
//                        when its modification time is more than an hour old.
//   unanswered.json      adult messages with no reply yet, each with the time the bridge first
//                        saw it, plus the time of the last reply or logged silence. The health check
//                        alerts when the oldest one is 15 minutes old. the fixed outage line is
//                        not a reply, so it never touches this file.
//   alert-state/<key>    one file per alert condition that has fired and not yet cleared. The
//                        health check and the bridge share the folder; each owns its own keys. The
//                        bridge's only key is "auth-stop". One file per key, rather than
//                        one shared JSON file, so two writers can never overwrite each other.

import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomically } from "../data/files.ts";

// ---------------------------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------------------------

export function heartbeatPath(stateDir: string): string {
  return join(stateDir, "heartbeat");
}

// Called only after a health call that reached Signal's server succeeded (the client's onHealth).
export function touchHeartbeat(stateDir: string, nowMs: number): void {
  const path = heartbeatPath(stateDir);
  writeFileSync(path, new Date(nowMs).toISOString() + "\n");
  // Set the file's time explicitly, so it is the bridge's clock the checker compares against.
  const seconds = nowMs / 1000;
  utimesSync(path, seconds, seconds);
}

// ---------------------------------------------------------------------------------------------
// Unanswered adult messages (the third alert condition)
// ---------------------------------------------------------------------------------------------

export function unansweredPath(stateDir: string): string {
  return join(stateDir, "unanswered.json");
}

interface UnansweredFile {
  messages: Array<{ id: string; firstSeenMs: number }>;
  lastAnsweredMs: number | null; // the last reply or logged deliberate silence
}

// Tracks which adult messages still wait for a reply. The bridge calls arrived() when the
// transport hands a message over, and answered() when the worker marks it handled, which the
// worker does only after the reply was sent or a deliberate silence was logged.
export class ReplyTracker {
  private path: string;
  private state: UnansweredFile;

  constructor(stateDir: string, private now: () => number) {
    this.path = unansweredPath(stateDir);
    this.state = existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as UnansweredFile) : { messages: [], lastAnsweredMs: null };
  }

  // A replay after a restart keeps the time the message was first seen.
  arrived(id: string): void {
    if (this.state.messages.some((entry) => entry.id === id)) return;
    this.state.messages.push({ id, firstSeenMs: this.now() });
    this.save();
  }

  answered(id: string): void {
    const before = this.state.messages.length;
    this.state.messages = this.state.messages.filter((entry) => entry.id !== id);
    if (this.state.messages.length === before) return;
    this.state.lastAnsweredMs = this.now();
    this.save();
  }

  firstSeen(id: string): number | null {
    return this.state.messages.find((entry) => entry.id === id)?.firstSeenMs ?? null;
  }

  // When the longest-waiting message was first seen, or null when nothing waits.
  oldestFirstSeen(): number | null {
    if (this.state.messages.length === 0) return null;
    return Math.min(...this.state.messages.map((entry) => entry.firstSeenMs));
  }

  private save(): void {
    writeFileAtomically(this.path, JSON.stringify(this.state, null, 2) + "\n");
  }
}

// ---------------------------------------------------------------------------------------------
// Alert state, shared with the checker
// ---------------------------------------------------------------------------------------------

export function alertStatePath(stateDir: string, key: string): string {
  return join(stateDir, "alert-state", key);
}

export function hasAlerted(stateDir: string, key: string): boolean {
  return existsSync(alertStatePath(stateDir, key));
}

export function recordAlert(stateDir: string, key: string, text: string, nowMs: number): void {
  mkdirSync(join(stateDir, "alert-state"), { recursive: true });
  writeFileSync(alertStatePath(stateDir, key), `${new Date(nowMs).toISOString()} ${text}\n`);
}

// The condition cleared: the next time it holds, it alerts again.
export function clearAlert(stateDir: string, key: string): void {
  rmSync(alertStatePath(stateDir, key), { force: true });
}
