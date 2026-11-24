// A stand-in for a BlueBubbles server, served on a loopback port, for the iMessage adapter tests.
//
// It speaks just enough of the real thing (v1 API): GET ping, server/info, chat/:guid, and POST
// message/query, message/text and message/react. Messages are kept in the shape BlueBubbles uses.
// Like the real server, `after` in a query means "newer than", so a client that does not re-read
// a little behind its cursor would lose messages that share a timestamp.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Member } from "../../src/config.ts";
import { IMessageAdapter } from "../../src/messaging/imessage/adapter.ts";
import type { IMessageAdapterConfig } from "../../src/messaging/imessage/settings.ts";

export const FAKE_PASSWORD = "bb pass/word&1=2-for-tests"; // awkward characters on purpose: it is URL-encoded on the wire
export const GROUP_GUID = "iMessage;+;chat000000000000000001";
export const OTHER_GROUP_GUID = "iMessage;+;chat000000000000000002";
export const ALEX_HANDLE = "+15555550101";
export const SAM_HANDLE = "sam@example.com";
export const STRANGER_HANDLE = "+15555550999";
export const BOT_NAME = "Dinner Bot";

export type Reply =
  | { ok: true }
  | { error: number; message?: string; headers?: Record<string, string> }
  | { hang: true }
  | { drop: true };

export interface Recorded {
  method: string;
  path: string; // after /api/v1/
  url: string; // the full URL as the client sent it (it contains the password)
  body: any;
}

// What a test says about a message that arrives.
export interface MessageSpec {
  guid?: string;
  from?: string; // the sender's handle; default Alex
  chat?: string; // the chat GUID; default the household group
  text?: string;
  at?: number; // dateCreated, epoch ms
  isFromMe?: boolean;
  service?: "iMessage" | "SMS";
  reaction?: string; // makes it a tapback ("love")
  attachments?: boolean;
  replyTo?: string; // threadOriginatorGuid
}

let counter = 0;

export function rawMessage(spec: MessageSpec = {}): any {
  const from = spec.from ?? ALEX_HANDLE;
  const service = spec.service ?? "iMessage";
  const chat = spec.chat ?? GROUP_GUID;
  return {
    guid: spec.guid ?? `MSG-${++counter}`,
    text: spec.text ?? "",
    dateCreated: spec.at ?? Date.now(),
    isFromMe: spec.isFromMe ?? false,
    handle: { address: from, service },
    chats: [{ guid: chat }],
    hasAttachments: spec.attachments ?? false,
    attachments: spec.attachments ? [{ guid: "ATT-1" }] : [],
    associatedMessageType: spec.reaction ?? null,
    threadOriginatorGuid: spec.replyTo ?? null,
  };
}

export class FakeBlueBubbles {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly url: string;
  requests: Recorded[] = [];
  messages: any[] = [];
  chats = new Set<string>([GROUP_GUID]);
  private nextId = 1;
  private sendScript: Reply[] = [];
  private overrides = new Map<string, Reply>(); // by path: "ping", "message/query", "message/react", "chat"
  privateApiOn = true;
  // When true, a successful send also appears in the message list as from the bot's own account.
  echoSends = false;

