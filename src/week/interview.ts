// The house-rules interview, as the worker runs it.
//
// The pieces of the interview itself (the saved state, the questions, the validation, the
// read-back, the save) live in src/onboarding. This file is the conductor: given what just
// happened (answers, a command, an approval), it decides what to say and what to save, and it does
// so in a way that survives a crash.
//
// How a turn survives a crash. A "turn" is everything the bot does for one thing the adults did.
// The worker records the turn first (journal.ts: "interview"), then carries it out as a list of
// steps. Each step's result is written to the journal as it finishes: the state after a
// transition, a message sent and how the send ended, the commit that was prepared. If the bridge
// stops, it runs the same turn again from the top. Any step with a recorded result is not done
// again (so the model is never asked twice, and a message with a recorded outcome is not sent
// twice); a step with no result is done now. A send that was cut off is sent with the same key,
// and the sender, which keeps its own journal, only sends what has not gone out.
//
// Because of that, a turn's decisions may only depend on its input and on recorded step results,
// never on files read mid-turn. Anything read from disk is read inside a step so it is recorded.

import { fingerprintFile } from "../data/files.ts";
import {
  readProfileStatus,
  type HouseProfile,
  type Night,
  type ProfileFiles,
} from "../data/profile.ts";
import type { SendOutcome, InboundEvent } from "../messaging/types.ts";
import { finishCommit, prepareCommit } from "../onboarding/commit.ts";
import { sampleExtraction, sampleProposal } from "../onboarding/control.ts";
import {
  CANCELLED_MESSAGE,
  EXTERNAL_EDIT_MESSAGE,
  FIRST_RUN_PROFILE_APPEARED,
  NOTHING_TO_SAVE,
  NO_SETUP_RUNNING,
  PROFILE_UNREADABLE,
  REASK_PREFIX,
  REPHRASE_REQUEST,
  SAMPLE_INTRO,
  SETUP_ALREADY_RUNNING,
  SETUP_RESUMED,
  clarificationMessage,
  problemsMessage,
  questionFor,
  savedMessage,
  welcomeMessage,
} from "../onboarding/questions.ts";
import { renderProfile, renderReadBack, renderSnapshot } from "../onboarding/render.ts";
import {
  applyExtraction,
  applySkips,
  approvalRoute,
  askSnapshot,
  cancelOnboarding,
  computeProposal,
  isActivePhase,
  loadOnboardingState,
  markConflictAsked,
  needsStartupReask,
  newOnboardingState,
  nextStateSeq,
  nextStep,
  nextTopic,
  onboardingStatePath,
  proposalFromProfile,
  recordAsk,
  recordDelivery,
  recordReadBack,
  recordReadBackDelivered,
  recordReadBackIds,
  recordSnapshotDelivered,
  recordSnapshotDelivery,
  repliesToLatestReadBack,
  saveIfNewer,
  snapshotApproval,
  startAsking,
  unconfirmedQuestion,
  withPhase,
  type BatchMessage,
  type DeliveryStatus,
  type LoadedOnboarding,
  type Mode,
  type OnboardingExtractOutcome,
  type OnboardingExtractRequest,
  type OnboardingState,
  type Proposal,
} from "../onboarding/state.ts";
import { validateProposal } from "../onboarding/validate.ts";
import { BatchJournal, type InterviewInput, type InterviewStep, type JournalEntry } from "./journal.ts";

export interface InterviewSettings {
  botName: string;
  members: Array<{ id: string; name: string }>;
  weeknights: readonly Night[];
  minDiscoveryNights: number;
  dryRun: boolean;
}

export interface InterviewDeps {
  stateDir: string;
  profileFiles: ProfileFiles;
  journal: BatchJournal;
  // Reads one batch of answers (the isolated model call). Optional so test stubs need not have it.
  extract?: (request: OnboardingExtractRequest) => Promise<OnboardingExtractOutcome>;
  send: (text: string, key: string) => Promise<SendOutcome>;
  now: () => number;
  log: (line: string) => void;
  settings: InterviewSettings;
  // The newest local receipt number so far: what a message must beat to count as coming after something was shown.
  receiptHighWater: () => number;
  // The profile has just been saved (also called again if a crash made the turn run twice).
  onProfileSaved: (commitId: string, mode: Mode) => void;
}

