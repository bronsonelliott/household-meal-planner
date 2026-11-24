// The house-rules interview, from a fresh install to a saved profile and the next scheduled draft,
// on the real worker, messenger, failure policy and scheduler, with only the chat app (the
// FakeAdapter) and the model's readings faked. test/interview-telegram.test.ts runs the same story
// through the Telegram adapter; test/interview-recovery.test.ts covers restarts and failures.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProfile } from "../src/data/profile.ts";
import { TOPIC_QUESTIONS } from "../src/onboarding/questions.ts";
import { loadWeek } from "../src/week/state.ts";
import { draftAnswer } from "./fixtures/ops-harness.ts";
import { InterviewHarness } from "./fixtures/interview-harness.ts";
import { alexNightsAndHabits, dinners, reachProposal, reading, start } from "./fixtures/interview-scenarios.ts";
import { FRIDAY_4PM } from "./fixtures/worker-harness.ts";
import { add } from "./fixtures/onboarding-fixtures.ts";

const harnesses: InterviewHarness[] = [];
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.stop();
});
const freshHousehold = (options: ConstructorParameters<typeof InterviewHarness>[0] = {}) => start(options, harnesses);

describe("the first-run interview, end to end", () => {
  test("the welcome is posted once, with the first question", async () => {
    const h = await freshHousehold();
    expect(h.texts).toHaveLength(1);
    expect(h.texts[0]).toContain("I'm Dinner Bot");
    expect(h.texts[0]).toContain("Alex and Sam");
    expect(h.texts[0]).toContain("Nothing is saved until");
    expect(h.texts[0]).toContain(TOPIC_QUESTIONS.nights);
    expect(h.state?.phase).toBe("asking");
    expect(h.state?.mode).toBe("first-run");
    expect(existsSync(h.profilePath)).toBe(false);
  });

  test("a multi-topic answer skips a question; skips cover the rest; the proposal is read back", async () => {
    const h = await freshHousehold();
    h.reads(alexNightsAndHabits());
    await h.say("Alex", "Friday is eating out. Weeknight dinners need to be quick. Chicken at least once a week.");
    // "habits" was answered inside that message, so the next question is the dinners one.
    expect(h.lastText).toBe(TOPIC_QUESTIONS.dinners);
    expect(h.state?.covered.habits?.kind).toBe("answer");

    h.reads(dinners());
    await h.say("Sam", "Chicken tacos and spaghetti and meatballs are our usual.");
    expect(h.lastText).toBe(TOPIC_QUESTIONS["wont-eat"]);

    const modelCalls = h.extractRequests.length;
    await h.say("Alex", "skip");
    expect(h.lastText).toBe(TOPIC_QUESTIONS.staples);
    await h.say("Sam", "skip");
    expect(h.extractRequests.length).toBe(modelCalls); // a bare "skip" never goes to the model

    // The read-back: plain words, nothing saved yet.
    const readBack = h.texts.slice(-1)[0]!;
    expect(readBack).toContain("Friday is eating out.");
    expect(readBack).toContain("I'll check this");
    expect(readBack).toContain("Chicken tacos");
    expect(readBack).toContain("Nothing is saved yet");
    expect(h.state?.phase).toBe("proposed");
    expect(existsSync(h.profilePath)).toBe(false);
  });

  test("two adults disagree: one clarification quotes both, and the interview waits for the answer", async () => {
    const h = await freshHousehold();
    h.reads(alexNightsAndHabits());
    const alexId = await h.say("Alex", "Friday is eating out. Weeknight dinners need to be quick. Chicken at least once a week.");
    h.reads(
      reading((batch) => ({
        additions: [add(batch[0]!, "dinners", "Chicken tacos", { kind: "dish", name: "Chicken tacos", protein: "chicken", tags: ["quick"], pool: "usual" })],
        topicsCovered: ["dinners"],
        conflicts: [
          {
            topic: "nights",
            subject: "Friday dinner",
            versions: [
              { memberId: "alex", memberName: "Alex", messageId: alexId, quote: "Friday is eating out", factId: "f1" },
              { memberId: "sam", memberName: "Sam", messageId: batch[0]!.id, quote: "we always cook on Fridays" },
            ],
          },
        ],
      })),
    );
    await h.say("Sam", "Chicken tacos. And we always cook on Fridays.");
    expect(h.lastText).toContain("Alex and Sam, I heard two different things about Friday dinner");
    expect(h.lastText).toContain('- Alex: "Friday is eating out"');
    expect(h.lastText).toContain('- Sam: "we always cook on Fridays"');
    expect(h.state?.phase).toBe("clarifying");

    // Alex settles it; the interview moves on to the next question.
    h.reads(reading((batch, request) => ({ resolvedConflicts: [{ conflictId: request.state.conflicts[0]!.id, messageId: batch[0]!.id }] })));
    await h.say("Alex", "Friday stays eating out.");
    expect(h.state?.conflicts[0]?.status).toBe("resolved");
    expect(h.lastText).toBe(TOPIC_QUESTIONS["wont-eat"]);
  });

  test("an edit after the read-back makes a new version that says what changed; an approval of the old one is not enough", async () => {
    const h = await freshHousehold();
    await reachProposal(h);
    const firstReadBack = h.idOfPost("Nothing is saved yet");

    h.reads(
      reading((batch) => ({
        additions: [add(batch[0]!, "habits", "red meat no more than once a week", { kind: "rule", check: { kind: "max", tag: "red-meat", count: 1 } })],
        topicsCovered: ["habits"],
      })),
    );
    await h.say("Sam", "Also, red meat no more than once a week.");
    expect(h.lastText).toContain("Version 3");
    expect(h.lastText).toContain("What changed since the last version");
    expect(h.lastText).toContain('Added rule: "red meat no more than once a week"');

    // Alex replies "looks good" to the OLD read-back: that is not the latest, so nothing is saved
    // and the bot asks the confirm question for what it would save now.
    await h.say("Alex", "looks good", { replyTo: firstReadBack });
    expect(existsSync(h.profilePath)).toBe(false);
    expect(h.lastText).toContain("Save these rules: 4 rules (4 checked), 2 dishes");
    expect(h.state?.phase).toBe("confirming-snapshot");
  });

  test("the confirm question: 'save it' approves exactly what it showed, and the file parses", async () => {
    const h = await freshHousehold();
    await reachProposal(h);
    await h.say("Alex", "save it"); // not a reply to the read-back: the bot asks first
    expect(existsSync(h.profilePath)).toBe(false);
    expect(h.lastText).toContain("Save these rules: 3 rules (3 checked), 2 dishes");

    await h.say("Sam", "Yes, save!");
    const saved = h.texts.at(-2)!;
    expect(saved).toContain("Saved.");
    expect(saved).toContain("nothing to undo");
    // Thursday: the first draft is still ahead, and the scheduler says when.
    expect(h.lastText).toBe("Your house rules are saved. The next dinner draft is Friday at 4:00 PM.");
    const profile = parseProfile(readFileSync(h.profilePath, "utf8"));
    expect(profile.rules.map((rule) => rule.prose)).toContain("Friday is eating out.");
    expect(profile.usualDishes.map((dish) => dish.name)).toEqual(["Chicken tacos", "Spaghetti and meatballs"]);
    expect(h.state?.phase).toBe("done");
    expect(existsSync(join(h.stateDir, "profile-last-change.json"))).toBe(false); // first creation: no undo
  });

  test("a confirm question goes stale when the rules change after it: the next 'save it' asks again instead of saving", async () => {
    const h = await freshHousehold();
    await reachProposal(h);
    await h.say("Alex", "save it");
    expect(h.state?.pendingSnapshot?.revision).toBe(h.state?.revision);
    const askedAt = h.state!.revision;

    h.reads(
      reading((batch) => ({
        additions: [add(batch[0]!, "habits", "red meat no more than once a week", { kind: "rule", check: { kind: "max", tag: "red-meat", count: 1 } })],
        topicsCovered: ["habits"],
      })),
    );
    await h.say("Sam", "Also, red meat no more than once a week.");
    expect(h.state?.pendingSnapshot).toBeNull();
    expect(h.state!.revision).toBe(askedAt + 1);

    await h.say("Alex", "save it");
    expect(existsSync(h.profilePath)).toBe(false); // the old question's approval does not carry over
    expect(h.lastText).toContain("Save these rules: 4 rules (4 checked), 2 dishes");
    await h.say("Sam", "save it");
    expect(parseProfile(readFileSync(h.profilePath, "utf8")).rules).toHaveLength(4);
  });

  test("approval by a direct reply to the latest read-back saves at once, then the next scheduled draft uses the new rules", async () => {
    const h = await freshHousehold();
    await reachProposal(h);
    const readBack = h.idOfPost("Nothing is saved yet");
    await h.say("Sam", "looks good", { replyTo: readBack });
    expect(h.texts.at(-2)).toContain("Saved.");
    expect(parseProfile(readFileSync(h.profilePath, "utf8")).rules).toHaveLength(3);
    expect(h.savedTimes).toBe(1);

    // The planner uses the new profile at once: Friday 4 PM, the draft is built against it.
    h.clock.nowMs = FRIDAY_4PM;
    h.brain.next(draftAnswer);
    await h.scheduler.tick();
    await h.settle();
    const request = h.brain.handled.at(-1)!;
    expect(request.kind).toBe("friday-draft");
    expect(request.context.profile.rules.map((rule) => rule.prose)).toContain("Friday is eating out.");
    expect(h.lastText).toContain("Here's the draft");
    expect(loadWeek(h.paths.weeksDir, "2026-10-05").status).toBe("drafted");
  });
});
