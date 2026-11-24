// Tests for the inbox: every receive notification is journaled first, filtered, deduplicated by
// message ID, and replayed after a restart until the worker reports it handled.

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { InboundEvent } from "../../src/messaging/types.ts";
import {
  ADULT_ID,
  BOT_NUMBER,
  GROUP_ID,
  fakeLog,
  STRANGER_ID,
  makeConfig,
  makeStateDir,
  readFixture,
  readJsonLines,
  receiveNotification,
  sendRequests,
  startTransport,
  variant,
  waitFor,
  type Transport,
} from "../fixtures/signal-harness.ts";

const running: Transport[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
});

// Starts the transport against the fake, which replays `notifications` right after subscribe.
// startTransport resolves after the settle window, so by then every notification is journaled.
async function receive(stateDir: string, notifications: Array<string | object>, onEvent?: (event: InboundEvent) => void) {
  const events: InboundEvent[] = [];
  const transport = await startTransport(makeConfig(stateDir, { afterSubscribe: notifications }), {
    onEvent: onEvent ?? ((event) => void events.push(event)),
    log: () => {},
  });
  running.push(transport);
  return { transport, events };
}

// The journal ID of a group text from `sender` at `timestamp`.
function eventId(timestamp: number, sender = ADULT_ID): string {
  return `signal/${GROUP_ID}/${sender}:${timestamp}`;
}

function journal(stateDir: string) {
  return readJsonLines(join(stateDir, "inbox.jsonl"));
}

describe("what becomes an event", () => {
  test("a group text from an allowlisted adult produces one event with its text", async () => {
    const stateDir = makeStateDir();
    const { events } = await receive(stateDir, ["group-text.json"]);
    expect(events).toEqual([
      {
        id: eventId(1790806588504),
        kind: "text",
        memberId: "adult-one",
        memberName: "Adult One",
        text: "Tacos Tuesday?",
        timestamp: 1790806588504,
        mentionsBot: false,
        repliesToBot: false,
        receiptSeq: 1, // the first message the inbox journaled
      },
    ]);
  });

  test("a mention of the bot is flagged", async () => {
    const stateDir = makeStateDir();
    const { events } = await receive(stateDir, ["group-mention-of-bot.json"]);
    expect(events.length).toBe(1);
    expect(events[0].mentionsBot).toBe(true);
    expect(events[0].text).toContain("This is test message 4.");
  });

  test("a group text from an account not on the allowlist produces no event and no send", async () => {
    const stateDir = makeStateDir();
    const { events } = await receive(stateDir, [variant("group-text.json", { source: STRANGER_ID })]);
    expect(events).toEqual([]);
    expect(sendRequests(stateDir)).toEqual([]);
  });

  test("an attachment-only message from a stranger gets nothing either", async () => {
    const stateDir = makeStateDir();
    const { events } = await receive(stateDir, [variant("group-attachment-only.json", { source: STRANGER_ID })]);
    expect(events).toEqual([]);
    expect(sendRequests(stateDir)).toEqual([]);
  });

  test("a reaction produces no event and no send", async () => {
    const stateDir = makeStateDir();
    const { events } = await receive(stateDir, ["group-reaction.json"]);
    expect(events).toEqual([]);
    expect(sendRequests(stateDir)).toEqual([]);
  });

  test("receipt, typing, sync, story, and edit envelopes produce no event", async () => {
    const stateDir = makeStateDir();
    const base = { source: ADULT_ID, sourceUuid: ADULT_ID, sourceNumber: null, sourceDevice: 1 };
    // No typing, sync, or story envelope arrived during the capture; these carry the field
    // names from signal-cli 0.14.8's JsonMessageEnvelope.
    const typing = receiveNotification({ ...base, timestamp: 1790806700001, typingMessage: { action: "STARTED", timestamp: 1790806700001, groupId: GROUP_ID } });
    const sync = receiveNotification({ ...base, timestamp: 1790806700002, syncMessage: { sentMessage: { destination: BOT_NUMBER, timestamp: 1790806700002, message: "j" } } });
    const story = receiveNotification({ ...base, timestamp: 1790806700003, storyMessage: { allowsReplies: true } });

    const { events } = await receive(stateDir, ["receipt-delivery.json", typing, sync, story, "group-edit.json"]);
    expect(events).toEqual([]);
  });

  test("a text in a different group produces no event", async () => {
    const stateDir = makeStateDir();
    const other = variant("group-text.json", {});
    other.params.result.envelope.dataMessage.groupInfo.groupId = "T1RIRVItR1JPVVA=";
    const { events } = await receive(stateDir, [other]);
    expect(events).toEqual([]);
  });

  test("a direct message is never handed to the worker", async () => {
    const stateDir = makeStateDir();
    const { events } = await receive(stateDir, ["direct-message.json"]);
    expect(events).toEqual([]);
  });
});

