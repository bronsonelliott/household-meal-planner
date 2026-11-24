// The iMessage adapter (beta): a BlueBubbles server's REST API, over plain fetch.
//
// BlueBubbles is a free app that runs on a Mac signed into Messages and exposes that Mac's
// messages over a small web API. This adapter asks it for new messages every few seconds and
// sends replies through it. The bot itself can run on any computer that can reach the server.
//
// Receiving is polling, with a cursor that is saved in the state folder:
//
//   - Each poll asks for every message since a few minutes BEFORE the cursor. Two messages can
//     carry the same timestamp, and a message can show up late; reading a little behind the cursor
//     catches both. The saved list of already-handled message guids keeps those re-reads from
//     being handled twice.
//   - The cursor moves past a message only after handlers.onMessage resolves (the inbox journal
//     write), or after the message was deliberately ignored. A journal failure stops the poll
//     with the cursor where it was, and the next poll tries again.
//
// What is ignored: the bot's own messages, tapbacks (reactions), SMS (unless allowSms), group
// chats other than the household's, and anything with no words and no attachment. Photos and
// files are not read; a message with only those gets the shared "say it in words" reply.
//
// Start-up, in this order:
//
//   1. check the settings (server address, password, every member's handle, the group's GUID)
//   2. ping the server: reachable, and the password works
//   3. read the server's info (a warning if private-api sending is chosen but not enabled)
//   4. group mode: the household chat exists
//   5. read whatever is waiting, journaling each message, so start-up ends with them on disk
//   6. start the polling loop in the background
//
// Addressing the bot: iMessage has no @-mention for a bot. A message counts as speaking to the
// bot when it says the bot's name (household.botName) as a whole word, in any capitals, and as a
// reply to the bot when it is an inline reply (a "thread originator") to a message the bot sent.
// The bot's sent guids are remembered, and any message from the bot's own account that the poll
// sees is added, because BlueBubbles can give an AppleScript send a temporary guid at first.

import { StartupError } from "../../config.ts";
import type { AckKind, AdapterHandlers, Capabilities, HealthResult, IncomingMessage, MessageRef, MessagingAdapter, SendOutcome } from "../types.ts";
import { BlueBubblesApi, chatLookupPath, describeAnswer, type ApiAnswer } from "./client.ts";
import { directChatGuid, isGroupChat, isIMessageChat, mentionsName, normalizeHandle, readMessage, readServerInfo, type SeenMessage } from "./normalize.ts";
import { sortSendAnswer } from "./results.ts";
import type { IMessageAdapterConfig, IMessageMember } from "./settings.ts";
import { CursorStore, SentGuidStore } from "./state.ts";

// Conservative: iMessage itself takes far more, but BlueBubbles and AppleScript get slower and
// flakier with very long texts.
const IMESSAGE_MAX_CHARS = 2000;
const PAGE_SIZE = 200;
const DEFAULT_OVERLAP_MS = 5 * 60_000;
const DEFAULT_FIRST_RUN_LOOKBACK_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 60_000;

// Tapbacks the bot can put on a message. A later tapback from the same sender replaces the one
// before it, so "like" gives way to "love" once the message is answered.
const TAPBACKS: Record<AckKind, string> = {
  received: "like",
  handled: "love",
};

// MUST BE CHECKED against the pinned BlueBubbles version: the `with` values that make message
// records include their chat and sender.
const MESSAGE_QUERY_WITH = ["chat", "handle"];

class PollError extends Error {
  constructor(
    message: string,
    readonly fatal = false,
  ) {
    super(message);
  }
}

export class IMessageAdapter implements MessagingAdapter {
  readonly platform = "imessage" as const;
  readonly capabilities: Capabilities;
  readonly conversationId: string | null;

