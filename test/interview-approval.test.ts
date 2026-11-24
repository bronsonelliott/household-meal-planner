// "Nothing is saved unless an adult approved exactly the bytes they were shown, after it fully
// reached them, against the profile file as it was when they were shown it." One test per way that
// used to be breakable. Each fails on the code before these fixes.

import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXTERNAL_EDIT_MESSAGE, FIRST_RUN_PROFILE_APPEARED } from "../src/onboarding/questions.ts";
import { InterviewHarness } from "./fixtures/interview-harness.ts";
import { alexNightsAndHabits, dinners, reachProposal, reading, start } from "./fixtures/interview-scenarios.ts";
import { add } from "./fixtures/onboarding-fixtures.ts";

const SAMPLE_FILE = join(import.meta.dir, "..", "data.example", "profile.md");

const harnesses: InterviewHarness[] = [];
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.stop();
});
const household = (options: ConstructorParameters<typeof InterviewHarness>[0] = {}) => start(options, harnesses);

describe("the confirm question", () => {
  test("shows the actual rules and lists, not only counts", async () => {
    const h = await household();
    await reachProposal(h);
    await h.say("Sam", "save it");
    const text = h.lastSnapshot;
    expect(text).toContain("Friday is eating out.");
    expect(text).toContain("I'll check this: Friday is always eating out");
    expect(text).toContain("Chicken tacos");
    expect(text).toContain("Spaghetti and meatballs");
  });

  test("a 'save it' does not count when the confirm question did not reach that adult in full", async () => {
    const h = await household();
    await reachProposal(h);
    // The chat app reports the confirm question as only partly delivered.
    h.scriptSends([{ kind: "partial", timestamp: 1, failedMembers: [{ member: "sam", type: "UNREGISTERED" }], nativeId: "partial-snapshot" }]);
    await h.say("Alex", "save it");
    expect(h.state?.phase).toBe("confirming-snapshot");
    h.scriptSends([]);

    await h.say("Sam", "save it");
    expect(existsSync(h.profilePath)).toBe(false); // that "save it" was not an answer to something Sam fully saw
    expect(h.state?.pendingSnapshot?.deliveries.alex).toBe("delivered");
    expect(h.state?.pendingSnapshot?.deliveries).toEqual({ alex: "delivered", sam: "delivered" }); // so it was asked again

    await h.say("Alex", "save it");
    expect(existsSync(h.profilePath)).toBe(true);
    expect(h.state?.phase).toBe("done");
  });

  test("two 'save it' messages that arrive while the bot is busy cannot approve the question posted for the first", async () => {
    const h = await household();
    await reachProposal(h);
    await h.type("Alex", "save it");
    await h.type("Sam", "save it"); // arrived before the question for the first one had gone out
    await h.pass();
    expect(existsSync(h.profilePath)).toBe(false);
    expect(h.state?.phase).toBe("confirming-snapshot");

    // Said after the latest question went out, it counts.
    await h.say("Alex", "save it");
    expect(existsSync(h.profilePath)).toBe(true);
  });

  test("the receipt numbers are the inbox's, so they survive a restart", async () => {
    const h = await household();
    await reachProposal(h);
    await h.say("Sam", "save it");
    const seq = h.state?.pendingSnapshot?.deliveredSeq;
    expect(typeof seq).toBe("number");
    await h.restart();
    expect(h.state?.pendingSnapshot?.deliveredSeq).toBe(seq ?? -1);
    await h.say("Alex", "save it"); // numbered after the restart, still greater
    expect(existsSync(h.profilePath)).toBe(true);
  });
});

describe("a hand edit between the read-back and the save", () => {
  test("first run: the hand-written file wins and the interview closes", async () => {
    const h = await household();
    await reachProposal(h);
    const byHand = readFileSync(SAMPLE_FILE, "utf8");
    writeFileSync(h.profilePath, byHand);
    await h.say("Sam", "save it", { replyTo: h.idOfPost("Nothing is saved yet") });
    expect(readFileSync(h.profilePath, "utf8")).toBe(byHand);
    expect(h.texts).toContain(FIRST_RUN_PROFILE_APPEARED);
    expect(h.state?.phase).toBe("cancelled");
  });

  test("redo: the file is left alone and a fresh read-back is shown", async () => {
    const original = readFileSync(SAMPLE_FILE, "utf8");
    const h = await household({ profile: original });
    await h.say("Alex", "use the sample");
    const byHand = original.replace("Friday is eating out.", "Friday is pizza night out.");
    writeFileSync(h.profilePath, byHand);
    await h.say("Sam", "save it", { replyTo: h.idOfPost("Nothing is saved yet") });
    expect(readFileSync(h.profilePath, "utf8")).toBe(byHand);
    expect(h.texts).toContain(EXTERNAL_EDIT_MESSAGE);
    expect(h.lastText).toContain("Nothing is saved yet");
    expect(h.state?.phase).toBe("proposed");
  });

  test("what is written is exactly what was shown", async () => {
    const h = await household();
    await reachProposal(h);
    const shown = h.state!.lastReadBack!.text;
    await h.say("Sam", "save it", { replyTo: h.idOfPost("Nothing is saved yet") });
    expect(readFileSync(h.profilePath, "utf8")).toBe(shown);
  });
});

