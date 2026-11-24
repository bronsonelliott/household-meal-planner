// The adapter kits the shared contract suite (test/messaging-contract.ts) runs against:
// the in-memory FakeAdapter, the Signal adapter talking to the fake signal-cli, the Telegram
// adapter talking to the fake Bot API, and the WhatsApp adapter talking to the fake Graph API.
//
// A kit knows how to build an adapter on the platform it wraps, how to make "inbound messages"
// show up while the adapter starts, how to script how sends end, and how to read back what reached
// the platform. The suite never touches platform details; a new platform's slice adds one more kit.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Member } from "../../src/config.ts";
import { FAKE_CONVERSATION_ID, FakeAdapter } from "../../src/messaging/fake.ts";
import { SignalAdapter } from "../../src/messaging/signal/adapter.ts";
import { TelegramAdapter } from "../../src/messaging/telegram/adapter.ts";
import { IMessageAdapter } from "../../src/messaging/imessage/adapter.ts";
import { WhatsAppAdapter } from "../../src/messaging/whatsapp/adapter.ts";
import { writeFileSync } from "node:fs";
import type { AckKind, MessagingAdapter, SendOutcome } from "../../src/messaging/types.ts";
import { ALEX_ID, FakeTelegramApi, GROUP_CHAT_ID, SAM_ID, STRANGER_ID, TEST_MEMBERS, telegramConfig, type Reply } from "./fake-telegram-api.ts";
import {
  ALEX_WA,
  FakeGraphApi,
  SAM_WA,
  STRANGER_WA,
  WHATSAPP_MEMBERS,
  postWebhook,
  webhookBody,
  whatsappConfig,
  type Reply as GraphReply,
} from "./fake-whatsapp-api.ts";
import {
  ALEX_HANDLE,
  FakeBlueBubbles,
  GROUP_GUID as IMESSAGE_GROUP_GUID,
  IMESSAGE_MEMBERS,
  SAM_HANDLE,
  STRANGER_HANDLE,
  imessageConfig,
  type Reply as BlueBubblesReply,
} from "./fake-bluebubbles.ts";
import type { FakeReply } from "./fake-signal-cli.ts";
import { BOT_NUMBER, GROUP_ID, fakeLog, makeConfig, readFixture } from "./signal-harness.ts";

// ---------------------------------------------------------------------------------------
// What a kit offers the suite

export type Who = "alex" | "sam" | "stranger";

// One message arriving while the adapter starts. `n` makes its platform ID and time unique.
export interface InboundSpec {
  from: Who;
  n: number;
  text?: string;
  attachments?: boolean;
  group?: boolean; // default true; false is a private message
  displayName?: string; // what the platform shows for the sender (a stranger can claim any name)
}

// How one send attempt ends.
export type SendStep = "sent" | "transient-failure" | "unknown";

export interface AdapterSetup {
  mode: "group" | "household-dms";
  inbound?: InboundSpec[];
  sendScript?: SendStep[]; // the last step repeats
  failAcks?: boolean;
  // Dry run, as the real bridge sets it on the adapter's own settings.
  dryRun?: boolean;
}

export interface RecordedSend {
  scope: "conversation" | "member";
  memberId: string | null; // "alex" / "sam" for a member send
  text: string;
}

export interface ContractKit {
  platform: string;
  members: Member[]; // Alex and Sam, each with an identity on this platform
  newAdapter(setup: AdapterSetup): MessagingAdapter;
  // Everything that reached the platform since the kit was made, across restarts.
  sends(): Promise<RecordedSend[]>;
  acks(): Promise<Array<{ kind: AckKind }>>;
}

export type KitFactory = (stateDir: string) => ContractKit;

// ---------------------------------------------------------------------------------------
// FakeAdapter kit

const FAKE_IDS: Record<Who, string> = { alex: "1001", sam: "1002", stranger: "9999" };

class PreloadedFake extends FakeAdapter {
  constructor(
    options: ConstructorParameters<typeof FakeAdapter>[0],
    private inbound: InboundSpec[],
    private baseTime: number,
  ) {
    super(options);
  }

  // Messages arrive during start-up, and start() resolves only after each is journaled.
  override async start(handlers: Parameters<FakeAdapter["start"]>[0]): Promise<void> {
    await super.start(handlers);
    for (const spec of this.inbound) {
      const group = spec.group ?? true;
      await this.inject({
        sender: { identity: FAKE_IDS[spec.from], displayName: spec.displayName ?? null },
        nativeId: `m${spec.n}`,
        isGroup: group,
        conversationId: group ? undefined : FAKE_IDS[spec.from],
        text: spec.text ?? "",
        hasAttachments: spec.attachments ?? false,
        timestamp: this.baseTime + spec.n,
      });
    }
  }
}

