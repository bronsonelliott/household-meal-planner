// What the interview does when things go wrong: restarts in every phase, a crash between the two
// halves of the save, a hand edit during recovery, a model outage, a practice (dry) run, a damaged
// state file, and a profile that appears by hand.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseProfile } from "../src/data/profile.ts";
import { EXTERNAL_EDIT_MESSAGE, FIRST_RUN_PROFILE_APPEARED, TOPIC_QUESTIONS } from "../src/onboarding/questions.ts";
import { OUTAGE_LINE } from "../src/ops/scheduler.ts";
import { InterviewHarness } from "./fixtures/interview-harness.ts";
import { alexNightsAndHabits, dinners, everythingInOneAnswer, reachProposal, reading, start } from "./fixtures/interview-scenarios.ts";
import { add } from "./fixtures/onboarding-fixtures.ts";

const SAMPLE_FILE = join(import.meta.dir, "..", "data.example", "profile.md");

const harnesses: InterviewHarness[] = [];
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.stop();
});
const household = (options: ConstructorParameters<typeof InterviewHarness>[0] = {}) => start(options, harnesses);

// A moment for background work to finish when a job is deliberately stuck (settle() would wait forever).
const moment = () => Bun.sleep(40);

describe("restarts", () => {
  test("a restart after the welcome does not post it again, and the first answer carries on", async () => {
    const h = await household();
    expect(h.texts).toHaveLength(1);
    await h.restart();
    expect(h.texts).toHaveLength(1);
    expect(h.state?.phase).toBe("asking");
    h.reads(alexNightsAndHabits());
    await h.say("Alex", "Friday is eating out. Weeknight dinners need to be quick. Chicken at least once a week.");
    expect(h.lastText).toBe(TOPIC_QUESTIONS.dinners);
  });

  test("a restart in the middle of a clarification keeps the open conflict", async () => {
    const h = await household();
    h.reads(alexNightsAndHabits());
    const alexId = await h.say("Alex", "Friday is eating out. Weeknight dinners need to be quick. Chicken at least once a week.");
    h.reads(
      reading((batch) => ({
        conflicts: [
          {
            topic: "nights",
            subject: "Friday dinner",
            versions: [
              { memberId: "alex", memberName: "Alex", messageId: alexId, quote: "Friday is eating out" },
              { memberId: "sam", memberName: "Sam", messageId: batch[0]!.id, quote: "we cook Fridays" },
            ],
          },
        ],
      })),
    );
    await h.say("Sam", "we cook Fridays");
    expect(h.state?.phase).toBe("clarifying");
    await h.restart();
    expect(h.state?.conflicts[0]?.status).toBe("open");
    h.reads(reading((batch, request) => ({ resolvedConflicts: [{ conflictId: request.state.conflicts[0]!.id, messageId: batch[0]!.id }] })));
    await h.say("Alex", "Friday stays out.");
    expect(h.lastText).toBe(TOPIC_QUESTIONS.dinners);
  });

  test("a restart after the read-back: a direct reply to it still saves at once (its message IDs were kept)", async () => {
    const h = await household();
    await reachProposal(h);
    const readBack = h.idOfPost("Nothing is saved yet");
    await h.restart();
    expect(h.state?.lastReadBack?.nativeIds.length).toBeGreaterThan(0);
    await h.say("Sam", "looks good", { replyTo: readBack });
    expect(existsSync(h.profilePath)).toBe(true);
    expect(h.state?.phase).toBe("done");
  });

  test("a restart after the confirm question: 'save it' still approves that snapshot", async () => {
    const h = await household();
    await reachProposal(h);
    await h.say("Alex", "save it");
    expect(h.state?.phase).toBe("confirming-snapshot");
    await h.restart();
    await h.say("Sam", "save it");
    expect(existsSync(h.profilePath)).toBe(true);
  });

  test("a restart after the save does not start the interview again", async () => {
    const h = await household();
    await reachProposal(h);
    await h.say("Alex", "save it");
    await h.say("Alex", "save it");
    const posts = h.texts.length;
    await h.restart();
    expect(h.texts).toHaveLength(posts);
    expect(h.state?.phase).toBe("done");
  });
});

