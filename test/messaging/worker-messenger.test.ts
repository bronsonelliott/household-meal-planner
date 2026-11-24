// The worker driven through the real shared messenger and a FakeAdapter, the way bridge.ts wires
// them: a message comes in, the worker replies through the messenger, and the message is marked
// handled and acknowledged. A restart does not reply twice.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeAdapter } from "../../src/messaging/fake.ts";
import { startMessenger, type Messenger } from "../../src/messaging/messenger.ts";
import { journalPath } from "../../src/week/journal.ts";
import { postedMarkerPath, sendUnknownMarkerPath, Worker } from "../../src/week/worker.ts";
import { CHICAGO_SCHEDULE } from "../fixtures/config-fixtures.ts";
import { answer, FRIDAY_4PM, isTestAdmin, setupHarness, THURSDAY_10AM } from "../fixtures/worker-harness.ts";

const COMING = "2026-10-05"; // the week the Friday draft is for
const running: Messenger[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
});

test("a text is answered through the messenger, acknowledged as handled, and not answered again after a restart", async () => {
  const h = setupHarness(THURSDAY_10AM);
  const members = [
    { id: "sam", name: "Sam", role: "admin" as const, identities: { telegram: "1002" } },
    { id: "alex", name: "Alex", role: "adult" as const, identities: { telegram: "1001" } },
  ];

  async function boot(inbound: boolean) {
    const adapter = new FakeAdapter({ platform: "telegram", conversationId: "household" });
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
      log: () => {},
    });
    await worker.recover();
    const messengerReady = startMessenger(adapter, {
      mode: "group",
      members,
      stateDir: h.paths.stateDir,
      dryRun: false,
      onEvent: (event) => worker.enqueueMessage(event),
      log: () => {},
      healthIntervalMs: 60 * 60 * 1000,
    });
    // Start-up has to finish before the message can be injected, which is the order bridge.ts uses too.
    messenger = await messengerReady;
    running.push(messenger);
    if (inbound) await adapter.inject({ sender: { identity: "1002", displayName: "Sam" }, nativeId: "42", text: "Thanks!", timestamp: THURSDAY_10AM });
    return { adapter, worker, messenger };
  }

  h.brain.next(answer([], "You're welcome."));
  const first = await boot(true);
  h.clock.advance(15_000);
  await first.worker.idle();

  expect(first.adapter.sends.map((send) => send.text)).toEqual(["You're welcome."]);
  await Bun.sleep(20);
  expect(first.adapter.acks.map((ack) => ack.kind)).toEqual(["received", "handled"]);
  await first.messenger.stop();
  running.length = 0;

  const second = await boot(false);
  h.clock.advance(15_000);
  await second.worker.idle();
  expect(second.adapter.sends).toEqual([]);
  expect(h.brain.handled.length).toBe(1);
});

// ---------------------------------------------------------------------------------------------
// Recovery with the real sender: the worker hands an interrupted send back under the same key,
// and the sender decides, person by person, what is already out.
// ---------------------------------------------------------------------------------------------

describe("a Friday draft interrupted mid-send, in household-dms mode", () => {
  const members = [
    { id: "alex", name: "Alex", role: "admin" as const, identities: { telegram: "1001" } },
    { id: "sam", name: "Sam", role: "adult" as const, identities: { telegram: "1002" } },
  ];
  const allOut = (request: { triggerId: string }) => ({
    changeSet: {
      operations: [
        {
          sourceMessageId: request.triggerId,
          action: "swap" as const,
          nights: (["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const).map((night) => ({ night, rule: null, dish: { kind: "out" as const } })),
        },
      ],
    },
    reply: { kind: "silent" as const, reason: "draft" },
  });

  // Boots a worker and a messenger over the same state folder, like a bridge start.
  async function boot(h: ReturnType<typeof setupHarness>, adapter: FakeAdapter) {
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
      log: () => {},
    });
    messenger = await startMessenger(adapter, {
      mode: "household-dms",
      members,
      stateDir: h.paths.stateDir,
      dryRun: false,
      onEvent: () => {},
      log: () => {},
      sleep: async () => {},
      now: h.clock.now,
      healthIntervalMs: 60 * 60 * 1000,
    });
    running.push(messenger);
    return { worker, messenger };
  }

  const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
  const rewrite = (path: string, keep: (record: any) => boolean) => writeFileSync(path, lines(path).filter((line) => keep(JSON.parse(line))).map((line) => line + "\n").join(""));

  // Runs a normal draft to both members, then rewinds the journals to "the bridge died during the
  // send": the worker's outcome is gone, and the outbox is cut back by `cutOutbox`.
  async function crashedDraft(cutOutbox: (record: any) => boolean) {
    const h = setupHarness(FRIDAY_4PM);
    h.brain.next(allOut);
    const first = await boot(h, new FakeAdapter({ platform: "telegram", conversationId: null }));
    await first.worker.enqueueFridayDraft({ late: false });
    await first.messenger.stop();
    running.length = 0;

    rewrite(journalPath(h.paths.stateDir), (record) => record.type !== "outcome" && record.type !== "done");
    rewrite(join(h.paths.stateDir, "outbox.jsonl"), cutOutbox);
    rmSync(postedMarkerPath(h.paths.stateDir, COMING), { force: true });
    rmSync(join(h.paths.stateDir, "send-failures.jsonl"), { force: true });
    return h;
  }

  test("a person the outbox shows was never attempted still gets the draft, and the one already sent does not", async () => {
    // Alex's send completed; Sam's never started.
    const h = await crashedDraft((record) => !(record.recipient === 1 && (record.type === "sending" || record.type === "result")));
    const adapter = new FakeAdapter({ platform: "telegram", conversationId: null });
    const { worker } = await boot(h, adapter);
    await worker.recover();
    await worker.idle();

    expect(adapter.sends.map((send) => send.memberId)).toEqual(["sam"]);
    expect(existsSync(postedMarkerPath(h.paths.stateDir, COMING))).toBe(true);
  });

  test("a person whose send was cut off stays Unknown and is not sent again, while the person never attempted is", async () => {
    // Alex's send was cut off (no result); Sam's never started.
    const h = await crashedDraft((record) => !(record.recipient === 1 && (record.type === "sending" || record.type === "result")) && !(record.recipient === 0 && record.type === "result"));
    const adapter = new FakeAdapter({ platform: "telegram", conversationId: null });
    const { worker } = await boot(h, adapter);
    await worker.recover();
    await worker.idle();

    expect(adapter.sends.map((send) => send.memberId)).toEqual(["sam"]);
    const failures = lines(join(h.paths.stateDir, "send-failures.jsonl")).map((line) => JSON.parse(line));
    expect(failures.map((record) => [record.class, record.target])).toEqual([["send-unknown", { member: "alex" }]]);
    // Alex may have it, so the draft is on the phones: the week is drafted, with the unknown marker.
    expect(existsSync(sendUnknownMarkerPath(h.paths.stateDir, COMING)) || existsSync(postedMarkerPath(h.paths.stateDir, COMING))).toBe(true);
  });
});
