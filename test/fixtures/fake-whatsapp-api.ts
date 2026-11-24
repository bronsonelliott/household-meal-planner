// A stand-in for Meta's Graph API (the WhatsApp Cloud API parts), served on a loopback port, plus
// helpers that build and sign the webhook calls Meta would make. For the WhatsApp adapter tests.
//
// It speaks just enough of the real thing: POST /<version>/<phone number ID>/messages (text,
// template, reaction, and the "read" mark) and GET /<version>/<phone number ID> (the number's
// record). A test scripts how sends answer and reads back every request.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Member } from "../../src/config.ts";
import { WhatsAppAdapter } from "../../src/messaging/whatsapp/adapter.ts";
import type { WhatsAppAdapterConfig } from "../../src/messaging/whatsapp/settings.ts";
import { signBody } from "../../src/messaging/whatsapp/webhook.ts";

export const FAKE_ACCESS_TOKEN = "EAAFAKE-access-token-for-tests";
export const FAKE_APP_SECRET = "fake-app-secret-for-tests";
export const FAKE_VERIFY_TOKEN = "fake-verify-token-for-tests";
export const PHONE_NUMBER_ID = "100200300400500";
export const API_VERSION = "v23.0";
export const WEBHOOK_PATH = "/whatsapp/webhook";
export const ALEX_WA = "15555550101";
export const SAM_WA = "15555550102";
export const STRANGER_WA = "15555550999";

export type Reply =
  | { ok: true }
  | { error: number; code?: number; message?: string; headers?: Record<string, string> } // Meta's error body, with this HTTP status
  | { hang: true };

export interface Recorded {
  method: string; // GET or POST
  path: string; // after the version, like "100200300400500/messages"
  body: any;
  authorization: string | null;
}

export class FakeGraphApi {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly url: string;
  requests: Recorded[] = [];
  private nextId = 1;
  private sendScript: Reply[] = [];
  private overrides = new Map<string, Reply>(); // by message type: "template", "reaction", "read", "lookup"
  numberRecord: Record<string, unknown> = { id: PHONE_NUMBER_ID, display_phone_number: "+1 555-555-0100", verified_name: "Dinner Bot", quality_rating: "GREEN" };