describe("a practice run", () => {
  // The practice run's journal (its own file now; the shared one before).
  function journalFile(dir: string): string {
    const practice = join(dir, "state", "batches.dry-run.jsonl");
    return existsSync(practice) ? practice : join(dir, "state", "batches.jsonl");
  }

  // A practice run that stopped after the commit was prepared and before it was finished.
  async function practiceCrashedAfterCommitPrepared(): Promise<string> {
    const practice = await household({ dryRun: true });
    await reachProposal(practice);
    await practice.say("Alex", "save it"); // the confirm question
    await practice.say("Sam", "save it"); // the practice save
    expect(practice.state?.phase).toBe("done");
    const file = journalFile(practice.dir);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const preparedAt = lines.findIndex((line) => line.includes('"commit-prepared"'));
    expect(preparedAt).toBeGreaterThan(0);
    writeFileSync(file, lines.slice(0, preparedAt + 1).join("\n") + "\n"); // the crash
    await practice.stop();
    return practice.dir;
  }

  test("a live restart on the same folders does not finish a practice commit", async () => {
    const dir = await practiceCrashedAfterCommitPrepared();
    const live = await household({ dir });
    expect(existsSync(live.profilePath)).toBe(false);
  });

  test("a practice record found in the live journal is refused and logged", async () => {
    const dir = await practiceCrashedAfterCommitPrepared();
    copyFileSync(journalFile(dir), join(dir, "state", "batches.jsonl")); // as an older version would have left it
    const live = await household({ dir });
    expect(existsSync(live.profilePath)).toBe(false);
    expect(live.logs.some((line) => line.includes("practice run") || line.includes("other mode"))).toBe(true);
  });
});

describe("a model outage", () => {
  test("an approval does not overtake an earlier change the bot could not read", async () => {
    const h = await household();
    await reachProposal(h);
    h.modelDown = "other";
    await h.say("Alex", "Actually add pizza night to the usual dishes.");
    expect(h.extractRequests.length).toBeGreaterThan(0);

    await h.say("Sam", "save it", { replyTo: h.idOfPost("Nothing is saved yet") });
    expect(existsSync(h.profilePath)).toBe(false);
    expect(h.texts.some((text) => text.includes("catching up on an earlier change"))).toBe(true);
    expect(h.state?.phase).toBe("proposed");
  });

  test("once the model is back, the earlier change is read first and the stale read-back cannot save", async () => {
    const h = await household();
    await reachProposal(h);
    h.modelDown = "other";
    await h.say("Alex", "Actually add pizza night to the usual dishes.");
    h.modelDown = null;
    h.reads(
      reading((batch) => ({
        additions: [add(batch[0]!, "dinners", "pizza night", { kind: "dish", name: "Pizza night", protein: "vegetarian", tags: ["pizza"], pool: "usual" })],
      })),
    );
    await h.say("Sam", "save it", { replyTo: h.idOfPost("Nothing is saved yet") });
    expect(existsSync(h.profilePath)).toBe(false); // the rules changed since that read-back
    expect(h.state?.facts.some((fact) => fact.wording.includes("pizza night"))).toBe(true);
  });
});

describe("replaying an old turn", () => {
  test("a message the journal already finished is a no-op: newer facts stay", async () => {
    const h = await household();
    h.reads(alexNightsAndHabits());
    const text = "Friday is eating out. Weeknight dinners need to be quick. Chicken at least once a week.";
    const first = await h.say("Alex", text);
    h.reads(dinners());
    await h.say("Sam", "Chicken tacos and spaghetti and meatballs are our usual.");
    const before = h.state!;
    expect(before.facts.length).toBeGreaterThan(3);
    const posts = h.texts.length;

    // The same message comes round again (a redelivery, or a restart before it was marked handled).
    h.worker.enqueueMessage({ id: first, kind: "text", memberId: "alex", memberName: "Alex", text, timestamp: 1, mentionsBot: false, repliesToBot: false });
    await h.settle();
    const after = h.state!;
    expect(after.facts.length).toBe(before.facts.length);
    expect(after.revision).toBe(before.revision);
    expect(after.currentTopic).toBe(before.currentTopic);
    expect(after.phase).toBe(before.phase);
    expect(h.texts).toHaveLength(posts);
  });
});