const STEP_OUTCOME: Record<SendStep, SendOutcome> = {
  sent: { kind: "sent", timestamp: 1 },
  "transient-failure": { kind: "failed", detail: "the fake platform is having a bad moment", transient: true },
  unknown: { kind: "unknown", detail: "the fake platform never answered" },
};

export const fakeKit: KitFactory = () => {
  const adapters: FakeAdapter[] = [];
  const members: Member[] = [
    { id: "alex", name: "Alex", role: "admin", identities: { telegram: FAKE_IDS.alex } },
    { id: "sam", name: "Sam", role: "adult", identities: { telegram: FAKE_IDS.sam } },
  ];
  return {
    platform: "fake (telegram-shaped)",
    members,
    newAdapter(setup) {
      const adapter = new PreloadedFake(
        { platform: "telegram", conversationId: setup.mode === "group" ? FAKE_CONVERSATION_ID : null, maxMessageChars: 1000 },
        setup.inbound ?? [],
        1_790_000_000_000,
      );
      adapter.failAcks = setup.failAcks ?? false;
      adapter.scriptSends((setup.sendScript ?? []).map((step) => STEP_OUTCOME[step]));
      adapters.push(adapter);
      return adapter;
    },
    async sends() {
      return adapters.flatMap((adapter) => adapter.sends.map(({ scope, memberId, text }) => ({ scope, memberId, text })));
    },
    async acks() {
      return adapters.flatMap((adapter) => adapter.acks.map((ack) => ({ kind: ack.kind })));
    },
  };
};

// ---------------------------------------------------------------------------------------
// Signal kit (the real adapter, the fake signal-cli)

const SIGNAL_IDS: Record<Who, string> = {
  alex: "aaaaaaaa-0000-4000-8000-000000000001",
  sam: "dddddddd-0000-4000-8000-00000000000d",
  stranger: "cccccccc-0000-4000-8000-00000000000c",
};
const SIGNAL_BASE_TIME = 1_790_900_000_000;

const SIGNAL_STEP: Record<SendStep, FakeReply> = {
  sent: { fixture: "rpc-send-group-success-response.json" },
  "transient-failure": { error: { code: -3, message: "Failed to send message: IO error" } },
  unknown: { noReply: true },
};

function signalEnvelope(spec: InboundSpec): object {
  const group = spec.group ?? true;
  const notification = readFixture(group ? "group-text.json" : "direct-message.json");
  const envelope = notification.params.result.envelope;
  const timestamp = SIGNAL_BASE_TIME + spec.n;
  envelope.source = SIGNAL_IDS[spec.from];
  envelope.sourceUuid = SIGNAL_IDS[spec.from];
  envelope.sourceName = spec.displayName ?? "Somebody";
  envelope.timestamp = timestamp;
  envelope.dataMessage.timestamp = timestamp;
  envelope.dataMessage.message = spec.text ?? "";
  if (spec.attachments) envelope.dataMessage.attachments = [{ contentType: "image/jpeg", id: "fake-attachment" }];
  return notification;
}

export const signalKit: KitFactory = (stateDir) => {
  const access = {
    botNumber: BOT_NUMBER,
    groupId: GROUP_ID,
    allowlist: [
      { name: "Alex", accountId: SIGNAL_IDS.alex },
      { name: "Sam", accountId: SIGNAL_IDS.sam },
    ],
  };
  const members = makeConfig(stateDir, {}, { access }).members;

  return {
    platform: "signal",
    members,
    newAdapter(setup) {
      // The fake signal-cli's group needs Sam in it for the start-up group check.
      const groups = readFixture("rpc-listGroups-response.json");
      groups.result[0].members.push({ number: null, uuid: SIGNAL_IDS.sam, isAdmin: false });
      const steps = setup.sendScript ?? ["sent"];
      const scenario = {
        listGroups: { result: groups.result },
        afterSubscribe: (setup.inbound ?? []).map(signalEnvelope),
        send: steps.map((step) => SIGNAL_STEP[step]),
        ...(setup.failAcks ? { sendReaction: { error: { code: -1, message: "nope" } } } : {}),
      };
      const config = makeConfig(stateDir, scenario, { access, mode: setup.mode, rpcTimeoutMs: 300, settleMs: 100 });
      return new SignalAdapter({ ...config.signal, ...(setup.dryRun ? { dryRun: true } : {}) });
    },
    async sends() {
      const accountToMember = new Map(members.map((member) => [member.identities.signal!, member.id]));
      return fakeLog(stateDir)
        .requests.filter((request) => request.method === "send")
        .map((request) =>
          "groupId" in request.params
            ? { scope: "conversation" as const, memberId: null, text: request.params.message }
            : { scope: "member" as const, memberId: accountToMember.get(request.params.recipient[0]) ?? null, text: request.params.message },
        );
    },
    async acks() {
      const kinds: Record<string, AckKind> = { "👀": "received", "✅": "handled" };
      return fakeLog(stateDir)
        .requests.filter((request) => request.method === "sendReaction")
        .map((request) => ({ kind: kinds[request.params.emoji]! }));
    },
  };
};


