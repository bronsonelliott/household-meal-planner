// A stand-in for Telegram's Bot API, served on a loopback port, for the Telegram adapter tests.
//
// It speaks just enough of the real thing: getMe, deleteWebhook, getChat, getChatMember,
// getUpdates (with an offset and a short long-poll), sendMessage and setMessageReaction. A test
// pushes updates in, scripts how sends and other calls answer, and reads back every request.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Member } from "../../src/config.ts";
import { TelegramAdapter } from "../../src/messaging/telegram/adapter.ts";
import type { TelegramAdapterConfig } from "../../src/messaging/telegram/settings.ts";

export const FAKE_TOKEN = "123456:FAKE-token_for-tests";
export const BOT = { id: 777000111, username: "dinner_helper_bot" };
export const GROUP_CHAT_ID = "-1001234567890";
export const SUPERGROUP_CHAT_ID = "-1009876543210";
export const ALEX_ID = "1001";
export const SAM_ID = "1002";
export const STRANGER_ID = "9999";

// How the fake answers one call: a result, a Telegram error, a hang, or a dropped connection.
export type Reply =
  | { ok: true; result?: any }
  | { error: number; description?: string; parameters?: Record<string, unknown> }
  | { hang: true }
  | { drop: true };

export interface Recorded {
  method: string;
  params: any;
}

// What a test says about a message that arrives.
export interface MessageSpec {
  from?: string; // user ID, default Alex
  fromBot?: boolean;
  chat?: string; // chat ID; default the household group
  chatType?: "private" | "group" | "supergroup" | "channel";
  text?: string;
  caption?: string;
  entities?: any[];
  extra?: Record<string, unknown>; // anything else on the message (photo, sticker, reply_to_message, sender_chat ...)
  messageId?: number;
  firstName?: string;
}

export class FakeTelegramApi {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly url: string;
  token = FAKE_TOKEN;
  canReadAllGroupMessages = true;
  botStatusInGroup = "member";
  // Longest the fake holds a getUpdates call open when nothing is waiting.
  holdCapMs = 80;

  requests: Recorded[] = [];
  private updates: any[] = [];
  private nextUpdateId = 100;
  private nextMessageId = 1;
  private waiters: Array<() => void> = [];
  private sendScript: Reply[] = [];
  private overrides = new Map<string, Reply>();
  // Chats that have been upgraded: old ID -> new ID. Sends and getChat on the old one answer with it.
  private migrated = new Map<string, string>();

