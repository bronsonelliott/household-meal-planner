// Small checks on the pieces the worker uses to run the interview: how a send's outcome becomes
// "did the read-back reach each adult, and under what message IDs", and when the bot counts as
// "awaiting a profile".

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendOutcome } from "../src/messaging/types.ts";
import { awaitingProfile, onboardingStateProblem } from "../src/onboarding/awaiting.ts";
import { newOnboardingState, onboardingStatePath, saveOnboardingState, repliesToLatestReadBack, recordReadBack, recordReadBackIds, type Proposal } from "../src/onboarding/state.ts";
import { summarizeSends } from "../src/week/interview.ts";
import { NOW, freshState } from "./fixtures/onboarding-fixtures.ts";

const MEMBERS = ["alex", "sam"];

describe("summarizeSends", () => {
  test("a group send that went out cleanly: delivered to both, with the group's message IDs", () => {
    const outcome: SendOutcome = { kind: "sent", timestamp: 1, recipients: [{ memberId: null, kind: "sent", parts: [{ part: 1, kind: "sent", nativeId: "g1" }] }] };
    expect(summarizeSends([outcome], MEMBERS)).toEqual({ ids: [{ memberId: null, nativeId: "g1" }], deliveries: { alex: "delivered", sam: "delivered" } });
  });

  test("private chats: each adult's own result, and a message held for one is queued, not delivered", () => {
    const outcome: SendOutcome = {
      kind: "partial",
      timestamp: 1,
      failedMembers: [{ member: "sam", type: "QUEUED" }],
      queued: true,
      recipients: [
        { memberId: "alex", kind: "sent", parts: [{ part: 1, kind: "sent", nativeId: "a1" }] },
        { memberId: "sam", kind: "failed", queued: true, parts: [{ part: 1, kind: "failed", queued: true }] },
      ],
    };
    expect(summarizeSends([outcome], MEMBERS)).toEqual({ ids: [{ memberId: "alex", nativeId: "a1" }], deliveries: { alex: "delivered", sam: "queued" } });
  });

  test("a read-back in several messages is delivered only if every message was", () => {
    const sent: SendOutcome = { kind: "sent", timestamp: 1, recipients: [{ memberId: null, kind: "sent", parts: [] }] };
    const held: SendOutcome = { kind: "failed", detail: "held", queued: true, recipients: [{ memberId: null, kind: "failed", queued: true, parts: [] }] };
    const failed: SendOutcome = { kind: "failed", detail: "no", recipients: [{ memberId: null, kind: "failed", parts: [] }] };
    expect(summarizeSends([sent, held], MEMBERS).deliveries).toEqual({ alex: "queued", sam: "queued" });
    expect(summarizeSends([sent, failed], MEMBERS).deliveries).toEqual({ alex: "partial", sam: "partial" });
    expect(summarizeSends([failed, failed], MEMBERS).deliveries).toEqual({ alex: "failed", sam: "failed" });
  });

  test("an outcome with no per-recipient detail applies to everyone; unknown is not enough to save on", () => {
    expect(summarizeSends([{ kind: "unknown", detail: "no answer" }], MEMBERS).deliveries).toEqual({ alex: "partial", sam: "partial" });
    expect(summarizeSends([{ kind: "sent", timestamp: 1, nativeId: "x" }], MEMBERS)).toEqual({ ids: [{ memberId: null, nativeId: "x" }], deliveries: { alex: "delivered", sam: "delivered" } });
  });

  test("an adult nobody reported on counts as not reached", () => {
    const outcome: SendOutcome = { kind: "sent", timestamp: 1, recipients: [{ memberId: "alex", kind: "sent", parts: [] }] };
    expect(summarizeSends([outcome], MEMBERS).deliveries).toEqual({ alex: "delivered", sam: "failed" });
  });
});

describe("a reply to the read-back", () => {
  const proposal = { rules: [], dishes: [], dislikes: [], vetoes: [], staples: [], sections: [], notes: [], lockWords: [], thresholds: { maxUsualDishesPerWeek: 2, maxNightsPerProtein: 2, repeatWindowWeeks: 3, batchingWindowSeconds: 15 }, defaults: { lockWords: true, thresholds: true, sections: true } } satisfies Proposal;

  test("it counts only for an ID the latest read-back got, in a chat that adult can see", () => {
    let state = recordReadBack(freshState(), proposal, MEMBERS, 1, NOW);
    state = recordReadBackIds(state, state.revision, [{ memberId: null, nativeId: "g1" }, { memberId: "sam", nativeId: "s1" }], NOW);
    expect(repliesToLatestReadBack(state, "alex", "g1")).toBe(true);
    expect(repliesToLatestReadBack(state, "sam", "s1")).toBe(true);
    expect(repliesToLatestReadBack(state, "alex", "s1")).toBe(false); // that is Sam's private copy
    expect(repliesToLatestReadBack(state, "alex", "other")).toBe(false);
    expect(repliesToLatestReadBack(state, "alex", undefined)).toBe(false);
    expect(repliesToLatestReadBack(freshState(), "alex", "g1")).toBe(false);
  });
});

describe("awaiting a profile", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function folders() {
    const dir = mkdtempSync(join(tmpdir(), "awaiting-"));
    dirs.push(dir);
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    return { stateDir, profilePath: join(dir, "profile.md") };
  }

  test("only while there is no profile and a first-run interview's state file says it is in progress (or cancelled)", () => {
    const { stateDir, profilePath } = folders();
    const input = { stateDir, profilePath, dryRun: false };
    expect(awaitingProfile(input)).toBe(false); // nothing behind the missing profile

    saveOnboardingState(onboardingStatePath(stateDir, false), newOnboardingState("first-run", "none", NOW));
    expect(awaitingProfile(input)).toBe(true);
    writeFileSync(profilePath, "   \n");
    expect(awaitingProfile(input)).toBe(true); // whitespace is the same as nothing

    saveOnboardingState(onboardingStatePath(stateDir, false), { ...newOnboardingState("first-run", "none", NOW), phase: "cancelled" });
    expect(awaitingProfile(input)).toBe(true);
    saveOnboardingState(onboardingStatePath(stateDir, false), { ...newOnboardingState("first-run", "none", NOW), phase: "done" });
    expect(awaitingProfile(input)).toBe(false);
    saveOnboardingState(onboardingStatePath(stateDir, false), newOnboardingState("redo", "x", NOW));
    expect(awaitingProfile(input)).toBe(false); // a redo has a profile to draft from
  });

  test("a practice run that finished is still waiting for a real profile; a damaged file is not 'in progress'", () => {
    const { stateDir, profilePath } = folders();
    saveOnboardingState(onboardingStatePath(stateDir, true), { ...newOnboardingState("first-run", "none", NOW), phase: "done" });
    expect(awaitingProfile({ stateDir, profilePath, dryRun: true })).toBe(true);

    writeFileSync(onboardingStatePath(stateDir, false), "{ broken");
    expect(awaitingProfile({ stateDir, profilePath, dryRun: false })).toBe(false);
    expect(onboardingStateProblem(stateDir, false)).toContain("can't be read");
    expect(onboardingStateProblem(stateDir, true)).toBeNull();
  });
});
