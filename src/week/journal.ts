// The batch journal: <stateDir>/batches.jsonl, append-only, one JSON object per line. The
// worker writes a record before each step of a batch or a Friday draft, so a restart can
// finish the job without asking the model again. The order of those records, and what a
// restart does with each, is described at the top of worker.ts.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendLineDurably } from "../data/files.ts";
import type { LoggedNight } from "../data/log.ts";
import type { Night } from "../data/profile.ts";
import type { RecipeCommand } from "../recipes/commands.ts";
import type { SendOutcome } from "../messaging/types.ts";
import type { CommitRecord, CommitStatus } from "../onboarding/commit.ts";
import type { BatchMessage, OnboardingExtractOutcome, OnboardingState, Proposal } from "../onboarding/state.ts";
import type { IngredientFill, Operation } from "./changeset.ts";
import type { NightValue, WeekFile } from "./state.ts";

// A practice run (dry run) keeps its own journal, so a live start never replays its turns.
export function journalPath(stateDir: string, dryRun = false): string {
  return join(stateDir, dryRun ? "batches.dry-run.jsonl" : "batches.jsonl");
}

// ---------------------------------------------------------------------------------------------
// Steps: the checked, resolved form of a change set, as the journal stores it
// ---------------------------------------------------------------------------------------------

export type Step =
  | { kind: "night"; mode: "pin" | "swap"; weekOf: string; night: Night; value: NightValue; who: string }
  | { kind: "lock"; weekOf: string }
  | { kind: "skip"; weekOf: string }
  | { kind: "unskip"; weekOf: string }
  | { kind: "have"; weekOf: string; items: string[] }
  | { kind: "report"; weekOf: string; text: string }
  | { kind: "profile"; op: Operation; who: string }
  // A recipe command, answered by code. `admin` is decided when the step is planned, so a replay
  // after a crash decides the same way.
  | { kind: "command"; command: RecipeCommand; admin: boolean; by?: string }
  | { kind: "say"; text: string }; // a dropped operation or the one question: just a reply line

// ---------------------------------------------------------------------------------------------
// The house-rules interview's turns
// ---------------------------------------------------------------------------------------------

// What started a turn. A turn is everything the bot does in answer to one thing: it is recorded
// first, then carried out step by step, and each step's result is recorded as it finishes. A
// restart runs the turn again from the top: a step with a recorded result is skipped (the model
// is never asked twice), and a send is repeated with the same key, which the sender knows.
export type InterviewInput =
  // The bridge started with no profile (or a redo began): welcome the adults and ask the first question.
  | { kind: "startup" }
  // Answers from the adults, with the model's reading of them (null when only "skip" was said).
  | { kind: "answers"; messages: BatchMessage[]; addressed: boolean; extraction: OnboardingExtractOutcome | null }
  | { kind: "command"; command: "setup" | "cancel" | "sample"; by: string; byName: string; messageId: string }
  // `receiptSeq` is the message's local receipt number (inbox.ts); null if it has none.
  | { kind: "approve"; by: string; byName: string; messageId: string; repliesToNativeId: string | null; receiptSeq: number | null };

// What one step of a turn produced. The wording of each `label` is the transition it records.
export type InterviewStep =
  // The interview's state, after a transition: started, extraction applied, question asked,
  // clarification asked, read-back recorded, read-back delivered, snapshot asked, commit begun,
  // finished, or cancelled.
  | { kind: "state"; label: string; state: OnboardingState; changed?: boolean }
  // The picture of the world when the turn began: what the file said, so that a replay decides the same way.
  | { kind: "began"; state: OnboardingState | null; profile: "ready" | "setup-needed" | "error"; fingerprint: string }
  // A message to the household and how the send ended (with the chat app's IDs in the outcome).
  | { kind: "said"; label: string; key: string; text: string; outcome: SendOutcome }
  // What the proposal works out to right now (also what a "save" would write).
  // `baselineFingerprint` is the profile file as it was when `text` was worked out.
  | { kind: "proposal"; proposal: Proposal; previous: Proposal | null; text: string; problems: string[]; flags: string[]; baselineFingerprint: string }
  | { kind: "commit-prepared"; record: CommitRecord }
  | { kind: "commit-finished"; status: CommitStatus };