type Began = Extract<InterviewStep, { kind: "began" }>;
type ProposalStep = Extract<InterviewStep, { kind: "proposal" }>;

// Runs a turn's steps in order, skipping the ones the journal already has.
class Run {
  private index = 0;
  constructor(
    readonly id: string,
    private entry: JournalEntry,
    private journal: BatchJournal,
  ) {}

  // The number the next step will get; sends use it to build a key that is the same on a replay.
  get next(): number {
    return this.index;
  }

  async step<T extends InterviewStep>(compute: () => T | Promise<T>): Promise<T> {
    const index = this.index++;
    const stored = this.entry.interviewSteps.get(index);
    if (stored) return stored as T;
    const value = await compute();
    this.journal.append({ type: "interview-step", id: this.id, index, step: value });
    return value;
  }
}

export class Interview {
  constructor(private deps: InterviewDeps) {}

  private get statePath(): string {
    return onboardingStatePath(this.deps.stateDir, this.deps.settings.dryRun);
  }

  private get profilePath(): string {
    return this.deps.profileFiles.profilePath;
  }

  private get now(): Date {
    return new Date(this.deps.now());
  }

  load(): LoadedOnboarding {
    return loadOnboardingState(this.statePath);
  }

  // True while the adults' messages are answers to the interview.
  isActive(): boolean {
    const loaded = this.load();
    return loaded.kind === "ok" && isActivePhase(loaded.state.phase);
  }

  // ----- Before a turn: the model call -----

  // Reads a batch of answers. This is the only place the model is asked; the result goes into the
  // turn's record, so a restart never asks again. Throws if the call fails (the worker holds the
  // messages and tries later).
  async prepareAnswers(events: InboundEvent[]): Promise<InterviewInput> {
    const loaded = this.load();
    if (loaded.kind !== "ok") throw new Error("the interview's state file is not available");
    const messages: BatchMessage[] = events.map((event) => ({ id: event.id, memberId: event.memberId, memberName: event.memberName, text: event.text }));
    const { state, rest } = applySkips(loaded.state, messages, this.now);
    let extraction: OnboardingExtractOutcome | null = null;
    if (rest.length > 0) {
      if (!this.deps.extract) throw new Error("This brain cannot read interview answers.");
      extraction = await this.deps.extract({ state, batch: rest });
    }
    return { kind: "answers", messages, addressed: events.some((event) => event.mentionsBot || event.repliesToBot), extraction };
  }

  // ----- Starting up -----

  // What the bridge should do at start: nothing, or begin the first-run interview. Looks at the
  // state file and the profile only; a corrupt state file is the bridge's startup error, checked by the caller.
  startupNeeded(): boolean {
    const status = readProfileStatus(this.profilePath);
    const loaded = this.load();
    if (status.kind !== "setup-needed" || loaded.kind === "corrupt") return false;
    if (loaded.kind === "missing") return true;
    const state = loaded.state;
    if (state.phase === "done") return !this.deps.settings.dryRun; // a finished practice run is not repeated
    return state.phase === "awaiting-start";
  }

  // True when the interview is waiting on a question whose send was never confirmed, and it has
  // not been repeated yet.
  questionNeedsReask(): boolean {
    const loaded = this.load();
    return loaded.kind === "ok" && needsStartupReask(loaded.state);
  }

  // A first-run interview left open when a profile has appeared by hand is closed, not resumed
  // (unless the save was already under way: that turn finishes it).
  closeIfProfileAppeared(): void {
    const status = readProfileStatus(this.profilePath);
    const loaded = this.load();
    if (status.kind === "ready" && loaded.kind === "ok" && loaded.state.mode === "first-run" && isActivePhase(loaded.state.phase) && loaded.state.phase !== "committing") {
      const cancelled = cancelOnboarding(loaded.state, this.now);
      saveIfNewer(this.statePath, { ...cancelled, stateSeq: nextStateSeq(this.statePath, cancelled) });
      this.deps.log("a profile appeared while the first-run interview was open; the interview was closed");
    }
  }

