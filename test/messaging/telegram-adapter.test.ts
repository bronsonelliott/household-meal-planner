// The Telegram adapter's own behaviour, against the fake Bot API: the offset, who counts as a
// sender, mentions and commands, how sends end, group migration, privacy mode, health, and that
// the bot token never reaches a log.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseConfig, StartupError } from "../../src/config.ts";
import { createAdapter } from "../../src/messaging/index.ts";
import { startMessenger, type Messenger } from "../../src/messaging/messenger.ts";
import { normalizeUpdate } from "../../src/messaging/telegram/normalize.ts";
import { diagnoseTelegram, PRIVACY_MODE_NOTE } from "../../src/messaging/telegram/diagnose.ts";
import { TelegramAdapter } from "../../src/messaging/telegram/adapter.ts";
import { telegramAdapterConfig } from "../../src/messaging/telegram/settings.ts";
import type { AdapterHandlers, IncomingMessage, InboundEvent } from "../../src/messaging/types.ts";
import {
  ALEX_ID,
  BOT,
  FakeTelegramApi,
  FAKE_TOKEN,
  freshStateDir,
  GROUP_CHAT_ID,
  SAM_ID,
  STRANGER_ID,
  SUPERGROUP_CHAT_ID,
  TEST_MEMBERS,
  telegramAdapter,
  telegramConfig,
} from "../fixtures/fake-telegram-api.ts";

let api: FakeTelegramApi;
let stateDir: string;
const running: Array<{ stop(): Promise<void> }> = [];

beforeEach(() => {
  api = new FakeTelegramApi();
  stateDir = freshStateDir();
});
afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
  api.stop();
});

async function eventually(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("eventually: condition not met in time");
    await Bun.sleep(10);
  }
}

// The real messenger around the real adapter, the way bridge.ts runs them.
async function boot(options: { mode?: "group" | "household-dms"; adapter?: TelegramAdapter } = {}) {
  const events: InboundEvent[] = [];
  const logs: string[] = [];
  const mode = options.mode ?? "group";
  const adapter = options.adapter ?? telegramAdapter(api, stateDir, { mode, chatId: mode === "group" ? GROUP_CHAT_ID : null });
  const messenger: Messenger = await startMessenger(adapter, {
    mode,
    members: TEST_MEMBERS,
    stateDir,
    dryRun: false,
    onEvent: (event) => void events.push(event),
    log: (line) => logs.push(line),
    sleep: async () => {},
    healthIntervalMs: 60 * 60 * 1000,
  });
  running.push(messenger);
  return { adapter, messenger, events, logs };
}

// An adapter on its own, with hand-written handlers, for tests that watch the hand-over itself.
function bareHandlers(onMessage: (message: IncomingMessage) => Promise<void>): AdapterHandlers & { logs: string[]; fatal: string[] } {
  const logs: string[] = [];
  const fatal: string[] = [];
  return { onMessage, onFatal: (reason) => void fatal.push(reason), log: (line) => void logs.push(line), logs, fatal };
}