// ---------------------------------------------------------------------------------------
// Telegram kit (the real adapter, the fake Bot API)

const TELEGRAM_IDS: Record<Who, string> = { alex: ALEX_ID, sam: SAM_ID, stranger: STRANGER_ID };
const TELEGRAM_STEP: Record<SendStep, Reply> = {
  sent: { ok: true, result: { message_id: 500, date: 1_790_000_100 } },
  "transient-failure": { error: 429, description: "Too Many Requests: retry later" },
  unknown: { hang: true },
};

// Messages arrive at the fake Bot API just before the adapter starts, so start() journals them.
class PreloadedTelegram extends TelegramAdapter {
  constructor(
    config: ConstructorParameters<typeof TelegramAdapter>[0],
    private fakeApi: FakeTelegramApi,
    private inbound: InboundSpec[],
  ) {
    super(config);
  }

  override async start(handlers: Parameters<TelegramAdapter["start"]>[0]): Promise<void> {
    for (const spec of this.inbound) {
      const group = spec.group ?? true;
      this.fakeApi.push({
        from: TELEGRAM_IDS[spec.from],
        chat: group ? GROUP_CHAT_ID : TELEGRAM_IDS[spec.from],
        messageId: 1000 + spec.n,
        firstName: spec.displayName ?? "Somebody",
        ...(spec.text !== undefined ? { text: spec.text } : {}),
        ...(spec.attachments ? { extra: { photo: [{ file_id: "fake" }] } } : {}),
      });
    }
    await super.start(handlers);
  }
}

export const telegramKit: KitFactory = (stateDir) => {
  const api = new FakeTelegramApi();
  const members: Member[] = TEST_MEMBERS;
  return {
    platform: "telegram",
    members,
    newAdapter(setup) {
      api.override("setMessageReaction", setup.failAcks ? { error: 400, description: "Bad Request: REACTION_INVALID" } : null);
      api.scriptSends((setup.sendScript ?? []).map((step) => TELEGRAM_STEP[step]));
      const config = { mode: setup.mode, chatId: setup.mode === "group" ? GROUP_CHAT_ID : null };
      return new PreloadedTelegram(telegramConfig(api, stateDir, { ...config, ...(setup.dryRun ? { dryRun: true } : {}) }), api, setup.inbound ?? []);
    },
    async sends() {
      return api.sends().map((send) =>
        String(send.chat_id) === GROUP_CHAT_ID
          ? { scope: "conversation" as const, memberId: null, text: send.text }
          : { scope: "member" as const, memberId: members.find((member) => member.identities.telegram === String(send.chat_id))?.id ?? null, text: send.text },
      );
    },
    async acks() {
      const kinds: Record<string, AckKind> = { "👀": "received", "👍": "handled" };
      return api.calls("setMessageReaction").map((call) => ({ kind: kinds[call.reaction[0].emoji]! }));
    },
  };
};


// ---------------------------------------------------------------------------------------
// WhatsApp kit (the real adapter, the fake Graph API, signed webhook calls)

const WHATSAPP_IDS: Record<Who, string> = { alex: ALEX_WA, sam: SAM_WA, stranger: STRANGER_WA };
const WHATSAPP_STEP: Record<SendStep, GraphReply> = {
  sent: { ok: true },
  "transient-failure": { error: 429, code: 130429, message: "Rate limit hit" },
  unknown: { hang: true },
};

// Messages arrive as signed webhook calls right after the adapter starts, and start() returns
// only once each has been answered 200, which the adapter does after the inbox journal write.
class PreloadedWhatsApp extends WhatsAppAdapter {
  constructor(
    config: ConstructorParameters<typeof WhatsAppAdapter>[0],
    private inbound: InboundSpec[],
  ) {
    super(config);
  }

  override async start(handlers: Parameters<WhatsAppAdapter["start"]>[0]): Promise<void> {
    await super.start(handlers);
    for (const spec of this.inbound) {
      // The official API has no group chats, so a "group" message cannot reach the bot at all.
      if (spec.group ?? true) continue;
      const response = await postWebhook(
        this.webhookPort!,
        webhookBody({
          messages: [
            { from: WHATSAPP_IDS[spec.from], id: `wamid.IN${spec.n}`, name: spec.displayName ?? "Somebody", ...(spec.attachments ? { type: "image" } : { text: spec.text ?? "" }) },
          ],
        }),
      );
      if (response.status !== 200) throw new Error(`the webhook answered ${response.status}`);
    }
  }
}