  // ----- Carrying out a turn -----

  async run(id: string): Promise<void> {
    const entry = this.deps.journal.get(id);
    if (!entry?.interview) return;
    // A finished turn is never carried out again: replaying it would write its older states over newer ones.
    if (entry.done) return;
    // A turn is only carried out in the mode (practice or real) it began in.
    if ((entry.interview.dryRun ?? false) !== this.deps.settings.dryRun) {
      this.deps.log(`interview turn ${id} was begun in the other mode (practice or real); leaving it alone`);
      return;
    }
    const run = new Run(id, entry, this.deps.journal);
    const input = entry.interview.input;
    switch (input.kind) {
      case "startup":
        return this.startup(run);
      case "reask":
        return this.reask(run);
      case "answers":
        return this.answers(run, input);
      case "command":
        if (input.command === "setup") return this.commandSetup(run);
        if (input.command === "cancel") return this.commandCancel(run);
        return this.commandSample(run, input);
      case "approve":
        return this.approve(run, input);
    }
  }

  // ----- Steps every turn uses -----

  // The picture when the turn begins (or at a later moment the turn needs a fresh look).
  private look(run: Run): Promise<Began> {
    return run.step(() => {
      const loaded = this.load();
      if (loaded.kind === "corrupt") throw new Error(loaded.message);
      const status = readProfileStatus(this.profilePath).kind;
      return {
        kind: "began" as const,
        state: loaded.kind === "ok" ? loaded.state : null,
        profile: status === "setup-needed" ? ("setup-needed" as const) : status === "ready" ? ("ready" as const) : ("error" as const),
        fingerprint: fingerprintFile(this.profilePath),
      };
    });
  }

  // Records a new state, and writes it. Returns the recorded state (which on a replay is the one
  // from the journal, not a new calculation).
  // Each recorded state carries a write number one above the file's, and a state no newer than
  // the file's is not written, so replaying an older turn can never undo a newer one.
  private async setState(run: Run, label: string, state: OnboardingState, changed?: boolean): Promise<OnboardingState> {
    const step = await run.step(() => ({ kind: "state" as const, label, state: { ...state, stateSeq: nextStateSeq(this.statePath, state) }, ...(changed !== undefined ? { changed } : {}) }));
    if (!saveIfNewer(this.statePath, step.state)) this.deps.log(`interview: a saved state from "${label}" was older than the file's, so it was not written`);
    return step.state;
  }

  // Sends one message to the household and records how it ended. The key is the same on a replay.
  private async say(run: Run, label: string, text: string): Promise<SendOutcome> {
    const key = `${run.id}:${run.next}`;
    const step = await run.step(async () => ({ kind: "said" as const, label, key, text, outcome: await this.deps.send(text, key) }));
    return step.outcome;
  }

  private memberIds(): string[] {
    return this.deps.settings.members.map((member) => member.id);
  }

  // What the proposal works out to right now, and what saving it would write.
  private proposal(run: Run, state: OnboardingState): Promise<ProposalStep> {
    return run.step(() => {
      const status = readProfileStatus(this.profilePath);
      // The file as these bytes are worked out from it: saving is only allowed over this very file.
      const baselineFingerprint = fingerprintFile(this.profilePath);
      const existing: HouseProfile | undefined = status.kind === "ready" ? status.profile : undefined;
      // A redo carries over what the household tuned by hand (lock words, limits, ingredient lines).
      const proposal = computeProposal(state, state.mode === "redo" ? existing : undefined);
      const validation = validateProposal(proposal, { weeknights: this.deps.settings.weeknights, minDiscoveryNights: this.deps.settings.minDiscoveryNights });
      const previous = state.lastReadBack?.proposal ?? (state.mode === "redo" && existing ? proposalFromProfile(existing) : null);
      return { kind: "proposal" as const, proposal, previous, text: renderProfile(proposal), problems: validation.problems, flags: validation.flags, baselineFingerprint };
    });
  }

  // ----- What to say next -----

