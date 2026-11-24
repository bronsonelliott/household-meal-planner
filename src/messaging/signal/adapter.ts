// The Signal adapter: signal-cli as a child process behind the shared messaging contract.
//
// Start-up, in this order:
//
//   1. check the settings (a bot number; a group in group mode)
//   2. start signal-cli in manual receive mode and subscribe
//   3. let messages arrive for a short settle window; each is journaled as it comes
//   4. group mode only: check the group (listGroups): it exists, the bot and every member are in it
//
// Step 3 comes before step 4 on purpose: listGroups reads signal-cli's LOCAL group state, which
// only updates as messages are received. Checking before receiving could fail forever on a
// membership change the server already knows about. Anything received during the window is
// already journaled, so a failed check loses nothing: the next start replays it.
//
// Signal has no receive cursor to move: signal-cli hands messages over in manual mode and we
// journal each one before the next is passed on. The adapter still waits for the journal write
// (handlers.onMessage) before it takes the next, which is the same rule other platforms follow
// before they advance a cursor or answer a webhook.

import { StartupError } from "../../config.ts";
import type { AckKind, AdapterHandlers, Capabilities, HealthResult, IncomingMessage, MessageRef, MessagingAdapter, SendOutcome } from "../types.ts";
import { checkGroupMembership } from "./access.ts";
import { describeAnswer, SignalClient, signalCliLaunchArgs } from "./client.ts";
import { sortSendAnswer } from "./results.ts";
import type { SignalAdapterConfig } from "./settings.ts";

const REACTIONS: Record<AckKind, string> = {
  received: "👀", // seen and being worked on
  handled: "✅", // answered (a Signal member has one reaction per message, so this replaces 👀)
};

// A generous cap: signal-cli accepts long bodies, so a normal reply is never split.
const SIGNAL_MAX_CHARS = 8000;

// The receive result as signal-cli sends it: an envelope, an exception, or both.
interface ReceiveResult {
  envelope?: any;
  exception?: { message?: string; type?: string } | null;
  account?: string;
}

// What an envelope turns into: a message, or the reason it is not one (receipts, typing
// indicators, reactions, and the like).
export type Normalized = { message: IncomingMessage } | { ignored: string };

export function normalizeEnvelope(envelope: any, botNumber: string): Normalized {
  if (envelope.receiptMessage) return { ignored: "receipt" };
  if (envelope.typingMessage) return { ignored: "typing" };
  if (envelope.syncMessage) return { ignored: "sync" };
  if (envelope.storyMessage) return { ignored: "story" };
  if (envelope.editMessage) return { ignored: "edit" };
  if (envelope.callMessage) return { ignored: "call" };

  const data = envelope.dataMessage;
  if (!data) return { ignored: "no message content" };
  if (data.reaction) return { ignored: "reaction" };
  if (data.storyContext) return { ignored: "story reply" };

  const sender: string | undefined = envelope.sourceUuid ?? envelope.source;
  if (!sender || typeof envelope.timestamp !== "number") return { ignored: "no sender or timestamp" };

  const groupId: string | null = data.groupInfo?.groupId ?? null;
  const mentions: any[] = Array.isArray(data.mentions) ? data.mentions : [];
  const quote = data.quote;
  return {
    message: {
      platform: "signal",
      // A group's ID; for a direct message, the sender's own ID stands for the private chat.
      conversationId: groupId ?? sender,
      nativeId: `${sender}:${envelope.timestamp}`,
      sender: { identity: sender, displayName: envelope.sourceName ?? null },
      isGroup: groupId !== null,
      text: typeof data.message === "string" ? data.message : "",
      hasAttachments: Array.isArray(data.attachments) && data.attachments.length > 0,
      mentionsBot: mentions.some((mention) => mention.number === botNumber),
      repliesToBot: Boolean(quote) && (quote.authorNumber === botNumber || quote.author === botNumber),
      // A Signal message is named by its send time, so the quote's id is the quoted message's timestamp.
      ...(quote && (typeof quote.id === "number" || typeof quote.id === "string") ? { replyToNativeId: String(quote.id) } : {}),
      timestamp: envelope.timestamp,
    },
  };
}

export class SignalAdapter implements MessagingAdapter {
  readonly platform = "signal" as const;
  readonly capabilities: Capabilities = { reactions: true, mentions: true, maxMessageChars: SIGNAL_MAX_CHARS, nativeGroups: true };
  readonly conversationId: string | null;

  private client: SignalClient | null = null;
  private handlers: AdapterHandlers | null = null;
  private started = false;
  private lastReceiveError: string | null = null;
  // Messages are handed over one at a time, in order, each after the last one's journal write.
  private receiving: Promise<void> = Promise.resolve();

  constructor(private config: SignalAdapterConfig) {
    this.conversationId = config.mode === "group" ? config.groupId : null;
  }

