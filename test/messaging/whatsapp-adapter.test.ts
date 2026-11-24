// The WhatsApp adapter's own behaviour, against the fake Graph API and signed fake webhook calls:
// the handshake, signatures, journal-before-200, duplicates, delivery statuses, the 24-hour window
// and the template path, how sends end, health, and that no secret reaches a log or a file.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { parseConfig, StartupError } from "../../src/config.ts";
import { runDoctor, runOnlineChecks } from "../../src/doctor.ts";
import { FAKE_RECIPE_APIS } from "../fixtures/config-fixtures.ts";
import { createAdapter } from "../../src/messaging/index.ts";
import { startMessenger, type Messenger } from "../../src/messaging/messenger.ts";
import { ATTACHMENT_ONLY_LINE } from "../../src/messaging/router.ts";
import type { AdapterHandlers, IncomingMessage, InboundEvent } from "../../src/messaging/types.ts";
import { WhatsAppAdapter } from "../../src/messaging/whatsapp/adapter.ts";
import { diagnoseWhatsApp } from "../../src/messaging/whatsapp/diagnose.ts";
import { whatsappAdapterConfig } from "../../src/messaging/whatsapp/settings.ts";
import { sortSendAnswer } from "../../src/messaging/whatsapp/results.ts";
import { WindowStore } from "../../src/messaging/whatsapp/state.ts";
import {
  ALEX_WA,
  FAKE_ACCESS_TOKEN,
  FAKE_APP_SECRET,
  FAKE_VERIFY_TOKEN,
  FakeGraphApi,
  PHONE_NUMBER_ID,
  SAM_WA,
  STRANGER_WA,
  WEBHOOK_PATH,
  WHATSAPP_MEMBERS,
  freshStateDir,
  postWebhook,
  statusEntry,
  webhookBody,
  whatsappAdapter,
  whatsappConfig,
} from "../fixtures/fake-whatsapp-api.ts";

const HOUR = 60 * 60 * 1000;
let api: FakeGraphApi;
let stateDir: string;
// The clock the adapter measures the 24-hour window with.
let clock: number;
const now = () => clock;
const running: Array<{ stop(): Promise<void> }> = [];
const servers: Server[] = [];

beforeEach(() => {
  api = new FakeGraphApi();
  stateDir = freshStateDir();
  clock = Date.now();
});
afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
  while (servers.length > 0) servers.pop()!.close();
  api.stop();
});

async function eventually(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("eventually: condition not met in time");
    await Bun.sleep(10);
  }
}

// The real messenger around the real adapter, the way bridge.ts runs them (household-dms mode).
async function boot(options: { adapter?: WhatsAppAdapter; template?: boolean } = {}) {
  const events: InboundEvent[] = [];
  const logs: string[] = [];
  const adapter =
    options.adapter ?? whatsappAdapter(api, stateDir, { now, ...(options.template === false ? { template: null } : {}) });
  const messenger: Messenger = await startMessenger(adapter, {
    mode: "household-dms",
    members: WHATSAPP_MEMBERS,
    stateDir,
    dryRun: false,
    onEvent: (event) => void events.push(event),
    log: (line) => logs.push(line),
    sleep: async () => {},
    now,
    healthIntervalMs: HOUR,
  });
  running.push(messenger);
  return { adapter, messenger, events, logs };
}

// An adapter on its own, with hand-written handlers, for tests that watch the hand-over itself.
function bareHandlers(onMessage: (message: IncomingMessage) => Promise<void>): AdapterHandlers & { logs: string[] } {
  const logs: string[] = [];
  return { onMessage, onFatal: () => {}, log: (line) => void logs.push(line), logs };
}

