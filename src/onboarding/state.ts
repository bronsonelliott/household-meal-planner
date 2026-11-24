// The house-rules interview's saved state: what the adults have said, what is covered, and where
// the conversation stands. It lives in `state/onboarding.json` (a dry run uses its own file name,
// so it never touches the real one).
//
// The design in one paragraph. Everything an adult says that matters becomes a "fact": a small
// record of who said it, in which message, in their exact words, and what it means. Facts are
// only ever added. A later answer cannot erase another adult's fact; the only way a fact leaves
// the proposal is its own author withdrawing it. The proposal (the future profile.md) is always
// worked out from the facts, never stored as the truth, so it can't drift from what was said.
// All functions here are plain: state in, new state out, nothing hidden. The file is only touched
// by loadOnboardingState and saveOnboardingState.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fingerprintText, writeFileAtomically } from "../data/files.ts";
import { DEFAULT_GROCERY_SECTIONS, matchGrocerySection, sameWords, type HouseProfile, type IngredientLine, type RuleCheck, type Thresholds } from "../data/profile.ts";

export const ONBOARDING_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

// The five fixed questions, in the order they are asked.
export const TOPICS = ["nights", "habits", "dinners", "wont-eat", "staples"] as const;
export type TopicId = (typeof TOPICS)[number];

export const PHASES = ["awaiting-start", "asking", "clarifying", "proposed", "confirming-snapshot", "committing", "done", "cancelled"] as const;
export type Phase = (typeof PHASES)[number];

export type Mode = "first-run" | "redo";

// The interview is under way (messages from the adults are answers, not meal requests).
export function isActivePhase(phase: Phase): boolean {
  return phase !== "done" && phase !== "cancelled";
}

export const FACT_KINDS = ["rule", "dish", "dislike", "veto", "staple", "section", "note"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

// What a fact means. The adult's own words are in `wording` on the fact; only the rule's `check`
// is the model's proposal, kept apart so it can never be mistaken for something an adult said.
export type FactDetail =
  | { kind: "rule"; check: RuleCheck } // the rule's sentence is the fact's wording
  | { kind: "dish"; name: string; protein: string; tags: string[]; pool: "usual" | "also-like" }
  | { kind: "dislike"; person: string; what: string }
  | { kind: "veto"; dish: string }
  | { kind: "staple"; item: string }
  | { kind: "section"; name: string }
  // An answer with nothing for the profile ("we eat everything"), or something that fits no list.
  // Kept so the topic counts as answered; shown in the read-back, never written to profile.md.
  | { kind: "note" };

export type Fact = FactDetail & {
  id: string; // "f1", "f2", ...
  memberId: string; // who said it
  memberName: string;
  messageId: string; // the message it came from
  topic: TopicId;
  wording: string; // the adult's own words, exactly as in their message
};

// A message the interview looks at: the part of an inbound event the interview needs.
export interface BatchMessage {
  id: string;
  memberId: string;
  memberName: string;
  text: string;
}

export interface ConflictVersion {
  memberId: string;
  memberName: string;
  messageId: string;
  quote: string;
  factId?: string;
}

export interface Conflict {
  id: string; // "c1", ...
  topic: TopicId;
  subject: string; // e.g. "Friday dinner"
  versions: ConflictVersion[]; // from at least two different adults
  status: "open" | "resolved";
  resolvedByMessageId?: string;
  // Set once the clarification has been sent, so it is asked once.
  askedAt?: string;
}

export type Coverage =
  | { kind: "answer"; messageIds: string[] } // sourced facts exist for this topic
  | { kind: "skip"; messageId: string; memberId: string }; // an adult said "skip" and nothing else

export type DeliveryStatus = "pending" | "delivered" | "partial" | "queued" | "failed";

export interface ReadBackRecord {
  revision: number; // the revision of the facts it was built from
  chunkCount: number;
  sentAt: string;
  proposal: Proposal; // what was shown, for "what changed since the last version"
  // One entry per adult: did they get the whole read-back? "queued" means the chat app is holding
  // it until they write to the bot; that does not count as delivered.
  deliveries: Record<string, DeliveryStatus>;
  // The chat app's own IDs of the messages this read-back became, so "save it" can be tied to a
  // reply to it. `memberId` is the adult whose private chat holds it, or null for the shared group.
  nativeIds: Array<{ memberId: string | null; nativeId: string }>;
  // The exact profile.md bytes this read-back described, and what the profile file looked like
  // when they were worked out ("none" for a first run). Saving writes these bytes, and only over
  // that file.
  text: string;
  baselineFingerprint: string;
  // The local receipt number (messaging/inbox.ts) reached when the last chunk finished going out.
  // Only a message received after it can approve this read-back.
  deliveredSeq: number | null;
}

// The confirm question: "Save these rules: ...?" The next "save it" approves exactly this snapshot.
export interface PendingSnapshot {
  revision: number;
  summary: string; // the short list at the top of the question
  proposal: Proposal; // what the question showed
  text: string; // the exact profile.md bytes that "save it" would write
  baselineFingerprint: string; // the profile file as it was when those bytes were worked out
  profileFingerprint: string; // fingerprint of the profile text that would be saved
  askedAt: string;
  // Delivery, kept the same way as for a read-back: per adult, with the chat app's IDs.
  chunkCount: number;
  deliveries: Record<string, DeliveryStatus>;
  nativeIds: Array<{ memberId: string | null; nativeId: string }>;
  deliveredSeq: number | null;
}

export interface LastAsk {
  topic: TopicId;
  delivered: boolean; // the send was confirmed
  reasked: boolean; // this is the "in case my last message didn't reach you" repeat
  // The chat app is holding the question to deliver later (WhatsApp, outside its reply window).
  // It will arrive on its own, so asking it again would post it twice. Missing in older files.
  queued?: boolean;
}

export interface OnboardingState {
  schemaVersion: typeof ONBOARDING_SCHEMA_VERSION;
  phase: Phase;
  mode: Mode;
  startedAt: string;
  updatedAt: string;
  currentTopic: TopicId | null;
  covered: Partial<Record<TopicId, Coverage>>;
  facts: Fact[]; // append-only
  withdrawn: Array<{ factId: string; messageId: string; memberId: string }>;
  conflicts: Conflict[];
  processedMessageIds: string[]; // batches are applied once, even if replayed after a restart
  nextFactNumber: number;
  nextConflictNumber: number;
  revision: number; // goes up every time the proposal could change
  lastReadBack: ReadBackRecord | null;
  pendingSnapshot: PendingSnapshot | null;
  // How the last question went out. A question whose send was never confirmed (unknown, failed,
  // queued) may not have been seen, so it is asked again. Missing in older files.
  lastAsk?: LastAsk | null;
  // The profile file's fingerprint when the interview began: "none" for a first run.
  originalFingerprint: string;
  // Goes up with every write of this file. A write older than what is on disk is never applied,
  // so replaying an old turn cannot undo a newer one. Missing in older files, which count as 0.
  stateSeq: number;
}

// ---------------------------------------------------------------------------------------------
// Small text helpers (shared with the rendering and the brain)
// ---------------------------------------------------------------------------------------------

export function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// True when `quote` is really in `text` (spacing differences ignored, wording exact).
export function quoteAppears(text: string, quote: string): boolean {
  const wanted = normalizeSpace(quote);
  return wanted.length > 0 && normalizeSpace(text).includes(wanted);
}

// One tidy line: no line breaks, no HTML-comment marks (the profile reader strips them).
export function oneLine(text: string): string {
  return normalizeSpace(text.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/<!--|-->/g, " "));
}