  // The conversation's next move for this state: a clarification, the next question, or the proposal.
  private async followUp(run: Run, state: OnboardingState): Promise<OnboardingState> {
    const step = nextStep(state);
    if (step.kind === "clarify") {
      await this.say(run, "clarification", clarificationMessage(step.conflict));
      return this.setState(run, "clarification-asked", markConflictAsked(state, step.conflict.id, this.now));
    }
    if (step.kind === "ask") {
      const outcome = await this.say(run, "question", questionFor(step.topic, this.deps.settings.members.length));
      const asking: OnboardingState = { ...withPhase(state, "asking", this.now), currentTopic: step.topic, pendingSnapshot: null };
      return this.setState(run, "question-asked", recordAsk(asking, step.topic, wasDelivered(outcome), false, this.now));
    }
    return this.readBack(run, state);
  }

  // Checks the proposal and, if it holds up, shows it to the adults in plain words.
  private async readBack(run: Run, state: OnboardingState): Promise<OnboardingState> {
    const p = await this.proposal(run, state);
    if (p.problems.length > 0) {
      await this.say(run, "problems", problemsMessage(p.problems));
      return state;
    }
    const chunks = renderReadBack(p.proposal, {
      revision: state.revision,
      weeknights: this.deps.settings.weeknights,
      previous: p.previous,
      flags: p.flags,
      mode: state.mode,
    });
    let current = await this.setState(run, "read-back-recorded", recordReadBack(state, p.proposal, this.memberIds(), chunks.length, this.now, { text: p.text, baselineFingerprint: p.baselineFingerprint }));
    const outcomes: SendOutcome[] = [];
    for (const chunk of chunks) outcomes.push(await this.say(run, "read-back", chunk));
    const { ids, deliveries } = summarizeSends(outcomes, this.memberIds());
    current = recordReadBackIds(current, state.revision, ids, this.now);
    for (const [memberId, status] of Object.entries(deliveries)) current = recordDelivery(current, state.revision, memberId, status, this.now);
    // Only a message received after this moment can approve what was just shown.
    current = recordReadBackDelivered(current, state.revision, this.deps.receiptHighWater(), this.now);
    return this.setState(run, "read-back-delivered", current);
  }

  // ----- The turns -----

  private async welcome(run: Run, state: OnboardingState): Promise<OnboardingState> {
    const text = welcomeMessage({ botName: this.deps.settings.botName, memberNames: this.deps.settings.members.map((member) => member.name), mode: state.mode });
    const outcome = await this.say(run, "welcome", text);
    const asking = startAsking(state, this.now);
    // The welcome carries the first question, so if it was not confirmed that question is unseen.
    const noted = asking.currentTopic ? recordAsk(asking, asking.currentTopic, wasDelivered(outcome), false, this.now) : asking;
    return this.setState(run, "question-asked", noted);
  }

  // Asks the question being waited on once more, with a short lead-in, and notes how that went.
  private async askAgain(run: Run, state: OnboardingState): Promise<OnboardingState> {
    const topic = state.currentTopic!;
    const outcome = await this.say(run, "question", `${REASK_PREFIX}\n\n${questionFor(topic, this.deps.settings.members.length)}`);
    return this.setState(run, "question-reasked", recordAsk(state, topic, wasDelivered(outcome), true, this.now));
  }

  // At start-up: the question being waited on never reached the household (its send ended
  // unknown, failed or queued), so it is asked once more. Asking a question twice is harmless,
  // unlike posting a meal plan twice.
  private async reask(run: Run): Promise<void> {
    const began = await this.look(run);
    const state = began.state;
    if (!state || !needsStartupReask(state)) return;
    await this.askAgain(run, state);
  }

  private freshState(began: Began): OnboardingState {
    const mode: Mode = began.profile === "ready" ? "redo" : "first-run";
    return newOnboardingState(mode, began.fingerprint, this.now);
  }

  private async startup(run: Run): Promise<void> {
    const began = await this.look(run);
    const state = began.state;
    if (state && isActivePhase(state.phase)) {
      if (state.phase === "awaiting-start") await this.welcome(run, state);
      return; // already under way: a restart does not repeat the welcome
    }
    if (began.profile !== "setup-needed") return; // a profile exists: nothing to set up on its own
    if (state?.phase === "cancelled") return; // stays cancelled until someone asks again
    const started = await this.setState(run, "started", this.freshState(began));
    await this.welcome(run, started);
  }

