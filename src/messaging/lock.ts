// One bridge per household: two bridges on one state folder would fight over the same messages
// and send every reply twice.

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { StartupError } from "../config.ts";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 checks existence without touching the process
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Takes <stateDir>/bridge.lock and returns the function that releases it. A lock is stale, and is
// cleared, when its process is gone or it was written before the machine last booted (after a
// reboot its PID may belong to some unrelated process).
export function acquireHouseholdLock(stateDir: string, log: (line: string) => void): () => void {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "bridge.lock");

  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8").trim());
    const bootTimeMs = Date.now() - uptime() * 1000;
    const writtenBeforeBoot = statSync(path).mtimeMs < bootTimeMs;
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid) && !writtenBeforeBoot) {
      throw new StartupError(`Another bridge (pid ${pid}) is already running for this household. Lock file: ${path}`);
    }
    log(`cleared a stale lock file (pid ${pid})`);
    unlinkSync(path);
  }

  try {
    // "wx" fails if the file appeared since the check above: someone else won the race.
    writeFileSync(path, String(process.pid), { flag: "wx" });
  } catch {
    throw new StartupError(`Another bridge took the lock file first: ${path}`);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (existsSync(path) && readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
  };
}
