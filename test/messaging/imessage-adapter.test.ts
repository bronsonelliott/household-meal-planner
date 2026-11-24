// The iMessage adapter's own behaviour, against a fake BlueBubbles server: the polling cursor, what
// is ignored, how the bot is addressed, how sends end, reactions, health, config, and that the
// server password never reaches a log, a file or an error.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, parseConfig, REPO_DIR, missingSecrets } from "../../src/config.ts";
import { runDoctor, runOnlineChecks } from "../../src/doctor.ts";
import { IMessageAdapter } from "../../src/messaging/imessage/adapter.ts";
import { BlueBubblesApi } from "../../src/messaging/imessage/client.ts";
import { diagnoseIMessage } from "../../src/messaging/imessage/diagnose.ts";
import { directChatGuid, mentionsName, normalizeHandle, readMessage } from "../../src/messaging/imessage/normalize.ts";
import { sortSendAnswer } from "../../src/messaging/imessage/results.ts";
import { imessageAdapterConfig } from "../../src/messaging/imessage/settings.ts";
import { createAdapter } from "../../src/messaging/index.ts";
import type { AdapterHandlers, IncomingMessage } from "../../src/messaging/types.ts";
import { exampleConfigText, FAKE_RECIPE_APIS } from "../fixtures/config-fixtures.ts";
import {
  ALEX_HANDLE,
  BOT_NAME,
  FAKE_PASSWORD,
  FakeBlueBubbles,
  GROUP_GUID,
  OTHER_GROUP_GUID,
  SAM_HANDLE,
  STRANGER_HANDLE,
  freshStateDir,
  imessageAdapter,
  imessageConfig,
} from "../fixtures/fake-bluebubbles.ts";

let api: FakeBlueBubbles;
let stateDir: string;
const running: IMessageAdapter[] = [];

