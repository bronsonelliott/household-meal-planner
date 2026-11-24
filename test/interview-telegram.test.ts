// The first-run interview through the real Telegram adapter (against the fake Bot API on a
// loopback port) and the real brain reading the answers (against the fake Anthropic client):
// fresh install, welcome, two adults answering, a read-back, and a "looks good" that is a native
// Telegram reply to it, which saves at once. Nothing here leaves the process.

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeCaller } from "../src/brain/claude.ts";
import { ClaudeBrain } from "../src/brain/index.ts";
import { parseProfile } from "../src/data/profile.ts";
import { startMessenger, type Messenger } from "../src/messaging/messenger.ts";
import { TOPIC_QUESTIONS } from "../src/onboarding/questions.ts";
import { Worker, type Brain } from "../src/week/worker.ts";
import { BRAIN_SETTINGS, CHICAGO_SCHEDULE, MON_TO_THU } from "./fixtures/config-fixtures.ts";
import { FakeAnthropic, answer } from "./fixtures/fake-anthropic.ts";
import { ALEX_ID, BOT, FakeTelegramApi, freshStateDir, GROUP_CHAT_ID, SAM_ID, TEST_MEMBERS, telegramAdapter } from "./fixtures/fake-telegram-api.ts";
import { draftAnswer } from "./fixtures/ops-harness.ts";
import { FakeClock, FRIDAY_4PM, isTestAdmin, StubBrain } from "./fixtures/worker-harness.ts";

const running: Messenger[] = [];
const apis: FakeTelegramApi[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
  while (apis.length > 0) apis.pop()!.stop();
});

async function eventually(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("eventually: condition not met in time");
    await Bun.sleep(10);
  }
}

const idOf = (messageId: number) => `telegram/${GROUP_CHAT_ID}/${messageId}`;

