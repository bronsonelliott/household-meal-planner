// Saving the approved profile: the whole file in one atomic write, in a way that survives a crash.
//
// The caller (the worker) journals the CommitRecord BEFORE calling finishCommit, then calls
// finishCommit. After a restart it calls finishCommit again with the journaled record; every
// step is safe to repeat. The one thing it never does is overwrite a file somebody edited in the
// meantime: if the file is neither what it was nor what was approved, it stops and says so.
//
// First run: there is nothing to go back to, so no undo record is written.
// Redo: the old file goes into the existing "last change" record first, so "undo" puts it back.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fingerprintFile, fingerprintText, writeFileAtomically } from "../data/files.ts";
import { parseProfile, recordLastChange, type ProfileFiles } from "../data/profile.ts";
import type { Mode } from "./state.ts";

export interface CommitRecord {
  commitId: string;
  revision: number; // the interview revision that was approved
  mode: Mode;
  preimageFingerprint: string; // fingerprint of the profile file as it was when the adults were shown the proposal, or "none"
  approvedText: string; // the exact bytes that were approved
  approvedFingerprint: string;
  at: string; // ISO time the commit began
  // Whether this was a practice run. A record is only ever finished in the mode it was made in.
  dryRun?: boolean;
}

export type CommitStatus =
  | "committed" // the file was written now
  | "already-committed" // the file already holds the approved bytes
  | "external-edit" // the file is neither the old one nor the approved one: nothing was written
  | "dry-run"; // a dry run: logged, never written

let counter = 0;

// Builds the record to journal. Throws a ProfileError if the approved text would not parse, so a
// profile the bot could not read back is never committed.
//
// `approvedText` and `preimageFingerprint` are what the adults were shown and the profile file as
// it was then, never anything read now: if the file has changed since, finishCommit sees the
// difference and writes nothing.
export function prepareCommit(input: { mode: Mode; revision: number; approvedText: string; preimageFingerprint: string; now: Date; dryRun?: boolean; commitId?: string }): CommitRecord {
  parseProfile(input.approvedText);
  counter += 1;
  return {
    commitId: input.commitId ?? `commit-${input.now.getTime()}-${counter}`,
    revision: input.revision,
    mode: input.mode,
    preimageFingerprint: input.preimageFingerprint,
    approvedText: input.approvedText,
    approvedFingerprint: fingerprintText(input.approvedText),
    at: input.now.toISOString(),
    dryRun: input.dryRun ?? false,
  };
}

export interface FinishOptions {
  who: string; // the adult who approved, for the undo record
  dryRun?: boolean;
  log?: (line: string) => void;
}

// Finishes (or re-finishes) a commit. Safe to call any number of times with the same record.
export function finishCommit(files: ProfileFiles, record: CommitRecord, options: FinishOptions): CommitStatus {
  const log = options.log ?? (() => {});
  if ((record.dryRun ?? false) !== (options.dryRun ?? false)) {
    throw new Error(`commit ${record.commitId} was prepared ${record.dryRun ? "in a practice run" : "for real"} and cannot be finished the other way`);
  }
  if (options.dryRun) {
    log(`dry run: would save the house profile (commit ${record.commitId}, version ${record.revision}, ${record.approvedText.length} characters); nothing was written`);
    return "dry-run";
  }

  const current = fingerprintFile(files.profilePath);
  if (current === record.approvedFingerprint) return "already-committed";

  // Anything but the file as it was when the commit began is somebody else's edit. A first run
  // that began with a whitespace-only file counts as unchanged if it is still that file.
  if (current !== record.preimageFingerprint) {
    log(`commit ${record.commitId}: the profile changed during the save, so it was left alone`);
    return "external-edit";
  }

  mkdirSync(dirname(files.profilePath), { recursive: true });
  if (record.mode === "redo") {
    // The undo record first: if we stop between the two writes, the old text is still in it.
    const before = existsSync(files.profilePath) ? readFileSync(files.profilePath, "utf8") : "";
    recordLastChange(files, options.who, "set up the house rules again", before, record.approvedText, new Date(record.at));
  } else {
    rmSync(files.lastChangePath, { force: true }); // nothing to undo to
  }
  writeFileAtomically(files.profilePath, record.approvedText);
  return "committed";
}