export type LogAction =
  | { kind: "lock"; weekOf: string; nights: LoggedNight[] }
  | { kind: "change-after-lock"; weekOf: string; night: Night; dish: string; protein: string; recipeId?: string }
  | { kind: "report"; weekOf: string; text: string };

export type JournalRecord =
  | {
      type: "batch";
      id: string;
      inboundIds: string[];
      at: string; // ISO time the batch was planned; used as the lock time and profile-change time
      today: string;
      weeksBefore: WeekFile[];
      steps: Step[];
      fills: IngredientFill[];
      brainText: string | null;
    }
  // `dryRun` is the mode the turn began in; it is only ever carried out in that mode.
  | { type: "interview"; id: string; inboundIds: string[]; at: string; input: InterviewInput; dryRun?: boolean }
  | { type: "interview-step"; id: string; index: number; step: InterviewStep }
  | { type: "step-done"; id: string; index: number; fragment: string | null }
  | { type: "applied"; id: string; reply: string | null }
  | { type: "draft"; id: string; weekOf: string; week: WeekFile; text: string }
  | { type: "sending"; id: string }
  | { type: "outcome"; id: string; outcome: SendOutcome }
  | { type: "done"; id: string };

export interface JournalEntry {
  id: string;
  batch: Extract<JournalRecord, { type: "batch" }> | null;
  interview: Extract<JournalRecord, { type: "interview" }> | null;
  interviewSteps: Map<number, InterviewStep>;
  draft: Extract<JournalRecord, { type: "draft" }> | null;
  stepsDone: Map<number, string | null>;
  applied: { reply: string | null } | null;
  sending: boolean;
  outcome: SendOutcome | null;
  done: boolean;
}

export class BatchJournal {
  private entries = new Map<string, JournalEntry>();
  private byInbound = new Map<string, string>();

  constructor(private path: string, log: (line: string) => void) {
    if (!existsSync(path)) return;
    const content = readFileSync(path, "utf8");
    // After a crash mid-write the file can end in a partial line. End it here, so the next
    // record starts on a line of its own instead of being glued onto the fragment (the same
    // fix as the inbox journal in messaging/inbox.ts).
    if (content !== "" && !content.endsWith("\n")) appendFileSync(path, "\n");

    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      try {
        this.remember(JSON.parse(line) as JournalRecord);
      } catch {
        log("batch journal: skipped an unreadable line"); // a partial line from a crash mid-write
      }
    }
  }

  get(id: string): JournalEntry | undefined {
    return this.entries.get(id);
  }

  batchIdFor(inboundId: string): string | undefined {
    return this.byInbound.get(inboundId);
  }

  unfinished(): JournalEntry[] {
    return [...this.entries.values()].filter((entry) => !entry.done);
  }

  // Appends one record, forced to disk, and updates the in-memory view.
  append(record: JournalRecord): void {
    appendLineDurably(this.path, record);
    this.remember(record);
  }

  private entry(id: string): JournalEntry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { id, batch: null, interview: null, interviewSteps: new Map(), draft: null, stepsDone: new Map(), applied: null, sending: false, outcome: null, done: false };
      this.entries.set(id, entry);
    }
    return entry;
  }

  private remember(record: JournalRecord): void {
    const entry = this.entry(record.id);
    switch (record.type) {
      case "batch":
        entry.batch = record;
        for (const inboundId of record.inboundIds) this.byInbound.set(inboundId, record.id);
        break;
      case "interview":
        entry.interview = record;
        for (const inboundId of record.inboundIds) this.byInbound.set(inboundId, record.id);
        break;
      case "interview-step":
        entry.interviewSteps.set(record.index, record.step);
        break;
      case "draft":
        entry.draft = record;
        break;
      case "step-done":
        entry.stepsDone.set(record.index, record.fragment);
        break;
      case "applied":
        entry.applied = { reply: record.reply };
        break;
      case "sending":
        entry.sending = true;
        break;
      case "outcome":
        entry.outcome = record.outcome;
        break;
      case "done":
        entry.done = true;
        break;
    }
  }
}
