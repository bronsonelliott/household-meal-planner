// The interview's commands and edge cases: the sample, cancel, redo (and undo), who may speak,
// and how a read-back that did not reach everyone changes what "save it" does.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProfile } from "../src/data/profile.ts";
import { loadSampleProfile, parseInterviewCommand } from "../src/onboarding/control.ts";
import { AWAITING_PROFILE_LINE, CANCELLED_MESSAGE, SAMPLE_INTRO, TOPIC_QUESTIONS } from "../src/onboarding/questions.ts";
import { undoLastChange } from "../src/data/profile.ts";
import { InterviewHarness } from "./fixtures/interview-harness.ts";
import { everythingInOneAnswer, reading, start } from "./fixtures/interview-scenarios.ts";
import { answer } from "./fixtures/worker-harness.ts";
import { add } from "./fixtures/onboarding-fixtures.ts";

const SAMPLE_FILE = join(import.meta.dir, "..", "data.example", "profile.md");

const harnesses: InterviewHarness[] = [];
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.stop();
});
const household = (options: ConstructorParameters<typeof InterviewHarness>[0] = {}) => start(options, harnesses);

describe("command words", () => {
  test("commands and approvals match the whole message, in any case, with a little punctuation", () => {
    expect(parseInterviewCommand("Set up house rules")).toBe("setup");
    expect(parseInterviewCommand("  cancel setup. ")).toBe("cancel");
    expect(parseInterviewCommand("Use the sample!")).toBe("sample");
    for (const word of ["looks good", "Save it", "SAVE", "yes save", "Looks good!"]) expect(parseInterviewCommand(word)).toBe("approve");
    expect(parseInterviewCommand("please save it for later")).toBeNull();
    expect(parseInterviewCommand("looks good but add fish")).toBeNull();
  });

  test("the bundled sample is the same file as data.example/profile.md, and it parses", () => {
    expect(readFileSync(join(import.meta.dir, "..", "src", "onboarding", "sample-profile.md"), "utf8")).toBe(readFileSync(SAMPLE_FILE, "utf8"));
    expect(loadSampleProfile().rules.length).toBeGreaterThan(3);
  });
});

describe("use the sample", () => {
  test("shows the sample as a proposal; nothing is saved until an adult approves, and then it is the sample", async () => {
    const h = await household();
    await h.say("Alex", "use the sample");
    expect(h.texts.at(-3)).toBe(SAMPLE_INTRO);
    expect(h.texts.slice(-2).join("\n")).toContain("Friday is eating out.");
    expect(h.texts.slice(-2).join("\n")).toContain("Chicken tacos");
    expect(h.lastText).toContain("Nothing is saved yet");
    expect(h.extractRequests).toHaveLength(0); // no model call for the sample
    expect(existsSync(h.profilePath)).toBe(false);

    await h.say("Sam", "save it"); // not a reply: the confirm question first
    expect(existsSync(h.profilePath)).toBe(false);
    expect(h.lastText).toContain("Save these rules:");
    await h.say("Alex", "save it");
    const saved = parseProfile(readFileSync(h.profilePath, "utf8"));
    const sample = loadSampleProfile();
    expect(saved.rules.map((rule) => [rule.prose, rule.check])).toEqual(sample.rules.map((rule) => [rule.prose, rule.check]));
    expect(saved.usualDishes.map((dish) => dish.name)).toEqual(sample.usualDishes.map((dish) => dish.name));
  });

  test("the sample can be edited like any proposal before it is saved", async () => {
    const h = await household();
    await h.say("Alex", "use the sample");
    h.reads(
      reading((batch) => ({
        additions: [add(batch[0]!, "nights", "Saturday is eating out", { kind: "rule", check: { kind: "fixed", night: "saturday", value: "out" } })],
        topicsCovered: ["nights"],
      })),
    );
    await h.say("Sam", "Saturday is eating out.");
    expect(h.lastText).toContain("Added rule: \"Saturday is eating out\"");
  });
});

