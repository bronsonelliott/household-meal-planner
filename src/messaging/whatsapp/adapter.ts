// The WhatsApp adapter (beta): Meta's official Cloud API, over plain fetch and one small web server.
//
// Receiving is a webhook. Meta POSTs each message to a public HTTPS address (a tunnel or reverse
// proxy forwards it to the server this adapter starts). Three rules keep that safe:
//
//   - A POST is checked against its X-Hub-Signature-256 signature before anything is parsed.
//   - We answer 200 only after handlers.onMessage resolves (the inbox journal write). If we crash
//     first, Meta never got its 200 and sends the message again; the inbox drops the duplicate.
//   - Delivery statuses (sent, delivered, read, failed) are logged and noted, and change nothing
//     else: no worker state moves because a "read" tick arrived.
//
// Sending has one big catch: WhatsApp only lets a bot send ordinary messages to someone for 24
// hours after that person last wrote to it. For each member the adapter remembers when that was.
//
//   inside the window    the text goes out as a normal message.
//   outside the window   the configured approved template goes out instead (at most once a day),
//                        and the text waits in the state folder. When that person next writes to the
//                        bot, the waiting text is delivered first. The send is reported as FAILED
//                        (marked "queued"): nothing was posted yet, and nobody should be told it was.
//   no template set      the send fails with a plain reason, and nothing is kept.
//
// Household-dms mode only: the official API cannot join group chats.

import { StartupError } from "../../config.ts";
import type { AckKind, AdapterHandlers, Capabilities, HealthResult, IncomingMessage, MessageRef, MessagingAdapter, SendOutcome } from "../types.ts";
import { DRY_RUN_DETAIL } from "../dry-run.ts";
import { describeAnswer, GraphApi, type ApiAnswer } from "./client.ts";
import { isWindowClosed, sortSendAnswer } from "./results.ts";
import type { WhatsAppAdapterConfig, WhatsAppMember } from "./settings.ts";
import { PENDING_MAX_AGE_MS, StatusStore, WINDOW_MS, WindowStore } from "./state.ts";
import { parseWebhook, sameSecret, signatureIsValid } from "./webhook.ts";

const WHATSAPP_MAX_CHARS = 4096;
// Meta's webhook bodies are small; anything bigger is not from Meta.
const MAX_WEBHOOK_BYTES = 1_048_576;

const REACTIONS: Record<AckKind, string> = {
  received: "👀",
  handled: "👍",
};

export class WhatsAppAdapter implements MessagingAdapter {
  readonly platform = "whatsapp" as const;
  readonly capabilities: Capabilities = { reactions: true, mentions: false, maxMessageChars: WHATSAPP_MAX_CHARS, nativeGroups: false };
  readonly conversationId = null;

  private api: GraphApi;
  private windows: WindowStore;
  private statuses: StatusStore;
  private handlers: AdapterHandlers | null = null;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private lastVerifiedPostAt: number | null = null;
  // Sends to one member run one after another, so a waiting text always goes out before a reply.
  private chains = new Map<string, Promise<unknown>>();
  private stopSignal = new AbortController();

  constructor(private config: WhatsAppAdapterConfig) {
    this.api = new GraphApi(config.accessToken, [config.appSecret, config.verifyToken], config.apiBaseUrl, config.apiVersion, config.requestTimeoutMs, config.dryRun === true);
    this.windows = new WindowStore(config.stateDir);
    this.statuses = new StatusStore(config.stateDir);
  }

  private now(): number {
    return (this.config.now ?? Date.now)();
  }

  // The port the webhook server really listens on (tests ask for port 0 and need to know it).
  get webhookPort(): number | null {
    return this.server?.port ?? null;
  }

  // ----- Start-up -----