  private async commandSetup(run: Run): Promise<void> {
    const began = await this.look(run);
    if (began.profile === "error") {
      await this.say(run, "notice", PROFILE_UNREADABLE);
      return;
    }
    const state = began.state;
    if (state && isActivePhase(state.phase)) {
      if (state.phase === "awaiting-start") {
        await this.welcome(run, state);
        return;
      }
      await this.say(run, "notice", SETUP_ALREADY_RUNNING);
      await this.followUp(run, state);
      return;
    }
    // A cancelled interview picks up where it left off, if nothing about the profile changed since.
    const sameSituation = state !== null && state.mode === (began.profile === "ready" ? "redo" : "first-run");
    if (state?.phase === "cancelled" && sameSituation) {
      const resumed = await this.setState(run, "resumed", { ...withPhase(state, "asking", this.now), currentTopic: nextTopic(state), pendingSnapshot: null });
      await this.say(run, "notice", SETUP_RESUMED);
      await this.followUp(run, resumed);
      return;
    }
    const started = await this.setState(run, "started", this.freshState(began));
    await this.welcome(run, started);
  }

  private async commandCancel(run: Run): Promise<void> {
    const began = await this.look(run);
    const state = began.state;
    if (!state || !isActivePhase(state.phase)) {
      await this.say(run, "notice", NO_SETUP_RUNNING);
      return;
    }
    await this.setState(run, "cancelled", cancelOnboarding(state, this.now));
    const tail = state.mode === "first-run" ? " Dinner drafts wait until the house rules are saved." : " Your current rules stay in use.";
    await this.say(run, "notice", CANCELLED_MESSAGE + tail);
  }

  private async commandSample(run: Run, input: Extract<InterviewInput, { kind: "command" }>): Promise<void> {
    const began = await this.look(run);
    if (began.profile === "error") {
      await this.say(run, "notice", PROFILE_UNREADABLE);
      return;
    }
    // The sample replaces whatever has been said so far: it is a fresh start from the sample.
    const fresh = this.freshState(began);
    const base = began.state && isActivePhase(began.state.phase) ? { ...fresh, mode: began.state.mode, originalFingerprint: began.state.originalFingerprint } : fresh;
    const asker: BatchMessage = { id: input.messageId, memberId: input.by, memberName: input.byName, text: "use the sample" };
    const loaded = await this.setState(run, "sample-loaded", applyExtraction(startAsking(base, this.now), [asker], sampleExtraction(sampleProposal(), asker), this.now).state, true);
    await this.say(run, "notice", SAMPLE_INTRO);
    await this.followUp(run, loaded);
  }

  private async answers(run: Run, input: Extract<InterviewInput, { kind: "answers" }>): Promise<void> {
    const began = await this.look(run);
    const state = began.state;
    if (!state || !isActivePhase(state.phase)) return; // the interview ended before these were read
    const skipped = applySkips(state, input.messages, this.now);
    let next = skipped.state;
    let changed = skipped.state !== state;
    let unusable = false;
    if (input.extraction) {
      if (input.extraction.ok) {
        const applied = applyExtraction(next, skipped.rest, input.extraction.result, this.now);
        next = applied.state;
        changed = changed || applied.changed;
        for (const note of applied.notes) this.deps.log(`interview: ${note}`);
      } else {
        unusable = true;
        this.deps.log(`interview: the answers could not be read: ${input.extraction.problems.join("; ")}`);
      }
    }
    next = await this.setState(run, "extraction-applied", next, changed);

    if (unusable) {
      await this.say(run, "rephrase", REPHRASE_REQUEST);
      return;
    }
    if (changed) {
      await this.followUp(run, next);
      return;
    }
    // Nothing new in these messages. If the question they are waiting on may never have arrived,
    // that is why they are not answering it: ask it again, whoever the message was for.
    if (unconfirmedQuestion(next) !== null) {
      await this.askAgain(run, next);
      return;
    }
    // Otherwise chatter between the adults gets no reply; a message to the bot does.
    if (!input.addressed) return;
    if (next.phase === "proposed" || next.phase === "confirming-snapshot") {
      await this.say(run, "notice", 'Say "save it" to save these rules, or tell me what to change.');
    } else {
      await this.say(run, "notice", "I didn't catch an answer in that.");
      await this.followUp(run, next);
    }
  }

