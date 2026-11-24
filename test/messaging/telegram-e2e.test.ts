// A whole week through the real pieces, with only Telegram and the model faked: the real worker,
// the real shared messenger, the real Telegram adapter, and the fake Bot API on a loopback port.
//
//   Friday: the draft posts to the group.
//   A member swaps a night; the reply restates the week.
//   "lock it": the grocery list is posted.
//   The bridge restarts (twice, once with Telegram redelivering old messages): nothing is
//   posted or applied again.

import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { startMessenger, type Messenger } from "../../src/messaging/messenger.ts";
import type { IngredientFill, IngredientRequest } from "../../src/week/changeset.ts";
import { Worker } from "../../src/week/worker.ts";
import { loadWeek } from "../../src/week/state.ts";
import { CHICAGO_SCHEDULE } from "../fixtures/config-fixtures.ts";
import { ALEX_ID, FakeTelegramApi, freshStateDir, GROUP_CHAT_ID, SAM_ID, TEST_MEMBERS, telegramAdapter } from "../fixtures/fake-telegram-api.ts";
import { FRIDAY_4PM, isTestAdmin, setupHarness } from "../fixtures/worker-harness.ts";

const COMING = "2026-10-05";
const NIGHTS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

const running: Messenger[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
});

async function eventually(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("eventually: condition not met in time");
    await Bun.sleep(10);
  }
}

test("Friday draft, a swap, 'lock it', a restart: every post happens once", async () => {
  const api = new FakeTelegramApi();
  const stateDir = freshStateDir();
  const h = setupHarness(FRIDAY_4PM);
  // The worker and the messenger share one state folder, like the real bridge.
  h.paths.stateDir = stateDir;
  const logs: string[] = [];

  // The "model": answers whatever the worker asks, from a short script.
  h.brain.fillIngredients = async (requests: IngredientRequest[]): Promise<IngredientFill[]> =>
    requests.map((request) => ({ weekOf: request.weekOf, night: request.night, dish: request.dish, ingredients: [{ section: "Meat & Fish" as const, text: `${request.dish} meat, 1 lb` }] }));

  async function boot() {
    const adapter = telegramAdapter(api, stateDir);
    let messenger: Messenger | null = null;
    const worker = new Worker({
      paths: h.paths,
      brain: h.brain,
      isAdmin: isTestAdmin,
      send: (text, key) => messenger!.sendToConversation(text, key),
      markHandled: (id) => messenger!.markHandled(id),
      now: h.clock.now,
      schedule: CHICAGO_SCHEDULE,
      quietWindowMs: 15_000,
      timers: { set: h.clock.set, clear: h.clock.clear },
      log: (line) => logs.push(line),
    });
    await worker.recover();
    messenger = await startMessenger(adapter, {
      mode: "group",
      members: TEST_MEMBERS,
      stateDir,
      dryRun: false,
      onEvent: (event) => worker.enqueueMessage(event),
      log: (line) => logs.push(line),
      healthIntervalMs: 60 * 60 * 1000,
    });
    running.push(messenger);
    return { worker, messenger };
  }

  // Delivers a message through Telegram and lets the worker finish it.
  async function say(worker: Worker, from: string, text: string, expectedSends: number, messageId: number) {
    api.push({ from, text, messageId });
    // The 👀 reaction means the message was journaled and handed to the worker.
    await eventually(() => api.calls("setMessageReaction").some((call) => call.message_id === messageId && call.reaction[0].emoji === "👀"));
    h.clock.advance(15_000);
    await worker.idle();
    await eventually(() => api.sends().length === expectedSends);
  }

  const first = await boot();

  // Friday: the draft posts.
  h.brain.next((request) => ({
    changeSet: {
      operations: [
        {
          sourceMessageId: request.triggerId,
          action: "swap",
          nights: NIGHTS.map((night) => ({ night, rule: null, dish: { kind: "profile" as const, name: "Chicken tacos" } })),
        },
      ],
    },
    reply: { kind: "silent", reason: "draft" },
  }));
  expect((await first.worker.enqueueFridayDraft({ late: false })).kind).toBe("posted");
  expect(api.sends().length).toBe(1);
  expect(api.sends()[0]!.chat_id).toBe(Number(GROUP_CHAT_ID));
  expect(api.sends()[0]!.text).toContain("Here's the draft for Oct 5 to Oct 11");
  expect(api.sends()[0]!.text).toContain("Tuesday: Chicken tacos");

  // Sam swaps Tuesday.
  const swapId = `telegram/${GROUP_CHAT_ID}/501`;
  h.brain.next(() => ({
    changeSet: {
      operations: [{ sourceMessageId: swapId, action: "swap", nights: [{ night: "tuesday", rule: null, dish: { kind: "profile", name: "Spaghetti and meatballs" } }] }],
    },
    reply: { kind: "text", text: "Swapped Tuesday to spaghetti." },
  }));
  await say(first.worker, SAM_ID, "Can we do spaghetti on Tuesday?", 2, 501);
  expect(api.sends()[1]!.text).toContain("Swapped Tuesday to spaghetti.");
  expect(api.sends()[1]!.text).toContain("Tuesday: Spaghetti and meatballs");
  expect(loadWeek(h.paths.weeksDir, COMING).nights.tuesday?.dish).toBe("Spaghetti and meatballs");

  // Alex locks it.
  const lockId = `telegram/${GROUP_CHAT_ID}/502`;
  h.brain.next(() => ({ changeSet: { operations: [{ sourceMessageId: lockId, action: "lock" }] }, reply: { kind: "text", text: "Locking it." } }));
  await say(first.worker, ALEX_ID, "lock it", 3, 502);
  expect(api.sends()[2]!.text).toContain("Locked the week of Oct 5.");
  expect(api.sends()[2]!.text).toContain("Grocery list for Oct 5 to Oct 11");
  expect(loadWeek(h.paths.weeksDir, COMING).status).toBe("locked");

  // Both messages were acknowledged: 👀 on arrival, 👍 once answered.
  await eventually(() => api.calls("setMessageReaction").length === 4);
  expect(api.calls("setMessageReaction").map((call) => [call.message_id, call.reaction[0].emoji])).toEqual([
    [501, "👀"],
    [501, "👍"],
    [502, "👀"],
    [502, "👍"],
  ]);

  // The bridge restarts. Nothing new arrives, and nothing is posted or sent to the model again.
  await first.messenger.stop();
  running.length = 0;
  const modelCalls = h.brain.handled.length;
  const second = await boot();
  h.clock.advance(15_000);
  await second.worker.idle();
  expect((await second.worker.enqueueFridayDraft({ late: false })).kind).toBe("already-posted");
  expect(api.sends().length).toBe(3);
  expect(h.brain.handled.length).toBe(modelCalls);

  // It restarts again after a crash that lost the saved offset: Telegram hands over the same
  // messages once more. They are recognised and dropped.
  await second.messenger.stop();
  running.length = 0;
  rmSync(join(stateDir, "telegram-offset.json"));
  api.push({ from: SAM_ID, text: "Can we do spaghetti on Tuesday?", messageId: 501 });
  api.push({ from: ALEX_ID, text: "lock it", messageId: 502 });
  const third = await boot();
  h.clock.advance(15_000);
  await third.worker.idle();
  expect(api.sends().length).toBe(3);
  expect(h.brain.handled.length).toBe(modelCalls);
  expect(logs.filter((line) => line.includes("dropped duplicate")).length).toBe(2);

  api.stop();
});
