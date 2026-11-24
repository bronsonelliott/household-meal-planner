import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeFacts,
  allTopicsCovered,
  applyExtraction,
  applySkips,
  approvalRoute,
  askSnapshot,
  cancelOnboarding,
  computeProposal,
  diffProposals,
  isSkipMessage,
  loadOnboardingState,
  nextStateSeq,
  saveIfNewer,
  nextStep,
  onboardingStatePath,
  proposalFromProfile,
  recordDelivery,
  recordReadBack,
  recordReadBackDelivered,
  recordSnapshotDelivered,
  recordSnapshotDelivery,
  snapshotApproval,
  saveOnboardingState,
  snapshotStillValid,
  startAsking,
  TOPICS,
} from "../src/onboarding/state.ts";
import { parseProfile } from "../src/data/profile.ts";
import { renderProfile } from "../src/onboarding/render.ts";
import { NOW, add, applied, extraction, freshState, msg } from "./fixtures/onboarding-fixtures.ts";

const FRIDAY_OUT = { kind: "rule", check: { kind: "fixed", night: "friday", value: "out" } } as const;

describe("applying an extraction", () => {
  test("a fact is recorded under the author of the cited message, with their exact words", () => {
    const m = msg("m1", "Sam", "Friday is eating out. Also no mushrooms for me.");
    const result = applyExtraction(freshState(), [m], extraction({ additions: [add(m, "nights", "Friday is eating out.", FRIDAY_OUT)] }), NOW);
    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatchObject({ id: "f1", memberId: "sam", memberName: "Sam", messageId: "m1", wording: "Friday is eating out." });
    expect(result.state.revision).toBe(1);
  });

  test("an addition citing a message outside the batch is ignored", () => {
    const m = msg("m1", "Sam", "hello");
    const stray = msg("zzz", "Alex", "Friday out");
    const result = applyExtraction(freshState(), [m], extraction({ additions: [add(stray, "nights", "Friday out", FRIDAY_OUT)] }), NOW);
    expect(result.added).toHaveLength(0);
    expect(result.changed).toBe(false);
    expect(result.notes.join(" ")).toContain("couldn't tie");
  });

  test("facts are only added: a later batch never removes anyone's fact", () => {
    const m1 = msg("m1", "Alex", "Friday is eating out.");
    const s1 = applied(freshState(), [m1], extraction({ additions: [add(m1, "nights", "Friday is eating out.", FRIDAY_OUT)] }));
    const m2 = msg("m2", "Sam", "We love tacos");
    const s2 = applied(s1, [m2], extraction({ additions: [add(m2, "dinners", "tacos", { kind: "dish", name: "Tacos", protein: "chicken", tags: [], pool: "usual" })] }));
    expect(s2.facts.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(s2.facts[0]).toEqual(s1.facts[0]!);
  });

  test("an adult can withdraw their own fact but not the other adult's", () => {
    const m1 = msg("m1", "Alex", "Friday is eating out.");
    const s1 = applied(freshState(), [m1], extraction({ additions: [add(m1, "nights", "Friday is eating out.", FRIDAY_OUT)] }));
    const bySam = msg("m2", "Sam", "scrap Alex's Friday thing");
    const refused = applyExtraction(s1, [bySam], extraction({ withdrawals: [{ factId: "f1", messageId: "m2" }] }), NOW);
    expect(activeFacts(refused.state)).toHaveLength(1);
    expect(refused.notes.join(" ")).toContain("only Alex can take that back");
    const byAlex = msg("m3", "Alex", "actually scrap the Friday thing");
    const done = applyExtraction(s1, [byAlex], extraction({ withdrawals: [{ factId: "f1", messageId: "m3" }] }), NOW);
    expect(activeFacts(done.state)).toHaveLength(0);
    expect(done.state.facts).toHaveLength(1); // still on record
    expect(done.state.revision).toBe(2);
  });

  test("a topic is covered only when a sourced fact exists for it", () => {
    const m = msg("m1", "Alex", "We are easy.");
    const claimed = applyExtraction(freshState(), [m], extraction({ topicsCovered: ["wont-eat"] }), NOW);
    expect(claimed.state.covered["wont-eat"]).toBeUndefined();
    expect(claimed.notes.join(" ")).toContain("nothing was recorded");

    const withNote = applied(freshState(), [m], extraction({ additions: [add(m, "wont-eat", "We are easy.", { kind: "note" })], topicsCovered: ["wont-eat"] }));
    expect(withNote.covered["wont-eat"]).toEqual({ kind: "answer", messageIds: ["m1"] });
  });

  test("facts without the model claiming the topic do not cover it", () => {
    const m = msg("m1", "Alex", "Friday is eating out.");
    const s = applied(freshState(), [m], extraction({ additions: [add(m, "nights", "Friday is eating out.", FRIDAY_OUT)] }));
    expect(s.covered.nights).toBeUndefined();
  });

  test("withdrawing the only fact uncovers an answered topic", () => {
    const m1 = msg("m1", "Alex", "Friday is eating out.");
    const s1 = applied(freshState(), [m1], extraction({ additions: [add(m1, "nights", "Friday is eating out.", FRIDAY_OUT)], topicsCovered: ["nights"] }));
    expect(s1.covered.nights).toBeDefined();
    const m2 = msg("m2", "Alex", "never mind that");
    const s2 = applied(s1, [m2], extraction({ withdrawals: [{ factId: "f1", messageId: "m2" }] }));
    expect(s2.covered.nights).toBeUndefined();
  });

  test("a batch that was already applied changes nothing", () => {
    const m = msg("m1", "Alex", "Friday is eating out.");
    const result = extraction({ additions: [add(m, "nights", "Friday is eating out.", FRIDAY_OUT)] });
    const once = applied(freshState(), [m], result);
    const twice = applyExtraction(once, [m], result, NOW);
    expect(twice.changed).toBe(false);
    expect(twice.state.facts).toHaveLength(1);
  });

  test("the same fact from the same adult is not added twice", () => {
    const m1 = msg("m1", "Alex", "Friday is eating out.");
    const m2 = msg("m2", "Alex", "Friday is eating out.");
    const a = add(m1, "nights", "Friday is eating out.", FRIDAY_OUT);
    const s1 = applied(freshState(), [m1], extraction({ additions: [a] }));
    const s2 = applied(s1, [m2], extraction({ additions: [{ ...a, messageId: "m2" }] }));
    expect(s2.facts).toHaveLength(1);
  });

  test("a change clears a pending snapshot and drops confirming-snapshot back to proposed", () => {
    const m1 = msg("m1", "Alex", "Friday is eating out.");
    let s = applied(freshState(), [m1], extraction({ additions: [add(m1, "nights", "Friday is eating out.", FRIDAY_OUT)] }));
    const proposal = computeProposal(s);
    s = askSnapshot(s, proposal, renderProfile(proposal), NOW);
    expect(s.phase).toBe("confirming-snapshot");
    const m2 = msg("m2", "Sam", "add pizza");
    s = applied(s, [m2], extraction({ additions: [add(m2, "dinners", "pizza", { kind: "dish", name: "Pizza", protein: "vegetarian", tags: [], pool: "usual" })] }));
    expect(s.pendingSnapshot).toBeNull();
    expect(s.phase).toBe("proposed");
  });
});

describe("skips and topic order", () => {
  test("only a whole-message skip counts", () => {
    expect(isSkipMessage("skip")).toBe(true);
    expect(isSkipMessage(" Skip. ")).toBe(true);
    expect(isSkipMessage("skip the fish rule")).toBe(false);
  });

  test("a skip covers the question being asked and is not sent to the model", () => {
    let s = startAsking(freshState(), NOW);
    expect(s.currentTopic).toBe("nights");
    const { state, rest } = applySkips(s, [msg("m1", "Sam", "skip"), msg("m2", "Alex", "we like tacos")], NOW);
    expect(state.covered.nights).toEqual({ kind: "skip", messageId: "m1", memberId: "sam" });
    expect(state.currentTopic).toBe("habits");
    expect(rest.map((m) => m.id)).toEqual(["m2"]);
  });

  test("nextStep goes ask, then propose; an open conflict comes first", () => {
    let s = startAsking(freshState(), NOW);
    expect(nextStep(s)).toEqual({ kind: "ask", topic: "nights" });
    for (const [i, topic] of TOPICS.entries()) s = applySkips({ ...s, currentTopic: topic }, [msg(`s${i}`, "Alex", "skip")], NOW).state;
    expect(allTopicsCovered(s)).toBe(true);
    expect(nextStep(s)).toEqual({ kind: "propose" });

    const a = msg("m1", "Alex", "Friday is eating out.");
    const b = msg("m2", "Sam", "Friday we cook at home.");
    s = applied(s, [a, b], extraction({ conflicts: [{ topic: "nights", subject: "Friday dinner", versions: [{ memberId: "alex", memberName: "Alex", messageId: "m1", quote: "Friday is eating out." }, { memberId: "sam", memberName: "Sam", messageId: "m2", quote: "Friday we cook at home." }] }] }));
    expect(nextStep(s).kind).toBe("clarify");
  });
});

describe("conflicts", () => {
  const versions = [
    { memberId: "alex", memberName: "Alex", messageId: "m1", quote: "Friday is eating out." },
    { memberId: "sam", memberName: "Sam", messageId: "m2", quote: "Friday we cook at home." },
  ];
  const found = { topic: "nights" as const, subject: "Friday dinner", versions };

  test("a conflict needs two different adults, and an identical one is not repeated", () => {
    const m = msg("m1", "Alex", "x");
    expect(applyExtraction(freshState(), [m], extraction({ conflicts: [{ ...found, versions: [versions[0]!, versions[0]!] }] }), NOW).state.conflicts).toHaveLength(0);
    const s1 = applied(freshState(), [m], extraction({ conflicts: [found] }));
    const m3 = msg("m3", "Sam", "y");
    const s2 = applied(s1, [m3], extraction({ conflicts: [found] }));
    expect(s2.conflicts).toHaveLength(1);
  });

  test("only one of the adults involved can resolve it", () => {
    const m = msg("m1", "Alex", "x");
    const s1 = applied(freshState(), [m], extraction({ conflicts: [found] }));
    const stranger = { id: "m9", memberId: "kim", memberName: "Kim", text: "fine" };
    expect(applyExtraction(s1, [stranger], extraction({ resolvedConflicts: [{ conflictId: "c1", messageId: "m9" }] }), NOW).state.conflicts[0]!.status).toBe("open");
    const sam = msg("m10", "Sam", "ok, out it is");
    expect(applyExtraction(s1, [sam], extraction({ resolvedConflicts: [{ conflictId: "c1", messageId: "m10" }] }), NOW).state.conflicts[0]!.status).toBe("resolved");
  });
});

describe("the proposal", () => {
  function twoAdultState() {
    const a = msg("m1", "Alex", "Friday is eating out. Chicken tacos are quick.");
    const b = msg("m2", "Sam", "No mushrooms for me. Never tuna casserole.");
    return applied(freshState(), [a, b], extraction({
      additions: [
        add(a, "nights", "Friday is eating out.", FRIDAY_OUT),
        add(a, "dinners", "Chicken tacos", { kind: "dish", name: "Chicken tacos", protein: "chicken", tags: ["mexican", "quick"], pool: "usual" }),
        add(b, "wont-eat", "No mushrooms for me.", { kind: "dislike", person: "Sam", what: "mushrooms" }),
        add(b, "wont-eat", "Never tuna casserole.", { kind: "veto", dish: "Tuna casserole" }),
      ],
    }));
  }

  test("it keeps the adult's wording and uses defaults for the rest", () => {
    const proposal = computeProposal(twoAdultState());
    expect(proposal.rules).toEqual([{ prose: "Friday is eating out.", check: { kind: "fixed", night: "friday", value: "out" }, who: "Alex" }]);
    expect(proposal.dishes[0]).toMatchObject({ name: "Chicken tacos", protein: "chicken", pool: "usual" });
    expect(proposal.dislikes).toEqual([{ person: "Sam", what: "mushrooms" }]);
    expect(proposal.vetoes).toEqual(["Tuna casserole"]);
    expect(proposal.defaults).toEqual({ lockWords: true, thresholds: true, sections: true });
    expect(proposal.lockWords).toEqual(["lock it", "lock the week"]);
  });

  test("a withdrawn fact leaves the proposal but stays on record", () => {
    const s = twoAdultState();
    const m = msg("m5", "Alex", "forget Friday");
    const after = applied(s, [m], extraction({ withdrawals: [{ factId: "f1", messageId: "m5" }] }));
    expect(computeProposal(after).rules).toEqual([]);
    expect(after.facts[0]!.id).toBe("f1");
  });

  test("the same dish from two adults merges its tags", () => {
    const a = msg("m1", "Alex", "tacos");
    const b = msg("m2", "Sam", "tacos are kid-friendly");
    const s = applied(freshState(), [a, b], extraction({
      additions: [
        add(a, "dinners", "tacos", { kind: "dish", name: "Tacos", protein: "beef", tags: ["quick"], pool: "usual" }),
        add(b, "dinners", "tacos are kid-friendly", { kind: "dish", name: "tacos", protein: "beef", tags: ["kid-friendly"], pool: "usual" }),
      ],
    }));
    const proposal = computeProposal(s);
    expect(proposal.dishes).toHaveLength(1);
    expect(proposal.dishes[0]!.tags).toEqual(["quick", "kid-friendly"]);
  });

  test("a redo carries over thresholds, lock words and ingredient lines for dishes with the same name", () => {
    const existing = parseProfile(renderProfile({
      ...computeProposal(twoAdultState()),
      lockWords: ["done"],
      thresholds: { maxUsualDishesPerWeek: 4, maxNightsPerProtein: 3, repeatWindowWeeks: 2, batchingWindowSeconds: 20 },
      dishes: [{ name: "Chicken tacos", protein: "chicken", tags: [], pool: "usual", ingredients: [{ section: "Meat & Fish", text: "thighs" }, { section: "Spices", text: "cumin" }, { section: "Produce", text: "limes" }] }],
      sections: ["Meat & Fish", "Spices", "Produce"],
    }));
    const proposal = computeProposal(twoAdultState(), existing);
    expect(proposal.lockWords).toEqual(["done"]);
    expect(proposal.thresholds.maxUsualDishesPerWeek).toBe(4);
    expect(proposal.defaults.thresholds).toBe(false);
    // "Produce" is not on the new (standard) store list, so that line is dropped rather than breaking the file.
    expect(proposal.dishes[0]!.ingredients.map((i) => i.text)).toEqual(["thighs", "cumin"]);
  });

  test("diffProposals says what was added and dropped, and says nothing for a first version", () => {
    const s = twoAdultState();
    const before = computeProposal(s);
    expect(diffProposals(null, before)).toEqual([]);
    const m = msg("m5", "Sam", "add pasta, and we never want tuna casserole off the list");
    const after = computeProposal(applied(s, [m], extraction({
      additions: [add(m, "dinners", "add pasta", { kind: "dish", name: "Pasta", protein: "vegetarian", tags: [], pool: "usual" })],
      withdrawals: [],
    })));
    expect(diffProposals(before, after)).toEqual(["Added dish: Pasta"]);
    expect(diffProposals(after, before)).toEqual(["Dropped dish: Pasta"]);
  });

  test("proposalFromProfile lets a redo's first read-back show changes against the old profile", () => {
    const old = parseProfile(renderProfile(computeProposal(twoAdultState())));
    const diff = diffProposals(proposalFromProfile(old), { ...computeProposal(twoAdultState()), vetoes: [] });
    expect(diff).toEqual(["Dropped veto: Tuna casserole"]);
  });
});

describe("the state file never goes backwards", () => {
  test("a state no newer than the file is not written, so a replayed old turn cannot undo a newer one", () => {
    const path = join(mkdtempSync(join(tmpdir(), "onboarding-seq-")), "onboarding.json");
    const first = { ...freshState(), stateSeq: nextStateSeq(path) };
    expect(saveIfNewer(path, first)).toBe(true);
    const newer = { ...first, revision: 5, stateSeq: nextStateSeq(path, first) };
    expect(saveIfNewer(path, newer)).toBe(true);
    expect(saveIfNewer(path, first)).toBe(false); // the replay
    expect(saveIfNewer(path, newer)).toBe(false); // the same write again changes nothing
    const loaded = loadOnboardingState(path);
    expect(loaded.kind === "ok" && loaded.state.revision).toBe(5);
  });
});

describe("read-backs and approval", () => {
  function proposedState() {
    const m = msg("m1", "Alex", "Friday is eating out.");
    let s = applied(freshState(), [m], extraction({ additions: [add(m, "nights", "Friday is eating out.", FRIDAY_OUT)] }));
    s = recordReadBack(s, computeProposal(s), ["alex", "sam"], 2, NOW, { text: "shown bytes", baselineFingerprint: "none" });
    return recordReadBackDelivered(s, s.revision, 10, NOW);
  }

  test("a direct reply to a fully delivered, unchanged read-back saves straight away", () => {
    let s = proposedState();
    s = recordDelivery(s, s.revision, "alex", "delivered", NOW);
    expect(approvalRoute(s, { memberId: "alex", repliesToLatestReadBack: true, receiptSeq: 11 })).toEqual({ route: "save" });
  });

  test("each missing condition sends the adult to the confirm question", () => {
    let s = proposedState();
    const ask = (memberId: string, repliesToLatestReadBack: boolean, receiptSeq: number | null = 11) => approvalRoute(s, { memberId, repliesToLatestReadBack, receiptSeq }).route;
    expect(ask("alex", true)).toBe("ask-snapshot"); // not delivered
    s = recordDelivery(s, s.revision, "alex", "queued", NOW);
    expect(ask("alex", true)).toBe("ask-snapshot"); // queued is not delivered
    s = recordDelivery(s, s.revision, "alex", "delivered", NOW);
    expect(ask("alex", false)).toBe("ask-snapshot"); // not a reply
    expect(ask("sam", true)).toBe("ask-snapshot"); // Sam got nothing
    expect(ask("alex", true, 10)).toBe("ask-snapshot"); // arrived before the read-back finished going out
    expect(ask("alex", true, 3)).toBe("ask-snapshot");
    expect(ask("alex", true, null)).toBe("ask-snapshot"); // no receipt number: cannot tell
    expect(ask("alex", true, 11)).toBe("save");
    const m = msg("m2", "Sam", "add pizza");
    const changed = applied(s, [m], extraction({ additions: [add(m, "dinners", "add pizza", { kind: "dish", name: "Pizza", protein: "vegetarian", tags: [], pool: "usual" })] }));
    expect(approvalRoute(changed, { memberId: "alex", repliesToLatestReadBack: true, receiptSeq: 11 })).toMatchObject({ route: "ask-snapshot", why: expect.stringContaining("changed") });
  });

  test("the confirm question approves only for an adult who got every part of it, after it went out", () => {
    const s0 = proposedState();
    const proposal = computeProposal(s0);
    let s = askSnapshot(s0, proposal, "bytes", NOW, { baselineFingerprint: "none", chunkCount: 2, memberIds: ["alex", "sam"] });
    const may = (memberId: string, receiptSeq: number | null) => snapshotApproval(s, { memberId, receiptSeq }).ok;
    expect(may("alex", 50)).toBe(false); // nothing delivered yet
    s = recordSnapshotDelivery(s, s.revision, "alex", "delivered", NOW);
    s = recordSnapshotDelivery(s, s.revision, "sam", "partial", NOW);
    s = recordSnapshotDelivered(s, s.revision, [], 40, NOW);
    expect(may("alex", 41)).toBe(true);
    expect(may("alex", 40)).toBe(false); // it was already there when the question finished going out
    expect(may("alex", null)).toBe(false);
    expect(may("sam", 41)).toBe(false); // Sam may have missed a chunk
  });

  test("a late delivery report about an older read-back is ignored", () => {
    const s = proposedState();
    expect(recordDelivery(s, s.revision - 1, "alex", "delivered", NOW)).toBe(s);
  });

  test("the confirm question approves the snapshot only while nothing has changed", () => {
    const s = proposedState();
    const proposal = computeProposal(s);
    const text = renderProfile(proposal);
    const asked = askSnapshot(s, proposal, text, NOW);
    expect(snapshotStillValid(asked, text)).toBe(true);
    expect(snapshotStillValid(asked, text + "x")).toBe(false);
    expect(snapshotStillValid({ ...asked, revision: asked.revision + 1 }, text)).toBe(false);
  });

  test("cancel keeps the facts and clears the snapshot", () => {
    const s = cancelOnboarding(askSnapshot(proposedState(), computeProposal(proposedState()), "x", NOW), NOW);
    expect(s.phase).toBe("cancelled");
    expect(s.pendingSnapshot).toBeNull();
    expect(s.facts).toHaveLength(1);
  });
});

describe("the state file", () => {
  test("a dry run uses its own file name", () => {
    expect(onboardingStatePath("/x/state", false)).toBe("/x/state/onboarding.json");
    expect(onboardingStatePath("/x/state", true)).toBe("/x/state/onboarding.dry-run.json");
  });

  test("it round-trips, and missing and damaged files are told apart", () => {
    const dir = mkdtempSync(join(tmpdir(), "onboarding-state-"));
    const path = join(dir, "state", "onboarding.json");
    expect(loadOnboardingState(path)).toEqual({ kind: "missing" });
    const state = startAsking(freshState("redo"), NOW);
    saveOnboardingState(path, state);
    expect(loadOnboardingState(path)).toEqual({ kind: "ok", state });

    writeFileSync(path, "{not json");
    expect(loadOnboardingState(path).kind).toBe("corrupt");
    writeFileSync(path, JSON.stringify({ ...state, schemaVersion: 99 }));
    const newer = loadOnboardingState(path);
    expect(newer.kind).toBe("corrupt");
    expect(newer.kind === "corrupt" && newer.message).toContain("version is 99");
    writeFileSync(path, JSON.stringify({ ...state, phase: "dancing" }));
    expect(loadOnboardingState(path).kind).toBe("corrupt");
  });
});