  async start(handlers: AdapterHandlers): Promise<void> {
    const { config } = this;
    this.handlers = handlers;

    if (config.phoneNumberId === "") throw new StartupError("The WhatsApp phone number ID is not set (messaging.whatsapp.phoneNumberId in config.toml).");
    if (config.accessToken === "") throw new StartupError("The WhatsApp access token is not set (the environment variable named by messaging.whatsapp.accessTokenEnv).");
    if (config.appSecret === "") throw new StartupError("The WhatsApp app secret is not set (the environment variable named by messaging.whatsapp.appSecretEnv). Without it nothing sent to the webhook can be trusted.");
    if (config.verifyToken === "") throw new StartupError("The WhatsApp webhook verify token is not set (the environment variable named by messaging.whatsapp.verifyTokenEnv).");
    for (const member of config.members) {
      if (member.waId === "") throw new StartupError(`${member.name || "A member"} has no WhatsApp number (members.identities.whatsapp in config.toml).`);
    }

    // A waiting text the last run was in the middle of posting may have gone out. Nothing can ask
    // WhatsApp, so it is dropped, never sent again, and said so plainly.
    for (const { memberId, item, what } of this.windows.settleInterrupted()) {
      const name = config.members.find((candidate) => candidate.id === memberId)?.name ?? memberId;
      if (what === "unknown") {
        handlers.log(`a message waiting for ${name} (queued ${new Date(item.queuedAt).toISOString()}) was being delivered when the bridge stopped; it may have gone out, so it is dropped and not sent again`);
      } else {
        handlers.log(`a message waiting for ${name} was already ${what === "sent" ? "delivered" : "given up on"} before the bridge stopped; removed`);
      }
    }

    // Is the token good? A rejected token is a start-up failure; anything else (Meta unreachable
    // for a moment) is only logged, because the webhook is still worth listening on.
    const check = await this.api.call(this.phoneNumberPath());
    if (check.kind === "api-error" && (check.code === 190 || check.httpStatus === 401)) {
      throw new StartupError("WhatsApp rejected the access token. Make a new permanent system-user token and put it in the environment variable named by messaging.whatsapp.accessTokenEnv.");
    }
    if (check.kind === "ok") handlers.log(`WhatsApp number ${check.body?.display_phone_number ?? config.phoneNumberId} connected`);
    else handlers.log(`WARNING: could not check the WhatsApp phone number at start-up (${describeAnswer(check)}); listening for the webhook anyway`);

    try {
      this.server = Bun.serve({
        hostname: config.webhook.host,
        port: config.webhook.port,
        maxRequestBodySize: MAX_WEBHOOK_BYTES,
        fetch: (request) => this.handleWebhook(request),
      });
    } catch (error) {
      throw new StartupError(`Could not listen for WhatsApp's webhook on ${config.webhook.host}:${config.webhook.port} (${(error as Error)?.message ?? error}). Is another program using that port?`);
    }
    handlers.log(`WhatsApp webhook listening on ${config.webhook.host}:${this.server.port}${config.webhook.path}`);
  }

  private phoneNumberPath(): string {
    return `${this.config.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`;
  }

  // ----- Receiving: the webhook -----

