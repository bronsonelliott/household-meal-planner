// Two ways the agent writes files so a crash or a sync never leaves a half-written one.

import { closeSync, fsyncSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";

// Writes to a temp file beside the target, then renames it into place, so a reader (or a sync tool)
// never sees a half-written file.
export function writeFileAtomically(path: string, text: string): void {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, text);
  renameSync(tempPath, path);
}

// Appends one JSON line to a journal and forces it to disk before returning, so a record the
// caller has written survives a crash the moment this returns.
export function appendLineDurably(path: string, record: object): void {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, JSON.stringify(record) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