  constructor(private password = FAKE_PASSWORD) {
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => this.handle(request) });
    this.url = `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  // ----- Test controls -----

  addMessage(spec: MessageSpec = {}): any {
    const raw = rawMessage(spec);
    this.messages.push(raw);
    return raw;
  }

  countOf(guid: string): number {
    return this.messages.filter((message) => message.guid === guid).length;
  }

  // Answers the next sends in order; the last one repeats. No script means success.
  scriptSends(replies: Reply[]): void {
    this.sendScript = [...replies];
  }

  // Makes every call to this path ("ping", "message/query", "message/react", "chat") answer this way.
  override(path: string, reply: Reply | null): void {
    if (reply === null) this.overrides.delete(path);
    else this.overrides.set(path, reply);
  }

  sends(): Array<{ chatGuid: string; message: string; method: string; tempGuid: string }> {
    return this.requests.filter((request) => request.path === "message/text").map((request) => request.body);
  }

  reactions(): any[] {
    return this.requests.filter((request) => request.path === "message/react").map((request) => request.body);
  }

  queries(): any[] {
    return this.requests.filter((request) => request.path === "message/query").map((request) => request.body);
  }

  // ----- The server -----

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/v1\//, "");
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : null;
    this.requests.push({ method: request.method, path, url: request.url, body });

    if (url.searchParams.get("password") !== this.password) return this.error(401, "Unauthorized: wrong password");

    const key = path.startsWith("chat/") ? "chat" : path;
    const forced = this.overrides.get(key);
    if (forced) return this.reply(forced);

    if (request.method === "GET" && path === "ping") return this.json({ status: 200, message: "Ping received!", data: "pong" });
    if (request.method === "GET" && path === "server/info") {
      return this.json({ status: 200, message: "Successfully got server metadata", data: { os_version: "15.1", server_version: "1.9.9", private_api: this.privateApiOn } });
    }
    if (request.method === "GET" && path.startsWith("chat/")) {
      const guid = decodeURIComponent(path.slice("chat/".length));
      return this.chats.has(guid) ? this.json({ status: 200, data: { guid, displayName: "Family" } }) : this.error(404, "Chat does not exist");
    }
    if (request.method === "POST" && path === "message/query") {
      const after = typeof body?.after === "number" ? body.after : 0;
      const matches = this.messages.filter((message) => message.dateCreated > after).sort((a, b) => a.dateCreated - b.dateCreated);
      const page = matches.slice(body?.offset ?? 0, (body?.offset ?? 0) + (body?.limit ?? 100));
      return this.json({ status: 200, message: "Successfully fetched messages", data: page });
    }
    if (request.method === "POST" && path === "message/text") {
      const scripted = this.sendScript.length > 1 ? this.sendScript.shift()! : this.sendScript[0];
      if (scripted) return this.reply(scripted, body);
      return this.accepted(body);
    }
    if (request.method === "POST" && path === "message/react") return this.json({ status: 200, data: { guid: `REACT-${this.nextId++}` } });
    return this.error(404, "Unknown path");
  }

  private accepted(body: any): Response {
    const guid = `OUT-${this.nextId++}`;
    if (this.echoSends) this.addMessage({ guid, isFromMe: true, chat: body?.chatGuid, text: body?.message });
    return this.json({ status: 200, message: "Message sent!", data: { guid, text: body?.message } });
  }

  private async reply(reply: Reply, body: any = {}): Promise<Response> {
    if ("hang" in reply) {
      await Bun.sleep(3000); // longer than any test's timeout; the client gives up first
      return this.error(500, "too late");
    }
    if ("drop" in reply) {
      // Promise an answer, then cut the connection before it arrives.
      return new Response(new ReadableStream({ start: (controller) => controller.error(new Error("dropped")) }), { headers: { "content-length": "100" } });
    }
    if ("error" in reply) return this.error(reply.error, reply.message ?? "error", reply.headers);
    return this.accepted(body);
  }

  private error(status: number, message: string, headers: Record<string, string> = {}): Response {
    return this.json({ status, message, error: { type: "Error", error: message } }, status, headers);
  }

  private json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }
}

// ---------------------------------------------------------------------------------------
// Building adapters against the fake

export const IMESSAGE_MEMBERS: Member[] = [
  { id: "alex", name: "Alex", role: "admin", identities: { imessage: ALEX_HANDLE } },
  { id: "sam", name: "Sam", role: "adult", identities: { imessage: SAM_HANDLE } },
];

export function freshStateDir(): string {
  return mkdtempSync(join(tmpdir(), "hmp-imessage-"));
}

export function imessageConfig(api: FakeBlueBubbles, stateDir: string, overrides: Partial<IMessageAdapterConfig> = {}): IMessageAdapterConfig {
  return {
    serverUrl: api.url,
    password: FAKE_PASSWORD,
    mode: "group",
    chatGuid: GROUP_GUID,
    sendMethod: "apple-script",
    pollIntervalMs: 40,
    allowSms: false,
    botName: BOT_NAME,
    members: IMESSAGE_MEMBERS.map((member) => ({ id: member.id, name: member.name, handle: member.identities.imessage! })),
    stateDir,
    requestTimeoutMs: 300,
    ...overrides,
  };
}

export function imessageAdapter(api: FakeBlueBubbles, stateDir: string, overrides: Partial<IMessageAdapterConfig> = {}): IMessageAdapter {
  return new IMessageAdapter(imessageConfig(api, stateDir, overrides));
}