test("Telegram: welcome, two adults answer, a native reply to the read-back saves, and Friday's draft uses the new rules", async () => {
  const api = new FakeTelegramApi();
  apis.push(api);
  const stateDir = freshStateDir();
  const dataDir = mkdtempSync(join(tmpdir(), "hmp-interview-data-"));
  mkdirSync(join(dataDir, "weeks"), { recursive: true });
  const profilePath = join(dataDir, "profile.md");
  const clock = new FakeClock(FRIDAY_4PM - 24 * 60 * 60_000); // Thursday afternoon
  const logs: string[] = [];

  // The brain: the real one reads the interview answers (through the fake Anthropic client); the
  // stub plans the Friday draft.
  const fake = new FakeAnthropic();
  const claude = new ClaudeBrain({ callModel: createClaudeCaller({ clientFactory: fake.factory, env: { ANTHROPIC_API_KEY: "sk-ant-api03-TEST-KEY-1234567890" } }), settings: BRAIN_SETTINGS, log: (line) => logs.push(line) });
  const planner = new StubBrain();
  const brain: Brain = {
    handle: (request) => planner.handle(request),
    fillIngredients: (requests) => planner.fillIngredients(requests),
    extractOnboarding: (request) => claude.extractOnboarding(request),
  };

  // As in the bridge: anything that needs to send waits for the messenger to be up.
  let messenger: Messenger | null = null;
  let messengerUp: (m: Messenger) => void = () => {};
  const ready = new Promise<Messenger>((resolve) => (messengerUp = resolve));
  const worker = new Worker({
    paths: {
      weeksDir: join(dataDir, "weeks"),
      logPath: join(dataDir, "log.md"),
      profileFiles: { profilePath, lastChangePath: join(stateDir, "profile-last-change.json") },
      sourcesPath: join(dataDir, "recipe-sources.json"),
      catalogPath: join(dataDir, "recipe-catalog.json"),
      stateDir,
    },
    brain,
    isAdmin: isTestAdmin,
    send: async (text, key) => (await ready).sendToConversation(text, key),
    markHandled: (id) => messenger?.markHandled(id),
    now: clock.now,
    schedule: CHICAGO_SCHEDULE,
    quietWindowMs: 15_000,
    timers: { set: clock.set, clear: clock.clear },
    log: (line) => logs.push(line),
    interview: { botName: "Dinner Bot", members: TEST_MEMBERS.map((m) => ({ id: m.id, name: m.name })), weeknights: MON_TO_THU, minDiscoveryNights: 1, dryRun: false },
  });
  void worker.recover();
  void worker.startOnboarding();
  messenger = await startMessenger(telegramAdapter(api, stateDir), {
    mode: "group",
    members: TEST_MEMBERS,
    stateDir,
    dryRun: false,
    onEvent: (event) => worker.enqueueMessage(event),
    log: (line) => logs.push(line),
    healthIntervalMs: 60 * 60 * 1000,
  });
  messengerUp(messenger);
  running.push(messenger);
  await worker.idle();

  // Types as an adult and waits for the bot to finish answering.
  async function say(from: string, text: string, messageId: number, replyTo?: number): Promise<void> {
    api.push({
      from,
      text,
      messageId,
      ...(replyTo !== undefined ? { extra: { reply_to_message: { message_id: replyTo, from: { id: BOT.id, is_bot: true } } } } : {}),
    });
    await eventually(() => api.calls("setMessageReaction").some((call) => call.message_id === messageId && call.reaction[0].emoji === "👀"));
    clock.advance(15_000);
    await worker.idle();
  }

  // The welcome: one post, to the group, with the first question.
  expect(api.sends()).toHaveLength(1);
  expect(api.sends()[0]!.chat_id).toBe(Number(GROUP_CHAT_ID));
  expect(api.sends()[0]!.text).toContain(TOPIC_QUESTIONS.nights);

  // Alex answers two questions at once; the real brain parses the fake model's JSON.
  const alexText = "Friday is eating out. Weeknight dinners need to be quick. Chicken at least once a week.";
  fake.push(
    answer(
      JSON.stringify({
        additions: [
          { sourceMessageId: idOf(501), topic: "nights", kind: "rule", wording: "Friday is eating out.", check: { kind: "fixed", night: "friday", value: "out" } },
          { sourceMessageId: idOf(501), topic: "nights", kind: "rule", wording: "Weeknight dinners need to be quick", check: { kind: "require", tag: "quick", nights: "weeknights" } },
          { sourceMessageId: idOf(501), topic: "habits", kind: "rule", wording: "Chicken at least once a week", check: { kind: "min", tag: "chicken", count: 1 } },
        ],
        topicsCovered: ["nights", "habits"],
      }),
    ),
  );
  await say(ALEX_ID, alexText, 501);
  expect(api.sends().at(-1)!.text).toBe(TOPIC_QUESTIONS.dinners);

  // Sam lists the usual dinners.
  fake.push(
    answer(
      JSON.stringify({
        additions: [
          { sourceMessageId: idOf(502), topic: "dinners", kind: "dish", wording: "Chicken tacos", name: "Chicken tacos", protein: "chicken", tags: ["quick", "mexican"], pool: "usual" },
        ],
        topicsCovered: ["dinners"],
      }),
    ),
  );
  await say(SAM_ID, "Chicken tacos, mostly.", 502);
  expect(api.sends().at(-1)!.text).toBe(TOPIC_QUESTIONS["wont-eat"]);

  // Two skips (no model call), and the read-back arrives.
  await say(ALEX_ID, "skip", 503);
  await say(SAM_ID, "skip", 504);
  const readBack = api.sends().at(-1)!.text;
  expect(readBack).toContain("Nothing is saved yet");
  expect(existsSync(profilePath)).toBe(false);
  const readBackMessageId = api.sends().length; // the fake numbers its own posts 1, 2, 3...

  // "looks good" as a native Telegram reply to the read-back: saved at once, no confirm question.
  await say(SAM_ID, "looks good", 505, readBackMessageId);
  expect(api.sends().at(-1)!.text).toContain("Saved.");
  const profile = parseProfile(readFileSync(profilePath, "utf8"));
  expect(profile.rules.map((rule) => rule.prose)).toEqual(["Friday is eating out.", "Weeknight dinners need to be quick", "Chicken at least once a week"]);
  expect(profile.usualDishes.map((dish) => dish.name)).toEqual(["Chicken tacos"]);

  // Friday: the draft is planned against the new profile.
  clock.nowMs = FRIDAY_4PM;
  planner.next(draftAnswer);
  expect((await worker.enqueueFridayDraft({ late: false })).kind).toBe("posted");
  expect(planner.handled.at(-1)!.context.profile.rules).toHaveLength(3);
  expect(api.sends().at(-1)!.text).toContain("Here's the draft");
});