  constructor() {
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => this.handle(request) });
    this.url = `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  // ----- Test controls -----

  push(spec: MessageSpec = {}): number {
    const chatId = spec.chat ?? GROUP_CHAT_ID;
    const chatType = spec.chatType ?? (Number(chatId) < 0 ? "supergroup" : "private");
    const text = spec.text;
    const message: any = {
      message_id: spec.messageId ?? this.nextMessageId++,
      date: 1_790_000_000,
      chat: { id: Number(chatId), type: chatType },
      from: { id: Number(spec.from ?? ALEX_ID), is_bot: spec.fromBot ?? false, first_name: spec.firstName ?? "Somebody" },
      ...(text !== undefined ? { text } : {}),
      ...(spec.caption !== undefined ? { caption: spec.caption } : {}),
      ...(spec.entities ? { [text !== undefined ? "entities" : "caption_entities"]: spec.entities } : {}),
      ...(spec.extra ?? {}),
    };
    return this.pushUpdate({ message });
  }

  // Any update at all, for the odd ones (edited_message, service messages).
  pushUpdate(body: Record<string, unknown>): number {
    const update_id = this.nextUpdateId++;
    this.updates.push({ update_id, ...body });
    for (const wake of this.waiters.splice(0)) wake();
    return update_id;
  }

  // Answers the next sendMessage calls in order; the last one repeats. No script means success.
  scriptSends(replies: Reply[]): void {
    this.sendScript = [...replies];
  }

  // Makes every call to `method` answer this way from now on.
  override(method: string, reply: Reply | null): void {
    if (reply === null) this.overrides.delete(method);
    else this.overrides.set(method, reply);
  }

  migrateChat(oldId: string, newId: string): void {
    this.migrated.set(oldId, newId);
  }

  calls(method: string): any[] {
    return this.requests.filter((request) => request.method === method).map((request) => request.params);
  }

  sends(): Array<{ chat_id: number; text: string }> {
    return this.calls("sendMessage");
  }

  // Updates Telegram still holds (not yet confirmed by an offset).
  pending(): number {
    return this.updates.length;
  }

  // ----- The server -----

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, bot, method] = url.pathname.split("/");
    if (bot !== `bot${this.token}` || !method) return this.json({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
    const params = await request.json().catch(() => ({}));
    this.requests.push({ method, params });

    const forced = this.overrides.get(method);
    if (forced) return this.reply(forced);
    if (method === "sendMessage") {
      const scripted = this.sendScript.length > 1 ? this.sendScript.shift()! : this.sendScript[0];
      const movedTo = this.migrated.get(String(params.chat_id));
      if (movedTo) return this.reply({ error: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: Number(movedTo) } });
      return this.reply(scripted ?? { ok: true, result: { message_id: this.nextMessageId++, date: 1_790_000_100 } });
    }

    switch (method) {
      case "getMe":
        return this.json({ ok: true, result: { id: BOT.id, is_bot: true, username: BOT.username, can_read_all_group_messages: this.canReadAllGroupMessages } });
      case "deleteWebhook":
        return this.json({ ok: true, result: true });
      case "getChat": {
        const movedTo = this.migrated.get(String(params.chat_id));
        if (movedTo) return this.reply({ error: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: Number(movedTo) } });
        return this.json({ ok: true, result: { id: params.chat_id, type: Number(params.chat_id) < 0 ? "supergroup" : "private", title: "Household" } });
      }
      case "getChatMember":
        return this.json({ ok: true, result: { status: this.botStatusInGroup, user: { id: params.user_id } } });
      case "setMessageReaction":
        return this.json({ ok: true, result: true });
      case "getUpdates":
        return this.getUpdates(params);
      default:
        return this.json({ ok: false, error_code: 404, description: "Not Found" }, 404);
    }
  }

  private async getUpdates(params: any): Promise<Response> {
    // Telegram forgets everything below the offset the client reports.
    const offset = Number(params.offset ?? 0);
    if (offset > 0) this.updates = this.updates.filter((update) => update.update_id >= offset);
    if (this.updates.length === 0 && Number(params.timeout) > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(Number(params.timeout) * 1000, this.holdCapMs));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.json({ ok: true, result: this.updates.slice(0, Number(params.limit ?? 100)) });
  }

  private async reply(reply: Reply): Promise<Response> {
    if ("hang" in reply) {
      await Bun.sleep(3000); // longer than any test's timeout; the client gives up first
      return this.json({ ok: false, error_code: 500, description: "too late" }, 500);
    }
    if ("drop" in reply) return new Response(null, { status: 499 }); // never used as a clean answer
    if ("error" in reply) {
      return this.json({ ok: false, error_code: reply.error, description: reply.description ?? "error", ...(reply.parameters ? { parameters: reply.parameters } : {}) }, reply.error);
    }
    return this.json({ ok: true, result: reply.result ?? true });
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }
}

// ---------------------------------------------------------------------------------------
// Building adapters against the fake

export const TEST_MEMBERS: Member[] = [
  { id: "alex", name: "Alex", role: "admin", identities: { telegram: ALEX_ID } },
  { id: "sam", name: "Sam", role: "adult", identities: { telegram: SAM_ID } },
];

export function freshStateDir(): string {
  return mkdtempSync(join(tmpdir(), "hmp-telegram-"));
}

export function telegramConfig(api: FakeTelegramApi, stateDir: string, overrides: Partial<TelegramAdapterConfig> = {}): TelegramAdapterConfig {
  const mode = overrides.mode ?? "group";
  return {
    token: api.token,
    chatId: mode === "group" ? GROUP_CHAT_ID : null,
    mode,
    members: TEST_MEMBERS.map((member) => ({ id: member.id, name: member.name, userId: member.identities.telegram! })),
    apiBaseUrl: api.url,
    stateDir,
    pollTimeoutSec: 1,
    requestTimeoutMs: 300,
    pollRetryDelaysMs: [20],
    ...overrides,
  };
}

export function telegramAdapter(api: FakeTelegramApi, stateDir: string, overrides: Partial<TelegramAdapterConfig> = {}): TelegramAdapter {
  return new TelegramAdapter(telegramConfig(api, stateDir, overrides));
}
