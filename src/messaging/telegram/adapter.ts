// The Telegram adapter: the Bot API over plain fetch, behind the shared messaging contract.
//
// Receiving is long polling: getUpdates holds the connection open until a message arrives (or 30
// seconds pass), and every call says "I have everything before update N" through its offset.
// Telegram forgets updates below the offset, so the offset is the cursor the shared rules talk
// about: it moves forward only after handlers.onMessage resolves (the inbox journal write). The
// offset is saved in the state folder. After a crash between the journal write and the offset save,
// Telegram simply sends the message again and the inbox drops the duplicate.
//
// Start-up, in this order:
//
//   1. check the settings (token, chat ID, every member's user ID)
//   2. getMe: the token works, and what is the bot's name (needed to spot mentions)
//   3. deleteWebhook: getUpdates refuses to work while a webhook is set
//   4. group mode: the chat exists and the bot is a member of it
//   5. drain whatever is waiting, journaling each message, so start-up ends with them on disk
//   6. start the polling loop in the background
//
// Chat IDs and group migration: when Telegram upgrades a group to a supergroup the chat ID
// changes. The adapter keeps using the ID from config.toml as the group's name everywhere inside
// the bot (journal IDs, routing) and quietly maps it to the new real ID on the way to Telegram.
// The new ID is saved in the state folder, and the log asks the admin to update config.toml.

import { StartupError } from "../../config.ts";
import type { AckKind, AdapterHandlers, Capabilities, HealthResult, MessageRef, MessagingAdapter, SendOutcome } from "../types.ts";
import { describeAnswer, TelegramApi, type ApiAnswer } from "./client.ts";
import { PRIVACY_MODE_NOTE } from "./diagnose.ts";
import { findMigration, normalizeUpdate, type BotIdentity } from "./normalize.ts";
import { sortSendAnswer } from "./results.ts";
import type { TelegramAdapterConfig } from "./settings.ts";
import { ChatMigrationStore, OffsetStore } from "./state.ts";

// Telegram's reaction list is short: 👀 and 👍 are on it, ✅ is not. A member's bot reaction
// replaces the one before it, so 👍 takes over from 👀 once the message is answered.
const REACTIONS: Record<AckKind, string> = {
  received: "👀",
  handled: "👍",
};

const TELEGRAM_MAX_CHARS = 4096;
const BATCH_SIZE = 100;