describe("the inbox journal", () => {
  test("messages are journaled; receipts and reactions are not messages and never reach the journal", async () => {
    const stateDir = makeStateDir();
    await receive(stateDir, ["group-reaction.json", "receipt-delivery.json", "group-text.json"]);
    const received = journal(stateDir).filter((line) => line.type === "received").map((line) => line.id);
    expect(received).toEqual([eventId(1790806588504)]);
  });

  test("a stranger's text is journaled and marked handled at once; the adult's text waits for the worker", async () => {
    const stateDir = makeStateDir();
    await receive(stateDir, [variant("group-text.json", { source: STRANGER_ID }), "group-text.json"]);
    const lines = journal(stateDir);
    expect(lines.filter((line) => line.type === "received").length).toBe(2);
    expect(lines.filter((line) => line.type === "handled").map((line) => line.id)).toEqual([eventId(1790806588504, STRANGER_ID)]);
  });

  test("two envelopes with the same sender and timestamp produce one event", async () => {
    const stateDir = makeStateDir();
    const { events } = await receive(stateDir, ["group-text.json", "group-text.json"]);
    expect(events.length).toBe(1);
    expect(journal(stateDir).filter((line) => line.type === "received").length).toBe(1);
  });

  test("the same timestamp from a different sender is a different message", async () => {
    const stateDir = makeStateDir({
      botNumber: BOT_NUMBER,
      groupId: GROUP_ID,
      allowlist: [
        { name: "Adult One", accountId: ADULT_ID },
        { name: "Adult Two", accountId: STRANGER_ID },
      ],
    });
    // Adult Two must be a group member for the start-up check to pass.
    const groups = readFixture("rpc-listGroups-response.json");
    groups.result[0].members.push({ number: null, uuid: STRANGER_ID, isAdmin: false });
    const events: InboundEvent[] = [];
    const transport = await startTransport(
      makeConfig(stateDir, {
        listGroups: { result: groups.result },
        afterSubscribe: ["group-text.json", variant("group-text.json", { source: STRANGER_ID })],
      }),
      { onEvent: (event) => void events.push(event), log: () => {} },
    );
    running.push(transport);
    expect(events.map((event) => event.memberId)).toEqual(["adult-one", "adult-two"]);
  });

  test("an entry stays unhandled when the worker hand-off throws, and replays once after a restart with no new receive", async () => {
    const stateDir = makeStateDir();
    const first = await receive(stateDir, ["group-text.json"], () => {
      throw new Error("worker fell over");
    });
    await first.transport.stop();
    running.length = 0;

    // Restart: the fake receives nothing this time.
    const second = await receive(stateDir, []);
    expect(second.events.map((event) => event.id)).toEqual([eventId(1790806588504)]);
    expect(second.events[0].text).toBe("Tacos Tuesday?");
  });

  test("an entry the worker marked handled does not replay", async () => {
    const stateDir = makeStateDir();
    const first = await receive(stateDir, ["group-text.json"]);
    first.transport.markHandled(first.events[0].id);
    await first.transport.stop();
    running.length = 0;

    const second = await receive(stateDir, []);
    expect(second.events).toEqual([]);
  });

  test("a message redelivered by Signal after a restart is still dropped as a duplicate", async () => {
    const stateDir = makeStateDir();
    const first = await receive(stateDir, ["group-text.json"]);
    first.transport.markHandled(first.events[0].id);
    await first.transport.stop();
    running.length = 0;

    const second = await receive(stateDir, ["group-text.json"]);
    expect(second.events).toEqual([]);
  });

  test("a torn last line (crash mid-write) is skipped, and records written after it stay readable", async () => {
    const stateDir = makeStateDir();
    const first = await receive(stateDir, ["group-text.json"]);
    await first.transport.stop();
    running.length = 0;
    appendFileSync(join(stateDir, "inbox.jsonl"), '{"type":"received","id":"half');

    // The next start replays the text and journals a new message after the fragment.
    const later = variant("group-text.json", { timestamp: 1790806588504 + 5000 });
    const second = await receive(stateDir, [later]);
    expect(second.events.map((event) => event.timestamp)).toEqual([1790806588504, 1790806588504 + 5000]);
    // Handle only the replayed one; the new one must survive in the journal and replay.
    second.transport.markHandled(second.events[0].id);
    await second.transport.stop();
    running.length = 0;

    const third = await receive(stateDir, []);
    expect(third.events.map((event) => event.timestamp)).toEqual([1790806588504 + 5000]);
  });

  test("a message arriving after the start-up check is handed over live", async () => {
    const stateDir = makeStateDir();
    const events: InboundEvent[] = [];
    const transport = await startTransport(makeConfig(stateDir, { afterListGroups: ["group-text.json"] }), {
      onEvent: (event) => void events.push(event),
      log: () => {},
    });
    running.push(transport);
    await waitFor(() => events.length === 1);
    expect(events[0].text).toBe("Tacos Tuesday?");
  });
});