// Rule sentences keep their words but not square brackets: the check is the last [..] on the line.
export function proseLine(text: string): string {
  return oneLine(text).replace(/\[/g, "(").replace(/\]/g, ")");
}

// A tag is one lower-case word. "Kid friendly" becomes "kid-friendly".
export function cleanTag(tag: string): string {
  return oneLine(tag)
    .toLowerCase()
    .replace(/[,\[\]]/g, "")
    .replace(/\s+/g, "-");
}

export function isValidTag(tag: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(tag);
}

// "skip" and nothing else (case, spaces and end punctuation don't matter).
export function isSkipMessage(text: string): boolean {
  return text.trim().toLowerCase().replace(/[.!\s]+$/, "") === "skip";
}

// ---------------------------------------------------------------------------------------------
// Starting and finishing
// ---------------------------------------------------------------------------------------------

export function newOnboardingState(mode: Mode, originalFingerprint: string, now: Date): OnboardingState {
  const at = now.toISOString();
  return {
    schemaVersion: ONBOARDING_SCHEMA_VERSION,
    phase: "awaiting-start",
    mode,
    startedAt: at,
    updatedAt: at,
    currentTopic: null,
    covered: {},
    facts: [],
    withdrawn: [],
    conflicts: [],
    processedMessageIds: [],
    nextFactNumber: 1,
    nextConflictNumber: 1,
    revision: 0,
    lastReadBack: null,
    pendingSnapshot: null,
    originalFingerprint,
    stateSeq: 0,
  };
}

// The welcome has gone out: the first question is the one being asked.
export function startAsking(state: OnboardingState, now: Date): OnboardingState {
  return touch({ ...state, phase: "asking", currentTopic: nextTopic(state) }, now);
}

// Notes how the question for `topic` went out.
// `queued` means the chat app kept it for later: not delivered yet, but not lost either.
export function recordAsk(state: OnboardingState, topic: TopicId, delivered: boolean, reasked: boolean, now: Date, queued = false): OnboardingState {
  return touch({ ...state, lastAsk: { topic, delivered, reasked, queued } }, now);
}

// The topic being waited on, when its question may never have been seen; otherwise null.
// A queued question is not in this group: it is on its way, and repeating it would send it twice.
export function unconfirmedQuestion(state: OnboardingState): TopicId | null {
  const ask = state.lastAsk;
  if (state.phase !== "asking" || state.currentTopic === null || !ask) return null;
  return ask.topic === state.currentTopic && !ask.delivered && !ask.queued ? state.currentTopic : null;
}