  private async approve(run: Run, input: Extract<InterviewInput, { kind: "approve" }>): Promise<void> {
    const began = await this.look(run);
    const state = began.state;
    if (!state || !isActivePhase(state.phase)) {
      await this.say(run, "notice", NO_SETUP_RUNNING);
      return;
    }
    if (state.phase !== "proposed" && state.phase !== "confirming-snapshot") {
      await this.say(run, "notice", NOTHING_TO_SAVE);
      await this.followUp(run, state);
      return;
    }

    // What this adult approves is what they were shown, in full, before their message arrived:
    // the confirm question if one is open, else the read-back they replied to.
    let shown: { text: string; baselineFingerprint: string } | null = null;
    const receiptSeq = input.receiptSeq ?? null;
    const snapshot = state.pendingSnapshot;
    if (state.phase === "confirming-snapshot" && snapshot) {
      const check = snapshotApproval(state, { memberId: input.by, receiptSeq });
      if (check.ok) shown = { text: snapshot.text, baselineFingerprint: snapshot.baselineFingerprint };
      else this.deps.log(`interview: that "save it" does not approve the confirm question, because ${check.why}`);
    }
    if (!shown) {
      const route = approvalRoute(state, { memberId: input.by, repliesToLatestReadBack: repliesToLatestReadBack(state, input.by, input.repliesToNativeId ?? undefined), receiptSeq });
      if (route.route === "save") shown = { text: state.lastReadBack!.text, baselineFingerprint: state.lastReadBack!.baselineFingerprint };
      else this.deps.log(`interview: asking the confirm question first, because ${route.why}`);
    }
    if (!shown) {
      await this.askSnapshot(run, state);
      return;
    }
    await this.commit(run, state, shown, input.byName);
  }

  // The confirm question: shows what would be saved (the rules and the lists), and notes how each
  // adult received it. Only an adult who got every part of it, and who answers after it went out,
  // can approve it.
  private async askSnapshot(run: Run, state: OnboardingState): Promise<void> {
    const p = await this.proposal(run, state);
    if (p.problems.length > 0) {
      await this.say(run, "problems", problemsMessage(p.problems));
      return;
    }
    const chunks = renderSnapshot(p.proposal, { weeknights: this.deps.settings.weeknights });
    const asked = await this.setState(run, "snapshot-asked", askSnapshot(state, p.proposal, p.text, this.now, { baselineFingerprint: p.baselineFingerprint, chunkCount: chunks.length, memberIds: this.memberIds() }));
    const outcomes: SendOutcome[] = [];
    for (const chunk of chunks) outcomes.push(await this.say(run, "snapshot", chunk));
    const { ids, deliveries } = summarizeSends(outcomes, this.memberIds());
    let current = asked;
    for (const [memberId, status] of Object.entries(deliveries)) current = recordSnapshotDelivery(current, state.revision, memberId, status, this.now);
    current = recordSnapshotDelivered(current, state.revision, ids, this.deps.receiptHighWater(), this.now);
    await this.setState(run, "snapshot-delivered", current);
  }

  // Journal the commit before it happens, then finish it. Both steps are safe to run again.
  // It writes exactly the bytes the adults were shown, and only over the file they were shown it against.
  private async commit(run: Run, state: OnboardingState, shown: { text: string; baselineFingerprint: string }, byName: string): Promise<void> {
    const prepared = await run.step(() => ({
      kind: "commit-prepared" as const,
      record: prepareCommit({ mode: state.mode, revision: state.revision, approvedText: shown.text, preimageFingerprint: shown.baselineFingerprint, now: this.now, dryRun: this.deps.settings.dryRun }),
    }));
    const committing = await this.setState(run, "commit-begun", withPhase(state, "committing", this.now));
    const finished = await run.step(() => ({
      kind: "commit-finished" as const,
      status: finishCommit(this.deps.profileFiles, prepared.record, { who: byName, dryRun: this.deps.settings.dryRun, log: this.deps.log }),
    }));

    if (finished.status === "external-edit") {
      await this.afterExternalEdit(run, committing);
      return;
    }
    await this.setState(run, "commit-finished", withPhase(committing, "done", this.now));
    await this.say(run, "saved", savedMessage(state.mode, finished.status === "dry-run"));
    if (finished.status !== "dry-run") this.deps.onProfileSaved(prepared.record.commitId, state.mode);
  }

