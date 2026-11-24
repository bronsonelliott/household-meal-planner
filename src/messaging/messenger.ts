// The messenger: the shared layer between one adapter and the rest of the bot.
//
//   1. check the household has members to listen to
//   2. take the household lock (one bridge per household)
//   3. start the adapter, which journals every message it receives (via handlers.onMessage)
//      before its platform is told the message arrived
//   4. go live: hand over journaled, unhandled messages first, then new ones as they arrive
//   5. run the health check now and every few minutes
//
// The worker and the scheduler see only this object (sendToConversation, markHandled, checkHealth,
// stop), never an adapter.

import type { ConversationMode, Member } from "../config.ts";
import { StartupError, numberFromEnv } from "../config.ts";
import { Inbox } from "./inbox.ts";
import { acquireHouseholdLock } from "./lock.ts";
import { ATTACHMENT_ONLY_LINE, DIRECT_MESSAGE_LINE, DirectMessageNotices, routeMessage, type Routing } from "./router.ts";
import { MessageSender, type Target } from "./sender.ts";
import type { AckKind, HealthResult, IncomingMessage, InboundEvent, MessagingAdapter, SendOutcome } from "./types.ts";

export { StartupError };

export interface MessengerOptions {
  mode: ConversationMode;
  members: Member[];
  stateDir: string;
  dryRun: boolean;
  // A text from a household member, for the worker. If it throws, the message stays unhandled and
  // replays on the next start. The worker calls markHandled when it is done.
  onEvent: (event: InboundEvent) => void | Promise<void>;
  // Each health result (the scheduler touches the heartbeat only on a healthy one).
  onHealth?: (result: HealthResult) => void;
  // The adapter's connection died after start-up.
  onFatal?: (reason: string) => void;
  log?: (line: string) => void;
  // Waits between send retries; tests pass one that returns at once.
  sleep?: (ms: number) => Promise<void>;
  // The clock for the once-a-day direct-message line and record times.
  now?: () => number;
  healthIntervalMs?: number;
  // Waits before each retry of a transient send failure (1, 5, and 15 minutes).
  retryDelaysMs?: number[];
}

export interface Messenger {
  // The reply to the household: the group chat, or every member's private chat in household-dms
  // mode. `key` (the worker's journal ID) lets a restart carry on a split send where it left off.
  sendToConversation(text: string, key?: string): Promise<SendOutcome>;
  sendToMember(memberId: string, text: string, key?: string): Promise<SendOutcome>;
  // The worker is done with this inbound message (reply sent, or a deliberate silence logged).
  markHandled(inboundId: string): void;
  // The newest local receipt number handed out so far (see InboundEvent.receiptSeq).
  receiptHighWater(): number;
  checkHealth(): Promise<HealthResult>;
  stop(): Promise<void>;
}

export const DEFAULT_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

// The runtime settings that come from the environment rather than config.toml.
export function healthIntervalFromEnv(env: Record<string, string | undefined> = process.env): number {
  return numberFromEnv(env, "HMP_HEALTH_INTERVAL_MS", 5 * 60_000);
}