beforeEach(() => {
  api = new FakeBlueBubbles();
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

// An adapter on its own with hand-written handlers, recording each message handed over.
async function boot(overrides: Parameters<typeof imessageConfig>[2] = {}, onMessage?: (message: IncomingMessage) => Promise<void>) {
  const received: IncomingMessage[] = [];
  const logs: string[] = [];
  const fatals: string[] = [];
  const handlers: AdapterHandlers = {
    onMessage: async (message) => {
      if (onMessage) await onMessage(message);
      received.push(message);
    },
    onFatal: (reason) => void fatals.push(reason),
    log: (line) => void logs.push(line),
  };
  const adapter = imessageAdapter(api, stateDir, overrides);
  running.push(adapter);
  await adapter.start(handlers);
  return { adapter, received, logs, fatals };
}

const recent = (offsetMs = 0) => Date.now() - 10_000 + offsetMs;

// ---------------------------------------------------------------------------------------

describe("receiving: the cursor", () => {
  test("a message that shares a timestamp with one already handled is not lost (and nothing is handled twice)", async () => {
    const at = recent();
    api.addMessage({ guid: "A", text: "first", at });
    const { received } = await boot();
    expect(received.map((m) => m.nativeId)).toEqual(["A"]);

    // Arrives later, but carries the same timestamp. The server only returns messages NEWER than
    // the `after` it is given, so only reading behind the cursor can find this one.
    api.addMessage({ guid: "B", text: "second", at });
    await eventually(() => received.length === 2);
    await Bun.sleep(150); // several more polls: A and B must not come again
    expect(received.map((m) => m.nativeId)).toEqual(["A", "B"]);
  });

  test("a restart picks up what arrived meanwhile and never handles an old message twice", async () => {
    api.addMessage({ guid: "A", text: "one", at: recent(0) });
    api.addMessage({ guid: "B", text: "two", at: recent(5) });
    const first = await boot();
    expect(first.received.length).toBe(2);
    await first.adapter.stop();

    api.addMessage({ guid: "C", text: "three while down", at: recent(10) });
    const second = await boot();
    expect(second.received.map((m) => m.nativeId)).toEqual(["C"]);
  });

  test("the cursor only moves after the journal write: a failed hand-over is tried again, not skipped", async () => {
    const flaky = { failures: 0 };
    const { received, logs } = await boot({}, async () => {
      if (flaky.failures > 0) {
        flaky.failures -= 1;
        throw new Error("the journal is full");
      }
    });
    flaky.failures = 2;
    api.addMessage({ guid: "B", text: "two", at: Date.now() });
    await eventually(() => received.length === 1, 5000);
    expect(received.map((m) => m.nativeId)).toEqual(["B"]);
    expect(logs.filter((line) => line.includes("could not journal message B")).length).toBe(2);
  }, 10_000);

  test("a failed hand-over during the first read refuses to start, and the message is still there next time", async () => {
    api.addMessage({ guid: "A", text: "one", at: recent() });
    const adapter = imessageAdapter(api, stateDir);
    await expect(
      adapter.start({
        onMessage: async () => {
          throw new Error("the journal is full");
        },
        onFatal: () => {},
        log: () => {},
      }),
    ).rejects.toThrow("The first read of new messages failed");
    await adapter.stop();
    expect((await boot()).received.map((m) => m.nativeId)).toEqual(["A"]);
  });

  test("the first run does not replay old history, but does catch a message sent while the bot was starting", async () => {
    api.addMessage({ guid: "OLD", text: "last month", at: Date.now() - 3 * 60 * 60_000 });
    api.addMessage({ guid: "NEW", text: "just now", at: Date.now() - 30_000 });
    const { received } = await boot();
    expect(received.map((m) => m.nativeId)).toEqual(["NEW"]);
  });

  test("more than one page of messages is all read", async () => {
    for (let i = 0; i < 230; i++) api.addMessage({ guid: `M${i}`, text: `n${i}`, at: recent(i) });
    const { received } = await boot();
    expect(received.length).toBe(230);
    expect(received[229]!.nativeId).toBe("M229");
  });

  test("the cursor is saved in the state folder and holds no message text", async () => {
    api.addMessage({ guid: "A", text: "private words", at: recent() });
    await boot();
    const saved = readFileSync(join(stateDir, "imessage-cursor.json"), "utf8");
    expect(JSON.parse(saved).seen.A).toBeGreaterThan(0);
    expect(saved).not.toContain("private words");
  });
});

describe("receiving: what is ignored", () => {
  test("the bot's own messages are ignored", async () => {
    api.addMessage({ guid: "SELF", text: "I said this", isFromMe: true, at: recent() });
    const { received } = await boot();
    expect(received).toEqual([]);
  });

  test("tapbacks are ignored, in the group and in private chats", async () => {
    api.addMessage({ guid: "T1", text: "Loved “Tacos”", reaction: "love", at: recent() });
    api.addMessage({ guid: "T2", text: "", reaction: "2001", chat: `iMessage;-;${ALEX_HANDLE}`, at: recent(1) });
    api.addMessage({ guid: "REAL", text: "Tacos", at: recent(2) });
    const { received } = await boot();
    expect(received.map((m) => m.nativeId)).toEqual(["REAL"]);
  });

  test("SMS is ignored by default, and read when allowSms is on", async () => {
    api.addMessage({ guid: "SMS1", text: "sent as a text", chat: `SMS;-;${ALEX_HANDLE}`, service: "SMS", at: recent() });
    expect((await boot()).received).toEqual([]);
    await running.pop()!.stop();

    stateDir = freshStateDir(); // a fresh bridge, so the first message is read again
    const allowed = await boot({ allowSms: true });
    expect(allowed.received.map((m) => [m.nativeId, m.conversationId, m.isGroup])).toEqual([["SMS1", `SMS;-;${ALEX_HANDLE}`, false]]);
  });

  test("other group chats on the Mac are not even handed over", async () => {
    api.addMessage({ guid: "OTHER", text: "the neighbours' chat", chat: OTHER_GROUP_GUID, at: recent() });
    api.addMessage({ guid: "MINE", text: "ours", at: recent(1) });
    const { received } = await boot();
    expect(received.map((m) => m.nativeId)).toEqual(["MINE"]);
  });

  test("in household-dms mode the household group is not a conversation either", async () => {
    api.addMessage({ guid: "G", text: "in the group", at: recent() });
    api.addMessage({ guid: "D", text: "in private", chat: directChatGuid(ALEX_HANDLE), at: recent(1) });
    const { received } = await boot({ mode: "household-dms", chatGuid: null });
    expect(received.map((m) => m.nativeId)).toEqual(["D"]);
  });

  test("a message with only a photo is handed over as attachment-only, and an empty one is dropped", async () => {
    api.addMessage({ guid: "PHOTO", text: "￼", attachments: true, at: recent() });
    api.addMessage({ guid: "EMPTY", text: "", at: recent(1) });
    const { received } = await boot();
    expect(received.map((m) => [m.nativeId, m.text, m.hasAttachments])).toEqual([["PHOTO", "", true]]);
  });

  test("the sender is the canonical handle, whatever its spelling", async () => {
    api.addMessage({ guid: "E", text: "hi", from: "Sam@Example.COM", at: recent() });
    api.addMessage({ guid: "P", text: "hi", from: "(555) 555-0101", at: recent(1) });
    const { received } = await boot();
    expect(received.map((m) => m.sender.identity)).toEqual([SAM_HANDLE, ALEX_HANDLE]);
  });
});

describe("addressing the bot", () => {
  test("the bot's name as a word, in any capitals, counts as speaking to it", () => {
    for (const text of ["Dinner Bot, swap Monday", "swap monday dinner bot", "thanks DINNER   BOT!", "hey (dinner bot)", "Dinner Bot"]) {
      expect(mentionsName(text, BOT_NAME)).toBe(true);
    }
    for (const text of ["dinner botany", "my dinner bottle", "what is for dinner", "Dinner-Bots", "xdinner bot"]) {
      expect(mentionsName(text, BOT_NAME)).toBe(text === "Dinner-Bots" ? false : false);
    }
  });

  test("names with regex characters are matched literally", () => {
    expect(mentionsName("hey Chef (Bot)!", "Chef (Bot)")).toBe(true);
    expect(mentionsName("hey Chef Bot!", "Chef (Bot)")).toBe(false);
  });

  test("mentionsBot is set from the text", async () => {
    api.addMessage({ guid: "Y", text: "Dinner Bot, swap Monday", at: recent() });
    api.addMessage({ guid: "N", text: "swap Monday", at: recent(1) });
    const { received } = await boot();
    expect(received.map((m) => [m.nativeId, m.mentionsBot])).toEqual([["Y", true], ["N", false]]);
  });

  test("an inline reply to a message the bot sent is a reply to the bot; a reply to anyone else is not", async () => {
    const { adapter, received } = await boot();
    const outcome = await adapter.sendToConversation("Monday: tacos");
    expect(outcome.kind).toBe("sent");
    const botGuid = api.sends().length === 1 ? "OUT-1" : "";

    api.addMessage({ guid: "R1", text: "swap it", replyTo: botGuid, at: Date.now() });
    api.addMessage({ guid: "R2", text: "lol", replyTo: "SOMEONE-ELSES", at: Date.now() + 1 });
    api.addMessage({ guid: "R3", text: "p-prefixed", replyTo: `p:0/${botGuid}`, at: Date.now() + 2 });
    await eventually(() => received.length === 3);
    expect(received.map((m) => [m.nativeId, m.repliesToBot])).toEqual([["R1", true], ["R2", false], ["R3", true]]);
    // The replied-to message is named the way a send names it, prefix or not, so a read-back can be matched.
    expect(received.map((m) => m.replyToNativeId)).toEqual(["OUT-1", "SOMEONE-ELSES", "OUT-1"]);
    expect((outcome as { nativeId?: string }).nativeId).toBe("OUT-1");
  });

  test("a message the poll sees from the bot's own account is learned as the bot's (a send's first guid can be temporary)", async () => {
    api.addMessage({ guid: "REAL-GUID", text: "Monday: tacos", isFromMe: true, at: recent() });
    api.addMessage({ guid: "Q", text: "swap it", replyTo: "REAL-GUID", at: recent(1) });
    const { received } = await boot();
    expect(received.map((m) => [m.nativeId, m.repliesToBot])).toEqual([["Q", true]]);
  });

  test("the sent guids survive a restart", async () => {
    const first = await boot();
    await first.adapter.sendToConversation("Monday: tacos");
    await first.adapter.stop();
    api.addMessage({ guid: "R", text: "ok", replyTo: "OUT-1", at: Date.now() });
    const second = await boot();
    expect(second.received[0]!.repliesToBot).toBe(true);
  });
});

describe("sending", () => {
  test("the group gets the chat GUID, a temp guid, the text and the send method", async () => {
    const { adapter } = await boot({ sendMethod: "apple-script" });
    expect((await adapter.sendToConversation("Monday: tacos")).kind).toBe("sent");
    const [send] = api.sends();
    expect(send).toMatchObject({ chatGuid: GROUP_GUID, message: "Monday: tacos", method: "apple-script" });
    expect(send!.tempGuid.length).toBeGreaterThan(8);
  });

  test("a member's private chat is derived from their handle, for a phone and for an email", async () => {
    const { adapter } = await boot({ mode: "household-dms", chatGuid: null, sendMethod: "private-api" });
    await adapter.sendToMember("alex", "hi");
    await adapter.sendToMember("sam", "hi");
    expect(api.sends().map((s) => [s.chatGuid, s.method])).toEqual([
      [`iMessage;-;${ALEX_HANDLE}`, "private-api"],
      [`iMessage;-;${SAM_HANDLE}`, "private-api"],
    ]);
  });

  test("sendToConversation in household-dms mode, and sendToMember for a stranger, fail without calling the server", async () => {
    const { adapter } = await boot({ mode: "household-dms", chatGuid: null });
    expect((await adapter.sendToConversation("x")).kind).toBe("failed");
    expect((await adapter.sendToMember("nobody", "x")).kind).toBe("failed");
    expect(api.sends()).toEqual([]);
  });

  test("the message limit is a conservative 2000 characters", () => {
    expect(imessageAdapter(api, stateDir).capabilities.maxMessageChars).toBe(2000);
  });

  const outcomeFor = async (reply: Parameters<FakeBlueBubbles["scriptSends"]>[0][number]) => {
    const { adapter } = await boot();
    api.scriptSends([reply]);
    return adapter.sendToConversation("Monday: tacos");
  };

  test("200 with a guid is sent", async () => {
    expect((await outcomeFor({ ok: true })).kind).toBe("sent");
  });

  test("a rejected password (401) is a permanent failure flagged as an auth failure", async () => {
    const outcome = await outcomeFor({ error: 401, message: "Unauthorized" });
    expect(outcome).toMatchObject({ kind: "failed", failureClass: "auth-failed", failureExtra: { authFailed: true } });
    expect((outcome as any).transient).toBeUndefined();
  });

  test("a 5xx may have been accepted, so it is Unknown; a missing chat (404) is permanent; 429 is transient and honours Retry-After", async () => {
    for (const status of [500, 502, 503]) {
      const outcome = await outcomeFor({ error: status, message: "AppleScript failed" });
      expect(outcome.kind).toBe("unknown");
      expect((outcome as any).transient).toBeUndefined();
    }
    expect(await outcomeFor({ error: 404, message: "Chat does not exist" })).toMatchObject({ kind: "failed" });
    expect(((await outcomeFor({ error: 404 })) as any).transient).toBeUndefined();
    expect(await outcomeFor({ error: 429, headers: { "retry-after": "30" } })).toMatchObject({ kind: "failed", transient: true, retryAfterMs: 30_000 });
  });

  test("no answer in time is unknown; a connection cut mid-answer is unknown", async () => {
    expect((await outcomeFor({ hang: true })).kind).toBe("unknown");
    expect((await outcomeFor({ drop: true })).kind).toBe("unknown");
  });

  test("nothing listening at the address is a clean, transient failure", async () => {
    const { adapter } = await boot();
    const dead = new FakeBlueBubbles();
    const url = dead.url;
    dead.stop();
    const lonely = new IMessageAdapter(imessageConfig(api, stateDir, { serverUrl: url }));
    expect(await lonely.sendToConversation("x")).toMatchObject({ kind: "failed", transient: true });
    expect(adapter).toBeDefined();
  });

  test("a 200 that carries no message guid is unknown, never claimed as sent", () => {
    expect(sortSendAnswer({ kind: "ok", body: { status: 200, data: {} } }).kind).toBe("unknown");
    expect(sortSendAnswer({ kind: "ok", body: { status: 200, data: { guid: "G" } } }, () => 42)).toEqual({ kind: "sent", timestamp: 42, nativeId: "G" });
  });
});

describe("reactions need the Private API", () => {
  test("with apple-script sending there are no reactions: the capability is off and acknowledge does nothing", async () => {
    const { adapter } = await boot({ sendMethod: "apple-script" });
    expect(adapter.capabilities.reactions).toBe(false);
    await adapter.acknowledge({ platform: "imessage", conversationId: GROUP_GUID, nativeId: "X", sender: { identity: ALEX_HANDLE, displayName: null }, timestamp: 1 }, "received");
    expect(api.reactions()).toEqual([]);
  });

  test("with private-api sending, 'received' and 'handled' are two different tapbacks on the message", async () => {
    const { adapter } = await boot({ sendMethod: "private-api" });
    expect(adapter.capabilities.reactions).toBe(true);
    const ref = { platform: "imessage" as const, conversationId: GROUP_GUID, nativeId: "X", sender: { identity: ALEX_HANDLE, displayName: null }, timestamp: 1 };
    await adapter.acknowledge(ref, "received");
    await adapter.acknowledge(ref, "handled");
    expect(api.reactions()).toEqual([
      { chatGuid: GROUP_GUID, selectedMessageGuid: "X", reaction: "like" },
      { chatGuid: GROUP_GUID, selectedMessageGuid: "X", reaction: "love" },
    ]);
  });

  test("a refused tapback rejects, so the caller logs it", async () => {
    const { adapter } = await boot({ sendMethod: "private-api" });
    api.override("message/react", { error: 400, message: "Private API is not enabled" });
    const ref = { platform: "imessage" as const, conversationId: GROUP_GUID, nativeId: "X", sender: { identity: ALEX_HANDLE, displayName: null }, timestamp: 1 };
    await expect(adapter.acknowledge(ref, "received")).rejects.toThrow("failed");
  });

  test("start-up warns when private-api is chosen but the server says it is off", async () => {
    api.privateApiOn = false;
    const { logs } = await boot({ sendMethod: "private-api" });
    expect(logs.join("\n")).toContain("Private API is not enabled");
  });
});

describe("start-up, health and failure", () => {
  const startsWith = async (overrides: Parameters<typeof imessageConfig>[2]) => {
    const adapter = imessageAdapter(api, stateDir, overrides);
    return adapter.start({ onMessage: async () => {}, onFatal: () => {}, log: () => {} }).then(
      () => "started",
      (error) => `${error.constructor.name}: ${error.message}`,
    );
  };

  test("missing settings and a wrong password refuse to start, in plain words", async () => {
    expect(await startsWith({ serverUrl: "" })).toContain("StartupError: The BlueBubbles server address is not set");
    expect(await startsWith({ password: "" })).toContain("password is not set");
    expect(await startsWith({ chatGuid: "" })).toContain("chat GUID is not set");
    expect(await startsWith({ password: "wrong" })).toContain("rejected the password");
  });

  test("a server that is not there refuses to start, and a missing household chat is named", async () => {
    const dead = new FakeBlueBubbles();
    const url = dead.url;
    dead.stop();
    expect(await startsWith({ serverUrl: url })).toContain("Could not reach the BlueBubbles server");
    expect(await startsWith({ chatGuid: "iMessage;+;chat999" })).toContain("cannot open the household chat");
  });

  test("health pings and looks up the chat, reports the time since the last read, and never sends", async () => {
    const { adapter } = await boot();
    const health = await adapter.checkHealth();
    expect(health.healthy).toBe(true);
    expect(health.reason).toMatch(/last read of new messages \d+ seconds? ago/);
    expect(api.requests.some((r) => r.path === `chat/${encodeURIComponent(GROUP_GUID)}`)).toBe(true);
    expect(api.sends()).toEqual([]);
  });

  test("health fails when the server stops answering, and when reading keeps failing", async () => {
    const { adapter } = await boot();
    api.override("message/query", { error: 500, message: "database locked" });
    await eventually(() => api.requests.filter((r) => r.path === "message/query").length >= 3);
    const reading = await adapter.checkHealth();
    expect(reading.healthy).toBe(false);
    expect(reading.reason).toContain("receiving is failing");

    api.override("ping", { error: 503 });
    expect((await adapter.checkHealth()).reason).toContain("did not answer a ping");
  });

  test("health notices a read loop that has gone quiet", async () => {
    let clock = Date.now();
    const { adapter } = await boot({ now: () => clock, pollIntervalMs: 10_000 });
    clock += 5 * 60_000;
    const health = await adapter.checkHealth();
    expect(health.healthy).toBe(false);
    expect(health.reason).toContain("no successful read of new messages for 5 minutes");
  });

  test("polling keeps going after a failed poll, and catches up", async () => {
    const { received, logs } = await boot();
    api.override("message/query", { error: 503 });
    await eventually(() => logs.some((line) => line.includes("polling problem")));
    api.addMessage({ guid: "LATE", text: "after the outage", at: Date.now() });
    api.override("message/query", null);
    await eventually(() => received.length === 1, 5000);
  }, 10_000);

  test("a password the server starts refusing mid-run is fatal, so the bridge restarts and says why", async () => {
    const { fatals } = await boot();
    api.override("message/query", { error: 401, message: "Unauthorized" });
    await eventually(() => fatals.length === 1);
    expect(fatals[0]).toContain("rejected the password");
  });
});

describe("the password never leaks", () => {
  const encoded = encodeURIComponent(FAKE_PASSWORD);

  test("it travels as the password query parameter, URL-encoded", async () => {
    await boot();
    expect(api.requests.length).toBeGreaterThan(0);
    for (const request of api.requests) expect(new URL(request.url).searchParams.get("password")).toBe(FAKE_PASSWORD);
  });

  test("redact() removes it in plain and encoded form, and any password= parameter", () => {
    const client = new BlueBubblesApi("http://x", FAKE_PASSWORD, 100);
    const clean = client.redact(`failed ${FAKE_PASSWORD} and http://x/api/v1/ping?password=${encoded} and ?password=other&a=1`);
    expect(clean).not.toContain(FAKE_PASSWORD);
    expect(clean).not.toContain(encoded);
    expect(clean).not.toContain("other");
  });

  test("a server that echoes the password in its error text does not get it into an outcome", async () => {
    const { adapter } = await boot();
    api.scriptSends([{ error: 400, message: `bad request for password=${encoded} (${FAKE_PASSWORD})` }]);
    const outcome = await adapter.sendToConversation("x");
    expect(JSON.stringify(outcome)).not.toContain(FAKE_PASSWORD);
    expect(JSON.stringify(outcome)).not.toContain(encoded);
  });

  test("a connection error that quotes the URL does not leak it, from start-up or from the doctor", async () => {
    const dead = new FakeBlueBubbles();
    const url = dead.url;
    dead.stop();
    const adapter = imessageAdapter(api, stateDir, { serverUrl: url });
    const failure = await adapter.start({ onMessage: async () => {}, onFatal: () => {}, log: () => {} }).catch((error) => String(error.message));
    expect(failure).not.toContain(FAKE_PASSWORD);
    expect(failure).not.toContain(encoded);

    const diagnosis = await diagnoseIMessage(imessageConfig(api, stateDir, { serverUrl: url }));
    expect(JSON.stringify(diagnosis)).not.toContain(FAKE_PASSWORD);
    expect(JSON.stringify(diagnosis)).not.toContain(encoded);
  });

  test("no log line and no file in the state folder contains it", async () => {
    api.addMessage({ guid: "A", text: "hello", at: recent() });
    const { adapter, logs } = await boot();
    await adapter.sendToConversation("Monday: tacos");
    await adapter.checkHealth();
    expect(logs.join("\n")).not.toContain(FAKE_PASSWORD);
    for (const file of readdirSync(stateDir)) {
      const text = readFileSync(join(stateDir, file), "utf8");
      expect(text).not.toContain(FAKE_PASSWORD);
      expect(text).not.toContain(encoded);
    }
  });
});

describe("handles and records", () => {
  test("handles are canonical: E.164 phones, lowercase emails", () => {
    expect(normalizeHandle("+1 (555) 555-0101")).toBe("+15555550101");
    expect(normalizeHandle("5555550101")).toBe("+15555550101");
    expect(normalizeHandle(" Sam@Example.com ")).toBe("sam@example.com");
    expect(directChatGuid("+15555550101")).toBe("iMessage;-;+15555550101");
  });

  test("a message record missing its guid or time is skipped, not guessed at", () => {
    expect(readMessage({ text: "x", dateCreated: 1 })).toBeNull();
    expect(readMessage({ guid: "G", text: "x" })).toBeNull();
    expect(readMessage({ guid: "G", text: "x", dateCreated: 1 })).toMatchObject({ guid: "G", chatGuid: null, isReaction: false });
  });
});

// ---------------------------------------------------------------------------------------
// Config, the factory and the doctor

function configText(edit: (text: string) => string = (text) => text): string {
  return exampleConfigText((text) =>
    edit(
      text
        .replace('platform = "signal"', 'platform = "imessage"')
        .replace('# imessage = "+15555550101"', 'imessage = "+15555550101"')
        .replace('# imessage = "+15555550102"', 'imessage = "Sam@Example.com"')
        .replace('# [messaging.imessage]', "[messaging.imessage]")
        .replace('# serverUrl = "http://192.168.1.20:1234"', 'serverUrl = "http://192.168.1.20:1234"')
        .replace('# chatGuid = "iMessage;+;chat000000000000000000"', 'chatGuid = "iMessage;+;chat000000000000000000"'),
    ),
  );
}

function problemsFor(edit: (text: string) => string): string[] {
  try {
    parseConfig(configText(edit), { baseDir: REPO_DIR, env: {} });
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
  throw new Error("expected the config to be refused");
}

describe("config", () => {
  test("a complete iMessage setup parses, with defaults, and emails are lowercased", () => {
    const config = parseConfig(configText(), { baseDir: REPO_DIR, env: {} });
    expect(config.messaging.imessage).toEqual({
      serverUrl: "http://192.168.1.20:1234",
      passwordEnv: "BLUEBUBBLES_PASSWORD",
      chatGuid: "iMessage;+;chat000000000000000000",
      sendMethod: "apple-script",
      pollIntervalSeconds: 5,
      allowSms: false,
    });
    expect(config.members.map((m) => m.identities.imessage)).toEqual(["+15555550101", "sam@example.com"]);
    expect(missingSecrets(config, {})).toContain("The environment variable BLUEBUBBLES_PASSWORD is not set. It should hold the BlueBubbles server password.");
  });

  test("the server address and, in group mode, the chat GUID are required", () => {
    expect(problemsFor((t) => t.replace('serverUrl = "http://192.168.1.20:1234"\n', ""))).toContain(
      'messaging.imessage.serverUrl is missing. It is the address of your BlueBubbles server, like "http://192.168.1.20:1234".',
    );
    expect(problemsFor((t) => t.replace(/chatGuid = ".*"\n/, "")).some((p) => p.startsWith("messaging.imessage.chatGuid is missing"))).toBe(true);
  });

  test("household-dms mode needs no chat GUID", () => {
    const text = configText((t) => t.replace(/chatGuid = ".*"\n/, "").replace('mode = "group"', 'mode = "household-dms"'));
    expect(parseConfig(text, { baseDir: REPO_DIR, env: {} }).messaging.imessage.chatGuid).toBeNull();
  });

  test("bad values are named: a one-to-one chat GUID, a password in the address, a wrong send method, a non-boolean", () => {
    expect(problemsFor((t) => t.replace("iMessage;+;chat000000000000000000", "iMessage;-;+15555550101")).some((p) => p.includes("must be a group chat GUID"))).toBe(true);
    expect(problemsFor((t) => t.replace("http://192.168.1.20:1234", "http://192.168.1.20:1234/?password=hunter2")).join("\n")).not.toContain("hunter2");
    expect(problemsFor((t) => t.replace("http://192.168.1.20:1234", "http://192.168.1.20:1234/?password=hunter2")).some((p) => p.includes("password goes in the environment variable"))).toBe(true);
    expect(problemsFor((t) => t.replace('# sendMethod = "apple-script"', 'sendMethod = "carrier-pigeon"')).some((p) => p.includes("messaging.imessage.sendMethod must be one of: apple-script, private-api"))).toBe(true);
    expect(problemsFor((t) => t.replace("# allowSms = false", 'allowSms = "yes"')).some((p) => p.includes("allowSms must be true or false"))).toBe(true);
    expect(problemsFor((t) => t.replace("# pollIntervalSeconds = 5", "pollIntervalSeconds = 0")).some((p) => p.includes("pollIntervalSeconds must be a whole number"))).toBe(true);
    expect(problemsFor((t) => t.replace('imessage = "+15555550101"', 'imessage = "not a handle"')).some((p) => p.includes("identities.imessage must be a phone number"))).toBe(true);
  });

  test("createAdapter builds the iMessage adapter, and its settings come from the config and the environment", () => {
    const config = parseConfig(configText(), { baseDir: REPO_DIR, env: {} });
    const env = { BLUEBUBBLES_PASSWORD: "pw" };
    expect(createAdapter(config, env)).toBeInstanceOf(IMessageAdapter);
    expect(imessageAdapterConfig(config, env)).toMatchObject({
      serverUrl: "http://192.168.1.20:1234",
      password: "pw",
      botName: "Dinner Bot",
      pollIntervalMs: 5000,
      members: [
        { id: "alex", handle: "+15555550101" },
        { id: "sam", handle: "sam@example.com" },
      ],
    });
  });
});

function household(env: Record<string, string> = {}): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "doctor-imessage-"));
  writeFileSync(join(dir, "config.toml"), configText());
  mkdirSync(join(dir, "data"));
  copyFileSync(join(REPO_DIR, "data.example", "profile.md"), join(dir, "data", "profile.md"));
  return { HMP_CONFIG: join(dir, "config.toml"), ANTHROPIC_API_KEY: "sk-test", BLUEBUBBLES_PASSWORD: FAKE_PASSWORD, ...env };
}

