// A messaging adapter that talks to nobody, for tests. It records every send and every
// acknowledgement, lets a test inject incoming messages, and plays back whatever send outcomes
// the test scripts.
//
// It follows the same rule a real adapter must: it advances its receive cursor only after
// handlers.onMessage has resolved (the inbox journal write). `cursor` counts messages whose
// journal write finished, so a test can check that.

import type { Platform } from "../config.ts";
import type { AckKind, AdapterHandlers, Capabilities, HealthResult, IncomingMessage, MessageRef, MessagingAdapter, SendOutcome } from "./types.ts";

export interface FakeSend {
  scope: "conversation" | "member";
  memberId: string | null;
  text: string;
}

export interface FakeAck {
  kind: AckKind;
  ref: MessageRef;
}

export interface FakeAdapterOptions {
  platform?: Platform;
  // The group chat's ID in group mode, null for household-dms mode.
  conversationId?: string | null;
  maxMessageChars?: number;
  reactions?: boolean;
}

export const FAKE_CONVERSATION_ID = "fake-household-group";

export class FakeAdapter implements MessagingAdapter {
  readonly platform: Platform;
  readonly capabilities: Capabilities;
  readonly conversationId: string | null;

  sends: FakeSend[] = [];
  acks: FakeAck[] = [];
  // How many injected messages have been journaled; the fake's "receive cursor".
  cursor = 0;
  started = false;
  stopped = false;
  health: HealthResult = { healthy: true, reason: "fake", at: 0 };
  // When true, acknowledge() rejects.
  failAcks = false;
  private handlers: AdapterHandlers | null = null;
  private script: SendOutcome[] = [];
  private nextNativeId = 1;

  constructor(options: FakeAdapterOptions = {}) {
    this.platform = options.platform ?? "telegram";
    this.conversationId = options.conversationId === undefined ? FAKE_CONVERSATION_ID : options.conversationId;
    this.capabilities = {
      reactions: options.reactions ?? true,
      mentions: true,
      maxMessageChars: options.maxMessageChars ?? 4096,
      nativeGroups: true,
    };
  }

  // Queue the outcomes of the next send attempts, one per attempt. When the queue runs out the
  // LAST one repeats; with nothing scripted every attempt is Sent.
  scriptSends(outcomes: SendOutcome[]): void {
    this.script = [...outcomes];
    this.scriptRepeat = outcomes.length > 0 ? outcomes[outcomes.length - 1]! : null;
  }
  private scriptRepeat: SendOutcome | null = null;

  async start(handlers: AdapterHandlers): Promise<void> {
    this.handlers = handlers;
    this.started = true;
  }

  // Delivers one incoming message the way a real adapter would, and waits for the journal write.
  // Fields left out default to a plain text from `sender` in the household conversation.
  async inject(message: Partial<IncomingMessage> & { sender: IncomingMessage["sender"] }): Promise<IncomingMessage> {
    const isGroup = message.isGroup ?? true;
    const full: IncomingMessage = {
      platform: this.platform,
      nativeId: `fake-${this.nextNativeId++}`,
      text: "",
      hasAttachments: false,
      mentionsBot: false,
      repliesToBot: false,
      timestamp: Date.now(),
      ...definedOnly(message),
      isGroup,
      conversationId: message.conversationId ?? (isGroup ? (this.conversationId ?? FAKE_CONVERSATION_ID) : message.sender.identity),
    };
    await this.handlers!.onMessage(full);
    this.cursor += 1; // only now may the "platform" forget the message
    return full;
  }

  // The fake's connection dies.
  crash(reason = "the fake adapter crashed"): void {
    this.handlers?.onFatal(reason);
  }

  async sendToConversation(text: string): Promise<SendOutcome> {
    this.sends.push({ scope: "conversation", memberId: null, text });
    return this.nextOutcome();
  }

  async sendToMember(memberId: string, text: string): Promise<SendOutcome> {
    this.sends.push({ scope: "member", memberId, text });
    return this.nextOutcome();
  }

  private nextOutcome(): SendOutcome {
    const scripted = this.script.shift() ?? this.scriptRepeat;
    if (scripted) return scripted;
    return { kind: "sent", timestamp: Date.now() };
  }

  async acknowledge(ref: MessageRef, kind: AckKind): Promise<void> {
    this.acks.push({ kind, ref });
    if (this.failAcks) throw new Error("the fake platform refused the reaction");
  }

  async checkHealth(): Promise<HealthResult> {
    return this.health;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
  }
}

// A copy without the keys a caller left undefined, so they do not override the defaults.
function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