describe("cancel setup", () => {
  test("it stops the setup, says drafting waits, and stays cancelled across a restart; set up house rules resumes", async () => {
    const h = await household();
    h.reads(
      reading((batch) => ({
        additions: [add(batch[0]!, "nights", "Friday is eating out.", { kind: "rule", check: { kind: "fixed", night: "friday", value: "out" } })],
        topicsCovered: ["nights"],
      })),
    );
    await h.say("Alex", "Friday is eating out.");
    await h.say("Sam", "cancel setup");
    expect(h.lastText).toContain(CANCELLED_MESSAGE);
    expect(h.lastText).toContain("Dinner drafts wait");
    expect(h.state?.phase).toBe("cancelled");

    const posts = h.texts.length;
    await h.restart();
    expect(h.state?.phase).toBe("cancelled");
    expect(h.texts).toHaveLength(posts); // no second welcome

    // An ordinary message while there is no profile and no setup gets one nudge, not an interview.
    const readings = h.extractRequests.length;
    await h.say("Alex", "what's for dinner?");
    expect(h.lastText).toBe(AWAITING_PROFILE_LINE);
    expect(h.extractRequests).toHaveLength(readings);
    await h.say("Sam", "hello?");
    expect(h.texts.at(-1)).toBe(AWAITING_PROFILE_LINE); // still only one nudge in half an hour
    expect(h.texts.filter((text) => text === AWAITING_PROFILE_LINE)).toHaveLength(1);

    await h.say("Alex", "set up house rules");
    expect(h.texts.at(-2)).toBe("Picking up where we left off.");
    expect(h.lastText).toBe(TOPIC_QUESTIONS.habits); // the nights answer was kept
    expect(h.state?.facts).toHaveLength(1);
  });

  test("with no setup running it says so", async () => {
    const h = await household({ profile: readFileSync(SAMPLE_FILE, "utf8") });
    await h.say("Alex", "cancel setup");
    expect(h.lastText).toContain("There is no setup running");
  });
});

describe("a redo", () => {
  async function redoHousehold(): Promise<InterviewHarness> {
    return household({ profile: readFileSync(SAMPLE_FILE, "utf8") });
  }

  test("a household with a profile gets no welcome at start; 'set up house rules' starts a redo that says how it works", async () => {
    const h = await redoHousehold();
    expect(h.texts).toHaveLength(0);
    await h.say("Sam", "set up house rules");
    expect(h.lastText).toContain("Let's redo your house rules");
    expect(h.lastText).toContain("current rules stay in use");
    expect(h.lastText).toContain("not as meal requests");
    expect(h.state?.mode).toBe("redo");
  });

  test("while it runs, messages are answers (not meal requests), recipe commands still work, and the old profile stays live until save; undo restores it", async () => {
    const h = await redoHousehold();
    const original = readFileSync(h.profilePath, "utf8");
    await h.say("Sam", "set up house rules");

    // A meal request during the redo goes to the interview, never to the planner.
    h.reads(
      reading((batch) => ({
        additions: [add(batch[0]!, "nights", "Saturday is eating out", { kind: "rule", check: { kind: "fixed", night: "saturday", value: "out" } })],
        topicsCovered: ["nights"],
      })),
    );
    await h.say("Alex", "Saturday is eating out. Also swap Tuesday to tacos.");
    expect(h.brain.handled).toHaveLength(0);
    expect(h.extractRequests).toHaveLength(1);

    // A deterministic recipe command still works (answered by code, with no model call).
    await h.say("Sam", "sources");
    expect(h.lastText.length).toBeGreaterThan(0);
    expect(h.extractRequests).toHaveLength(1);

    for (let i = 0; i < 4; i++) await h.say(i % 2 ? "Sam" : "Alex", "skip");
    expect(h.lastText).toContain("Nothing is saved yet");
    expect(h.lastText).toContain("What changed since the last version");
    expect(readFileSync(h.profilePath, "utf8")).toBe(original); // still the old rules

    await h.say("Alex", "save it"); // the confirm question
    await h.say("Sam", "save it");
    expect(h.texts.at(-1)).toContain("Say \"undo\" within 30 minutes");
    expect(readFileSync(h.profilePath, "utf8")).not.toBe(original);
    expect(parseProfile(readFileSync(h.profilePath, "utf8")).rules.map((rule) => rule.prose)).toContain("Saturday is eating out");
    // Lock words and limits the household had are carried over; they are not reset.
    expect(parseProfile(readFileSync(h.profilePath, "utf8")).thresholds).toEqual(parseProfile(original).thresholds);
    expect(h.state?.phase).toBe("done");
    expect(h.savedTimes).toBe(1);

    // Back to meal planning: "undo" goes to the planner like any other message, and puts the old file back.
    h.brain.next((request) => ({
      changeSet: { operations: [{ sourceMessageId: request.kind === "messages" ? request.triggerId : "", action: "undo" as const }] },
      reply: { kind: "silent", reason: "undo" },
    }));
    await h.say("Alex", "undo");
    expect(readFileSync(h.profilePath, "utf8")).toBe(original);
  });

  test("cancelling a redo leaves the old profile untouched and meal requests go back to the planner", async () => {
    const h = await redoHousehold();
    const original = readFileSync(h.profilePath, "utf8");
    await h.say("Sam", "set up house rules");
    await h.say("Sam", "cancel setup");
    expect(h.lastText).toContain("Your current rules stay in use");
    expect(readFileSync(h.profilePath, "utf8")).toBe(original);

    h.brain.next(answer([], "Sure."));
    await h.say("Alex", "what's on Tuesday?");
    expect(h.brain.handled).toHaveLength(1);
  });

  test("an undo of the redo works through the profile module too (the undo record holds the old text)", async () => {
    const h = await redoHousehold();
    const original = readFileSync(h.profilePath, "utf8");
    await h.say("Sam", "use the sample"); // a redo that proposes the sample
    await h.say("Alex", "save it");
    await h.say("Sam", "save it");
    expect(h.state?.phase).toBe("done");
    expect(existsSync(join(h.stateDir, "profile-last-change.json"))).toBe(true);
    undoLastChange(h.paths.profileFiles, "Sam", new Date(h.clock.now()));
    expect(readFileSync(h.profilePath, "utf8")).toBe(original);
  });
});