function journal(): any[] {
  const path = join(stateDir, "inbox.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// Both members wrote a moment ago (before the clock moves), so their windows are open.
function openWindows(): void {
  const store = new WindowStore(stateDir);
  store.recordInbound("alex", clock);
  store.recordInbound("sam", clock);
}

const windowFile = () => JSON.parse(readFileSync(join(stateDir, "whatsapp-window.json"), "utf8"));
const textsTo = (waId: string) => api.sent("text").filter((send) => send.to === waId).map((send) => send.text.body);
const templatesTo = (waId: string) => api.sent("template").filter((send) => send.to === waId);

// ---------------------------------------------------------------------------------------

describe("the webhook handshake", () => {
  const ask = (adapter: WhatsAppAdapter, query: string, path = WEBHOOK_PATH) => fetch(`http://127.0.0.1:${adapter.webhookPort}${path}?${query}`);

  test("the right verify token gets the challenge echoed back; anything else is refused", async () => {
    const { adapter } = await boot();
    const good = await ask(adapter, `hub.mode=subscribe&hub.verify_token=${FAKE_VERIFY_TOKEN}&hub.challenge=1158201444`);
    expect(good.status).toBe(200);
    expect(await good.text()).toBe("1158201444");

    expect((await ask(adapter, "hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1")).status).toBe(403);
    expect((await ask(adapter, `hub.mode=unsubscribe&hub.verify_token=${FAKE_VERIFY_TOKEN}&hub.challenge=1`)).status).toBe(403);
    expect((await ask(adapter, "hub.mode=subscribe&hub.challenge=1")).status).toBe(403);
    expect((await ask(adapter, `hub.mode=subscribe&hub.verify_token=${FAKE_VERIFY_TOKEN}&hub.challenge=1`, "/elsewhere")).status).toBe(404);
  });

  test("a verify token of a different length is refused without an error", async () => {
    const { adapter } = await boot();
    expect((await ask(adapter, "hub.mode=subscribe&hub.verify_token=x&hub.challenge=1")).status).toBe(403);
  });
});

describe("signatures", () => {
  test("a missing, wrong or mismatched signature is refused with 401, nothing is journaled, and the body is not logged", async () => {
    const { adapter, events, logs } = await boot();
    const body = webhookBody({ messages: [{ text: "SECRET-DINNER-WORDS" }] });
    const port = adapter.webhookPort!;

    expect((await postWebhook(port, body, { signature: null })).status).toBe(401);
    expect((await postWebhook(port, body, { secret: "some-other-secret" })).status).toBe(401);
    expect((await postWebhook(port, body, { signature: "sha256=abc" })).status).toBe(401);
    expect((await postWebhook(port, body, { signature: "not-even-a-prefix" })).status).toBe(401);
    // Signed for a different body than the one sent.
    const other = JSON.stringify(webhookBody({ messages: [{ text: "something else" }] }));
    const { signBody } = await import("../../src/messaging/whatsapp/webhook.ts");
    expect((await postWebhook(port, JSON.stringify(body), { signature: signBody(other, FAKE_APP_SECRET) })).status).toBe(401);

    expect(events).toEqual([]);
    expect(journal()).toEqual([]);
    expect(logs.filter((line) => line.includes("refused"))).toHaveLength(5);
    expect(logs.join("\n")).not.toContain("SECRET-DINNER-WORDS");
  });

  test("the signature is checked before the body is read as JSON: unsigned garbage is a 401, not a parse error", async () => {
    const { adapter } = await boot();
    expect((await postWebhook(adapter.webhookPort!, "{not json", { signature: null })).status).toBe(401);
    // Signed garbage is a 400.
    expect((await postWebhook(adapter.webhookPort!, "{not json")).status).toBe(400);
  });

  test("a correctly signed call is accepted", async () => {
    const { adapter, events } = await boot();
    expect((await postWebhook(adapter.webhookPort!, webhookBody({ messages: [{ text: "Tacos Tuesday?" }] }))).status).toBe(200);
    expect(events.map((event) => event.text)).toEqual(["Tacos Tuesday?"]);
  });
});

describe("receiving", () => {
  test("the 200 comes only after the journal write resolves", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const adapter = whatsappAdapter(api, stateDir, { now });
    running.push(adapter);
    const received: string[] = [];
    await adapter.start(bareHandlers(async (message) => {
      await gate;
      received.push(message.nativeId);
    }));

    let answered = false;
    const pending = postWebhook(adapter.webhookPort!, webhookBody({ messages: [{ id: "wamid.A", text: "hi" }] })).then((response) => {
      answered = true;
      return response;
    });
    await Bun.sleep(150);
    expect(answered).toBe(false); // still waiting for the journal
    release();
    expect((await pending).status).toBe(200);
    expect(received).toEqual(["wamid.A"]);
  });

  test("when the journal write fails the answer is 500, so Meta sends it again", async () => {
    const adapter = whatsappAdapter(api, stateDir, { now });
    running.push(adapter);
    const handlers = bareHandlers(async () => {
      throw new Error("disk full");
    });
    await adapter.start(handlers);
    expect((await postWebhook(adapter.webhookPort!, webhookBody({ messages: [{ text: "hi" }] }))).status).toBe(500);
    expect(handlers.logs.some((line) => line.includes("asking Meta to retry"))).toBe(true);
  });

  test("the same message delivered twice is one event and one journal entry", async () => {
    const { adapter, events, logs } = await boot();
    const body = webhookBody({ messages: [{ id: "wamid.SAME", text: "Tacos Tuesday?" }] });
    expect((await postWebhook(adapter.webhookPort!, body)).status).toBe(200);
    expect((await postWebhook(adapter.webhookPort!, body)).status).toBe(200);
    expect(events).toHaveLength(1);
    expect(journal().filter((line) => line.type === "received")).toHaveLength(1);
    expect(logs.some((line) => line.includes("dropped duplicate"))).toBe(true);
  });

  test("the journal ID is built from the sender's number and the message ID, and the sender is named by number, not profile name", async () => {
    const { adapter } = await boot();
    await postWebhook(adapter.webhookPort!, webhookBody({ messages: [{ from: STRANGER_WA, id: "wamid.X", text: "hi", name: "Alex" }] }));
    expect(journal()[0].id).toBe(`whatsapp/${STRANGER_WA}/wamid.X`);
    expect(journal()[0].message.sender).toEqual({ identity: STRANGER_WA, displayName: "Alex" });
    expect(journal().some((line) => line.type === "handled")).toBe(true); // not on the allowlist, closed out
  });

  test("an image or document with a caption is a text; without one it is attachment-only and gets the 'say it in words' line", async () => {
    const { adapter, events } = await boot();
    const port = adapter.webhookPort!;
    await postWebhook(port, webhookBody({ messages: [{ type: "image", text: "our fridge" }] }));
    expect(events.map((event) => event.text)).toEqual(["our fridge"]);

    for (const type of ["image", "audio", "document", "sticker"]) {
      await postWebhook(port, webhookBody({ messages: [{ from: SAM_WA, type }] }));
    }
    await eventually(() => textsTo(SAM_WA).length === 4);
    expect(textsTo(SAM_WA)).toEqual([ATTACHMENT_ONLY_LINE, ATTACHMENT_ONLY_LINE, ATTACHMENT_ONLY_LINE, ATTACHMENT_ONLY_LINE]);
    expect(events).toHaveLength(1);
  });

  test("other message types and events for another phone number ID are ignored, and still answered 200", async () => {
    const { adapter, events, logs } = await boot();
    const port = adapter.webhookPort!;
    expect((await postWebhook(port, webhookBody({ messages: [{ type: "location" }, { type: "reaction" }] }))).status).toBe(200);
    expect((await postWebhook(port, webhookBody({ messages: [{ text: "hi" }], phoneNumberId: "999" }))).status).toBe(200);
    expect((await postWebhook(port, { object: "whatsapp_business_account", entry: [] })).status).toBe(200);
    expect(events).toEqual([]);
    expect(journal()).toEqual([]);
    expect(logs.some((line) => line.includes("ignored a location message"))).toBe(true);
  });

  test("a call that is not on the webhook path or not a GET/POST gets the right refusal", async () => {
    const { adapter } = await boot();
    const base = `http://127.0.0.1:${adapter.webhookPort}`;
    expect((await postWebhook(adapter.webhookPort!, {}, { path: "/other" })).status).toBe(404);
    expect((await fetch(base + WEBHOOK_PATH, { method: "DELETE" })).status).toBe(405);
  });
});

describe("delivery statuses", () => {
  test("they are logged and recorded once, and change no worker or window state", async () => {
    openWindows();
    const before = JSON.stringify(windowFile());
    const { adapter, events, logs } = await boot();
    const port = adapter.webhookPort!;
    const sent = statusEntry("wamid.OUT1", "sent");
    const failed = statusEntry("wamid.OUT2", "failed", { errors: [{ code: 131026, title: "Message undeliverable" }] });

    for (let i = 0; i < 2; i++) {
      expect((await postWebhook(port, webhookBody({ statuses: [sent, statusEntry("wamid.OUT1", "delivered"), statusEntry("wamid.OUT1", "read"), failed] }))).status).toBe(200);
    }
    expect(events).toEqual([]);
    expect(journal()).toEqual([]);
    expect(api.sent("text")).toEqual([]);
    expect(JSON.stringify(windowFile())).toBe(before);

    const statuses = JSON.parse(readFileSync(join(stateDir, "whatsapp-statuses.json"), "utf8"));
    expect(Object.keys(statuses["wamid.OUT1"].seen)).toEqual(["sent", "delivered", "read"]);
    expect(statuses["wamid.OUT2"]).toMatchObject({ error: "131026: Message undeliverable" });
    expect(Object.keys(statuses["wamid.OUT2"].seen)).toEqual(["failed"]);
    // The repeat of the same four statuses logged nothing new.
    expect(logs.filter((line) => line.includes("wamid.OUT1"))).toHaveLength(3);
    expect(logs.filter((line) => line.includes("wamid.OUT2"))).toHaveLength(1);
  });
});

describe("the 24-hour window", () => {
  test("inside it a reply is an ordinary text message; no template is sent", async () => {
    openWindows();
    const { messenger } = await boot();
    clock += 23 * HOUR;
    const outcome = await messenger.sendToMember("alex", "Monday: tacos");
    expect(outcome.kind).toBe("sent");
    expect(textsTo(ALEX_WA)).toEqual(["Monday: tacos"]);
    expect(api.sent("template")).toEqual([]);
  });

  test("outside it the template goes out instead, nothing is claimed as posted, and the text waits", async () => {
    openWindows();
    const { messenger } = await boot();
    clock += 25 * HOUR;
    const outcome = await messenger.sendToMember("alex", "Monday: tacos");

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("expected failed");
    expect(outcome.detail).toContain("will be delivered when Alex replies");
    expect(outcome.detail).toContain("not been delivered yet");
    expect(api.sent("text")).toEqual([]);
    expect(templatesTo(ALEX_WA)).toHaveLength(1);
    expect(templatesTo(ALEX_WA)[0].template).toEqual({ name: "meal_plan_ready", language: { code: "en_US" } });
    expect(windowFile().members.alex.pending.map((item: any) => item.text)).toEqual(["Monday: tacos"]);
    expect(readFileSync(join(stateDir, "send-failures.jsonl"), "utf8")).toContain("awaiting-reply");
  });

  test("a second send the same day does not send the template again, and both texts wait", async () => {
    openWindows();
    const { messenger } = await boot();
    clock += 25 * HOUR;
    await messenger.sendToMember("alex", "one");
    clock += HOUR;
    await messenger.sendToMember("alex", "two");
    expect(templatesTo(ALEX_WA)).toHaveLength(1);
    expect(windowFile().members.alex.pending.map((item: any) => item.text)).toEqual(["one", "two"]);
    clock += 24 * HOUR; // a day after the first template: another may go out
    await messenger.sendToMember("alex", "three");
    expect(templatesTo(ALEX_WA)).toHaveLength(2);
  });

  test("a long message outside the window is kept whole: every part waits, and is delivered in order", async () => {
    openWindows();
    const { adapter, messenger } = await boot();
    clock += 25 * HOUR;
    const text = Array.from({ length: 200 }, (_, index) => `Line ${index}: ${"x".repeat(50)}`).join("\n"); // about 10,000 characters
    const outcome = await messenger.sendToMember("alex", text, "long-1");
    expect(outcome.kind).toBe("failed");
    const waiting = windowFile().members.alex.pending.map((item: any) => item.text);
    expect(waiting.length).toBeGreaterThanOrEqual(3);
    expect(waiting.join("\n")).toBe(text);
    expect(templatesTo(ALEX_WA)).toHaveLength(1);

    await postWebhook(adapter.webhookPort!, webhookBody({ messages: [{ text: "hello", timestamp: Math.floor(clock / 1000) }] }));
    await eventually(() => textsTo(ALEX_WA).length === waiting.length);
    expect(textsTo(ALEX_WA)).toEqual(waiting);
    expect(windowFile().members.alex.pending).toEqual([]);
  });

  test("when the member next writes in, the waiting text is delivered first, ahead of the bot's reply", async () => {
    openWindows();
    const { adapter, messenger } = await boot();
    clock += 25 * HOUR;
    await messenger.sendToMember("alex", "Monday: tacos");
    await messenger.sendToMember("alex", "Tuesday: soup");

    await postWebhook(adapter.webhookPort!, webhookBody({ messages: [{ text: "got it", timestamp: Math.floor(clock / 1000) }] }));
    // The worker would answer straight away; the answer must still arrive after the waiting texts.
    const reply = await messenger.sendToMember("alex", "Thanks, Alex");
    expect(reply.kind).toBe("sent");
    expect(textsTo(ALEX_WA)).toEqual(["Monday: tacos", "Tuesday: soup", "Thanks, Alex"]);
    expect(windowFile().members.alex.pending).toEqual([]);
    expect(windowFile().members.alex.templateSentAt).toBeNull();
  });

  test("a waiting text that cannot be delivered yet stays waiting; one more than a week old is dropped", async () => {
    openWindows();
    const { adapter, messenger, logs } = await boot();
    clock += 25 * HOUR;
    await messenger.sendToMember("alex", "old plan");
    clock += 8 * 24 * HOUR;
    await messenger.sendToMember("alex", "fresh plan");
    api.scriptSends([{ error: 429, code: 130429 }, { ok: true }]);
    await postWebhook(adapter.webhookPort!, webhookBody({ messages: [{ text: "hi", timestamp: Math.floor(clock / 1000) }] }));
    await eventually(() => logs.some((line) => line.includes("it stays waiting")));
    expect(logs.some((line) => line.includes("more than a week old"))).toBe(true);
    expect(windowFile().members.alex.pending.map((item: any) => item.text)).toEqual(["fresh plan"]);
    // The next time they write, it goes out.
    await postWebhook(adapter.webhookPort!, webhookBody({ messages: [{ text: "hello?", timestamp: Math.floor(clock / 1000) }] }));
    await eventually(() => windowFile().members.alex.pending.length === 0);
    expect(textsTo(ALEX_WA)).toContain("fresh plan");
  });

  test("with no template the member's send fails with a plain reason, nothing is kept, and a household send is not claimed as posted", async () => {
    openWindows();
    const { messenger } = await boot({ template: false });
    clock += 25 * HOUR;
    const outcome = await messenger.sendToConversation("Monday: tacos", "plan-1");
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("expected failed");
    expect(outcome.recipients!.map((recipient) => recipient.kind)).toEqual(["failed", "failed"]);
    expect(outcome.recipients![1]!.detail).toBe("waiting for Sam to message the bot; WhatsApp only allows replies within 24 hours");
    expect(api.requests.filter((request) => request.method === "POST")).toEqual([]);
    expect(existsSync(join(stateDir, "whatsapp-window.json"))).toBe(true);
    expect(windowFile().members.sam.pending).toEqual([]);
  });

  test("a household send where one member is in the window and one is not is Partial, naming the one who missed it", async () => {
    openWindows();
    const { adapter, messenger } = await boot({ template: false });
    clock += 25 * HOUR;
    await postWebhook(adapter.webhookPort!, webhookBody({ messages: [{ from: SAM_WA, text: "hi", timestamp: Math.floor(clock / 1000) }] }));
    const outcome = await messenger.sendToConversation("Monday: tacos", "plan-1");
    expect(outcome.kind).toBe("partial");
    if (outcome.kind !== "partial") throw new Error("expected partial");
    expect(outcome.failedMembers).toEqual([{ member: "alex", type: "FAILED" }]);
    expect(textsTo(SAM_WA)).toContain("Monday: tacos");
  });

  test("a household send with the template path is Failed overall, and the text is not claimed as posted to anyone", async () => {
    openWindows();
    const { messenger } = await boot();
    clock += 25 * HOUR;
    const outcome = await messenger.sendToConversation("Monday: tacos", "plan-1");
    expect(outcome.kind).toBe("failed");
    expect(templatesTo(ALEX_WA)).toHaveLength(1);
    expect(templatesTo(SAM_WA)).toHaveLength(1);
  });

  test("a member who has never written is outside the window", async () => {
    const { messenger } = await boot();
    const outcome = await messenger.sendToMember("sam", "hello");
    expect(outcome.kind).toBe("failed");
    expect(templatesTo(SAM_WA)).toHaveLength(1);
  });

  test("Meta saying 131047 inside what we thought was the window is treated as closed, and nothing was sent", async () => {
    openWindows();
    const { messenger } = await boot();
    api.scriptSends([{ error: 400, code: 131047, message: "Re-engagement message" }]);
    const outcome = await messenger.sendToMember("alex", "Monday: tacos");
    expect(outcome.kind).toBe("failed");
    expect(templatesTo(ALEX_WA)).toHaveLength(1);
    expect(windowFile().members.alex.pending.map((item: any) => item.text)).toEqual(["Monday: tacos"]);
    expect(windowFile().members.alex.lastInboundAt).toBe(0);
  });

  test("the window, the template note and the waiting texts survive a restart", async () => {
    openWindows();
    const first = await boot();
    clock += 25 * HOUR;
    await first.messenger.sendToMember("alex", "Monday: tacos");
    await first.messenger.stop();
    running.length = 0;
    api.requests.length = 0;

    // Sam wrote again after the restart, so Sam is back inside the window.
    const second = await boot();
    await postWebhook(second.adapter.webhookPort!, webhookBody({ messages: [{ from: SAM_WA, text: "hi", timestamp: Math.floor(clock / 1000) }] }));
    expect((await second.messenger.sendToMember("sam", "hello Sam")).kind).toBe("sent");
    // Alex's template was already sent before the restart, so a new send waits without another one.
    await second.messenger.sendToMember("alex", "Tuesday: soup");
    expect(templatesTo(ALEX_WA)).toHaveLength(0);
    expect(windowFile().members.alex.pending.map((item: any) => item.text)).toEqual(["Monday: tacos", "Tuesday: soup"]);

    await second.messenger.stop();
    running.length = 0;
    const third = await boot();
    await postWebhook(third.adapter.webhookPort!, webhookBody({ messages: [{ text: "back", timestamp: Math.floor(clock / 1000) }] }));
    await eventually(() => textsTo(ALEX_WA).length === 2);
    expect(textsTo(ALEX_WA)).toEqual(["Monday: tacos", "Tuesday: soup"]);
  });

  test("an old message redelivered by Meta does not shrink or reopen the window", async () => {
    openWindows();
    const { adapter, messenger } = await boot();
    clock += 30 * HOUR;
    const old = Math.floor((clock - 29 * HOUR) / 1000);
    await postWebhook(adapter.webhookPort!, webhookBody({ messages: [{ text: "old news", timestamp: old }] }));
    expect((await messenger.sendToMember("alex", "hello")).kind).toBe("failed"); // 29 hours ago is still outside the window
  });
});

describe("how a send ends", () => {
  async function sendWith(reply: Parameters<FakeGraphApi["scriptSends"]>[0][number]) {
    openWindows();
    const { messenger } = await boot();
    api.scriptSends([reply]);
    return messenger.sendToMember("alex", "Monday: tacos");
  }

  test("200 with a message ID is Sent", async () => {
    expect((await sendWith({ ok: true })).kind).toBe("sent");
  });

  test("rate and spam limits are transient failures, with Retry-After when Meta gives it", () => {
    for (const code of [130429, 131048, 131056]) {
      const outcome = sortSendAnswer({ kind: "api-error", httpStatus: 400, code, subcode: null, message: "limit", retryAfterMs: 90_000 });
      expect(outcome).toMatchObject({ kind: "failed", transient: true, failureClass: "rate-limited", retryAfterMs: 90_000 });
    }
    expect(sortSendAnswer({ kind: "api-error", httpStatus: 429, code: null, subcode: null, message: "slow down" })).toMatchObject({ kind: "failed", transient: true, failureClass: "rate-limited" });
  });

  test("a 429 through the real client carries the Retry-After header", async () => {
    const outcome = await sendWith({ error: 429, code: 130429, message: "Rate limit hit", headers: { "retry-after": "12" } });
    expect(outcome.kind).toBe("failed"); // retried 3 times with no sleeping, then given up
    expect(api.sent("text")).toHaveLength(4);
  });

  test("a rejected token (190) is a permanent failure flagged as an auth failure, and not retried", async () => {
    const outcome = await sendWith({ error: 401, code: 190, message: "Error validating access token" });
    expect(outcome.kind).toBe("failed");
    expect(api.sent("text")).toHaveLength(1);
    const record = readFileSync(join(stateDir, "send-failures.jsonl"), "utf8");
    expect(record).toContain('"class":"auth-failed"');
    expect(record).toContain('"authFailed":true');
    expect(sortSendAnswer({ kind: "api-error", httpStatus: 400, code: 190, subcode: null, message: "x" })).toMatchObject({ kind: "failed", failureClass: "auth-failed" });
    expect((sortSendAnswer({ kind: "api-error", httpStatus: 400, code: 190, subcode: null, message: "x" }) as any).transient).toBeUndefined();
  });

  test("another refusal (an unreachable number) is a permanent failure", async () => {
    const outcome = await sendWith({ error: 400, code: 131026, message: "Message undeliverable" });
    expect(outcome.kind).toBe("failed");
    expect(api.sent("text")).toHaveLength(1);
  });

  test("an answer that never comes is Unknown and is not sent again", async () => {
    const outcome = await sendWith({ hang: true });
    expect(outcome.kind).toBe("unknown");
    expect(api.sent("text")).toHaveLength(1);
  });

  test("a 200 with no message ID is not claimed as Sent", () => {
    expect(sortSendAnswer({ kind: "ok", body: {} }).kind).toBe("unknown");
  });

  test("a connection that dies after the request went out is Unknown; one that never connected is a clean, retryable failure", async () => {
    // A server that takes the request and hangs up without answering.
    const hangup = createServer((socket) => socket.once("data", () => socket.destroy()));
    servers.push(hangup);
    await new Promise<void>((resolve) => hangup.listen(0, "127.0.0.1", resolve));
    const port = (hangup.address() as any).port;
    openWindows();
    const dropping = await boot({ adapter: whatsappAdapter(api, stateDir, { now, apiBaseUrl: `http://127.0.0.1:${port}` }) }).catch((error) => error);
    // Start-up only logs a failed lookup (it is not a refusal), so the adapter is up.
    expect(dropping.messenger).toBeDefined();
    const outcome = await dropping.messenger.sendToMember("alex", "hello");
    expect(outcome.kind).toBe("unknown");
    await dropping.messenger.stop();
    running.length = 0;

    const closedPort = port; // the server below is gone, so nothing listens here
    hangup.close();
    await Bun.sleep(20);
    const refused = whatsappAdapter(api, stateDir, { now, apiBaseUrl: `http://127.0.0.1:${closedPort}` });
    const answer = await refused.sendToMember("alex", "hello");
    expect(answer).toMatchObject({ kind: "failed", transient: true });
  });

  test("any 5xx answer, a gateway error included, may have gone out, so it is Unknown; a rate limit is still transient", async () => {
    for (const httpStatus of [500, 502, 503]) {
      expect(sortSendAnswer({ kind: "api-error", httpStatus, code: null, subcode: null, message: "server trouble" }).kind).toBe("unknown");
    }
    expect(sortSendAnswer({ kind: "api-error", httpStatus: 400, code: 130429, subcode: null, message: "rate" })).toMatchObject({ kind: "failed", transient: true });
    expect(sortSendAnswer({ kind: "api-error", httpStatus: 429, code: null, subcode: null, message: "rate" })).toMatchObject({ kind: "failed", transient: true });
  });
});

describe("acknowledgements", () => {
  test("'received' marks the message read and puts 👀 on it; 'handled' puts 👍 on it", async () => {
    openWindows();
    const { adapter, messenger, events } = await boot();
    await postWebhook(adapter.webhookPort!, webhookBody({ messages: [{ id: "wamid.IN1", text: "hi" }] }));
    await eventually(() => api.sent("reaction").length === 1);
    expect(api.reads()).toEqual([{ messaging_product: "whatsapp", status: "read", message_id: "wamid.IN1" }]);
    expect(api.sent("reaction")[0]).toMatchObject({ to: ALEX_WA, reaction: { message_id: "wamid.IN1", emoji: "👀" } });

    messenger.markHandled(events[0]!.id);
    await eventually(() => api.sent("reaction").length === 2);
    expect(api.sent("reaction")[1].reaction.emoji).toBe("👍");
  });

  test("a failed read mark or reaction is reported, and the other still goes out", async () => {
    const { adapter } = await boot();
    api.override("read", { error: 400, code: 100, message: "nope" });
    const ref = { platform: "whatsapp" as const, conversationId: ALEX_WA, nativeId: "wamid.X", sender: { identity: ALEX_WA, displayName: null }, timestamp: 1 };
    await expect(adapter.acknowledge(ref, "received")).rejects.toThrow(/marking wamid.X as read failed/);
    expect(api.sent("reaction")).toHaveLength(1);
  });
});

describe("health", () => {
  test("it reads the phone number's record and reports webhook activity separately, and never sends a message", async () => {
    const { adapter } = await boot();
    const quiet = await adapter.checkHealth();
    expect(quiet.healthy).toBe(true);
    expect(quiet.reason).toContain("Dinner Bot");
    expect(quiet.reason).toContain("quality GREEN");
    expect(quiet.reason).toContain("no webhook call received since the bridge started");

    await postWebhook(adapter.webhookPort!, webhookBody({ statuses: [statusEntry("wamid.OUT1", "sent")] }));
    clock += 5 * 60_000;
    expect((await adapter.checkHealth()).reason).toContain("last webhook call 5 minutes ago");
    expect(api.requests.filter((request) => request.method === "POST")).toEqual([]);
    expect(api.requests.some((request) => request.path === `${PHONE_NUMBER_ID}` && request.method === "GET")).toBe(true);
  });

  test("an unsigned call does not count as webhook activity", async () => {
    const { adapter } = await boot();
    await postWebhook(adapter.webhookPort!, webhookBody({}), { signature: null });
    expect(adapter.webhookActivity().lastVerifiedPostAt).toBeNull();
  });

  test("a rejected token or an unreachable number is unhealthy, and says what failed", async () => {
    const { adapter } = await boot();
    api.override("lookup", { error: 401, code: 190, message: "Error validating access token" });
    const result = await adapter.checkHealth();
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain("190");
  });
});

describe("start-up", () => {
  const start = (overrides: Parameters<typeof whatsappConfig>[2]) => {
    const adapter = new WhatsAppAdapter(whatsappConfig(api, stateDir, overrides));
    running.push(adapter);
    return adapter.start(bareHandlers(async () => {}));
  };

  test("a missing secret, token or phone number ID is refused in plain words", async () => {
    await expect(start({ appSecret: "" })).rejects.toThrow(/app secret is not set/);
    await expect(start({ accessToken: "" })).rejects.toThrow(/access token is not set/);
    await expect(start({ verifyToken: "" })).rejects.toThrow(/verify token is not set/);
    await expect(start({ phoneNumberId: "" })).rejects.toThrow(/phone number ID is not set/);
    await expect(start({ members: [{ id: "alex", name: "Alex", waId: "" }] })).rejects.toThrow(/Alex has no WhatsApp number/);
  });

  test("a rejected access token stops the start; a lookup that merely fails does not", async () => {
    api.override("lookup", { error: 401, code: 190, message: "bad token" });
    await expect(start({})).rejects.toThrow(/rejected the access token/);
    api.override("lookup", { error: 500, code: 1, message: "hiccup" });
    await start({});
  });

  test("a webhook port that is already taken is a plain start-up error", async () => {
    const first = new WhatsAppAdapter(whatsappConfig(api, stateDir));
    running.push(first);
    await first.start(bareHandlers(async () => {}));
    const port = first.webhookPort!;
    const second = new WhatsAppAdapter(whatsappConfig(api, stateDir, { webhook: { host: "127.0.0.1", port, path: WEBHOOK_PATH } }));
    await expect(second.start(bareHandlers(async () => {}))).rejects.toThrow(StartupError);
  });

  test("there is no group chat to send to", async () => {
    const adapter = whatsappAdapter(api, stateDir);
    expect(adapter.capabilities.nativeGroups).toBe(false);
    expect((await adapter.sendToConversation("hi")).kind).toBe("failed");
    expect((await adapter.sendToMember("nobody", "hi")).kind).toBe("failed");
  });
});

describe("secrets", () => {
  test("the token, app secret and verify token reach no log line, journal, state file or failure record", async () => {
    openWindows();
    const { adapter, messenger, logs } = await boot();
    const port = adapter.webhookPort!;
    // Make Meta's own error text echo the token back at us, as a badly behaved proxy might.
    api.override("template", { error: 400, code: 100, message: `bad request for ${FAKE_ACCESS_TOKEN} and ${FAKE_APP_SECRET}` });
    clock += 25 * HOUR;
    const outcome = await messenger.sendToMember("alex", "Monday: tacos");
    expect(outcome.kind).toBe("failed");
    expect("detail" in outcome ? outcome.detail : "").toContain("<secret>");

    await postWebhook(port, webhookBody({ messages: [{ text: "hi", timestamp: Math.floor(clock / 1000) }] }), { signature: "sha256=bad" });
    await fetch(`http://127.0.0.1:${port}${WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${FAKE_VERIFY_TOKEN}x&hub.challenge=1`);
    await adapter.checkHealth();

    const everything = [logs.join("\n"), ...readdirSync(stateDir).map((name) => readFileSync(join(stateDir, name), "utf8"))].join("\n");
    for (const secret of [FAKE_ACCESS_TOKEN, FAKE_APP_SECRET, FAKE_VERIFY_TOKEN]) expect(everything).not.toContain(secret);
    // The token only ever travelled in the Authorization header.
    expect(api.requests.every((request) => request.authorization === `Bearer ${FAKE_ACCESS_TOKEN}`)).toBe(true);
  });
});

describe("configuration", () => {
  const configText = [
    '[household]\nname = "H"',
    '[[members]]\nid = "alex"\nname = "Alex"\nrole = "admin"\n[members.identities]\nwhatsapp = "+15555550101"',
    '[[members]]\nid = "sam"\nname = "Sam"\nrole = "adult"\n[members.identities]\nwhatsapp = "15555550102"',
    '[schedule]\ntimezone = "UTC"',
    '[messaging]\nplatform = "whatsapp"',
    '[messaging.whatsapp]\nphoneNumberId = "123456789"',
  ].join("\n");
  const parse = (text: string) => parseConfig(text, { baseDir: "/base", env: {} });

  test("defaults: household-dms, a recent API version, the usual variable names, no template; numbers are stored digits only", () => {
    const config = parse(configText);
    expect(config.messaging.mode).toBe("household-dms");
    expect(config.messaging.whatsapp).toEqual({
      phoneNumberId: "123456789",
      apiVersion: "v23.0",
      webhook: { host: "127.0.0.1", port: 8787, path: "/whatsapp/webhook" },
      accessTokenEnv: "WHATSAPP_ACCESS_TOKEN",
      appSecretEnv: "WHATSAPP_APP_SECRET",
      verifyTokenEnv: "WHATSAPP_VERIFY_TOKEN",
      template: null,
    });
    expect(config.members.map((member) => member.identities.whatsapp)).toEqual(["15555550101", "15555550102"]);
  });

  test("the webhook, version and template can be set", () => {
    const config = parse(
      configText +
        '\napiVersion = "v24.0"\n[messaging.whatsapp.webhook]\nhost = "0.0.0.0"\nport = 9000\npath = "/hook"\n[messaging.whatsapp.template]\nname = "meal_plan_ready"\nlanguage = "en_GB"',
    );
    expect(config.messaging.whatsapp.apiVersion).toBe("v24.0");
    expect(config.messaging.whatsapp.webhook).toEqual({ host: "0.0.0.0", port: 9000, path: "/hook" });
    expect(config.messaging.whatsapp.template).toEqual({ name: "meal_plan_ready", language: "en_GB" });
  });

  test("group mode is refused with a plain message", () => {
    expect(() => parse(configText + '\n[messaging.conversation]\nmode = "group"')).toThrow(/not available on WhatsApp/);
    expect(() => parse(configText + '\n[messaging.conversation]\nmode = "group"')).toThrow(/household-dms/);
  });

  test("a missing phone number ID, a bad version, and a template with no name are refused", () => {
    expect(() => parse(configText.replace('[messaging.whatsapp]\nphoneNumberId = "123456789"', "[messaging.whatsapp]"))).toThrow(/phoneNumberId is missing/);
    expect(() => parse(configText + '\napiVersion = "latest"')).toThrow(/apiVersion/);
    expect(() => parse(configText + '\n[messaging.whatsapp.template]\nlanguage = "en_US"')).toThrow(/template.name is missing/);
  });

  test("createAdapter builds the WhatsApp adapter, reading the secrets from the named variables", () => {
    const config = parse(configText);
    const env = { WHATSAPP_ACCESS_TOKEN: "a", WHATSAPP_APP_SECRET: "b", WHATSAPP_VERIFY_TOKEN: "c", HMP_WHATSAPP_API_URL: "http://127.0.0.1:1" };
    expect(createAdapter(config, env)).toBeInstanceOf(WhatsAppAdapter);
    expect(whatsappAdapterConfig(config, env)).toMatchObject({ accessToken: "a", appSecret: "b", verifyToken: "c", apiBaseUrl: "http://127.0.0.1:1" });
  });
});

describe("bun run doctor", () => {
  const configText = [
    '[household]\nname = "H"',
    '[[members]]\nid = "alex"\nname = "Alex"\nrole = "admin"\n[members.identities]\nwhatsapp = "15555550101"',
    '[schedule]\ntimezone = "UTC"',
    '[messaging]\nplatform = "whatsapp"',
    '[messaging.whatsapp]\nphoneNumberId = "123456789"',
  ].join("\n");

  async function household(env: Record<string, string> = {}) {
    const { mkdtempSync, writeFileSync, mkdirSync, copyFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "doctor-wa-"));
    writeFileSync(join(dir, "config.toml"), configText);
    mkdirSync(join(dir, "data"));
    copyFileSync(join(import.meta.dir, "..", "..", "data.example", "profile.md"), join(dir, "data", "profile.md"));
    return { HMP_CONFIG: join(dir, "config.toml"), ANTHROPIC_API_KEY: "k", ...env };
  }

  test("offline it names each missing setting and sends nothing", async () => {
    const report = runDoctor(await household());
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain("WHATSAPP_ACCESS_TOKEN");
    expect(report.problems.join("\n")).toContain("WHATSAPP_APP_SECRET");
    expect(report.problems.join("\n")).toContain("WHATSAPP_VERIFY_TOKEN");
  });

  test("offline with everything set it says where the webhook listens and warns that there is no template", async () => {
    const report = runDoctor(await household({ WHATSAPP_ACCESS_TOKEN: "a", WHATSAPP_APP_SECRET: "b", WHATSAPP_VERIFY_TOKEN: "c" }));
    expect(report.ok).toBe(true);
    const text = report.lines.join("\n");
    expect(text).toContain("webhook listens on 127.0.0.1:8787/whatsapp/webhook");
    expect(text).toContain("template: none set");
    expect(text).not.toMatch(/\ba\b.*\bb\b.*\bc\b/);
  });

  test("--online reads the phone number and nothing else", async () => {
    const env = await household({ WHATSAPP_ACCESS_TOKEN: FAKE_ACCESS_TOKEN, WHATSAPP_APP_SECRET: "b", WHATSAPP_VERIFY_TOKEN: "c", HMP_WHATSAPP_API_URL: api.url });
    const report = await runOnlineChecks({ ...env }, FAKE_RECIPE_APIS);
    // The household's phone number ID is "123456789", which the fake does not know.
    expect(report.ok).toBe(false);
    expect(api.requests.filter((request) => request.method === "POST")).toEqual([]);

    const good = await diagnoseWhatsApp(whatsappConfig(api, stateDir));
    expect(good.problems).toEqual([]);
    expect(good.lines.join("\n")).toContain("Dinner Bot");
    expect(good.lines.join("\n")).toContain("quality rating: GREEN");
    expect(api.requests.filter((request) => request.method === "POST")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// Waiting texts that survive a crash without going out twice, dry run, and "waiting for a reply".

describe("waiting texts and crashes", () => {
  const writeWindow = (members: Record<string, unknown>) => writeFileSync(join(stateDir, "whatsapp-window.json"), JSON.stringify({ members }));
  const waiting = (text: string, extra: Record<string, unknown> = {}) => ({ id: `id-${text}`, text, queuedAt: clock, ...extra });

  test("each waiting text has a stable id, and the attempt is on disk before the text is posted", async () => {
    openWindows();
    const { adapter, messenger } = await boot();
    clock += 25 * HOUR;
    await messenger.sendToMember("alex", "Monday: tacos");
    const ids = windowFile().members.alex.pending.map((item: any) => item.id);
    expect(ids).toHaveLength(1);
    expect(typeof ids[0]).toBe("string");

    // Meta never answers, so the file shows the state at the moment of the post.
    api.scriptSends([{ hang: true }]);
    await postWebhook(adapter.webhookPort!, webhookBody({ messages: [{ text: "hi", timestamp: Math.floor(clock / 1000) }] }));
    await eventually(() => api.sent("text").length === 1);
    const item = windowFile().members.alex.pending[0];
    expect(item.id).toBe(ids[0]);
    expect(typeof item.attemptedAt).toBe("number"); // recorded, with no outcome yet
    expect(item.outcome).toBeUndefined();
  });

  test("after a crash, a text with an attempt but no outcome is dropped as Unknown and never sent again", async () => {
    writeWindow({
      alex: { lastInboundAt: 0, templateSentAt: null, pending: [waiting("cut off", { attemptedAt: clock - 1000 }), waiting("never tried")] },
    });
    const { adapter, logs } = await boot();
    expect(logs.some((line) => line.includes("it may have gone out, so it is dropped and not sent again"))).toBe(true);
    expect(windowFile().members.alex.pending.map((item: any) => item.text)).toEqual(["never tried"]);

    // The next time Alex writes, only the text that was never tried goes out.
    await postWebhook(adapter.webhookPort!, webhookBody({ messages: [{ text: "hi", timestamp: Math.floor(clock / 1000) }] }));
    await eventually(() => windowFile().members.alex.pending.length === 0);
    expect(textsTo(ALEX_WA)).toEqual(["never tried"]);
  });

  test("after a crash, a text whose outcome was recorded is finished: delivered ones go, ones that only stayed waiting are kept", async () => {
    writeWindow({
      alex: {
        lastInboundAt: 0,
        templateSentAt: null,
        pending: [waiting("delivered", { attemptedAt: clock - 5, outcome: "sent" }), waiting("rate limited", { attemptedAt: clock - 5, outcome: "stays" })],
      },
    });
    await boot();
    const pending = windowFile().members.alex.pending;
    expect(pending.map((item: any) => item.text)).toEqual(["rate limited"]);
    expect(pending[0].attemptedAt).toBeUndefined();
    expect(api.sent("text")).toEqual([]);
  });

  test("a waiting text saved before ids existed gets one", async () => {
    writeWindow({ alex: { lastInboundAt: 0, templateSentAt: null, pending: [{ text: "old format", queuedAt: clock }] } });
    const store = new WindowStore(stateDir);
    expect(typeof store.pending("alex")[0]!.id).toBe("string");
  });

  test("a text that is delivered is dropped by its id; one that fails for now stays, with its attempt cleared", async () => {
    openWindows();
    const { adapter, messenger } = await boot();
    clock += 25 * HOUR;
    await messenger.sendToMember("alex", "stays");
    api.scriptSends([{ error: 429, code: 130429 }]);
    await postWebhook(adapter.webhookPort!, webhookBody({ messages: [{ text: "hi", timestamp: Math.floor(clock / 1000) }] }));
    await eventually(() => api.sent("text").length === 1);
    await Bun.sleep(30);
    const item = windowFile().members.alex.pending[0];
    expect(item.text).toBe("stays");
    expect(item.attemptedAt).toBeUndefined();
    expect(item.outcome).toBeUndefined();
  });
});

describe("dry run", () => {
  test("waiting texts are kept, not delivered or dropped, and no template or text is posted", async () => {
    const store = new WindowStore(stateDir);
    store.recordInbound("alex", clock - 25 * HOUR);
    store.addPending("alex", "kept for a real run", clock - HOUR);
    const adapter = whatsappAdapter(api, stateDir, { now, dryRun: true });
    const { logs } = await boot({ adapter });

    // Alex writes, so the window opens and the waiting text would normally go out.
    await postWebhook(adapter.webhookPort!, webhookBody({ messages: [{ text: "hi", timestamp: Math.floor(clock / 1000) }] }));
    await eventually(() => logs.some((line) => line.includes("DRY RUN: would deliver")));
    expect(windowFile().members.alex.pending.map((item: any) => item.text)).toEqual(["kept for a real run"]);
    expect(windowFile().members.alex.pending[0].attemptedAt).toBeUndefined();

    // A send outside the window would send the template and keep the text; in dry run it does neither.
    clock += 30 * HOUR;
    const outcome = await adapter.sendToMember("sam", "Monday: tacos");
    expect(outcome.kind).toBe("failed");
    expect(api.sent("text")).toEqual([]);
    expect(api.sent("template")).toEqual([]);
    expect(api.sent("reaction")).toEqual([]);
    expect(api.reads()).toEqual([]);
    expect(api.requests.filter((request) => request.method === "POST")).toEqual([]);
  });
});

describe("a draft kept for replies is reported as waiting, not as failed", () => {
  test("every member outside the window: failed, and flagged as queued for all of them", async () => {
    openWindows();
    const { messenger } = await boot();
    clock += 25 * HOUR;
    const outcome = await messenger.sendToConversation("Monday: tacos", "draft-1");
    expect(outcome).toMatchObject({ kind: "failed", queued: true });
    expect(outcome.recipients!.map((recipient) => [recipient.memberId, recipient.kind, recipient.queued])).toEqual([
      ["alex", "failed", true],
      ["sam", "failed", true],
    ]);
  });

  test("one member inside the window and one outside: partial, flagged as queued, the waiting one named", async () => {
    openWindows();
    const { adapter, messenger } = await boot();
    clock += 25 * HOUR;
    // Alex writes in a moment ago (the default sender of a test webhook); Sam does not.
    await postWebhook(adapter.webhookPort!, webhookBody({ messages: [{ text: "hi", timestamp: Math.floor(clock / 1000) }] }));
    const outcome = await messenger.sendToConversation("Monday: tacos", "draft-2");
    expect(outcome).toMatchObject({ kind: "partial", queued: true, failedMembers: [{ member: "sam", type: "QUEUED" }] });
    expect(textsTo(ALEX_WA)).toEqual(["Monday: tacos"]);
    expect(textsTo(SAM_WA)).toEqual([]);
  });

  test("with no template the text is not kept, so it is a plain failure, not a queued one", async () => {
    openWindows();
    const { messenger } = await boot({ template: false });
    clock += 25 * HOUR;
    const outcome = await messenger.sendToConversation("Monday: tacos", "draft-3");
    expect(outcome.kind).toBe("failed");
    expect(outcome.queued).toBeUndefined();
  });
});