describe("reactions on group texts", () => {
  function reactions(stateDir: string) {
    return fakeLog(stateDir)
      .requests.filter((request) => request.method === "sendReaction")
      .map((request) => request.params);
  }

  test("a group text gets 👀 when it is handed to the worker, aimed at that message", async () => {
    const stateDir = makeStateDir();
    await receive(stateDir, ["group-text.json"]);
    await waitFor(() => reactions(stateDir).length === 1);
    expect(reactions(stateDir)).toEqual([
      { groupId: GROUP_ID, emoji: "👀", targetAuthor: ADULT_ID, targetTimestamp: 1790806588504 },
    ]);
  });

  test("the worker marking it handled swaps in ✅", async () => {
    const stateDir = makeStateDir();
    const { transport, events } = await receive(stateDir, ["group-text.json"]);
    transport.markHandled(events[0].id);
    await waitFor(() => reactions(stateDir).length === 2);
    expect(reactions(stateDir).map((params) => params.emoji)).toEqual(["👀", "✅"]);
    expect(reactions(stateDir)[1].targetTimestamp).toBe(1790806588504);
  });

  test("dropped messages (a reaction, a stranger's text) get no reaction", async () => {
    const stateDir = makeStateDir();
    await receive(stateDir, ["group-reaction.json", variant("group-text.json", { source: STRANGER_ID })]);
    expect(reactions(stateDir)).toEqual([]);
  });

  test("a failed reaction is logged only: the event still reaches the worker and nothing is recorded for the checker", async () => {
    const stateDir = makeStateDir();
    const lines: string[] = [];
    const events: InboundEvent[] = [];
    const config = makeConfig(stateDir, {
      afterSubscribe: ["group-text.json"],
      sendReaction: { error: { code: -1, message: "nope" } },
    });
    const transport = await startTransport(config, { onEvent: (event) => void events.push(event), log: (line) => lines.push(line) });
    running.push(transport);
    await waitFor(() => lines.some((line) => line.includes("reaction 👀")));
    expect(events.length).toBe(1);
    expect(existsSync(join(stateDir, "send-failures.jsonl"))).toBe(false);
  });

  test("a dry run sends no reaction", async () => {
    const stateDir = makeStateDir();
    const lines: string[] = [];
    const config = makeConfig(stateDir, { afterSubscribe: ["group-text.json"] }, { dryRun: true });
    const transport = await startTransport(config, { onEvent: () => {}, log: (line) => lines.push(line) });
    running.push(transport);
    expect(reactions(stateDir)).toEqual([]);
    expect(lines.some((line) => line.startsWith("DRY RUN: would acknowledge (received)"))).toBe(true);
  });
});