// True at start-up when that unseen question has not been repeated yet. After one repeat a
// restart leaves it alone, so restarts never loop; an adult's next message can still prompt another.
export function needsStartupReask(state: OnboardingState): boolean {
  return unconfirmedQuestion(state) !== null && state.lastAsk?.reasked !== true;
}

export function withPhase(state: OnboardingState, phase: Phase, now: Date): OnboardingState {
  return touch({ ...state, phase }, now);
}

export function cancelOnboarding(state: OnboardingState, now: Date): OnboardingState {
  return touch({ ...state, phase: "cancelled", pendingSnapshot: null }, now);
}

function touch(state: OnboardingState, now: Date): OnboardingState {
  return { ...state, updatedAt: now.toISOString() };
}

// ---------------------------------------------------------------------------------------------
// Topics: what is covered and what to do next
// ---------------------------------------------------------------------------------------------

// The first topic nobody has covered, or null when all five are.
export function nextTopic(state: Pick<OnboardingState, "covered">): TopicId | null {
  return TOPICS.find((topic) => state.covered[topic] === undefined) ?? null;
}

export function allTopicsCovered(state: OnboardingState): boolean {
  return nextTopic(state) === null;
}

export function openConflicts(state: OnboardingState): Conflict[] {
  return state.conflicts.filter((conflict) => conflict.status === "open");
}

// What the conversation needs next: a clarification (open conflicts come first), the next
// question, or the proposal.
export type NextStep = { kind: "clarify"; conflict: Conflict } | { kind: "ask"; topic: TopicId } | { kind: "propose" };

export function nextStep(state: OnboardingState): NextStep {
  const conflict = openConflicts(state)[0];
  if (conflict) return { kind: "clarify", conflict };
  const topic = nextTopic(state);
  return topic ? { kind: "ask", topic } : { kind: "propose" };
}

// Messages that are only "skip" cover the topic being asked (and the next, for a second "skip").
// Returns the new state and the messages left for the model to read.
export function applySkips(state: OnboardingState, batch: BatchMessage[], now: Date): { state: OnboardingState; rest: BatchMessage[] } {
  let current = state;
  const rest: BatchMessage[] = [];
  for (const message of batch) {
    const topic = nextTopic(current);
    if (!isSkipMessage(message.text) || topic === null || current.processedMessageIds.includes(message.id)) {
      rest.push(message);
      continue;
    }
    current = {
      ...current,
      covered: { ...current.covered, [topic]: { kind: "skip", messageId: message.id, memberId: message.memberId } },
      processedMessageIds: [...current.processedMessageIds, message.id],
    };
    current = { ...current, currentTopic: nextTopic(current) };
  }
  return { state: current === state ? state : touch(current, now), rest };
}

// ---------------------------------------------------------------------------------------------
// Applying what the model found
// ---------------------------------------------------------------------------------------------

// What one extraction call returns once it has been checked (see brain/onboarding.ts).
export interface Addition {
  messageId: string;
  topic: TopicId;
  wording: string;
  detail: FactDetail;
}

export interface ExtractedConflict {
  topic: TopicId;
  subject: string;
  versions: ConflictVersion[]; // already attributed and quote-checked
}

export interface ExtractionResult {
  additions: Addition[];
  topicsCovered: TopicId[];
  withdrawals: Array<{ factId: string; messageId: string }>;
  conflicts: ExtractedConflict[];
  resolvedConflicts: Array<{ conflictId: string; messageId: string }>;
}

export function emptyExtraction(): ExtractionResult {
  return { additions: [], topicsCovered: [], withdrawals: [], conflicts: [], resolvedConflicts: [] };
}

// What the brain is asked: the state so far and the new messages.
export interface OnboardingExtractRequest {
  state: OnboardingState;
  batch: BatchMessage[];
}

export type OnboardingExtractOutcome = { ok: true; result: ExtractionResult } | { ok: false; problems: string[] };

export interface ApplyResult {
  state: OnboardingState;
  added: Fact[];
  notes: string[]; // things the model claimed that code did not accept, in plain words
  changed: boolean; // true when the proposal could now be different
}

export function activeFacts(state: OnboardingState): Fact[] {
  const gone = new Set(state.withdrawn.map((entry) => entry.factId));
  return state.facts.filter((fact) => !gone.has(fact.id));
}