describe("bun run doctor", () => {
  test("offline: ready, says what it will use, and starts and calls nothing", () => {
    const report = runDoctor(household());
    expect(report.ok).toBe(true);
    const text = report.lines.join("\n");
    expect(text).toContain("iMessage (beta)");
    expect(text).toContain("http://192.168.1.20:1234");
    expect(text).toContain("apple-script");
    expect(text).not.toContain(FAKE_PASSWORD);
    expect(api.requests).toEqual([]);
  });

  test("a missing password variable is reported by name", () => {
    const env = household();
    delete env.BLUEBUBBLES_PASSWORD;
    expect(runDoctor(env).problems.join("\n")).toContain("BLUEBUBBLES_PASSWORD is not set");
  });

  test("--online pings the server and looks up the chat, and sends nothing", async () => {
    const report = await runOnlineChecks(household({ HMP_BLUEBUBBLES_URL: api.url }), FAKE_RECIPE_APIS);
    // The example config's chat GUID is not one the fake knows, so tell the fake about it.
    expect(report.problems.join("\n")).toContain("cannot be opened");
    api.chats.add("iMessage;+;chat000000000000000000");
    const again = await runOnlineChecks(household({ HMP_BLUEBUBBLES_URL: api.url }), FAKE_RECIPE_APIS);
    expect(again.ok).toBe(true);
    const text = again.lines.join("\n");
    expect(text).toContain("reachable, password accepted");
    expect(text).toContain("1.9.9");
    expect(text).not.toContain(FAKE_PASSWORD);
    expect(api.sends()).toEqual([]);
    expect(api.requests.every((r) => ["ping", "server/info"].includes(r.path) || r.path.startsWith("chat/"))).toBe(true);
  });

  test("--online names a wrong password and an unreachable server without printing the password", async () => {
    const wrong = await runOnlineChecks(household({ HMP_BLUEBUBBLES_URL: api.url, BLUEBUBBLES_PASSWORD: "nope" }), FAKE_RECIPE_APIS);
    expect(wrong.problems[0]).toContain("rejected the password");
    const dead = new FakeBlueBubbles();
    const url = dead.url;
    dead.stop();
    const gone = await runOnlineChecks(household({ HMP_BLUEBUBBLES_URL: url }), FAKE_RECIPE_APIS);
    expect(gone.problems[0]).toContain("could not reach the BlueBubbles server");
    expect(JSON.stringify(gone)).not.toContain(FAKE_PASSWORD);
  });

  test("--online with private-api chosen warns when the server's Private API is off", async () => {
    api.privateApiOn = false;
    api.chats.add("iMessage;+;chat000000000000000000");
    const config = imessageConfig(api, stateDir, { sendMethod: "private-api" });
    const diagnosis = await diagnoseIMessage(config);
    expect(diagnosis.problems.join("\n")).toContain("Private API is not enabled");
  });
});