  async start(handlers: AdapterHandlers): Promise<void> {
    const { config } = this;
    const log = handlers.log;
    this.handlers = handlers;

    if (config.botNumber === "") throw new StartupError("The Signal bot number is not set (messaging.signal.botNumber in config.toml).");
    if (config.mode === "group" && !config.groupId) throw new StartupError("The Signal group ID is not set (messaging.signal.groupId in config.toml).");
    for (const member of config.members) {
      if (member.accountId === "") throw new StartupError(`${member.name || "A member"} has no Signal account ID (members.identities.signal in config.toml).`);
    }

    const command = [...config.signalCliCommand, ...signalCliLaunchArgs(config.signalDataDir, config.botNumber)];
    const env = config.javaHome ? { ...process.env, JAVA_HOME: config.javaHome } : { ...process.env };
    const client = new SignalClient(command, env, config.rpcTimeoutMs, log, config.dryRun === true);
    this.client = client;
    client.onReceive = (result) => this.receive(result);
    client.onExit = (code) => {
      // During start-up the failed call already reports it.
      if (!this.started) return;
      this.started = false;
      handlers.onFatal(`signal-cli exited (code ${code})`);
    };

    const subscribed = await client.call("subscribeReceive");
    if (subscribed.kind !== "result") throw new StartupError(`subscribeReceive failed: ${describeAnswer(subscribed)}`);
    log(`subscribed to receive (subscription ${subscribed.result})`);

    await new Promise((resolve) => setTimeout(resolve, config.settleMs));
    await this.receiving; // everything that arrived is journaled before the check

    if (config.mode === "group") {
      const groups = await client.call("listGroups");
      if (groups.kind !== "result") throw new StartupError(`listGroups failed: ${describeAnswer(groups)}`);
      const problem = checkGroupMembership(groups.result ?? [], config.groupId!, config.botNumber, config.members);
      if (problem) throw new StartupError(problem);
      log("group check passed");
    }
    this.started = true;
  }

  // Called for every receive notification from signal-cli.
  private receive(result: ReceiveResult): void {
    const log = this.handlers!.log;
    if (result.exception) {
      const { type, message } = result.exception;
      this.lastReceiveError = [type, message].filter(Boolean).join(": ") || "unknown receive error";
      log(`signal-cli receive error: ${this.lastReceiveError}`);
    } else if (result.envelope) {
      this.lastReceiveError = null;
    }
    if (!result.envelope) return;

    const normalized = normalizeEnvelope(result.envelope, this.config.botNumber);
    if ("ignored" in normalized) {
      if (normalized.ignored === "no sender or timestamp") log("dropped an envelope with no sender or timestamp");
      return;
    }
    const message = normalized.message;
    this.receiving = this.receiving
      .then(() => this.handlers!.onMessage(message))
      .catch((error) => log(`could not journal ${message.nativeId}: ${(error as Error)?.message ?? error}`));
  }

  sendToConversation(text: string): Promise<SendOutcome> {
    if (this.config.mode !== "group" || !this.config.groupId) {
      return Promise.resolve({ kind: "failed", detail: "there is no Signal group configured (conversation.mode is household-dms)" });
    }
    return this.send({ groupId: this.config.groupId, message: text });
  }

  sendToMember(memberId: string, text: string): Promise<SendOutcome> {
    const member = this.config.members.find((candidate) => candidate.id === memberId);
    if (!member) return Promise.resolve({ kind: "failed", detail: `no Signal account ID is configured for member ${memberId}` });
    return this.send({ recipient: [member.accountId], message: text });
  }

  private async send(params: object): Promise<SendOutcome> {
    return sortSendAnswer(await this.client!.call("send", params));
  }

  async acknowledge(ref: MessageRef, kind: AckKind): Promise<void> {
    const emoji = REACTIONS[kind];
    const where = ref.conversationId === ref.sender.identity ? { recipient: [ref.sender.identity] } : { groupId: ref.conversationId };
    const answer = await this.client!.call("sendReaction", { ...where, emoji, targetAuthor: ref.sender.identity, targetTimestamp: ref.timestamp });
    if (answer.kind !== "result") throw new Error(`reaction ${emoji} on ${ref.nativeId} failed: ${describeAnswer(answer)}`);
  }

  async checkHealth(): Promise<HealthResult> {
    const at = Date.now();
    if (this.lastReceiveError) {
      return { healthy: false, reason: `signal-cli reported a receive error: ${this.lastReceiveError}`, at };
    }
    // getUserStatus asks Signal's server, so it fails when the account or the link is broken.
    // The UUID it returns is not the bot's group-member UUID; only isRegistered is read.
    const answer = await this.client!.call("getUserStatus", { recipient: [this.config.botNumber] });
    if (answer.kind !== "result") return { healthy: false, reason: `getUserStatus failed: ${describeAnswer(answer)}`, at };
    const entries: any[] = Array.isArray(answer.result) ? answer.result : [];
    if (entries.some((entry) => entry?.isRegistered === true)) return { healthy: true, reason: "registered", at };
    return { healthy: false, reason: "Signal's server says the bot's number is not registered", at };
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.client) await this.client.stop();
  }
}
