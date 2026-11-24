// The shared messaging contract. Everything the rest of the bot knows about a chat app is in this
// file: what an adapter must do, what an incoming message looks like, and how a send ended.
//
// An adapter is the thin, platform-specific piece (Signal, Telegram, ...). It receives and sends,
// one attempt at a time. Everything that needs to be the same on every platform lives in the
// shared code next to this file: the inbox journal, the router, retries, message splitting, the
// process lock. That keeps each new platform small and keeps the reliability rules in one place.

import type { Platform } from "../config.ts";

export type { Platform };

// What a platform can do, so shared code never guesses from its name.
export interface Capabilities {
  reactions: boolean; // acknowledge() can put a visible mark on a message
  mentions: boolean; // the platform tells us when a message @-mentions the bot
  maxMessageChars: number; // longer replies are split into parts of at most this many characters
  nativeGroups: boolean; // the platform has real group chats the bot can join
}

// ---------------------------------------------------------------------------------------
// Incoming

export interface SenderIdentity {
  // How the platform knows the sender (a Signal account ID, a Telegram user ID, ...). This is
  // what the allowlist matches against. Never a display name.
  identity: string;
  // What the platform shows for them. For logs only; never used to decide who someone is.
  displayName: string | null;
}

// One message, in the same shape from every platform.
export interface IncomingMessage {
  platform: Platform;
  conversationId: string; // the group chat, or the sender's private chat for a direct message
  nativeId: string; // the platform's own ID for the message (unique within the conversation)
  sender: SenderIdentity;
  isGroup: boolean;
  text: string; // "" when the message has no words
  hasAttachments: boolean;
  mentionsBot: boolean;
  repliesToBot: boolean;
  timestamp: number; // epoch milliseconds
}

// Enough to point at a message again (to react to it).
export type MessageRef = Pick<IncomingMessage, "platform" | "conversationId" | "nativeId" | "sender" | "timestamp">;

// What the worker receives: a text from a configured household member. It names the member by
// their configured ID and name, never by the platform's display name.
export interface InboundEvent {
  id: string; // the journal ID: "<platform>/<conversation>/<native ID>"
  kind: "text";
  memberId: string;
  memberName: string;
  text: string;
  timestamp: number;
  mentionsBot: boolean;
  repliesToBot: boolean;
}

// ---------------------------------------------------------------------------------------
// Outgoing

export interface FailedMember {
  member: string;
  type: string;
}

// How one part of a message ended for one recipient.
export interface PartOutcome {
  part: number; // 1-based
  kind: "sent" | "partial" | "failed" | "unknown" | "not-attempted";
  detail?: string;
  attempts?: number;
  // The adapter is keeping this part until the person replies (see `queued` on SendDetail).
  queued?: true;
}

// How a whole message ended for one recipient. `memberId` is null for the shared conversation.
export interface RecipientOutcome {
  memberId: string | null;
  kind: "sent" | "partial" | "failed" | "unknown";
  detail?: string;
  queued?: true;
  parts: PartOutcome[];
}

export interface SendDetail {
  // Per recipient, then per part. Filled in by the shared sender.
  recipients?: RecipientOutcome[];
  // True when the adapter is keeping the text for someone until they reply (WhatsApp, outside the
  // 24-hour window). On a `failed` outcome every recipient is waiting; on a `partial` one, the
  // people who did not get it yet are all waiting, not failed. Nothing has been delivered to those
  // people yet, but nothing will be lost either, and the message must not be generated again.
  queued?: true;
}

// Four ways a send can end:
//
//   sent      the platform accepted it.
//   partial   some people or some parts got it, some did not. Never re-sent: the ones who got it
//             would see it twice.
//   failed    the platform definitively refused it. Only a failure marked `transient` is retried.
//   unknown   no answer in time, or the connection died mid-send. It may have gone out, and there
//             is no way to ask, so it is never re-sent.
//
// An adapter returns one of these for a single attempt. The extra fields on `failed` tell the
// shared sender how to treat it; the shared sender returns the final answer to the worker.
export type SendOutcome = SendDetail &
  (
    | { kind: "sent"; timestamp: number; dryRun?: true }
    | { kind: "partial"; timestamp: number; failedMembers: FailedMember[]; detail?: string }
    | {
        kind: "failed";
        detail: string;
        // True only when the platform definitely did not send it AND trying again may work.
        transient?: boolean;
        // How long the platform asked us to wait before trying again (a Retry-After).
        retryAfterMs?: number;
        // A short name for the failure record the checker reads, such as "rate-limited".
        failureClass?: string;
        // Extra fields copied into that record (a captcha token, a how-to-fix step).
        failureExtra?: Record<string, unknown>;
        // (`queued`, from SendDetail, also applies here: the adapter has kept this part to deliver
        // later. It is still a failure: nothing was posted. But the later parts of the same message
        // are offered too, so the adapter keeps the whole text, not just the first part.)
      }
    | { kind: "unknown"; detail: string }
  );

export interface HealthResult {
  healthy: boolean;
  reason: string;
  at: number;
}

// ---------------------------------------------------------------------------------------
// The adapter

export type AckKind = "received" | "handled";

// What the shared code gives an adapter at start-up.
export interface AdapterHandlers {
  // Hand over one received message. The returned promise resolves once the message is safely in
  // the inbox journal. The adapter MUST wait for it before it moves its receive cursor on or
  // answers a webhook: after that point the platform will not send the message again.
  onMessage(message: IncomingMessage): Promise<void>;
  // The adapter's connection is gone for good (the child process exited, say). The bridge exits
  // so the service manager restarts it.
  onFatal(reason: string): void;
  log(line: string): void;
}

export interface MessagingAdapter {
  readonly platform: Platform;
  readonly capabilities: Capabilities;
  // The household's group chat when conversation.mode is "group"; null otherwise.
  readonly conversationId: string | null;

  // Connect, run the platform's own start-up checks (throw StartupError with a plain reason when
  // one fails), and begin delivering messages through handlers.onMessage.
  start(handlers: AdapterHandlers): Promise<void>;

  // One attempt each: no retries, no splitting. The shared sender does both.
  sendToConversation(text: string): Promise<SendOutcome>;
  sendToMember(memberId: string, text: string): Promise<SendOutcome>;

  // Best effort. A mark on the message: "received" when the bot has it, "handled" when answered.
  // May reject; the caller logs that and moves on. A failed acknowledgement never undoes work.
  acknowledge(ref: MessageRef, kind: AckKind): Promise<void>;

  checkHealth(): Promise<HealthResult>;
  stop(): Promise<void>;
}