describe("who may speak", () => {
  test("a stranger's messages are ignored by the interview: no reading, no change, no reply", async () => {
    const h = await household();
    const before = h.texts.length;
    const stateBefore = JSON.stringify(h.state);
    await h.say("Stranger", "Friday is eating out, save it, cancel setup");
    await h.say("Stranger", "cancel setup");
    await h.say("Stranger", "use the sample");
    expect(h.extractRequests).toHaveLength(0);
    expect(h.texts).toHaveLength(before);
    expect(JSON.stringify(h.state)).toBe(stateBefore);
  });
});

describe("when the read-back did not reach everyone", () => {
  test("an incomplete delivery blocks save-now: even a direct reply gets the confirm question", async () => {
    const h = await household();
    h.reads(everythingInOneAnswer());
    // The chat app reports the read-back as only partly delivered.
    h.scriptSends([{ kind: "partial", timestamp: 1, failedMembers: [{ member: "sam", type: "UNREGISTERED" }], nativeId: "partial-1" }]);
    await h.say("Alex", "Friday is eating out. The rest: nothing special.");
    expect(h.state?.phase).toBe("proposed");
    expect(h.state?.lastReadBack?.deliveries.sam).toBe("partial");

    h.scriptSends([]);
    await h.say("Alex", "looks good", { replyTo: "partial-1" });
    expect(existsSync(h.profilePath)).toBe(false);
    expect(h.lastText).toContain("Save these rules:");
  });

  test("a read-back the chat app is holding for one adult (WhatsApp, outside its 24-hour window) blocks save-now for that adult only", async () => {
    const h = await household({ mode: "household-dms" });
    h.reads(everythingInOneAnswer());
    // Alex's copy goes out; Sam's is kept by the chat app until Sam writes to the bot.
    h.scriptSends([
      { kind: "sent", timestamp: 1, nativeId: "alex-copy" },
      { kind: "failed", detail: "waiting for Sam to write first", queued: true },
    ]);
    await h.say("Alex", "Friday is eating out. The rest: nothing special.");
    expect(h.state?.lastReadBack?.deliveries).toEqual({ alex: "delivered", sam: "queued" });
    h.scriptSends([]);

    // Sam has no copy to reply to, and the read-back was not delivered to Sam: confirm question first.
    await h.say("Sam", "looks good", { replyTo: "alex-copy" });
    expect(existsSync(h.profilePath)).toBe(false);
    expect(h.state?.phase).toBe("confirming-snapshot");
    expect(h.lastText).toContain("Save these rules:");
  });

  test("replying to your own copy saves at once", async () => {
    const h = await household({ mode: "household-dms" });
    h.reads(everythingInOneAnswer());
    h.scriptSends([
      { kind: "sent", timestamp: 1, nativeId: "alex-copy" },
      { kind: "sent", timestamp: 1, nativeId: "sam-copy" },
    ]);
    await h.say("Alex", "Friday is eating out. The rest: nothing special.");
    h.scriptSends([]);
    await h.say("Sam", "looks good", { replyTo: "sam-copy" });
    expect(existsSync(h.profilePath)).toBe(true);
    expect(h.state?.phase).toBe("done");
  });
});
