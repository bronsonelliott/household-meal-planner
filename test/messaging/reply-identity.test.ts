// "Which message is this a reply to?" and "what is the ID of the message the bot just posted?", on
// every platform. The house-rules interview uses the pair to tell a "looks good" that answers the
// latest read-back from one that does not. Each adapter names messages its own way; both halves
// must name them the same way, so a reply's ID equals the ID the send reported.

import { describe, expect, test } from "bun:test";
import { routeMessage } from "../../src/messaging/router.ts";
import { normalizeEnvelope } from "../../src/messaging/signal/adapter.ts";
import { sortSendAnswer as sortSignal } from "../../src/messaging/signal/results.ts";
import { sortSendAnswer as sortTelegram } from "../../src/messaging/telegram/results.ts";
import { normalizeUpdate } from "../../src/messaging/telegram/normalize.ts";
import { parseWebhook } from "../../src/messaging/whatsapp/webhook.ts";
import { sortSendAnswer as sortWhatsApp } from "../../src/messaging/whatsapp/results.ts";
import { sortSendAnswer as sortIMessage } from "../../src/messaging/imessage/results.ts";
import { readMessage } from "../../src/messaging/imessage/normalize.ts";
import type { IncomingMessage } from "../../src/messaging/types.ts";
import { BOT } from "../fixtures/fake-telegram-api.ts";

describe("Telegram", () => {
  const update = (message: object) => ({ update_id: 1, message: { message_id: 9, date: 1_790_000_000, chat: { id: -100, type: "supergroup" }, from: { id: 1001, is_bot: false, first_name: "Alex" }, text: "looks good", ...message } });
  const normalize = (message: object) => normalizeUpdate(update(message), BOT, (id) => String(id)) as { message: IncomingMessage };

  test("a reply carries the replied-to message's ID; a plain message carries none", () => {
    expect(normalize({ reply_to_message: { message_id: 42, from: { id: BOT.id, is_bot: true } } }).message.replyToNativeId).toBe("42");
    expect(normalize({}).message.replyToNativeId).toBeUndefined();
  });

  test("a send reports the ID Telegram gave the message", () => {
    expect(sortTelegram({ kind: "ok", result: { message_id: 42, date: 1_790_000_100 } })).toEqual({ kind: "sent", timestamp: 1_790_000_100_000, nativeId: "42" });
  });
});

describe("Signal", () => {
  const envelope = (dataMessage: object) => ({ sourceUuid: "alex-uuid", timestamp: 1_790_000_000_000, dataMessage: { message: "looks good", groupInfo: { groupId: "G" }, ...dataMessage } });

  test("a quote carries the quoted message's timestamp; no quote carries none", () => {
    const quoted = normalizeEnvelope(envelope({ quote: { id: 1_789_999_999_000, authorNumber: "+15550000000" } }), "+15550000000") as { message: IncomingMessage };
    expect(quoted.message.replyToNativeId).toBe("1789999999000");
    expect(quoted.message.repliesToBot).toBe(true);
    expect((normalizeEnvelope(envelope({}), "+15550000000") as { message: IncomingMessage }).message.replyToNativeId).toBeUndefined();
  });

  test("a send reports its timestamp as the ID, the same one a later quote of it carries", () => {
    const outcome = sortSignal({ kind: "result", result: { timestamp: 1_789_999_999_000, results: [{ type: "SUCCESS" }] } });
    expect(outcome).toEqual({ kind: "sent", timestamp: 1_789_999_999_000, nativeId: "1789999999000" });
  });
});

describe("WhatsApp", () => {
  const webhook = (message: object) => ({
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN" }, contacts: [], messages: [{ from: "15551230001", id: "wamid.NEW", timestamp: "1790000000", type: "text", text: { body: "looks good" }, ...message }] } }] }],
  });

  test("a reply carries context.id; a plain message carries none", () => {
    expect(parseWebhook(webhook({ context: { from: "15550000000", id: "wamid.BOT1" } }), "PN").messages[0]!.replyToNativeId).toBe("wamid.BOT1");
    expect(parseWebhook(webhook({}), "PN").messages[0]!.replyToNativeId).toBeUndefined();
  });

  test("a send reports Meta's message ID", () => {
    expect(sortWhatsApp({ kind: "ok", body: { messages: [{ id: "wamid.BOT1" }] } }, () => 5)).toEqual({ kind: "sent", timestamp: 5, nativeId: "wamid.BOT1" });
  });
});

describe("iMessage", () => {
  test("a threaded reply carries its originator's guid, without any prefix; a plain message carries none", () => {
    const base = { guid: "G1", text: "looks good", dateCreated: 1, isFromMe: false, chats: [{ guid: "iMessage;+;chat1" }], handle: { address: "+15551230001" } };
    expect(readMessage({ ...base, threadOriginatorGuid: "p:0/OUT-1" })!.threadOriginatorGuid).toBe("OUT-1");
    expect(readMessage(base)!.threadOriginatorGuid).toBeNull();
  });

  test("a send reports the server's guid, the same name a reply to it uses", () => {
    expect(sortIMessage({ kind: "ok", body: { status: 200, data: { guid: "p:0/OUT-1" } } }, () => 7)).toEqual({ kind: "sent", timestamp: 7, nativeId: "OUT-1" });
  });
});

describe("the router carries the field to the worker", () => {
  const message: IncomingMessage = {
    platform: "telegram",
    conversationId: "-100",
    nativeId: "9",
    sender: { identity: "1001", displayName: "Alex" },
    isGroup: true,
    text: "looks good",
    hasAttachments: false,
    mentionsBot: false,
    repliesToBot: true,
    replyToNativeId: "42",
    timestamp: 1,
  };
  const context = { platform: "telegram" as const, mode: "group" as const, members: [{ id: "alex", name: "Alex", role: "admin" as const, identities: { telegram: "1001" } }], conversationId: "-100" };

  test("replyToNativeId reaches the event, and is absent when the message had none", () => {
    const routed = routeMessage(message, "telegram/-100/9", context);
    expect(routed.action === "event" && routed.event.replyToNativeId).toBe("42");
    const plain = routeMessage({ ...message, replyToNativeId: undefined }, "telegram/-100/9", context);
    expect(plain.action === "event" && "replyToNativeId" in plain.event).toBe(false);
  });
});