  constructor() {
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => this.handle(request) });
    this.url = `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  // ----- Test controls -----

  // Answers the next text-message sends in order; the last one repeats. No script means success.
  scriptSends(replies: Reply[]): void {
    this.sendScript = [...replies];
  }

  // Makes every call of this kind ("template", "reaction", "read", "lookup") answer this way.
  override(kind: string, reply: Reply | null): void {
    if (reply === null) this.overrides.delete(kind);
    else this.overrides.set(kind, reply);
  }

  // Message sends of one kind ("text", "template", "reaction"), as the bodies we received.
  sent(type: string): any[] {
    return this.requests.filter((request) => request.method === "POST" && request.body?.type === type).map((request) => request.body);
  }

  reads(): any[] {
    return this.requests.filter((request) => request.method === "POST" && request.body?.status === "read").map((request) => request.body);
  }

  // ----- The server -----

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, version, ...rest] = url.pathname.split("/");
    const path = rest.join("/");
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : null;
    this.requests.push({ method: request.method, path, body, authorization: request.headers.get("authorization") });

    if (version !== API_VERSION) return this.error(404, 100, "Unsupported request: wrong version");
    if (request.headers.get("authorization") !== `Bearer ${FAKE_ACCESS_TOKEN}`) return this.error(401, 190, "Invalid OAuth access token.");

    if (request.method === "GET" && path === PHONE_NUMBER_ID) {
      const forced = this.overrides.get("lookup");
      return forced ? this.reply(forced) : this.json(this.numberRecord);
    }
    if (request.method === "POST" && path === `${PHONE_NUMBER_ID}/messages`) {
      const kind = body?.status === "read" ? "read" : String(body?.type ?? "unknown");
      const forced = this.overrides.get(kind);
      if (forced) return this.reply(forced);
      if (kind === "read") return this.json({ success: true });
      if (kind === "text") {
        const scripted = this.sendScript.length > 1 ? this.sendScript.shift()! : this.sendScript[0];
        if (scripted) return this.reply(scripted);
      }
      return this.accepted(body);
    }
    return this.error(404, 100, "Unknown path");
  }

  private accepted(body: any): Response {
    return this.json({ messaging_product: "whatsapp", contacts: [{ input: body?.to, wa_id: body?.to }], messages: [{ id: `wamid.OUT${this.nextId++}` }] });
  }

  private async reply(reply: Reply): Promise<Response> {
    if ("hang" in reply) {
      await Bun.sleep(3000); // longer than any test's timeout; the client gives up first
      return this.error(500, 1, "too late");
    }
    if ("error" in reply) return this.error(reply.error, reply.code ?? 1, reply.message ?? "error", reply.headers);
    return this.accepted({});
  }

  private error(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
    return this.json({ error: { message, type: "OAuthException", code, fbtrace_id: "TRACE" } }, status, headers);
  }

  private json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }
}

// ---------------------------------------------------------------------------------------
// Webhook calls, the way Meta makes them

export interface InboundSpec {
  from?: string; // the sender's wa_id; default Alex
  id?: string; // the message ID (wamid)
  type?: string; // text, image, audio, document, sticker, location, reaction ...
  text?: string; // the body for a text, or the caption for an image/document
  name?: string; // the sender's profile name
  timestamp?: number; // seconds; default now
}

let counter = 0;

export function messageEntry(spec: InboundSpec = {}): any {
  const from = spec.from ?? ALEX_WA;
  const type = spec.type ?? "text";
  const message: any = { from, id: spec.id ?? `wamid.IN${++counter}`, timestamp: String(spec.timestamp ?? Math.floor(Date.now() / 1000)), type };
  if (type === "text") message.text = { body: spec.text ?? "" };
  else message[type] = { id: "media-id", ...(spec.text !== undefined ? { caption: spec.text } : {}) };
  return { message, contact: { wa_id: from, profile: { name: spec.name ?? "Somebody" } } };
}

// A whole webhook body with these messages and statuses in it.
export function webhookBody(options: { messages?: InboundSpec[]; statuses?: any[]; phoneNumberId?: string } = {}): any {
  const entries = (options.messages ?? []).map(messageEntry);
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA-ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15555550100", phone_number_id: options.phoneNumberId ?? PHONE_NUMBER_ID },
              ...(entries.length > 0 ? { contacts: entries.map((entry) => entry.contact), messages: entries.map((entry) => entry.message) } : {}),
              ...(options.statuses ? { statuses: options.statuses } : {}),
            },
          },
        ],
      },
    ],
  };
}

export function statusEntry(id: string, status: string, extra: Record<string, unknown> = {}): any {
  return { id, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: ALEX_WA, ...extra };
}

// POSTs a webhook call to the adapter, signed with the fake app secret unless told otherwise.
export async function postWebhook(
  port: number,
  body: unknown,
  options: { signature?: string | null; secret?: string; path?: string } = {},
): Promise<Response> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const signature = options.signature === undefined ? signBody(raw, options.secret ?? FAKE_APP_SECRET) : options.signature;
  return fetch(`http://127.0.0.1:${port}${options.path ?? WEBHOOK_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(signature === null ? {} : { "x-hub-signature-256": signature }) },
    body: raw,
  });
}

// ---------------------------------------------------------------------------------------
// Building adapters against the fake

export const WHATSAPP_MEMBERS: Member[] = [
  { id: "alex", name: "Alex", role: "admin", identities: { whatsapp: ALEX_WA } },
  { id: "sam", name: "Sam", role: "adult", identities: { whatsapp: SAM_WA } },
];

export function freshStateDir(): string {
  return mkdtempSync(join(tmpdir(), "hmp-whatsapp-"));
}

export function whatsappConfig(api: FakeGraphApi, stateDir: string, overrides: Partial<WhatsAppAdapterConfig> = {}): WhatsAppAdapterConfig {
  return {
    phoneNumberId: PHONE_NUMBER_ID,
    apiVersion: API_VERSION,
    accessToken: FAKE_ACCESS_TOKEN,
    appSecret: FAKE_APP_SECRET,
    verifyToken: FAKE_VERIFY_TOKEN,
    members: WHATSAPP_MEMBERS.map((member) => ({ id: member.id, name: member.name, waId: member.identities.whatsapp! })),
    apiBaseUrl: api.url,
    webhook: { host: "127.0.0.1", port: 0, path: WEBHOOK_PATH },
    template: { name: "meal_plan_ready", language: "en_US" },
    stateDir,
    requestTimeoutMs: 300,
    ...overrides,
  };
}

export function whatsappAdapter(api: FakeGraphApi, stateDir: string, overrides: Partial<WhatsAppAdapterConfig> = {}): WhatsAppAdapter {
  return new WhatsAppAdapter(whatsappConfig(api, stateDir, overrides));
}