describe("a crash in the middle of a turn", () => {
  test("after the model read the answers and the question went out: the model is not asked again and the question is not posted twice", async () => {
    const h = await household();
    h.reads(alexNightsAndHabits());
    h.dieAfterNextSend = true; // the next question goes out, then the process dies
    await h.type("Alex", "Friday is eating out. Weeknight dinners need to be quick. Chicken at least once a week.");
    h.clock.advance(15_000);
    await moment();
    const readings = h.extractRequests.length;
    const posts = h.texts.length;
    expect(h.lastText).toBe(TOPIC_QUESTIONS.dinners);

    await h.crash();
    expect(h.extractRequests).toHaveLength(readings); // the journaled reading was used
    expect(h.texts).toHaveLength(posts); // and the question was not sent again
    expect(h.state?.phase).toBe("asking");
    expect(h.state?.currentTopic).toBe("dinners");
    expect(h.state?.covered.habits?.kind).toBe("answer");
    // The interrupted turn was finished from its record: its steps are all there and it is marked done.
    const records = readFileSync(join(h.stateDir, "batches.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const turn = records.find((record) => record.type === "interview" && record.input.kind === "answers");
    expect(records.some((record) => record.type === "interview-step" && record.id === turn.id && record.step.label === "question-asked")).toBe(true);
    expect(records.some((record) => record.type === "done" && record.id === turn.id)).toBe(true);
  });

  test("after the read-back went out: it is not posted again, and its delivery is recorded", async () => {
    const h = await household();
    h.reads(alexNightsAndHabits());
    await h.say("Alex", "Friday is eating out. Weeknight dinners need to be quick. Chicken at least once a week.");
    h.reads(dinners());
    await h.say("Sam", "Chicken tacos and spaghetti and meatballs are our usual.");
    await h.say("Alex", "skip");
    h.dieAfterNextSend = true; // the read-back goes out as the last "skip" is handled, then the process dies
    await h.type("Sam", "skip");
    h.clock.advance(15_000);
    await moment();
    const posts = h.texts.length;
    expect(h.lastText).toContain("Nothing is saved yet");

    await h.crash();
    expect(h.texts).toHaveLength(posts);
    expect(h.state?.phase).toBe("proposed");
    expect(h.state?.lastReadBack?.deliveries).toEqual({ alex: "delivered", sam: "delivered" });
    expect(h.state?.lastReadBack?.nativeIds.length).toBeGreaterThan(0);
  });

  test("after the welcome went out: it is not posted again", async () => {
    const h = new InterviewHarness();
    harnesses.push(h);
    h.dieAfterNextSend = true; // the welcome goes out, then the process dies
    await h.boot({ settle: false });
    await moment();
    expect(h.texts).toHaveLength(1);
    await h.crash();
    expect(h.texts).toHaveLength(1);
    expect(h.state?.phase).toBe("asking");
  });

  // The save is two halves: the commit is prepared and written down, then the file is written. A
  // read-only data folder stops the second half, as a crash would.
  async function crashDuringSave(h: InterviewHarness): Promise<void> {
    chmodSync(h.dataDir, 0o500);
    await h.say("Alex", "save it"); // asks the confirm question
    await h.say("Sam", "save it"); // the save begins and cannot finish
    chmodSync(h.dataDir, 0o700);
  }

  test("between the two halves of the save: recovery finishes it, once", async () => {
    const h = await household();
    await reachProposal(h);
    await crashDuringSave(h);
    expect(existsSync(h.profilePath)).toBe(false);
    expect(h.state?.phase).toBe("committing");
    expect(h.texts.some((text) => text.includes("Saved."))).toBe(false);

    await h.restart();
    expect(parseProfile(readFileSync(h.profilePath, "utf8")).rules).toHaveLength(3);
    expect(h.state?.phase).toBe("done");
    expect(h.texts.filter((text) => text.includes("Saved.")).length).toBe(1);
  });

  test("a hand edit made while the save was stuck is never overwritten: the first-run interview gives way to it", async () => {
    const h = await household();
    await reachProposal(h);
    await crashDuringSave(h);
    const byHand = readFileSync(SAMPLE_FILE, "utf8");
    writeFileSync(h.profilePath, byHand);

    await h.restart();
    expect(readFileSync(h.profilePath, "utf8")).toBe(byHand);
    expect(h.texts.some((text) => text === FIRST_RUN_PROFILE_APPEARED)).toBe(true);
    expect(h.state?.phase).toBe("cancelled");
  });

  test("in a redo, a hand edit during recovery gives a fresh read-back and the file keeps the edit", async () => {
    const original = readFileSync(SAMPLE_FILE, "utf8");
    const h = await household({ profile: original });
    await h.say("Alex", "use the sample"); // a redo whose proposal is the sample
    await h.say("Sam", "save it"); // confirm question
    chmodSync(h.dataDir, 0o500);
    await h.say("Alex", "save it");
    chmodSync(h.dataDir, 0o700);
    expect(h.state?.phase).toBe("committing");
    const byHand = original.replace("Friday is eating out.", "Friday is pizza night out.");
    writeFileSync(h.profilePath, byHand);

    await h.restart();
    expect(readFileSync(h.profilePath, "utf8")).toBe(byHand); // untouched
    expect(h.texts.some((text) => text === EXTERNAL_EDIT_MESSAGE)).toBe(true);
    expect(h.lastText).toContain("Nothing is saved yet");
    expect(h.state?.phase).toBe("proposed");
    // Nothing approved before applies to the new read-back.
    await h.say("Alex", "save it");
    expect(h.lastText).toContain("Save these rules:");
    expect(readFileSync(h.profilePath, "utf8")).toBe(byHand);
  });
});

describe("the model is down", () => {
  test("the failure policy says so once, the answers are held, and the interview carries on when the model is back", async () => {
    const h = await household();
    h.modelDown = "other";
    const id = await h.say("Alex", "Friday is eating out. Weeknight dinners need to be quick. Chicken at least once a week.");
    expect(h.texts.filter((text) => text === OUTAGE_LINE)).toHaveLength(1);
    expect(h.state?.facts).toHaveLength(0);
    expect(h.lastText).toBe(OUTAGE_LINE);

    // Ten minutes later it tries again; the model has recovered.
    h.modelDown = null;
    h.reads(alexNightsAndHabits());
    h.clock.advance(10 * 60_000);
    await h.settle();
    expect(h.lastText).toBe(TOPIC_QUESTIONS.dinners);
    expect(h.state?.facts).toHaveLength(3);
    expect(h.texts.filter((text) => text === OUTAGE_LINE)).toHaveLength(1);
    expect(h.state?.processedMessageIds).toContain(id);
  });

  test("a bare skip needs no model, so it works during an outage", async () => {
    const h = await household();
    h.modelDown = "other";
    await h.say("Alex", "skip");
    expect(h.lastText).toBe(TOPIC_QUESTIONS.habits);
    expect(h.texts.filter((text) => text === OUTAGE_LINE)).toHaveLength(0);
  });
});

describe("a practice run (dry run)", () => {
  test("it uses its own state file, posts nothing for real, and never writes the profile", async () => {
    const h = await household({ dryRun: true });
    expect(existsSync(join(h.stateDir, "onboarding.dry-run.json"))).toBe(true);
    expect(existsSync(join(h.stateDir, "onboarding.json"))).toBe(false);
    expect(h.sends).toHaveLength(0); // nothing reached the chat app
    expect(h.texts[0]).toContain("I'm Dinner Bot"); // the would-be welcome was logged

    h.reads(everythingInOneAnswer());
    await h.say("Alex", "Friday is eating out. The rest: nothing special.");
    await h.say("Sam", "save it");
    await h.say("Alex", "save it");
    expect(h.lastText).toContain("practice run");
    expect(existsSync(h.profilePath)).toBe(false);
    expect(h.state?.phase).toBe("done");
    expect(h.savedTimes).toBe(0);

    // A restart does not start another practice interview, and the real welcome is untouched.
    const posts = h.texts.length;
    await h.restart();
    expect(h.texts).toHaveLength(posts);
    expect(existsSync(join(h.stateDir, "onboarding.json"))).toBe(false);
  });

  test("a real run after a practice run on the same folders still gets its own welcome", async () => {
    const practice = await household({ dryRun: true });
    await practice.stop();
    const real = await household({ dir: practice.dir });
    expect(real.texts[0]).toContain("I'm Dinner Bot");
    expect(existsSync(join(practice.stateDir, "onboarding.json"))).toBe(true);
    expect(existsSync(join(practice.stateDir, "onboarding.dry-run.json"))).toBe(true);
  });
});

describe("a damaged state file, and a profile that appears by hand", () => {
  test("a damaged interview file is not guessed at: the command says so and nothing is overwritten", async () => {
    const h = await household();
    await h.restart();
    const file = join(h.stateDir, "onboarding.json");
    writeFileSync(file, "{ this is not json");
    await h.say("Alex", "set up house rules");
    expect(h.lastText).toContain("I can't read my setup notes");
    expect(readFileSync(file, "utf8")).toBe("{ this is not json");
  });

  test("a profile written by hand while the interview is open closes it at the next start", async () => {
    const h = await household();
    writeFileSync(h.profilePath, readFileSync(SAMPLE_FILE, "utf8"));
    await h.restart();
    expect(h.state?.phase).toBe("cancelled");
    // The planner is back in charge: an ordinary message goes to it, not the interview.
    h.brain.next(() => ({ changeSet: { operations: [] }, reply: { kind: "text", text: "Tuesday is tacos." } }));
    await h.say("Sam", "what's on Tuesday?");
    expect(h.brain.handled).toHaveLength(1);
    expect(h.lastText).toBe("Tuesday is tacos.");
  });
});