export const whatsappKit: KitFactory = (stateDir) => {
  const api = new FakeGraphApi();
  const members: Member[] = WHATSAPP_MEMBERS;
  return {
    platform: "whatsapp",
    members,
    newAdapter(setup) {
      api.override("reaction", setup.failAcks ? { error: 400, code: 100, message: "Invalid parameter" } : null);
      api.scriptSends((setup.sendScript ?? []).map((step) => WHATSAPP_STEP[step]));
      // Both members wrote to the bot a moment ago, so their 24-hour windows are open. (The first
      // adapter of a test sets this up; a restart keeps whatever the adapter saved.)
      const windowFile = join(stateDir, "whatsapp-window.json");
      if (!existsSync(windowFile)) {
        const now = Date.now();
        writeFileSync(windowFile, JSON.stringify({ members: { alex: { lastInboundAt: now, templateSentAt: null, pending: [] }, sam: { lastInboundAt: now, templateSentAt: null, pending: [] } } }));
      }
      return new PreloadedWhatsApp(whatsappConfig(api, stateDir, setup.dryRun ? { dryRun: true } : {}), setup.inbound ?? []);
    },
    async sends() {
      return api.sent("text").map((send) => ({ scope: "member" as const, memberId: members.find((member) => member.identities.whatsapp === send.to)?.id ?? null, text: send.text.body }));
    },
    async acks() {
      const kinds: Record<string, AckKind> = { "👀": "received", "👍": "handled" };
      return api.sent("reaction").map((send) => ({ kind: kinds[send.reaction.emoji]! }));
    },
  };
};


// ---------------------------------------------------------------------------------------
// iMessage kit (the real adapter, a fake BlueBubbles server, reading by polling)

const IMESSAGE_HANDLES: Record<Who, string> = { alex: ALEX_HANDLE, sam: SAM_HANDLE, stranger: STRANGER_HANDLE };
const IMESSAGE_STEP: Record<SendStep, BlueBubblesReply> = {
  sent: { ok: true },
  "transient-failure": { error: 429, message: "Too many requests" },
  unknown: { hang: true },
};

export const imessageKit: KitFactory = (stateDir) => {
  const api = new FakeBlueBubbles();
  const members: Member[] = IMESSAGE_MEMBERS;
  // Message times are fixed per kit, so a message "delivered again" after a restart is the same one.
  const baseTime = Date.now() - 20_000;
  return {
    platform: "imessage",
    members,
    newAdapter(setup) {
      api.override("message/react", setup.failAcks ? { error: 400, message: "Private API is not enabled" } : null);
      api.scriptSends((setup.sendScript ?? []).map((step) => IMESSAGE_STEP[step]));
      // Messages are waiting on the server when the adapter starts. A message listed twice is the
      // platform returning it twice.
      const wanted = new Map<string, number>();
      for (const spec of setup.inbound ?? []) {
        const guid = `IN-${spec.n}`;
        wanted.set(guid, (wanted.get(guid) ?? 0) + 1);
        if (api.countOf(guid) >= wanted.get(guid)!) continue;
        api.addMessage({
          guid,
          from: IMESSAGE_HANDLES[spec.from],
          chat: (spec.group ?? true) ? IMESSAGE_GROUP_GUID : `iMessage;-;${IMESSAGE_HANDLES[spec.from]}`,
          text: spec.text ?? "",
          attachments: spec.attachments ?? false,
          at: baseTime + spec.n,
        });
      }
      // Private API sending is what turns reactions on, and the suite checks reactions.
      return new IMessageAdapter(imessageConfig(api, stateDir, { mode: setup.mode, chatGuid: setup.mode === "group" ? IMESSAGE_GROUP_GUID : null, sendMethod: "private-api", ...(setup.dryRun ? { dryRun: true } : {}) }));
    },
    async sends() {
      return api.sends().map((send) =>
        send.chatGuid === IMESSAGE_GROUP_GUID
          ? { scope: "conversation" as const, memberId: null, text: send.message }
          : { scope: "member" as const, memberId: members.find((member) => `iMessage;-;${member.identities.imessage}` === send.chatGuid)?.id ?? null, text: send.message },
      );
    },
    async acks() {
      const kinds: Record<string, AckKind> = { like: "received", love: "handled" };
      return api.reactions().map((reaction) => ({ kind: kinds[reaction.reaction]! }));
    },
  };
};
