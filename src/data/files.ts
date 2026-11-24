// Two ways the agent writes files so a crash or a sync never leaves a half-written one.

import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

// Writes to a temp file beside the target, then renames it into place, so a reader (or a sync tool)
// never sees a half-written file. The folder is created if it isn't there yet (a fresh install
// starts with no data/ or state/ folder).
export function writeFileAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, text);
  renameSync(tempPath, path);
}

// Appends one JSON line to a journal and forces it to disk before returning, so a record the
// caller has written survives a crash the moment this returns.
export function appendLineDurably(path: string, record: object): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    writeSync(fd, JSON.stringify(record) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// A short fingerprint of some text, used to tell "the same bytes" from "someone edited it".
export function fingerprintText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// The fingerprint of a file's current bytes, or "none" when there is no file.
export function fingerprintFile(path: string): string {
  return existsSync(path) ? fingerprintText(readFileSync(path, "utf8")) : "none";
}