  private async handleWebhook(request: Request): Promise<Response> {
    const log = this.handlers!.log;
    const url = new URL(request.url);
    if (url.pathname !== this.config.webhook.path) return new Response("not found", { status: 404 });

    // Meta's "is this address really yours?" handshake, done when the webhook is first set up.
    if (request.method === "GET") {
      const given = url.searchParams.get("hub.verify_token") ?? "";
      if (url.searchParams.get("hub.mode") === "subscribe" && sameSecret(given, this.config.verifyToken)) {
        return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200, headers: { "content-type": "text/plain" } });
      }
      log("WhatsApp webhook handshake refused: the verify token did not match");
      return new Response("forbidden", { status: 403 });
    }
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    // The signature first, on the raw bytes. The body is not logged, not even when it is refused.
    const raw = new Uint8Array(await request.arrayBuffer());
    if (!signatureIsValid(raw, request.headers.get("x-hub-signature-256"), this.config.appSecret)) {
      log("WhatsApp webhook call refused: missing or wrong signature");
      return new Response("bad signature", { status: 401 });
    }
    this.lastVerifiedPostAt = this.now();

    let body: any;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      log("WhatsApp webhook call refused: the body is not JSON");
      return new Response("bad request", { status: 400 });
    }

    try {
      const parsed = parseWebhook(body, this.config.phoneNumberId);
      for (const note of parsed.skipped) log(`WhatsApp webhook: ignored ${note}`);
      for (const status of parsed.statuses) this.noteStatus(status);
      for (const message of parsed.messages) await this.receive(message);
    } catch (error) {
      // Not journaled (or the journal failed), so no 200: Meta will send it again.
      log(`WhatsApp webhook: could not process a call, asking Meta to retry (${this.api.redact(String((error as Error)?.message ?? error))})`);
      return new Response("try again", { status: 500 });
    }
    return new Response("ok", { status: 200 });
  }

  private noteStatus(status: { messageId: string; status: string; at: number; error?: string }): void {
    const isNew = this.statuses.record(status.messageId, status.status, status.at, status.error);
    if (!isNew) return;
    this.handlers!.log(`WhatsApp message ${status.messageId} is ${status.status}${status.error ? ` (${status.error})` : ""}`);
  }

  private async receive(message: IncomingMessage): Promise<void> {
    const member = this.config.members.find((candidate) => candidate.waId === message.sender.identity);
    if (member) {
      // They wrote, so the 24-hour window is open again. Anything waiting for them goes out now,
      // ahead of whatever the bot answers (the per-member queue keeps that order).
      this.windows.recordInbound(member.id, Math.min(message.timestamp, this.now()));
      void this.deliverPending(member);
    }
    await this.handlers!.onMessage(message);
  }

  // ----- Sending -----

  sendToConversation(_text: string): Promise<SendOutcome> {
    return Promise.resolve({ kind: "failed", detail: "WhatsApp has no group chat for the bot to post in (conversation.mode must be household-dms)" });
  }

  sendToMember(memberId: string, text: string): Promise<SendOutcome> {
    const member = this.config.members.find((candidate) => candidate.id === memberId);
    if (!member) return Promise.resolve({ kind: "failed", detail: `no WhatsApp number is configured for member ${memberId}` });
    return this.inLine(member.id, () => this.deliver(member, text));
  }

  // Runs `work` after every earlier piece of work for the same member has finished.
  private inLine<T>(memberId: string, work: () => Promise<T>): Promise<T> {
    const before = this.chains.get(memberId) ?? Promise.resolve();
    const mine = before.then(work, work);
    this.chains.set(memberId, mine.catch(() => {}));
    return mine;
  }

  private async deliver(member: WhatsAppMember, text: string): Promise<SendOutcome> {
    // The shared sender never gets here in dry run; this is the backstop so a template or a text
    // can never be posted (or kept for later) by accident.
    if (this.config.dryRun) return { kind: "failed", detail: DRY_RUN_DETAIL };
    if (this.windows.isOpen(member.id, this.now())) {
      const answer = await this.postText(member.waId, text);
      if (!isWindowClosed(answer)) return sortSendAnswer(answer, () => this.now());
      // Our clock said open, Meta says shut. Meta refused it outright, so nothing went out.
      this.windows.markClosed(member.id);
      this.handlers?.log(`WhatsApp says ${member.name}'s 24-hour window is closed; treating it as closed`);
    }
    return this.outsideWindow(member, text);
  }

  private async outsideWindow(member: WhatsAppMember, text: string): Promise<SendOutcome> {
    const { template } = this.config;
    if (!template) {
      return {
        kind: "failed",
        detail: `waiting for ${member.name} to message the bot; WhatsApp only allows replies within 24 hours`,
        failureClass: "window-closed",
      };
    }

    const lastTemplate = this.windows.templateSentAt(member.id);
    if (lastTemplate === null || this.now() - lastTemplate >= WINDOW_MS) {
      const answer = await this.api.call(`${this.config.phoneNumberId}/messages`, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: member.waId,
        type: "template",
        template: { name: template.name, language: { code: template.language } },
      });
      const outcome = sortSendAnswer(answer, () => this.now());
      // A template that did not go out (or may not have) is that failure's answer, and the text is
      // not kept: a retry will come back through here, and an unknown is never tried again.
      if (outcome.kind !== "sent") return outcome;
      this.windows.markTemplateSent(member.id, this.now());
    }

    this.windows.addPending(member.id, text, this.now());
    return {
      kind: "failed",
      queued: true,
      failureClass: "awaiting-reply",
      detail: `${member.name} has not written to the bot in the last 24 hours, so WhatsApp only allows the approved template. It was sent, and this message will be delivered when ${member.name} replies. It has not been delivered yet`,
    };
  }

  private postText(to: string, body: string): Promise<ApiAnswer> {
    return this.api.call(`${this.config.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body },
    });
  }

  // The window just opened: send what was waiting, oldest first.
  //
  // Each text is handled in a fixed order so a crash can never make it go out twice: the attempt
  // is written to disk, then it is posted, then the answer is written, then the text is dropped.
  // (At start-up a text with an attempt and no answer is dropped as Unknown: see start().)
  private deliverPending(member: WhatsAppMember): Promise<void> {
    return this.inLine(member.id, async () => {
      const log = this.handlers!.log;
      // Dry run posts nothing, and the waiting texts are kept for a real run.
      if (this.config.dryRun) {
        if (this.windows.pending(member.id).length > 0) log(`DRY RUN: would deliver the texts waiting for ${member.name}; they are kept`);
        return;
      }
      for (const item of this.windows.pending(member.id)) {
        if (this.now() - item.queuedAt > PENDING_MAX_AGE_MS) {
          log(`dropped a message waiting for ${member.name}: it was more than a week old`);
          this.windows.dropPending(member.id, item.id);
          continue;
        }
        this.windows.recordAttempt(member.id, item.id, this.now());
        const answer = await this.postText(member.waId, item.text);
        const outcome = sortSendAnswer(answer, () => this.now());
        if (outcome.kind === "sent") {
          this.windows.recordOutcome(member.id, item.id, "sent");
          log(`delivered a waiting message to ${member.name}`);
          this.windows.dropPending(member.id, item.id);
          continue;
        }
        if (outcome.kind === "failed" && (outcome.transient === true || isWindowClosed(answer))) {
          this.windows.recordOutcome(member.id, item.id, "stays");
          this.windows.clearAttempt(member.id, item.id);
          log(`could not deliver a waiting message to ${member.name} yet (${outcome.detail}); it stays waiting`);
          return;
        }
        // Refused for good, or it may already have gone out: either way, not tried again.
        this.windows.recordOutcome(member.id, item.id, "gave-up");
        log(`gave up on a waiting message to ${member.name} (${outcome.kind}: ${"detail" in outcome ? outcome.detail : ""})`);
        this.windows.dropPending(member.id, item.id);
      }
    }).catch((error) => this.handlers?.log(`delivering waiting messages to ${member.name} failed: ${this.api.redact(String((error as Error)?.message ?? error))}`));
  }

  async acknowledge(ref: MessageRef, kind: AckKind): Promise<void> {
    const problems: string[] = [];
    const url = `${this.config.phoneNumberId}/messages`;
    // "Received" also marks the message read, so the blue ticks show the bot has seen it.
    if (kind === "received") {
      const read = await this.api.call(url, { messaging_product: "whatsapp", status: "read", message_id: ref.nativeId });
      if (read.kind !== "ok") problems.push(`marking ${ref.nativeId} as read failed: ${describeAnswer(read)}`);
    }
    const emoji = REACTIONS[kind];
    const reaction = await this.api.call(url, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: ref.conversationId,
      type: "reaction",
      reaction: { message_id: ref.nativeId, emoji },
    });
    if (reaction.kind !== "ok") problems.push(`reaction ${emoji} on ${ref.nativeId} failed: ${describeAnswer(reaction)}`);
    if (problems.length > 0) throw new Error(problems.join("; "));
  }

  // ----- Health -----

  // When Meta last sent us a correctly signed call, for the health line and the doctor.
  webhookActivity(): { lastVerifiedPostAt: number | null } {
    return { lastVerifiedPostAt: this.lastVerifiedPostAt };
  }

  // Reads the phone number's record (never sends a message). A quiet webhook is reported but is not
  // a fault: a household can go a day without writing.
  async checkHealth(): Promise<HealthResult> {
    const at = this.now();
    const answer = await this.api.call(this.phoneNumberPath());
    if (answer.kind !== "ok") return { healthy: false, reason: `the phone number lookup failed: ${describeAnswer(answer)}`, at };
    const { display_phone_number, verified_name, quality_rating } = answer.body ?? {};
    const webhook =
      this.lastVerifiedPostAt === null
        ? "no webhook call received since the bridge started"
        : `last webhook call ${describeAge(at - this.lastVerifiedPostAt)} ago`;
    return { healthy: true, reason: `ok: ${verified_name ?? "the number"} (${display_phone_number ?? "?"}), quality ${quality_rating ?? "unknown"}; ${webhook}`, at };
  }

  async stop(): Promise<void> {
    this.stopSignal.abort();
    this.server?.stop(true);
    this.server = null;
    await Promise.allSettled([...this.chains.values()]);
  }
}

function describeAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${Math.floor(minutes / 60)} hours`;
}