  private api: BlueBubblesApi;
  private cursor: CursorStore;
  private sentGuids: SentGuidStore;
  private handlers: AdapterHandlers | null = null;
  private running = false;
  private stopSignal = new AbortController();
  private loop: Promise<void> = Promise.resolve();
  private lastPollError: string | null = null;
  private lastPollOkAt: number | null = null;
  private overlapMs: number;

  constructor(private config: IMessageAdapterConfig) {
    this.conversationId = config.mode === "group" ? config.chatGuid : null;
    // Tapbacks go through BlueBubbles' Private API, so reactions exist only when it is the send method.
    this.capabilities = { reactions: config.sendMethod === "private-api", mentions: true, maxMessageChars: IMESSAGE_MAX_CHARS, nativeGroups: true };
    this.api = new BlueBubblesApi(config.serverUrl, config.password, config.requestTimeoutMs, config.dryRun === true);
    this.cursor = new CursorStore(config.stateDir);
    this.sentGuids = new SentGuidStore(config.stateDir);
    this.overlapMs = config.overlapMs ?? DEFAULT_OVERLAP_MS;
  }

  private now(): number {
    return (this.config.now ?? Date.now)();
  }

  // ----- Start-up -----

  async start(handlers: AdapterHandlers): Promise<void> {
    const { config } = this;
    const log = handlers.log;
    this.handlers = handlers;

    if (config.serverUrl === "") throw new StartupError("The BlueBubbles server address is not set (messaging.imessage.serverUrl in config.toml).");
    if (config.password === "") throw new StartupError("The BlueBubbles server password is not set (the environment variable named by messaging.imessage.passwordEnv).");
    if (config.mode === "group" && !config.chatGuid) throw new StartupError("The iMessage group chat GUID is not set (messaging.imessage.chatGuid in config.toml).");
    for (const member of config.members) {
      if (member.handle === "") throw new StartupError(`${member.name || "A member"} has no iMessage handle (members.identities.imessage in config.toml).`);
    }

    const ping = await this.api.call("ping");
    if (ping.kind === "api-error" && (ping.httpStatus === 401 || ping.httpStatus === 403)) {
      throw new StartupError("The BlueBubbles server rejected the password. Check the environment variable named by messaging.imessage.passwordEnv.");
    }
    if (ping.kind !== "ok") {
      throw new StartupError(`Could not reach the BlueBubbles server (${describeAnswer(ping)}). Is the Mac awake, BlueBubbles running, and messaging.imessage.serverUrl right?`);
    }

    const info = await this.api.call("server/info");
    if (info.kind === "ok") {
      const summary = readServerInfo(info.body);
      log(`BlueBubbles server ${summary.version ?? "(version not reported)"} connected`);
      if (config.sendMethod === "private-api" && summary.privateApi === false) {
        log("WARNING: sendMethod is private-api but the BlueBubbles server says its Private API is not enabled. Sends and reactions will fail until it is.");
      }
    } else {
      log(`WARNING: could not read the BlueBubbles server's info (${describeAnswer(info)})`);
    }

    if (config.mode === "group") {
      const chat = await this.api.call(chatLookupPath(config.chatGuid!));
      if (chat.kind !== "ok") {
        throw new StartupError(`BlueBubbles cannot open the household chat ${config.chatGuid} (${describeAnswer(chat)}). Is messaging.imessage.chatGuid right, and is that chat in this Mac's Messages?`);
      }
    }

    // First ever run: begin a little before now, so a message sent while the bot was starting is
    // not lost, but the chat's old history is not replayed.
    if (this.cursor.get() === null) this.cursor.start(this.now() - (config.firstRunLookbackMs ?? DEFAULT_FIRST_RUN_LOOKBACK_MS));

    this.running = true;
    // Whatever is waiting is journaled before start() returns.
    try {
      await this.pollOnce();
    } catch (error) {
      this.running = false;
      throw new StartupError(`The first read of new messages failed (${(error as Error).message}).`);
    }
    this.loop = this.pollLoop();
  }

  // ----- Receiving -----