function journal(): any[] {
  const path = join(stateDir, "inbox.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const offsetFile = () => join(stateDir, "telegram-offset.json");
const readOffset = () => JSON.parse(readFileSync(offsetFile(), "utf8")).offset;

// ---------------------------------------------------------------------------------------

describe("the update offset", () => {
  test("it is saved after the messages are journaled, and a restart asks for it", async () => {
    const first = await boot();
    const lastId = (api.push({ text: "one" }), api.push({ text: "two" }));
    await eventually(() => first.events.length === 2);
    await eventually(() => existsSync(offsetFile()) && readOffset() === lastId + 1);
    await first.messenger.stop();
    running.length = 0;

    api.requests.length = 0;
    const second = await boot();
    expect(api.calls("getUpdates")[0].offset).toBe(lastId + 1);
    expect(second.events.map((event) => event.text)).toEqual(["one", "two"]); // replayed from the journal, not from Telegram
    expect(api.pending()).toBe(0);
  });

  test("it does not move while the journal write is still pending", async () => {
    api.push({ text: "hello" });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const adapter = telegramAdapter(api, stateDir);
    running.push(adapter);
    const handlers = bareHandlers(() => gate);

    const starting = adapter.start(handlers); // start-up waits for the journal write too
    await Bun.sleep(100);
    expect(existsSync(offsetFile())).toBe(false);
    release();
    await starting;
    expect(readOffset()).toBeGreaterThan(100);
  });

  test("a journal write that fails leaves the offset alone, and the message comes again", async () => {
    const adapter = telegramAdapter(api, stateDir);
    running.push(adapter);
    const seen: string[] = [];
    let failures = 1;
    const handlers = bareHandlers(async (message) => {
      if (failures-- > 0) throw new Error("disk full");
      seen.push(message.text);
    });
    api.push({ text: "hello" });
    await adapter.start(handlers).catch(() => {}); // the start-up drain hits the failure
    // Start again as the bridge would after exiting: nothing was lost.
    const again = telegramAdapter(api, stateDir);
    running.push(again);
    await again.start(handlers);
    expect(seen).toEqual(["hello"]);
  });

  test("crash after the journal write but before the offset moved: no loss, and no double apply", async () => {
    const first = await boot();
    api.push({ text: "Tacos Tuesday?" });
    await eventually(() => first.events.length === 1);
    await eventually(() => existsSync(offsetFile()));
    await first.messenger.stop();
    running.length = 0;

    // The crash: the message is journaled, the offset never reached the disk.
    rmSync(offsetFile());
    // (and Telegram still holds the message, because the offset never moved)
    api.push({ text: "Tacos Tuesday?", messageId: 1 }); // the same Telegram message, delivered again

    const second = await boot();
    expect(second.events.map((event) => event.text)).toEqual(["Tacos Tuesday?"]); // one replay of the unhandled message
    expect(journal().filter((line) => line.type === "received").length).toBe(1); // not journaled twice
    expect(second.logs.some((line) => line.includes("dropped duplicate"))).toBe(true);

    // Once the worker has finished it, a restart with the same stale redelivery does nothing.
    second.messenger.markHandled(second.events[0]!.id);
    await second.messenger.stop();
    running.length = 0;
    rmSync(offsetFile());
    api.push({ text: "Tacos Tuesday?", messageId: 1 });
    const third = await boot();
    expect(third.events).toEqual([]);
  });

  test("it asks Telegram only for new messages, and ignores an edit that arrives anyway", async () => {
    const run = await boot();
    api.pushUpdate({ edited_message: { message_id: 5, date: 1, chat: { id: Number(GROUP_CHAT_ID), type: "supergroup" }, from: { id: Number(ALEX_ID), is_bot: false }, text: "edited" } });
    api.push({ text: "real one" });
    await eventually(() => run.events.length === 1);
    expect(run.events[0]!.text).toBe("real one");
    expect(api.calls("getUpdates")[0].allowed_updates).toEqual(["message"]);
    expect(api.calls("deleteWebhook").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------

describe("reading a Telegram message", () => {
  const bot = { id: BOT.id, username: BOT.username };
  const logical = (id: number) => String(id);
  function normalize(message: Record<string, unknown>) {
    return normalizeUpdate(
      { update_id: 1, message: { message_id: 7, date: 1_790_000_000, chat: { id: -100, type: "supergroup" }, from: { id: 1001, is_bot: false, first_name: "Alex" }, ...message } },
      bot,
      logical,
    );
  }
  const asMessage = (result: ReturnType<typeof normalize>) => ("message" in result ? result.message : null);

  test("a plain message becomes the shared shape, named by user ID rather than display name", () => {
    const message = asMessage(normalize({ text: "Tacos Tuesday?" }))!;
    expect(message).toMatchObject({
      platform: "telegram",
      conversationId: "-100",
      nativeId: "7",
      sender: { identity: "1001", displayName: "Alex" },
      isGroup: true,
      text: "Tacos Tuesday?",
      hasAttachments: false,
      mentionsBot: false,
      repliesToBot: false,
      timestamp: 1_790_000_000_000,
    });
  });

  test("a private chat is not a group", () => {
    expect(asMessage(normalize({ text: "hi", chat: { id: 1001, type: "private" } }))).toMatchObject({ isGroup: false, conversationId: "1001" });
  });

  test("an @mention of this bot is a mention; one of another name is not", () => {
    const mine = asMessage(normalize({ text: `@${BOT.username} what's for dinner`, entities: [{ type: "mention", offset: 0, length: BOT.username.length + 1 }] }))!;
    expect(mine.mentionsBot).toBe(true);
    const other = asMessage(normalize({ text: "@someone_else hi", entities: [{ type: "mention", offset: 0, length: 13 }] }))!;
    expect(other.mentionsBot).toBe(false);
  });

  test("a text_mention (a mention of a bot with no username shown) matches on the bot's ID", () => {
    const text = "Dinner Bot, swap Monday";
    const mine = asMessage(normalize({ text, entities: [{ type: "text_mention", offset: 0, length: 10, user: { id: BOT.id } }] }))!;
    expect(mine.mentionsBot).toBe(true);
    const other = asMessage(normalize({ text, entities: [{ type: "text_mention", offset: 0, length: 10, user: { id: 5 } }] }))!;
    expect(other.mentionsBot).toBe(false);
  });

  test("/command@thisbot becomes /command and counts as a mention; /command@otherbot is ignored", () => {
    const mine = asMessage(normalize({ text: `/sources@${BOT.username.toUpperCase()} add example.com`, entities: [{ type: "bot_command", offset: 0, length: BOT.username.length + 9 }] }))!;
    expect(mine.text).toBe("/sources add example.com");
    expect(mine.mentionsBot).toBe(true);
    expect(normalize({ text: "/sources@another_bot", entities: [{ type: "bot_command", offset: 0, length: 20 }] })).toEqual({ ignored: "command for another bot" });
    // A plain command is left exactly as typed.
    expect(asMessage(normalize({ text: "/sources", entities: [{ type: "bot_command", offset: 0, length: 8 }] }))!.text).toBe("/sources");
  });

  test("a reply to one of the bot's messages is a reply to the bot", () => {
    expect(asMessage(normalize({ text: "yes please", reply_to_message: { message_id: 3, from: { id: BOT.id, is_bot: true } } }))!.repliesToBot).toBe(true);
    expect(asMessage(normalize({ text: "yes please", reply_to_message: { message_id: 3, from: { id: 1002, is_bot: false } } }))!.repliesToBot).toBe(false);
  });

  test("a caption counts as text, and a photo or sticker with no words is an attachment", () => {
    const captioned = asMessage(normalize({ caption: "our fridge", photo: [{ file_id: "x" }] }))!;
    expect(captioned).toMatchObject({ text: "our fridge", hasAttachments: true });
    expect(asMessage(normalize({ photo: [{ file_id: "x" }] }))).toMatchObject({ text: "", hasAttachments: true });
    expect(asMessage(normalize({ sticker: { file_id: "x" } }))).toMatchObject({ text: "", hasAttachments: true });
    expect(asMessage(normalize({ document: { file_id: "x" } }))).toMatchObject({ hasAttachments: true });
  });

  test("an anonymous admin, a channel post, a bot, and a message with no sender are all rejected", () => {
    expect(normalize({ text: "x", sender_chat: { id: -100, type: "supergroup" }, from: { id: 1087968824, is_bot: true, first_name: "Group" } })).toHaveProperty("ignored");
    expect(normalize({ text: "x", chat: { id: -200, type: "channel" } })).toEqual({ ignored: "channel post" });
    expect(normalize({ text: "x", from: { id: 55, is_bot: true, first_name: "Other bot" } })).toEqual({ ignored: "sent by a bot" });
    expect(normalize({ text: "x", is_automatic_forward: true })).toHaveProperty("ignored");
    expect(normalize({ text: "x", from: undefined })).toEqual({ ignored: "no sender" });
  });

  test("end to end: an anonymous admin who claims to be Alex gets nothing", async () => {
    const run = await boot();
    api.push({ text: "Swap Monday for pizza", extra: { sender_chat: { id: Number(GROUP_CHAT_ID), type: "supergroup" } }, from: "1087968824", fromBot: true });
    api.push({ text: "from a stranger", from: STRANGER_ID, firstName: "Alex" });
    api.push({ text: "from Sam", from: SAM_ID });
    await eventually(() => run.events.length === 1);
    expect(run.events[0]).toMatchObject({ memberId: "sam", text: "from Sam" });
    expect(api.sends()).toEqual([]);
    expect(api.calls("setMessageReaction").map((call) => call.message_id).length).toBe(1); // only Sam's message was acknowledged
  });

  test("end to end: mention, command and reply reach the worker with the right flags", async () => {
    const run = await boot();
    api.push({ text: `@${BOT.username} lock it`, entities: [{ type: "mention", offset: 0, length: BOT.username.length + 1 }] });
    api.push({ text: `/recipes@${BOT.username} status`, entities: [{ type: "bot_command", offset: 0, length: BOT.username.length + 9 }] });
    api.push({ text: "yes", extra: { reply_to_message: { message_id: 1, from: { id: BOT.id, is_bot: true } } } });
    await eventually(() => run.events.length === 3);
    expect(run.events.map((event) => [event.text, event.mentionsBot, event.repliesToBot])).toEqual([
      [`@${BOT.username} lock it`, true, false],
      ["/recipes status", true, false],
      ["yes", false, true],
    ]);
  });
});

// ---------------------------------------------------------------------------------------

describe("sending", () => {
  async function started(overrides: Partial<ReturnType<typeof telegramConfig>> = {}) {
    const adapter = telegramAdapter(api, stateDir, overrides);
    running.push(adapter);
    const handlers = bareHandlers(async () => {});
    await adapter.start(handlers);
    return { adapter, handlers };
  }

  test("plain text goes out with no parse mode", async () => {
    const { adapter } = await started();
    const outcome = await adapter.sendToConversation("Monday: *tacos* _and_ [links](x)");
    expect(outcome.kind).toBe("sent");
    expect(api.sends()).toEqual([{ chat_id: Number(GROUP_CHAT_ID), text: "Monday: *tacos* _and_ [links](x)" }]);
  });

  test("429 with retry_after: a transient failure that carries the wait", async () => {
    api.scriptSends([{ error: 429, description: "Too Many Requests: retry after 7", parameters: { retry_after: 7 } }]);
    const { adapter } = await started();
    expect(await adapter.sendToConversation("hi")).toMatchObject({ kind: "failed", transient: true, retryAfterMs: 7000, failureClass: "rate-limited" });
  });

  test("403 and 400 (bot removed, chat gone): failed for good, never retried", async () => {
    api.scriptSends([{ error: 403, description: "Forbidden: bot was kicked from the supergroup chat" }]);
    const { adapter } = await started();
    const outcome = await adapter.sendToConversation("hi");
    expect(outcome.kind).toBe("failed");
    expect(outcome).not.toHaveProperty("transient");
    api.scriptSends([{ error: 400, description: "Bad Request: chat not found" }]);
    expect((await adapter.sendToConversation("hi")).kind).toBe("failed");
  });

  test("through the shared sender, a 403 is one attempt and one failure record", async () => {
    api.scriptSends([{ error: 403, description: "Forbidden: bot was kicked" }]);
    const run = await boot();
    const outcome = await run.messenger.sendToConversation("hi");
    expect(outcome.kind).toBe("failed");
    expect(api.sends().length).toBe(1);
    const failures = readFileSync(join(stateDir, "send-failures.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(failures.map((record) => record.class)).toEqual(["send-failed"]);
  });

  test("no answer in time is Unknown", async () => {
    api.scriptSends([{ hang: true }]);
    const { adapter } = await started();
    expect((await adapter.sendToConversation("hi")).kind).toBe("unknown");
  });

  test("any 5xx answer to a send, a gateway error included, may have been accepted, so it is Unknown and never retried", async () => {
    const { adapter } = await started();
    for (const status of [500, 502, 503]) {
      api.scriptSends([{ error: status, description: "Server trouble" }]);
      const outcome = await adapter.sendToConversation("hi");
      expect(outcome.kind).toBe("unknown");
      expect(outcome).not.toHaveProperty("transient");
    }
  });

  test("a connection that cannot be made is a clean, retryable failure", async () => {
    const { adapter } = await started();
    api.stop();
    expect(await adapter.sendToConversation("hi")).toMatchObject({ kind: "failed", transient: true });
  });

  test("a long reply is cut at 4096 characters and nothing is lost", async () => {
    const run = await boot();
    const text = Array.from({ length: 220 }, (_, index) => `Line ${index}: ${"y".repeat(40)}`).join("\n");
    expect(text.length).toBeGreaterThan(9000);
    expect((await run.messenger.sendToConversation(text, "long-1")).kind).toBe("sent");
    const parts = api.sends().map((send) => send.text);
    expect(parts.length).toBe(3);
    expect(parts.every((part) => part.length <= 4096)).toBe(true);
    expect(parts.join("\n")).toBe(text);
  });

  test("household-dms: each member is written to by their user ID", async () => {
    const run = await boot({ mode: "household-dms" });
    expect((await run.messenger.sendToConversation("Monday: tacos")).kind).toBe("sent");
    expect(api.sends().map((send) => send.chat_id)).toEqual([Number(ALEX_ID), Number(SAM_ID)]);
  });

  test("household-dms: a private message from a member is the conversation, a group message is not", async () => {
    const run = await boot({ mode: "household-dms" });
    api.push({ text: "in the group", from: ALEX_ID });
    api.push({ text: "in private", from: ALEX_ID, chat: ALEX_ID });
    await eventually(() => run.events.length === 1);
    expect(run.events[0]!.text).toBe("in private");
  });
});

// ---------------------------------------------------------------------------------------

describe("acknowledgements", () => {
  test("they use reactions Telegram allows: 👀 when received, 👍 when handled (✅ is not on its list)", async () => {
    const run = await boot();
    api.push({ text: "hi" });
    await eventually(() => run.events.length === 1);
    run.messenger.markHandled(run.events[0]!.id);
    await eventually(() => api.calls("setMessageReaction").length === 2);
    expect(api.calls("setMessageReaction").map((call) => call.reaction)).toEqual([[{ type: "emoji", emoji: "👀" }], [{ type: "emoji", emoji: "👍" }]]);
    expect(api.calls("setMessageReaction")[0].chat_id).toBe(Number(GROUP_CHAT_ID));
  });

  test("a rejected reaction is logged and the message is still handled", async () => {
    api.override("setMessageReaction", { error: 400, description: "Bad Request: REACTION_INVALID" });
    const run = await boot();
    api.push({ text: "hi" });
    await eventually(() => run.events.length === 1);
    run.messenger.markHandled(run.events[0]!.id);
    await eventually(() => run.logs.filter((line) => line.includes("failed")).length >= 2);
    expect(journal().some((line) => line.type === "handled" && line.reason === "handled by the worker")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------

describe("a group upgraded to a supergroup", () => {
  test("a send to the old ID follows the new one, remembers it, and says what to change", async () => {
    api.migrateChat(GROUP_CHAT_ID, SUPERGROUP_CHAT_ID);
    // Telegram already knows the move at start-up (getChat on the old ID names the new one).
    const run = await boot();
    expect(run.logs.some((line) => line.includes(SUPERGROUP_CHAT_ID) && line.includes("messaging.telegram.chatId"))).toBe(true);
    expect((await run.messenger.sendToConversation("Monday: tacos")).kind).toBe("sent");
    expect(api.sends().map((send) => String(send.chat_id))).toEqual([SUPERGROUP_CHAT_ID]);
    expect(JSON.parse(readFileSync(join(stateDir, "telegram-chat.json"), "utf8"))).toEqual({ configured: GROUP_CHAT_ID, current: SUPERGROUP_CHAT_ID });
  });

  test("a migration discovered mid-send is followed once, with no double post", async () => {
    const run = await boot();
    api.migrateChat(GROUP_CHAT_ID, SUPERGROUP_CHAT_ID); // happens after start-up
    expect((await run.messenger.sendToConversation("Monday: tacos")).kind).toBe("sent");
    const sends = api.sends().map((send) => String(send.chat_id));
    expect(sends).toEqual([GROUP_CHAT_ID, SUPERGROUP_CHAT_ID]); // the first was refused outright, the second posted
    expect(run.logs.some((line) => line.includes("upgraded"))).toBe(true);
  });

  test("messages from the new chat are routed as the household group, and replies and reactions go to the new ID", async () => {
    const run = await boot();
    api.migrateChat(GROUP_CHAT_ID, SUPERGROUP_CHAT_ID);
    api.pushUpdate({ message: { message_id: 900, date: 1, chat: { id: Number(SUPERGROUP_CHAT_ID), type: "supergroup" }, migrate_from_chat_id: Number(GROUP_CHAT_ID), from: { id: Number(ALEX_ID), is_bot: false } } });
    api.push({ chat: SUPERGROUP_CHAT_ID, text: "still here?" });
    await eventually(() => run.events.length === 1);
    expect(run.events[0]!.id).toBe(`telegram/${GROUP_CHAT_ID}/${journal().filter((line) => line.type === "received").at(-1).message.nativeId}`);
    await eventually(() => api.calls("setMessageReaction").length === 1);
    expect(api.calls("setMessageReaction")[0].chat_id).toBe(Number(SUPERGROUP_CHAT_ID));
  });

  test("a restart keeps using the saved new ID, until the config is updated to it", async () => {
    api.migrateChat(GROUP_CHAT_ID, SUPERGROUP_CHAT_ID);
    const first = await boot();
    await first.messenger.stop();
    running.length = 0;
    api.requests.length = 0;

    const second = await boot();
    expect(api.calls("getChat")[0].chat_id).toBe(Number(SUPERGROUP_CHAT_ID)); // straight to the new ID
    await second.messenger.stop();
    running.length = 0;

    // The admin edits config.toml to the new ID: the saved note is stale and must not interfere.
    const updated = telegramAdapter(api, stateDir, { chatId: SUPERGROUP_CHAT_ID });
    const third = await boot({ adapter: updated });
    expect((await third.messenger.sendToConversation("hi")).kind).toBe("sent");
    expect(String(api.sends().at(-1)!.chat_id)).toBe(SUPERGROUP_CHAT_ID);
  });
});

// ---------------------------------------------------------------------------------------

describe("start-up checks, privacy mode and health", () => {
  async function failsWith(adapter: TelegramAdapter): Promise<string> {
    try {
      await startMessenger(adapter, { mode: "group", members: TEST_MEMBERS, stateDir, dryRun: false, onEvent: () => {}, log: () => {} });
    } catch (error) {
      expect(error).toBeInstanceOf(StartupError);
      return (error as Error).message;
    }
    throw new Error("expected start-up to fail");
  }

  test("a rejected token, a missing token, a missing chat ID, and a missing member ID stop start-up with a plain reason", async () => {
    expect(await failsWith(telegramAdapter(api, stateDir, { token: "wrong:token" }))).toContain("rejected the bot token");
    expect(await failsWith(telegramAdapter(api, stateDir, { token: "" }))).toContain("token is not set");
    expect(await failsWith(telegramAdapter(api, stateDir, { chatId: "" }))).toContain("chat ID is not set");
    expect(await failsWith(telegramAdapter(api, stateDir, { members: [{ id: "alex", name: "Alex", userId: "" }] }))).toContain("Alex has no Telegram user ID");
  });

  test("a chat the bot cannot open, or a bot that was removed, stops start-up", async () => {
    api.override("getChat", { error: 400, description: "Bad Request: chat not found" });
    expect(await failsWith(telegramAdapter(api, stateDir))).toContain("cannot open the household chat");
    api.override("getChat", null);
    api.botStatusInGroup = "kicked";
    expect(await failsWith(telegramAdapter(api, stateDir))).toContain("not in the Telegram group");
  });

  test("privacy mode on: healthy, but the start-up log and the health reason say what the bot cannot see", async () => {
    api.canReadAllGroupMessages = false;
    const run = await boot();
    expect(run.logs.some((line) => line.includes("privacy mode is ON") && line.includes("BotFather"))).toBe(true);
    const health = await run.messenger.checkHealth();
    expect(health.healthy).toBe(true);
    expect(health.reason).toContain("privacy mode");
  });

  test("privacy mode off, or the bot is a group admin: no warning", async () => {
    const off = await boot();
    expect(off.logs.some((line) => line.includes("privacy"))).toBe(false);
    expect((await off.messenger.checkHealth()).reason).toBe("ok");
    await off.messenger.stop();
    running.length = 0;

    api.canReadAllGroupMessages = false;
    api.botStatusInGroup = "administrator";
    const admin = await boot();
    expect(admin.logs.some((line) => line.includes("privacy"))).toBe(false);
  });

  test("health fails when the bot is out of the group, and when polling is failing, and recovers", async () => {
    const run = await boot();
    expect((await run.messenger.checkHealth()).healthy).toBe(true);

    api.override("getChat", { error: 403, description: "Forbidden: bot was kicked" });
    expect(await run.messenger.checkHealth()).toMatchObject({ healthy: false });
    api.override("getChat", null);

    api.override("getUpdates", { error: 502, description: "Bad Gateway" });
    await eventually(() => run.logs.some((line) => line.includes("polling problem")));
    expect((await run.messenger.checkHealth()).healthy).toBe(false);
    api.override("getUpdates", null);
    await eventually(() => api.calls("getUpdates").length > 3);
    await Bun.sleep(150);
    expect((await run.messenger.checkHealth()).healthy).toBe(true);
  });

  test("an idle long poll that answers a little late is not a problem (the request timeout allows for the poll)", async () => {
    // The general request timeout is tiny here; the poll's own limit must still be poll time + slack.
    api.holdCapMs = 100;
    api.idleAnswerLateMs = 700;
    const adapter = telegramAdapter(api, stateDir, { pollTimeoutSec: 1, requestTimeoutMs: 100 });
    const run = await boot({ adapter });
    await eventually(() => api.calls("getUpdates").length >= 2, 4000);
    expect(run.logs.some((line) => line.includes("polling problem"))).toBe(false);
    expect((await run.messenger.checkHealth()).healthy).toBe(true);
  });

  test("polling carries on through errors and picks the message up afterwards", async () => {
    const run = await boot();
    api.override("getUpdates", { error: 502, description: "Bad Gateway" });
    api.push({ text: "sent during the outage" });
    await Bun.sleep(100);
    expect(run.events).toEqual([]);
    api.override("getUpdates", null);
    await eventually(() => run.events.length === 1);
  });

  test("Telegram turning the token down while polling is fatal, so the bridge restarts", async () => {
    const adapter = telegramAdapter(api, stateDir);
    running.push(adapter);
    const handlers = bareHandlers(async () => {});
    await adapter.start(handlers);
    api.override("getUpdates", { error: 401, description: "Unauthorized" });
    await eventually(() => handlers.fatal.length === 1);
  });

  test("doctor --online: reports the bot, the group and the privacy warning; a bad token is a problem", async () => {
    api.canReadAllGroupMessages = false;
    const good = await diagnoseTelegram(telegramConfig(api, stateDir));
    expect(good.problems).toEqual([]);
    expect(good.lines.join("\n")).toContain(`@${BOT.username}`);
    expect(good.lines.join("\n")).toContain(PRIVACY_MODE_NOTE);
    const bad = await diagnoseTelegram(telegramConfig(api, stateDir, { token: "nope:nope" }));
    expect(bad.problems.length).toBe(1);
    expect(bad.problems[0]).not.toContain("nope:nope");
  });
});

// ---------------------------------------------------------------------------------------

describe("the token stays secret", () => {
  test("it never appears in logs, outcomes, failure records or errors, even when calls fail", async () => {
    api.scriptSends([{ error: 403, description: "Forbidden" }, { hang: true }, { error: 429, description: "slow down", parameters: { retry_after: 1 } }]);
    const run = await boot();
    const outcomes = [];
    for (let i = 0; i < 3; i++) outcomes.push(await run.messenger.sendToConversation(`message ${i}`, `key-${i}`));
    api.override("getUpdates", { error: 502, description: "Bad Gateway" });
    await Bun.sleep(100);
    api.stop(); // connection refused from here on
    outcomes.push(await run.messenger.sendToConversation("after the server went away", "key-3"));
    await Bun.sleep(100);

    const everything = [
      ...run.logs,
      JSON.stringify(outcomes),
      ...["send-failures.jsonl", "outbox.jsonl", "inbox.jsonl"].map((name) => (existsSync(join(stateDir, name)) ? readFileSync(join(stateDir, name), "utf8") : "")),
    ].join("\n");
    expect(everything).not.toContain(FAKE_TOKEN);
    expect(everything).not.toContain("FAKE-token");
    expect(everything).not.toContain("/bot123456");
  });
});

// ---------------------------------------------------------------------------------------

describe("wiring", () => {
  const configText = [
    '[household]\nname = "Test"',
    '[[members]]\nid = "alex"\nname = "Alex"\nrole = "admin"\n[members.identities]\ntelegram = "1001"',
    '[schedule]\ntimezone = "America/Chicago"',
    '[messaging]\nplatform = "telegram"',
    '[messaging.telegram]\nchatId = "-1001234567890"\nbotTokenEnv = "MY_TELEGRAM_TOKEN"',
  ].join("\n");

  test("createAdapter builds the Telegram adapter, reading the token from the named variable", () => {
    const config = parseConfig(configText, { baseDir: "/base", env: {} });
    const env = { MY_TELEGRAM_TOKEN: "abc:def", HMP_TELEGRAM_API_URL: "http://127.0.0.1:1" };
    const adapter = createAdapter(config, env);
    expect(adapter.platform).toBe("telegram");
    expect(adapter.conversationId).toBe("-1001234567890");
    expect(telegramAdapterConfig(config, env)).toMatchObject({ token: "abc:def", chatId: "-1001234567890", apiBaseUrl: "http://127.0.0.1:1", members: [{ id: "alex", userId: "1001" }] });
  });

  test("a chat ID written as a bare number is rejected with the fix", () => {
    expect(() => parseConfig(configText.replace('"-1001234567890"', "-1001234567890"), { baseDir: "/base", env: {} })).toThrow(/chatId/);
    expect(() => parseConfig(configText.replace("-1001234567890", "not-a-number"), { baseDir: "/base", env: {} })).toThrow(/like "-1001234567890"/);
  });
});