function defaultLog(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Refuses to start with nobody to listen to: an empty allowlist would make the bot silently
// ignore everyone.
function checkMembers(adapter: MessagingAdapter, members: Member[]): void {
  if (members.length === 0) {
    throw new StartupError("The allowlist is empty. Add each adult as a [[members]] entry in config.toml with their chat identity.");
  }
  for (const member of members) {
    if ((member.identities[adapter.platform] ?? "") === "") {
      throw new StartupError(`${member.name || "A member"} has no ${adapter.platform} identity (members.identities.${adapter.platform} in config.toml).`);
    }
  }
}

export async function startMessenger(adapter: MessagingAdapter, options: MessengerOptions): Promise<Messenger> {
  const log = options.log ?? defaultLog;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  const { members, mode, stateDir } = options;

  checkMembers(adapter, members);
  const releaseLock = acquireHouseholdLock(stateDir, log);

  let started = false;
  let live = false;
  let healthTimer: ReturnType<typeof setInterval> | null = null;

  try {
    const inbox = new Inbox(stateDir, log, options.dryRun);
    const notices = new DirectMessageNotices(stateDir);
    const sender = new MessageSender({
      adapter,
      mode,
      members,
      stateDir,
      dryRun: options.dryRun,
      retryDelaysMs: options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
      sleep,
      now,
      log,
    });
    const routerContext = { platform: adapter.platform, mode, members, conversationId: adapter.conversationId };

    // A reaction (or whatever the platform offers) on each text the worker gets: "received" when
    // it arrives, "handled" once the worker has answered it. A "received" that stays means the bot
    // is stuck on that message. Best effort: a failed acknowledgement is logged, never retried,
    // and never undoes anything; the reply is what counts.
    function acknowledge(id: string, kind: AckKind): void {
      const message = inbox.get(id);
      if (!message || !adapter.capabilities.reactions) return;
      if (options.dryRun) {
        log(`DRY RUN: would acknowledge (${kind}) ${id}`);
        return;
      }
      void (async () => adapter.acknowledge(message, kind))().catch((error) => {
        log(`acknowledging (${kind}) ${id} failed: ${(error as Error)?.message ?? error}`);
      });
    }

    function handOff(event: InboundEvent): void {
      acknowledge(event.id, "received");
      const leftUnhandled = (error: unknown) =>
        log(`worker hand-off failed for ${event.id}; it stays unhandled: ${(error as Error)?.message ?? error}`);
      try {
        const result = options.onEvent({ ...event, receiptSeq: inbox.seqOf(event.id) });
        if (result instanceof Promise) result.catch(leftUnhandled);
      } catch (error) {
        leftUnhandled(error);
      }
    }

    // Sends a fixed line, then marks the message handled whatever the outcome: the line is a
    // courtesy, and the sender has already recorded any failure for the checker.
    async function sendFixedLine(id: string, target: Target, text: string, reason: string): Promise<void> {
      const outcome = await sender.send(text, target, `fixed-line:${id}`);
      inbox.markHandled(id, `${reason}; fixed line ${outcome.kind}`);
    }

    function deliver(id: string, routing: Routing): void {
      switch (routing.action) {
        case "event":
          handOff(routing.event);
          return;
        case "attachment-only": {
          // In a group the line goes to the group; in household-dms mode, to that member alone.
          const target: Target = mode === "group" ? { kind: "conversation" } : { kind: "member", memberId: routing.memberId };
          void sendFixedLine(id, target, ATTACHMENT_ONLY_LINE, "attachment only");
          return;
        }
        case "direct-message":
          if (!notices.isDue(routing.memberId, now())) {
            inbox.markHandled(id, "direct message; line already sent in the last day");
            return;
          }
          // Recorded before sending, so two direct messages in a row get one line.
          notices.recordSent(routing.memberId, now());
          void sendFixedLine(id, { kind: "member", memberId: routing.memberId }, DIRECT_MESSAGE_LINE, "direct message");
          return;
        case "drop":
          return; // route() marks these handled itself
      }
    }

    function route(id: string, message: IncomingMessage): void {
      if (inbox.isHandled(id)) return;
      const routing = routeMessage(message, id, routerContext);
      if (routing.action === "drop") {
        inbox.markHandled(id, `dropped: ${routing.reason}`);
        return;
      }
      deliver(id, routing);
    }

    const handlers = {
      // Resolves once the message is on disk: the adapter waits for this before its platform may
      // forget the message.
      onMessage: async (message: IncomingMessage) => {
        const { id, isNew } = await inbox.record(message);
        if (!isNew) {
          log(`dropped duplicate ${id}`);
          return;
        }
        // Still starting up: goLive() delivers it.
        if (live) route(id, message);
      },
      onFatal: (reason: string) => {
        if (!started) return; // during start-up the failed start reports it
        started = false;
        if (healthTimer) clearInterval(healthTimer);
        releaseLock();
        log(reason);
        options.onFatal?.(reason);
      },
      log,
    };

    await adapter.start(handlers);

    async function reportHealth(): Promise<void> {
      const result = await adapter.checkHealth();
      if (!result.healthy) log(`unhealthy: ${result.reason}`);
      options.onHealth?.(result);
    }

    started = true;
    live = true;
    // First every unhandled message from the journal (this run's and any left over from a
    // previous run), in arrival order; new ones follow as they come.
    for (const { id, message } of inbox.unhandled()) route(id, message);
    void reportHealth();
    healthTimer = setInterval(() => void reportHealth(), options.healthIntervalMs ?? healthIntervalFromEnv());

    return {
      sendToConversation: (text, key) => sender.send(text, { kind: "conversation" }, key),
      sendToMember: (memberId, text, key) => sender.send(text, { kind: "member", memberId }, key),
      receiptHighWater: () => inbox.highWater(),
      markHandled: (inboundId) => {
        inbox.markHandled(inboundId, "handled by the worker");
        acknowledge(inboundId, "handled");
      },
      checkHealth: () => adapter.checkHealth(),
      stop: async () => {
        started = false;
        live = false;
        if (healthTimer) clearInterval(healthTimer);
        await adapter.stop();
        releaseLock();
      },
    };
  } catch (error) {
    await adapter.stop().catch(() => {});
    releaseLock();
    throw error;
  }
}

// What bridge.ts calls: start the messenger, and exit the process non-zero when a start-up check
// fails or when the adapter's connection dies, so the service manager restarts the whole tree.
export async function startMessengerOrExit(adapter: MessagingAdapter, options: MessengerOptions): Promise<Messenger> {
  try {
    return await startMessenger(adapter, {
      ...options,
      onFatal: (reason) => {
        options.onFatal?.(reason);
        console.error(`${reason}; the bridge exits so the service manager restarts it.`);
        process.exit(1);
      },
    });
  } catch (error) {
    if (error instanceof StartupError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