  // One poll: ask for everything since a little before the cursor and handle each message in
  // order. Throws PollError when the call failed or a journal write did.
  private async pollOnce(): Promise<void> {
    const since = Math.max(0, (this.cursor.get() ?? 0) - this.overlapMs);
    let offset = 0;
    for (;;) {
      const answer = await this.api.call(
        "message/query",
        { limit: PAGE_SIZE, offset, sort: "ASC", after: since, with: MESSAGE_QUERY_WITH },
        { signal: this.stopSignal.signal },
      );
      if (answer.kind === "aborted") return;
      if (answer.kind !== "ok") throw this.pollFailure(answer);

      const page: any[] = Array.isArray(answer.body?.data) ? answer.body.data : [];
      for (const raw of page) {
        const message = readMessage(raw);
        if (!message || this.cursor.hasSeen(message.guid)) continue;
        try {
          await this.handleMessage(message);
        } catch (error) {
          // Not journaled, so the cursor stays put and the next poll tries this message again.
          throw new PollError(`could not journal message ${message.guid}: ${this.api.redact(String((error as Error)?.message ?? error))}`);
        }
        // Only now does reading move past it.
        this.cursor.advance(message.guid, message.dateCreated, this.overlapMs);
      }
      if (page.length < PAGE_SIZE) break;
      offset += page.length;
    }
    this.lastPollError = null;
    this.lastPollOkAt = this.now();
  }

  private pollFailure(answer: Exclude<ApiAnswer, { kind: "ok" } | { kind: "aborted" }>): PollError {
    if (answer.kind === "api-error" && (answer.httpStatus === 401 || answer.httpStatus === 403)) {
      return new PollError("the BlueBubbles server rejected the password", true);
    }
    return new PollError(describeAnswer(answer));
  }

  // Decides what a message is, and hands it over if it is one the bot should see.
  private async handleMessage(message: SeenMessage): Promise<void> {
    const { config } = this;
    const chatGuid = message.chatGuid;
    if (chatGuid === null) return; // we cannot tell which conversation it belongs to

    // Other groups on this Mac are none of the bot's business: they are not even journaled.
    if (isGroupChat(chatGuid) && chatGuid !== config.chatGuid) return;

    // The bot's own messages (and anything else sent from this Apple ID) are never input, but they
    // tell us which message guids belong to the bot, for spotting replies to it.
    if (message.isFromMe) {
      this.sentGuids.add(message.guid);
      return;
    }
    if (message.isReaction) return; // a tapback, not a message
    if (!isIMessageChat(chatGuid) && !config.allowSms) return; // SMS, and not asked for

    const text = message.text;
    if (text === "" && !message.hasAttachments) return;

    const incoming: IncomingMessage = {
      platform: "imessage",
      conversationId: chatGuid,
      nativeId: message.guid,
      sender: { identity: message.senderAddress === null ? "" : normalizeHandle(message.senderAddress), displayName: null },
      isGroup: isGroupChat(chatGuid),
      text,
      hasAttachments: message.hasAttachments,
      mentionsBot: mentionsName(text, config.botName),
      repliesToBot: message.threadOriginatorGuid !== null && this.sentGuids.has(message.threadOriginatorGuid),
      timestamp: message.dateCreated,
    };
    await this.handlers!.onMessage(incoming);
  }

  private async pollLoop(): Promise<void> {
    const log = this.handlers!.log;
    let failures = 0;
    while (this.running) {
      await this.pause(failures === 0 ? this.config.pollIntervalMs : Math.min(this.config.pollIntervalMs * 2 ** failures, MAX_BACKOFF_MS));
      if (!this.running) return;
      try {
        await this.pollOnce();
        failures = 0;
      } catch (error) {
        if (!this.running) return;
        const problem = error as PollError;
        this.lastPollError = problem.message;
        log(`iMessage polling problem: ${problem.message}`);
        if (problem.fatal) {
          this.running = false;
          this.handlers!.onFatal(problem.message);
          return;
        }
        failures += 1;
      }
    }
  }