// A failed poll the loop should wait out and try again, or one it cannot recover from.
class PollError extends Error {
  constructor(
    message: string,
    readonly fatal = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class TelegramAdapter implements MessagingAdapter {
  readonly platform = "telegram" as const;
  readonly capabilities: Capabilities = { reactions: true, mentions: true, maxMessageChars: TELEGRAM_MAX_CHARS, nativeGroups: true };
  readonly conversationId: string | null;

  private api: TelegramApi;
  private offsets: OffsetStore;
  private migrations: ChatMigrationStore;
  private handlers: AdapterHandlers | null = null;
  private bot: BotIdentity | null = null;
  private privacyModeOn = false;
  // The real Telegram chat ID for the household group; differs from config.chatId after a migration.
  private realChatId: string | null;
  private running = false;
  private stopSignal = new AbortController();
  private loop: Promise<void> = Promise.resolve();
  private lastPollError: string | null = null;

  constructor(private config: TelegramAdapterConfig) {
    this.conversationId = config.mode === "group" ? config.chatId : null;
    this.api = new TelegramApi(config.token, config.apiBaseUrl, config.requestTimeoutMs, config.dryRun === true);
    this.offsets = new OffsetStore(config.stateDir);
    this.migrations = new ChatMigrationStore(config.stateDir);
    this.realChatId = this.conversationId;
    // A saved migration applies only while config.toml still has the ID it was saved against.
    // Once the admin updates the config, the config is right and the saved note is stale.
    const moved = this.migrations.get();
    if (moved && moved.configured === this.conversationId) this.realChatId = moved.current;
  }

  async start(handlers: AdapterHandlers): Promise<void> {
    const { config } = this;
    const log = handlers.log;
    this.handlers = handlers;

    if (config.token === "") throw new StartupError("The Telegram bot token is not set (the environment variable named by messaging.telegram.botTokenEnv).");
    if (config.mode === "group" && !config.chatId) throw new StartupError("The Telegram chat ID is not set (messaging.telegram.chatId in config.toml).");
    for (const member of config.members) {
      if (member.userId === "") throw new StartupError(`${member.name || "A member"} has no Telegram user ID (members.identities.telegram in config.toml).`);
    }

    const me = await this.api.call("getMe");
    if (me.kind === "api-error" && me.errorCode === 401) throw new StartupError("Telegram rejected the bot token. Check the token in the environment variable, or ask BotFather for a new one.");
    if (me.kind !== "ok") throw new StartupError(`getMe failed: ${describeAnswer(me)}`);
    if (typeof me.result?.id !== "number" || typeof me.result?.username !== "string") throw new StartupError("getMe did not return a bot ID and username.");
    this.bot = { id: me.result.id, username: me.result.username };
    log(`Telegram bot @${this.bot.username} connected`);

    // Messages only wait for getUpdates while no webhook is set.
    const hook = await this.api.call("deleteWebhook");
    if (hook.kind !== "ok") throw new StartupError(`deleteWebhook failed: ${describeAnswer(hook)}`);

    if (config.mode === "group") {
      await this.checkGroup(me.result, log);
    }

    this.running = true;
    // Whatever is waiting is journaled before start() returns.
    for (;;) {
      const count = await this.pollOnce(0);
      if (count < BATCH_SIZE) break;
    }
    this.loop = this.pollLoop();
  }

  // Group mode: the chat exists, it is a group, the bot is in it, and privacy mode is explained.
  private async checkGroup(bot: any, log: (line: string) => void): Promise<void> {
    let chat = await this.api.call("getChat", { chat_id: Number(this.realChatId) });
    // A group that was already upgraded answers with where it moved to.
    if (chat.kind === "api-error" && chat.parameters.migrate_to_chat_id) {
      this.noteMigration(String(chat.parameters.migrate_to_chat_id), log);
      chat = await this.api.call("getChat", { chat_id: Number(this.realChatId) });
    }
    if (chat.kind !== "ok") {
      throw new StartupError(`Telegram cannot open the household chat ${this.config.chatId} (${describeAnswer(chat)}). Is the bot in the group, and is messaging.telegram.chatId right?`);
    }
    if (chat.result.type !== "group" && chat.result.type !== "supergroup") {
      throw new StartupError(`The Telegram chat ${this.config.chatId} is a ${chat.result.type} chat, not a group.`);
    }
    const membership = await this.api.call("getChatMember", { chat_id: Number(this.realChatId), user_id: this.bot!.id });
    if (membership.kind !== "ok") throw new StartupError(`Could not check the bot's place in the group (${describeAnswer(membership)}).`);
    const status: string = membership.result?.status;
    if (status === "left" || status === "kicked") throw new StartupError("The bot is not in the Telegram group (it left or was removed). Add it back.");

    const isAdmin = status === "administrator" || status === "creator";
    this.privacyModeOn = bot.can_read_all_group_messages === false && !isAdmin;
    if (this.privacyModeOn) log(`WARNING: ${PRIVACY_MODE_NOTE}`);
  }

  // The group got a new chat ID. Follow it, remember it, and say plainly what to change.
  private noteMigration(newId: string, log: (line: string) => void): void {
    if (this.conversationId === null || newId === this.realChatId) return;
    const oldId = this.realChatId;
    this.realChatId = newId;
    this.migrations.set({ configured: this.conversationId, current: newId });
    log(
      `Telegram upgraded the household group to a supergroup: its chat ID changed from ${oldId} to ${newId}. ` +
        `The bot keeps working by following the new ID. Please set messaging.telegram.chatId = "${newId}" in config.toml.`,
    );
  }

  // The name the rest of the bot uses for a Telegram chat: the group is always the configured ID.
  private logicalChatId(chatId: number): string {
    const id = String(chatId);
    return id === this.realChatId && this.conversationId !== null ? this.conversationId : id;
  }

  // The reverse, for sending: the configured group ID becomes the group's real, current ID.
  private realIdFor(conversationId: string): number {
    return Number(conversationId === this.conversationId && this.realChatId !== null ? this.realChatId : conversationId);
  }

  // ----- Receiving -----

  // One getUpdates call: journal each update in order, then move the offset past it. Returns how
  // many updates came back. Throws PollError when the call failed or a journal write did.
  private async pollOnce(timeoutSec: number): Promise<number> {
    const offset = this.offsets.get();
    const answer = await this.api.call(
      "getUpdates",
      { offset, limit: BATCH_SIZE, timeout: timeoutSec, allowed_updates: ["message"] },
      { timeoutMs: timeoutSec * 1000 + this.config.requestTimeoutMs, signal: this.stopSignal.signal },
    );
    if (answer.kind === "aborted") return 0;
    if (answer.kind !== "ok") throw this.pollFailure(answer);

    const updates: any[] = Array.isArray(answer.result) ? answer.result : [];
    for (const update of updates) {
      try {
        await this.handleUpdate(update);
      } catch (error) {
        // Not journaled, so the offset stays put and Telegram will send it again.
        throw new PollError(`could not journal update ${update?.update_id}: ${(error as Error)?.message ?? error}`);
      }
      // Only now may Telegram forget it.
      this.offsets.set(update.update_id + 1);
    }
    this.lastPollError = null;
    return updates.length;
  }

  private pollFailure(answer: Exclude<ApiAnswer, { kind: "ok" } | { kind: "aborted" }>): PollError {
    if (answer.kind === "api-error") {
      if (answer.errorCode === 401) return new PollError("Telegram rejected the bot token", true);
      if (answer.errorCode === 409) {
        return new PollError("Telegram says another program is already reading this bot's messages (a second copy of the bridge, or a webhook). Only one may run");
      }
      if (answer.errorCode === 429) return new PollError(describeAnswer(answer), false, (answer.parameters.retry_after ?? 1) * 1000);
    }
    return new PollError(describeAnswer(answer));
  }

  private async handleUpdate(update: any): Promise<void> {
    const log = this.handlers!.log;
    const migration = findMigration(update);
    if (migration && migration.from === this.realChatId) this.noteMigration(migration.to, log);

    const normalized = normalizeUpdate(update, this.bot!, (chatId) => this.logicalChatId(chatId));
    if ("ignored" in normalized) return;
    await this.handlers!.onMessage(normalized.message);
  }

  private async pollLoop(): Promise<void> {
    const log = this.handlers!.log;
    const delays = this.config.pollRetryDelaysMs;
    let failures = 0;
    while (this.running) {
      try {
        await this.pollOnce(this.config.pollTimeoutSec);
        failures = 0;
      } catch (error) {
        if (!this.running) return;
        const problem = error as PollError;
        this.lastPollError = problem.message;
        log(`Telegram polling problem: ${problem.message}`);
        if (problem.fatal) {
          this.running = false;
          this.handlers!.onFatal(problem.message);
          return;
        }
        const wait = problem.retryAfterMs ?? delays[Math.min(failures, delays.length - 1)]!;
        failures += 1;
        await this.pause(wait);
      }
    }
  }

  // A wait that ends early when the adapter stops.
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const signal = this.stopSignal.signal;
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
    if (this.config.mode !== "group" || this.realChatId === null) {
      return Promise.resolve({ kind: "failed", detail: "there is no Telegram group configured (conversation.mode is household-dms)" });
    }
    return this.send(this.realChatId, text);
  }

  sendToMember(memberId: string, text: string): Promise<SendOutcome> {
    const member = this.config.members.find((candidate) => candidate.id === memberId);
    if (!member) return Promise.resolve({ kind: "failed", detail: `no Telegram user ID is configured for member ${memberId}` });
    return this.send(member.userId, text);
  }

  private async send(chatId: string, text: string): Promise<SendOutcome> {
    // No parse_mode: the text goes out exactly as written, with nothing to escape.
    let answer = await this.api.call("sendMessage", { chat_id: Number(chatId), text });
    // The group was upgraded since we last looked. Telegram refused this send outright, so
    // sending it again to the new chat cannot post twice.
    if (answer.kind === "api-error" && answer.parameters.migrate_to_chat_id && chatId === this.realChatId) {
      this.noteMigration(String(answer.parameters.migrate_to_chat_id), this.handlers!.log);
      answer = await this.api.call("sendMessage", { chat_id: Number(this.realChatId), text });
    }
    return sortSendAnswer(answer);
  }

  async acknowledge(ref: MessageRef, kind: AckKind): Promise<void> {
    const emoji = REACTIONS[kind];
    const answer = await this.api.call("setMessageReaction", {
      chat_id: this.realIdFor(ref.conversationId),
      message_id: Number(ref.nativeId),
      reaction: [{ type: "emoji", emoji }],
    });
    if (answer.kind !== "ok") throw new Error(`reaction ${emoji} on ${ref.nativeId} failed: ${describeAnswer(answer)}`);
  }

  // ----- Health -----

  async checkHealth(): Promise<HealthResult> {
    const at = Date.now();
    const me = await this.api.call("getMe");
    if (me.kind !== "ok") return { healthy: false, reason: `getMe failed: ${describeAnswer(me)}`, at };
    if (this.lastPollError) return { healthy: false, reason: `receiving is failing: ${this.lastPollError}`, at };
    if (this.config.mode === "group") {
      const chat = await this.api.call("getChat", { chat_id: this.realIdFor(this.config.chatId!) });
      if (chat.kind !== "ok") return { healthy: false, reason: `the household chat cannot be opened: ${describeAnswer(chat)}`, at };
    }
    // Still healthy with privacy mode on: the bot works, it just sees less.
    return { healthy: true, reason: this.privacyModeOn ? `ok, but ${PRIVACY_MODE_NOTE}` : "ok", at };
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopSignal.abort();
    await this.loop.catch(() => {});
  }
}