  // The profile file was changed by hand while the save was under way. Nothing was written. A
  // first-run interview gives way to the hand-written file; a redo shows a fresh read-back.
  private async afterExternalEdit(run: Run, state: OnboardingState): Promise<void> {
    const began = await this.look(run);
    if (state.mode === "first-run" && began.profile === "ready") {
      await this.setState(run, "cancelled", cancelOnboarding(state, this.now));
      await this.say(run, "notice", FIRST_RUN_PROFILE_APPEARED);
      this.deps.onProfileSaved(`hand-written-${state.startedAt}`, state.mode);
      return;
    }
    // A new revision: nothing approved before applies to what the file says now.
    const reopened = await this.setState(run, "external-edit", { ...withPhase(state, "proposed", this.now), revision: state.revision + 1, pendingSnapshot: null });
    await this.say(run, "notice", EXTERNAL_EDIT_MESSAGE);
    await this.readBack(run, reopened);
  }
}

// ---------------------------------------------------------------------------------------------
// Reading send outcomes
// ---------------------------------------------------------------------------------------------

function statusOf(outcome: { kind: SendOutcome["kind"]; queued?: true }): DeliveryStatus {
  switch (outcome.kind) {
    case "sent":
      return "delivered";
    case "partial":
      return outcome.queued ? "queued" : "partial";
    case "failed":
      return outcome.queued ? "queued" : "failed";
    case "unknown":
      return "partial"; // it may have arrived; that is not enough to save on
  }
}

// How a read-back's messages reached each adult, and the chat app's IDs of those messages.
export function summarizeSends(outcomes: SendOutcome[], memberIds: string[]): { ids: Array<{ memberId: string | null; nativeId: string }>; deliveries: Record<string, DeliveryStatus> } {
  const perMember = new Map<string, DeliveryStatus[]>(memberIds.map((id) => [id, []]));
  const ids: Array<{ memberId: string | null; nativeId: string }> = [];

  for (const outcome of outcomes) {
    const recipients = outcome.recipients;
    if (!recipients || recipients.length === 0) {
      const status = statusOf(outcome);
      for (const list of perMember.values()) list.push(status);
      if ((outcome.kind === "sent" || outcome.kind === "partial") && outcome.nativeId) ids.push({ memberId: null, nativeId: outcome.nativeId });
      continue;
    }
    const covered = new Set<string>();
    for (const recipient of recipients) {
      const status = statusOf(recipient);
      if (recipient.memberId === null) {
        for (const [id, list] of perMember) {
          list.push(status);
          covered.add(id);
        }
      } else if (perMember.has(recipient.memberId)) {
        perMember.get(recipient.memberId)!.push(status);
        covered.add(recipient.memberId);
      }
      for (const part of recipient.parts) if (part.nativeId) ids.push({ memberId: recipient.memberId, nativeId: part.nativeId });
    }
    for (const [id, list] of perMember) if (!covered.has(id)) list.push("failed");
  }

  const deliveries: Record<string, DeliveryStatus> = {};
  for (const [id, list] of perMember) deliveries[id] = combine(list);
  return { ids, deliveries };
}

function combine(statuses: DeliveryStatus[]): DeliveryStatus {
  if (statuses.length === 0) return "failed";
  if (statuses.every((status) => status === "delivered")) return "delivered";
  if (statuses.includes("queued")) return "queued";
  if (statuses.some((status) => status === "delivered" || status === "partial")) return "partial";
  return "failed";
}

// A send is confirmed when it was posted (even to only some members). Unknown, failed and queued
// sends may never have been seen.
function wasDelivered(outcome: SendOutcome): boolean {
  return outcome.kind === "sent" || outcome.kind === "partial";
}