  // A wait that ends early when the adapter stops.
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.stopSignal.signal;
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done);
    });
  }

  // ----- Sending -----

  sendToConversation(text: string): Promise<SendOutcome> {
    if (this.config.mode !== "group" || !this.config.chatGuid) {
      return Promise.resolve({ kind: "failed", detail: "there is no iMessage group configured (conversation.mode is household-dms)" });
    }
    return this.send(this.config.chatGuid, text);
  }

  sendToMember(memberId: string, text: string): Promise<SendOutcome> {
    const member = this.member(memberId);
    if (!member) return Promise.resolve({ kind: "failed", detail: `no iMessage handle is configured for member ${memberId}` });
    return this.send(directChatGuid(member.handle), text);
  }

  private member(memberId: string): IMessageMember | undefined {
    return this.config.members.find((candidate) => candidate.id === memberId);
  }

  private async send(chatGuid: string, text: string): Promise<SendOutcome> {
    // MUST BE CHECKED against the pinned BlueBubbles version: POST message/text takes chatGuid,
    // tempGuid, message and method, and answers {data: {guid}}.
    const answer = await this.api.call("message/text", {
      chatGuid,
      tempGuid: `hmp-${crypto.randomUUID()}`,
      message: text,
      method: this.config.sendMethod,
    });
    const outcome = sortSendAnswer(answer, () => this.now());
    if (outcome.kind === "sent") this.sentGuids.add(answer.kind === "ok" ? answer.body.data.guid : "");
    return outcome;
  }

  // A tapback, through the Private API. Without it this does nothing (the messenger does not even
  // call it, because capabilities.reactions is false).
  async acknowledge(ref: MessageRef, kind: AckKind): Promise<void> {
    if (!this.capabilities.reactions) return;
    // MUST BE CHECKED against the pinned BlueBubbles version: POST message/react takes chatGuid,
    // selectedMessageGuid and reaction ("love", "like", "dislike", "laugh", "emphasize", "question").
    const answer = await this.api.call("message/react", { chatGuid: ref.conversationId, selectedMessageGuid: ref.nativeId, reaction: TAPBACKS[kind] });
    if (answer.kind !== "ok") throw new Error(`tapback ${TAPBACKS[kind]} on ${ref.nativeId} failed: ${describeAnswer(answer)}`);
  }

  // ----- Health -----

  // Pings the server, looks up the household chat, and reports how recently reading worked. Never
  // sends a message.
  async checkHealth(): Promise<HealthResult> {
    const at = this.now();
    const ping = await this.api.call("ping");
    if (ping.kind !== "ok") return { healthy: false, reason: `the BlueBubbles server did not answer a ping: ${describeAnswer(ping)}`, at };
    if (this.config.mode === "group") {
      const chat = await this.api.call(chatLookupPath(this.config.chatGuid!));
      if (chat.kind !== "ok") return { healthy: false, reason: `the household chat cannot be opened: ${describeAnswer(chat)}`, at };
    }
    if (this.lastPollError) return { healthy: false, reason: `receiving is failing: ${this.lastPollError}`, at };
    const sinceLastPoll = this.lastPollOkAt === null ? null : at - this.lastPollOkAt;
    // Polls are a few seconds apart; this long without one means the loop is stuck.
    if (sinceLastPoll === null || sinceLastPoll > Math.max(this.config.pollIntervalMs * 6, 60_000)) {
      return { healthy: false, reason: sinceLastPoll === null ? "no successful read of new messages yet" : `no successful read of new messages for ${describeAge(sinceLastPoll)}`, at };
    }
    return { healthy: true, reason: `ok: BlueBubbles reachable; last read of new messages ${describeAge(sinceLastPoll)} ago`, at };
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopSignal.abort();
    await this.loop.catch(() => {});
  }
}

function describeAge(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