// Folds one extraction into the state. Rules it enforces, whatever the model said:
//   - every addition cites a message in this batch, and is recorded under that message's author;
//   - nothing is ever removed, except an adult withdrawing their own fact;
//   - a topic counts as covered only when a sourced fact for it exists (or an adult said "skip");
//   - a batch already applied is not applied twice.
export function applyExtraction(state: OnboardingState, batch: BatchMessage[], extraction: ExtractionResult, now: Date): ApplyResult {
  const notes: string[] = [];
  if (batch.length > 0 && batch.every((message) => state.processedMessageIds.includes(message.id))) {
    return { state, added: [], notes: ["Those messages were already read."], changed: false };
  }
  const authors = new Map(batch.map((message) => [message.id, message]));
  let next: OnboardingState = { ...state, facts: [...state.facts], withdrawn: [...state.withdrawn], conflicts: state.conflicts.map((c) => ({ ...c })) };
  let changed = false;

  // Withdrawals: an adult can take back only what they said themselves.
  for (const entry of extraction.withdrawals) {
    const fact = next.facts.find((candidate) => candidate.id === entry.factId);
    const author = authors.get(entry.messageId);
    if (!fact || !author) {
      notes.push(`Ignored a withdrawal of ${entry.factId}: no such fact or message.`);
    } else if (fact.memberId !== author.memberId) {
      notes.push(`Ignored a withdrawal of ${entry.factId}: only ${fact.memberName} can take that back.`);
    } else if (!next.withdrawn.some((w) => w.factId === fact.id)) {
      next.withdrawn.push({ factId: fact.id, messageId: entry.messageId, memberId: author.memberId });
      changed = true;
    }
  }

  // Additions.
  const added: Fact[] = [];
  for (const addition of extraction.additions) {
    const author = authors.get(addition.messageId);
    if (!author) {
      notes.push(`Ignored something I couldn't tie to a message: "${addition.wording}".`);
      continue;
    }
    const duplicate = next.facts.some(
      (fact) => fact.memberId === author.memberId && fact.kind === addition.detail.kind && sameWords(fact.wording, addition.wording) && sameDetail(fact, addition.detail),
    );
    if (duplicate) continue;
    const fact = { ...addition.detail, id: `f${next.nextFactNumber}`, memberId: author.memberId, memberName: author.memberName, messageId: author.id, topic: addition.topic, wording: normalizeSpace(addition.wording) } as Fact;
    next.nextFactNumber += 1;
    next.facts.push(fact);
    added.push(fact);
    changed = true;
  }

  // Conflicts: new ones are added open; an identical open one is not added twice.
  for (const found of extraction.conflicts) {
    const memberIds = new Set(found.versions.map((version) => version.memberId));
    if (memberIds.size < 2) {
      notes.push(`Ignored a conflict about "${found.subject}": it needs two different adults.`);
      continue;
    }
    const same = next.conflicts.some((existing) => existing.status === "open" && existing.topic === found.topic && sameVersions(existing.versions, found.versions));
    if (same) continue;
    next.conflicts.push({ id: `c${next.nextConflictNumber}`, topic: found.topic, subject: oneLine(found.subject), versions: found.versions, status: "open" });
    next.nextConflictNumber += 1;
    changed = true;
  }
  for (const entry of extraction.resolvedConflicts) {
    const conflict = next.conflicts.find((candidate) => candidate.id === entry.conflictId);
    const author = authors.get(entry.messageId);
    if (!conflict || conflict.status !== "open" || !author) {
      notes.push(`Ignored a resolution of ${entry.conflictId}.`);
    } else if (!conflict.versions.some((version) => version.memberId === author.memberId)) {
      notes.push(`Ignored a resolution of ${entry.conflictId}: it must come from one of the adults involved.`);
    } else {
      conflict.status = "resolved";
      conflict.resolvedByMessageId = entry.messageId;
      changed = true;
    }
  }

  next.processedMessageIds = [...next.processedMessageIds, ...batch.map((message) => message.id).filter((id) => !next.processedMessageIds.includes(id))];

  // Coverage. An "answer" topic stays covered only while it has an active sourced fact.
  const covered = { ...next.covered };
  for (const topic of TOPICS) {
    const sources = unique(activeFacts(next).filter((fact) => fact.topic === topic).map((fact) => fact.messageId));
    const existing = covered[topic];
    if (existing?.kind === "skip") continue;
    if (sources.length > 0 && (extraction.topicsCovered.includes(topic) || existing !== undefined)) covered[topic] = { kind: "answer", messageIds: sources };
    else if (existing !== undefined) delete covered[topic]; // its facts were all withdrawn
    if (extraction.topicsCovered.includes(topic) && sources.length === 0) notes.push(`I didn't count "${topic}" as answered: nothing was recorded for it.`);
  }
  next.covered = covered;
  next.currentTopic = nextTopic(next);

  if (changed) {
    next.revision += 1;
    next.pendingSnapshot = null; // anything approved earlier no longer matches
    if (next.phase === "confirming-snapshot") next.phase = "proposed";
  }
  return { state: touch(next, now), added, notes, changed };
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function sameDetail(fact: Fact, detail: FactDetail): boolean {
  const { id, memberId, memberName, messageId, topic, wording, ...own } = fact;
  void id, memberId, memberName, messageId, topic, wording;
  return JSON.stringify(own) === JSON.stringify(detail);
}

function sameVersions(a: ConflictVersion[], b: ConflictVersion[]): boolean {
  const key = (v: ConflictVersion) => `${v.memberId}|${v.factId ?? v.messageId}|${normalizeSpace(v.quote)}`;
  const left = a.map(key).sort().join("\n");
  const right = b.map(key).sort().join("\n");
  return left === right;
}

export function markConflictAsked(state: OnboardingState, conflictId: string, now: Date): OnboardingState {
  const conflicts = state.conflicts.map((conflict) => (conflict.id === conflictId ? { ...conflict, askedAt: now.toISOString() } : conflict));
  return touch({ ...state, conflicts, phase: "clarifying" }, now);
}

// ---------------------------------------------------------------------------------------------
// The proposal: what the facts add up to
// ---------------------------------------------------------------------------------------------

export interface ProposalRule {
  prose: string;
  check: RuleCheck;
  who: string; // the adult who said it
}

export interface ProposalDish {
  name: string;
  protein: string;
  tags: string[];
  pool: "usual" | "also-like";
  ingredients: IngredientLine[]; // carried over from an existing profile; empty for a new dish
}

export interface Proposal {
  rules: ProposalRule[];
  dishes: ProposalDish[];
  dislikes: Array<{ person: string; what: string }>;
  vetoes: string[];
  staples: string[];
  sections: string[]; // empty means "the standard list"
  notes: string[]; // answers with nothing to save, shown but never written
  lockWords: string[];
  thresholds: Thresholds;
  // What came from the code's defaults rather than from the adults, so the read-back can say so.
  defaults: { lockWords: boolean; thresholds: boolean; sections: boolean };
}

export const DEFAULT_LOCK_WORDS: readonly string[] = ["lock it", "lock the week"];

export const DEFAULT_THRESHOLDS: Thresholds = {
  maxUsualDishesPerWeek: 2,
  maxNightsPerProtein: 2,
  repeatWindowWeeks: 3,
  batchingWindowSeconds: 15,
};

// The proposal the facts add up to. With `existing` (a redo), lock words, thresholds and the
// ingredient lines of dishes with the same name are carried over so redoing the rules does not
// reset what the household tuned by hand.
export function computeProposal(state: OnboardingState, existing?: HouseProfile): Proposal {
  const rules: ProposalRule[] = [];
  const dishes: ProposalDish[] = [];
  const dislikes: Proposal["dislikes"] = [];
  const vetoes: string[] = [];
  const staples: string[] = [];
  const sections: string[] = [];
  const notes: string[] = [];

  for (const fact of activeFacts(state)) {
    switch (fact.kind) {
      case "rule": {
        const prose = proseLine(fact.wording);
        if (!rules.some((rule) => sameWords(rule.prose, prose))) rules.push({ prose, check: fact.check, who: fact.memberName });
        break;
      }
      case "dish": {
        const name = oneLine(fact.name);
        const found = dishes.find((dish) => sameWords(dish.name, name));
        if (!found) {
          dishes.push({ name, protein: oneLine(fact.protein).toLowerCase(), tags: unique(fact.tags.map(cleanTag)), pool: fact.pool, ingredients: [] });
        } else {
          found.tags = unique([...found.tags, ...fact.tags.map(cleanTag)]);
          if (fact.pool === "usual") found.pool = "usual";
        }
        break;
      }
      case "dislike": {
        const entry = { person: oneLine(fact.person).replace(/:/g, ""), what: oneLine(fact.what) };
        if (!dislikes.some((d) => sameWords(d.person, entry.person) && sameWords(d.what, entry.what))) dislikes.push(entry);
        break;
      }
      case "veto":
        if (!vetoes.some((v) => sameWords(v, fact.dish))) vetoes.push(oneLine(fact.dish));
        break;
      case "staple":
        if (!staples.some((s) => sameWords(s, fact.item))) staples.push(oneLine(fact.item));
        break;
      case "section":
        if (!sections.some((s) => sameWords(s, fact.name))) sections.push(oneLine(fact.name));
        break;
      case "note":
        notes.push(oneLine(fact.wording));
        break;
    }
  }

  const sectionList = sections.length > 0 ? sections : [...DEFAULT_GROCERY_SECTIONS];
  if (existing) {
    for (const dish of dishes) {
      const old = [...existing.usualDishes, ...existing.alsoLikeDishes].find((candidate) => sameWords(candidate.name, dish.name));
      if (!old) continue;
      // Keep an ingredient line only when its store section is still on the list.
      dish.ingredients = old.ingredients.flatMap((line) => {
        const section = matchGrocerySection(sectionList, line.section);
        return section ? [{ section, text: line.text }] : [];
      });
    }
  }
  return {
    rules,
    dishes,
    dislikes,
    vetoes,
    staples,
    sections,
    notes,
    lockWords: existing ? [...existing.lockWords] : [...DEFAULT_LOCK_WORDS],
    thresholds: existing ? { ...existing.thresholds } : { ...DEFAULT_THRESHOLDS },
    defaults: { lockWords: !existing, thresholds: !existing, sections: sections.length === 0 },
  };
}

// The proposal that matches an existing profile, so a redo's first read-back can say what changed.
export function proposalFromProfile(profile: HouseProfile): Proposal {
  const dish = (pool: ProposalDish["pool"]) => (d: HouseProfile["usualDishes"][number]): ProposalDish => ({ name: d.name, protein: d.protein, tags: [...d.tags], pool, ingredients: [...d.ingredients] });
  return {
    rules: profile.rules.map((rule) => ({ prose: rule.prose, check: rule.check, who: "the old profile" })),
    dishes: [...profile.usualDishes.map(dish("usual")), ...profile.alsoLikeDishes.map(dish("also-like"))],
    dislikes: profile.dislikes.map((d) => ({ person: d.person, what: d.what })),
    vetoes: [...profile.vetoes],
    staples: [...profile.staples],
    sections: profile.grocerySections.join("|") === DEFAULT_GROCERY_SECTIONS.join("|") ? [] : [...profile.grocerySections],
    notes: [],
    lockWords: [...profile.lockWords],
    thresholds: { ...profile.thresholds },
    defaults: { lockWords: false, thresholds: false, sections: false },
  };
}

// Plain-words lines for what differs between two proposals ("what changed since the last version").
export function diffProposals(previous: Proposal | null, next: Proposal): string[] {
  if (previous === null) return [];
  const lines: string[] = [];
  const list = <T>(label: string, before: T[], after: T[], key: (item: T) => string, show: (item: T) => string) => {
    const beforeKeys = new Set(before.map((item) => key(item).toLowerCase()));
    const afterKeys = new Set(after.map((item) => key(item).toLowerCase()));
    for (const item of after) if (!beforeKeys.has(key(item).toLowerCase())) lines.push(`Added ${label}: ${show(item)}`);
    for (const item of before) if (!afterKeys.has(key(item).toLowerCase())) lines.push(`Dropped ${label}: ${show(item)}`);
  };
  list("rule", previous.rules, next.rules, (r) => r.prose, (r) => `"${r.prose}"`);
  for (const rule of next.rules) {
    const old = previous.rules.find((candidate) => sameWords(candidate.prose, rule.prose));
    if (old && JSON.stringify(old.check) !== JSON.stringify(rule.check)) lines.push(`Changed how I check "${rule.prose}"`);
  }
  list("dish", previous.dishes, next.dishes, (d) => d.name, (d) => d.name);
  for (const dish of next.dishes) {
    const old = previous.dishes.find((candidate) => sameWords(candidate.name, dish.name));
    if (old && [...old.tags].sort().join(",") !== [...dish.tags].sort().join(",")) lines.push(`Changed the tags on ${dish.name}`);
  }
  list("dislike", previous.dislikes, next.dislikes, (d) => `${d.person}:${d.what}`, (d) => `${d.person} and ${d.what}`);
  list("veto", previous.vetoes, next.vetoes, (v) => v, (v) => v);
  list("staple", previous.staples, next.staples, (s) => s, (s) => s);
  list("store section", previous.sections, next.sections, (s) => s, (s) => s);
  return lines;
}

// A fingerprint of a proposal's content, for "is this still the same proposal".
export function proposalFingerprint(proposal: Proposal): string {
  return fingerprintText(JSON.stringify(proposal));
}

// ---------------------------------------------------------------------------------------------
// Read-backs, delivery, and approval
// ---------------------------------------------------------------------------------------------

// Records that a read-back for the current revision is going out to these adults.
export interface ShownProfile {
  text: string; // the exact bytes the adults were shown
  baselineFingerprint: string; // the profile file when those bytes were worked out
}

export function recordReadBack(state: OnboardingState, proposal: Proposal, memberIds: string[], chunkCount: number, now: Date, shown: ShownProfile = { text: "", baselineFingerprint: "" }): OnboardingState {
  const deliveries: Record<string, DeliveryStatus> = {};
  for (const id of memberIds) deliveries[id] = "pending";
  const record: ReadBackRecord = { revision: state.revision, chunkCount, sentAt: now.toISOString(), proposal, deliveries, nativeIds: [], text: shown.text, baselineFingerprint: shown.baselineFingerprint, deliveredSeq: null };
  return touch({ ...state, lastReadBack: record, phase: "proposed", pendingSnapshot: null }, now);
}

// Notes how the latest read-back reached one adult. A late report about an older read-back is ignored.
export function recordDelivery(state: OnboardingState, revision: number, memberId: string, status: DeliveryStatus, now: Date): OnboardingState {
  const record = state.lastReadBack;
  if (!record || record.revision !== revision) return state;
  return touch({ ...state, lastReadBack: { ...record, deliveries: { ...record.deliveries, [memberId]: status } } }, now);
}

// Notes the chat app's IDs for the messages the latest read-back became.
export function recordReadBackIds(state: OnboardingState, revision: number, ids: ReadBackRecord["nativeIds"], now: Date): OnboardingState {
  const record = state.lastReadBack;
  if (!record || record.revision !== revision) return state;
  return touch({ ...state, lastReadBack: { ...record, nativeIds: ids } }, now);
}

// Is this message a direct reply to one of the latest read-back's messages, in a chat this adult
// can see? (In an adult's private chat only the copy sent there counts; in the group, any copy.)
// Notes the moment the read-back finished going out, as a local receipt number.
export function recordReadBackDelivered(state: OnboardingState, revision: number, receiptSeq: number, now: Date): OnboardingState {
  const record = state.lastReadBack;
  if (!record || record.revision !== revision) return state;
  return touch({ ...state, lastReadBack: { ...record, deliveredSeq: receiptSeq } }, now);
}

export function repliesToLatestReadBack(state: OnboardingState, memberId: string, replyToNativeId: string | undefined): boolean {
  if (replyToNativeId === undefined || replyToNativeId === "") return false;
  const ids = state.lastReadBack?.nativeIds ?? [];
  return ids.some((entry) => entry.nativeId === replyToNativeId && (entry.memberId === null || entry.memberId === memberId));
}

export function readBackDeliveredTo(state: OnboardingState, memberId: string): boolean {
  return state.lastReadBack?.deliveries[memberId] === "delivered";
}

// Can "looks good" from this adult save straight away? Only when it is a direct reply to the latest
// read-back, that read-back reached them in full, and nothing has changed since it was built.
// Otherwise the bot asks the confirm question first.
export function approvalRoute(
  state: OnboardingState,
  input: { memberId: string; repliesToLatestReadBack: boolean; receiptSeq?: number | null },
): { route: "save" } | { route: "ask-snapshot"; why: string } {
  const record = state.lastReadBack;
  if (!record) return { route: "ask-snapshot", why: "no read-back has been sent yet" };
  if (record.revision !== state.revision) return { route: "ask-snapshot", why: "the rules changed after the last read-back" };
  if (record.text === "") return { route: "ask-snapshot", why: "I don't have the exact text that was shown" };
  if (!readBackDeliveredTo(state, input.memberId)) return { route: "ask-snapshot", why: "the read-back may not have reached them in full" };
  if (!arrivedAfter(input.receiptSeq, record.deliveredSeq)) return { route: "ask-snapshot", why: "it arrived before the read-back had finished going out" };
  if (!input.repliesToLatestReadBack) return { route: "ask-snapshot", why: "it wasn't a reply to the read-back" };
  return { route: "save" };
}

// True only when both numbers are known and the message came in after the shown text was out.
function arrivedAfter(receiptSeq: number | null | undefined, deliveredSeq: number | null): boolean {
  return typeof receiptSeq === "number" && deliveredSeq !== null && receiptSeq > deliveredSeq;
}

export function snapshotSummary(proposal: Proposal): string {
  const checked = proposal.rules.filter((rule) => rule.check.kind !== "advisory").length;
  const parts = [
    `${proposal.rules.length} rule${proposal.rules.length === 1 ? "" : "s"} (${checked} checked)`,
    `${proposal.dishes.length} dish${proposal.dishes.length === 1 ? "" : "es"}`,
  ];
  if (proposal.dislikes.length > 0) parts.push(`${proposal.dislikes.length} dislike${proposal.dislikes.length === 1 ? "" : "s"}`);
  if (proposal.vetoes.length > 0) parts.push(`${proposal.vetoes.length} never-again`);
  if (proposal.staples.length > 0) parts.push(`${proposal.staples.length} staple${proposal.staples.length === 1 ? "" : "s"}`);
  return parts.join(", ");
}

// Asks the confirm question for the current revision. `profileText` is exactly what would be saved.
export function askSnapshot(
  state: OnboardingState,
  proposal: Proposal,
  profileText: string,
  now: Date,
  options: { baselineFingerprint?: string; chunkCount?: number; memberIds?: string[] } = {},
): OnboardingState {
  const deliveries: Record<string, DeliveryStatus> = {};
  for (const id of options.memberIds ?? []) deliveries[id] = "pending";
  const snapshot: PendingSnapshot = {
    revision: state.revision,
    summary: snapshotSummary(proposal),
    proposal,
    text: profileText,
    baselineFingerprint: options.baselineFingerprint ?? "",
    profileFingerprint: fingerprintText(profileText),
    askedAt: now.toISOString(),
    chunkCount: options.chunkCount ?? 1,
    deliveries,
    nativeIds: [],
    deliveredSeq: null,
  };
  return touch({ ...state, pendingSnapshot: snapshot, phase: "confirming-snapshot" }, now);
}

export function recordSnapshotDelivery(state: OnboardingState, revision: number, memberId: string, status: DeliveryStatus, now: Date): OnboardingState {
  const snapshot = state.pendingSnapshot;
  if (!snapshot || snapshot.revision !== revision) return state;
  return touch({ ...state, pendingSnapshot: { ...snapshot, deliveries: { ...snapshot.deliveries, [memberId]: status } } }, now);
}

export function recordSnapshotDelivered(state: OnboardingState, revision: number, ids: ReadBackRecord["nativeIds"], receiptSeq: number, now: Date): OnboardingState {
  const snapshot = state.pendingSnapshot;
  if (!snapshot || snapshot.revision !== revision) return state;
  return touch({ ...state, pendingSnapshot: { ...snapshot, nativeIds: ids, deliveredSeq: receiptSeq } }, now);
}

// Can this adult's "save it" approve the pending snapshot? Only if the snapshot is for the current
// rules, every chunk of it reached that adult, and their message came in after it finished going out.
export function snapshotApproval(state: OnboardingState, input: { memberId: string; receiptSeq?: number | null }): { ok: true } | { ok: false; why: string } {
  const snapshot = state.pendingSnapshot;
  if (state.phase !== "confirming-snapshot" || snapshot === null) return { ok: false, why: "no confirm question is open" };
  if (snapshot.revision !== state.revision) return { ok: false, why: "the rules changed after the confirm question" };
  if (snapshot.text === "") return { ok: false, why: "I don't have the exact text that was shown" };
  if (snapshot.deliveries[input.memberId] !== "delivered") return { ok: false, why: "the confirm question may not have reached them in full" };
  if (!arrivedAfter(input.receiptSeq, snapshot.deliveredSeq)) return { ok: false, why: "it arrived before the confirm question had finished going out" };
  return { ok: true };
}

export function snapshotStillValid(state: OnboardingState, profileText: string): boolean {
  const snapshot = state.pendingSnapshot;
  return snapshot !== null && snapshot.revision === state.revision && snapshot.profileFingerprint === fingerprintText(profileText);
}

// ---------------------------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------------------------

// A dry run keeps its own file, so it can never consume the real welcome or the real interview.
export function onboardingStatePath(stateDir: string, dryRun: boolean): string {
  return join(stateDir, dryRun ? "onboarding.dry-run.json" : "onboarding.json");
}

export type LoadedOnboarding = { kind: "missing" } | { kind: "ok"; state: OnboardingState } | { kind: "corrupt"; message: string };

export function loadOnboardingState(path: string): LoadedOnboarding {
  if (!existsSync(path)) return { kind: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { kind: "corrupt", message: `The interview file ${path} can't be read: ${(error as Error).message}` };
  }
  const problem = stateProblem(parsed);
  if (problem) return { kind: "corrupt", message: `The interview file ${path} is not usable: ${problem}` };
  return { kind: "ok", state: parsed as OnboardingState };
}

// The write number the next save should carry: one more than what is on disk (or than the state
// in hand, if that is already ahead).
export function nextStateSeq(path: string, state?: OnboardingState): number {
  const loaded = loadOnboardingState(path);
  const onDisk = loaded.kind === "ok" ? loaded.state.stateSeq ?? 0 : 0;
  return Math.max(onDisk, state?.stateSeq ?? 0) + 1;
}

// Writes the state only if it is newer than the file. Returns false (and writes nothing) for an
// old state, such as one a replayed turn carries.
export function saveIfNewer(path: string, state: OnboardingState): boolean {
  const loaded = loadOnboardingState(path);
  if (loaded.kind === "ok" && (loaded.state.stateSeq ?? 0) >= state.stateSeq) return false;
  saveOnboardingState(path, state);
  return true;
}

export function saveOnboardingState(path: string, state: OnboardingState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomically(path, JSON.stringify(state, null, 2) + "\n");
}

// A light shape check: enough to refuse a file from a newer version or a damaged one.
function stateProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "it is not an object";
  const s = value as Record<string, unknown>;
  if (s.schemaVersion !== ONBOARDING_SCHEMA_VERSION) return `its version is ${String(s.schemaVersion)}, and this program reads version ${ONBOARDING_SCHEMA_VERSION}`;
  if (!(PHASES as readonly unknown[]).includes(s.phase)) return `the phase "${String(s.phase)}" is unknown`;
  if (s.mode !== "first-run" && s.mode !== "redo") return `the mode "${String(s.mode)}" is unknown`;
  for (const key of ["facts", "withdrawn", "conflicts", "processedMessageIds"]) {
    if (!Array.isArray(s[key])) return `"${key}" is missing`;
  }
  if (typeof s.revision !== "number" || typeof s.nextFactNumber !== "number" || typeof s.nextConflictNumber !== "number") return "a counter is missing";
  if (typeof s.covered !== "object" || s.covered === null) return `"covered" is missing`;
  if (typeof s.originalFingerprint !== "string") return `"originalFingerprint" is missing`;
  if (s.stateSeq !== undefined && typeof s.stateSeq !== "number") return `"stateSeq" is not a number`;
  for (const fact of s.facts as unknown[]) {
    const f = fact as Record<string, unknown>;
    if (typeof f?.id !== "string" || !(FACT_KINDS as readonly unknown[]).includes(f.kind) || !(TOPICS as readonly unknown[]).includes(f.topic)) return "a fact is damaged";
  }
  return null;
}
