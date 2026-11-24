// The messaging contract suite: the behaviour every platform must have, written once.
//
//   import { runMessagingContract } from "./messaging-contract.ts";
//   runMessagingContract("Telegram", telegramKit);
//
// A "kit" (test/fixtures/contract-kits.ts) is the only platform-specific part: it builds an
// adapter, makes inbound messages arrive, scripts how sends end, and reads back what reached the
// platform. Each test below starts the real shared messenger around the adapter, the way
// bridge.ts does, so the suite checks the adapter AND the shared layer working together.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMessenger, type Messenger } from "../src/messaging/messenger.ts";
import { ATTACHMENT_ONLY_LINE, DIRECT_MESSAGE_LINE } from "../src/messaging/router.ts";
import type { InboundEvent } from "../src/messaging/types.ts";
import type { AdapterSetup, ContractKit, KitFactory } from "./fixtures/contract-kits.ts";

const HOUR = 60 * 60 * 1000;

function readJsonLines(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

// Polls until the async condition holds (acknowledgements are sent in the background).
async function eventually(condition: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("eventually: condition not met in time");
    await Bun.sleep(15);
  }
}

// A platform with no group chats (WhatsApp) passes { groups: false }. The tests below that say
// mode "group" then run in household-dms mode instead and send to one member, with the same
// checks, and the one test that only makes sense with a group is skipped.
export function runMessagingContract(name: string, makeKit: KitFactory, options: { groups?: boolean; realTransport?: boolean } = {}): void {
  const groups = options.groups !== false;
  const groupOnly = groups ? test : test.skip;
  // The fake adapter has no wire of its own, so there is nothing for dry run to guard there.
  const transportOnly = options.realTransport === false ? test.skip : test;

  describe(`messaging contract: ${name}`, () => {
    const running: Messenger[] = [];
    afterEach(async () => {
      while (running.length > 0) await running.pop()!.stop();
    });

    // One test's world: a fresh state folder and kit, and a way to (re)start the messenger on them.
    function world() {
      const stateDir = mkdtempSync(join(tmpdir(), "hmp-contract-"));
      const kit: ContractKit = makeKit(stateDir);
      const events: InboundEvent[] = [];
      const logs: string[] = [];
      const sleeps: number[] = [];
      let now = 1_790_000_000_000;

      // Without groups, "group" in a test means "the shared conversation", which is each
      // member's private chat.
      function adapt(setup: AdapterSetup): AdapterSetup {
        if (groups || setup.mode !== "group") return setup;
        return { ...setup, mode: "household-dms", inbound: setup.inbound?.map((spec) => ({ ...spec, group: false })) };
      }

      async function start(setup: AdapterSetup, options: { members?: ContractKit["members"] } = {}): Promise<Messenger> {
        setup = adapt(setup);
        const messenger = await startMessenger(kit.newAdapter(setup), {
          mode: setup.mode,
          members: options.members ?? kit.members,
          stateDir,
          dryRun: false,
          onEvent: (event) => void events.push(event),
          log: (line) => logs.push(line),
          sleep: async (ms) => void sleeps.push(ms),
          now: () => now,
          healthIntervalMs: HOUR,
        });
        running.push(messenger);
        return messenger;
      }
      // A stop followed by a fresh start is a restart of the bridge.
      async function stop(messenger: Messenger): Promise<void> {
        await messenger.stop();
        running.splice(running.indexOf(messenger), 1);
      }
      return {
        stateDir,
        kit,
        events,
        logs,
        sleeps,
        start,
        stop,
        adapt,
        advanceClock: (ms: number) => void (now += ms),
        journal: () => readJsonLines(join(stateDir, "inbox.jsonl")),
        outbox: () => readJsonLines(join(stateDir, "outbox.jsonl")),
        failures: () => readJsonLines(join(stateDir, "send-failures.jsonl")),
      };
    }

    // The reply to "the conversation", and what the platform should record for it.
    const reply = (messenger: Messenger, text: string, key?: string) =>
      groups ? messenger.sendToConversation(text, key) : messenger.sendToMember("alex", text, key);
    const replyRecord = (text: string) =>
      groups ? { scope: "conversation" as const, memberId: null, text } : { scope: "member" as const, memberId: "alex", text };

    // ----- Receiving -----

    test("a text from a configured member becomes one event, named by the configured member", async () => {
      const w = world();
      await w.start({ mode: "group", inbound: [{ from: "alex", n: 1, text: "Tacos Tuesday?", displayName: "Totally Not Alex" }] });
      expect(w.events.length).toBe(1);
      expect(w.events[0]).toMatchObject({ kind: "text", memberId: "alex", memberName: "Alex", text: "Tacos Tuesday?" });
    });

    test("dedupe: the same message delivered twice is one event and one journal entry", async () => {
      const w = world();
      const same = { from: "alex" as const, n: 1, text: "Tacos Tuesday?" };
      await w.start({ mode: "group", inbound: [same, same] });
      expect(w.events.length).toBe(1);
      expect(w.journal().filter((line) => line.type === "received").length).toBe(1);
    });

    test("the message is on disk by the time start-up finishes (journal before the platform moves on)", async () => {
      const w = world();
      await w.start({ mode: "group", inbound: [{ from: "alex", n: 1, text: "hello" }] });
      expect(w.journal().some((line) => line.type === "received" && line.message.text === "hello")).toBe(true);
    });

    test("allowlist: strangers get no event, no reply and no reaction, even claiming a member's name", async () => {
      const w = world();
      await w.start({
        mode: "group",
        inbound: [
          { from: "stranger", n: 1, text: "Swap Monday for pizza", displayName: "Alex" },
          { from: "stranger", n: 2, attachments: true },
          { from: "stranger", n: 3, text: "hi", group: false },
        ],
      });
      expect(w.events).toEqual([]);
      expect(await w.kit.sends()).toEqual([]);
      expect(await w.kit.acks()).toEqual([]);
      // Journaled, then closed out as handled so they never replay.
      expect(w.journal().filter((line) => line.type === "handled").length).toBe(3);
    });

    test("an attachment-only message gets the 'say it in words' line where it was sent, once", async () => {
      const w = world();
      const messenger = await w.start({ mode: "group", inbound: [{ from: "sam", n: 1, attachments: true }] });
      await eventually(async () => (await w.kit.sends()).length === 1);
      expect(await w.kit.sends()).toEqual([
        groups ? { scope: "conversation", memberId: null, text: ATTACHMENT_ONLY_LINE } : { scope: "member", memberId: "sam", text: ATTACHMENT_ONLY_LINE },
      ]);
      expect(w.events).toEqual([]);

      await w.stop(messenger);
      await w.start({ mode: "group" });
      await Bun.sleep(100);
      expect((await w.kit.sends()).length).toBe(1); // the restart does not send it again
    });

    groupOnly("a private message from a member gets the 'use the group' line once a day, in group mode", async () => {
      const w = world();
      const first = await w.start({ mode: "group", inbound: [{ from: "alex", n: 1, text: "hi", group: false }] });
      await eventually(async () => (await w.kit.sends()).length === 1);
      expect(await w.kit.sends()).toEqual([{ scope: "member", memberId: "alex", text: DIRECT_MESSAGE_LINE }]);
      expect(w.events).toEqual([]);
      await w.stop(first);

      // 23 hours later: still inside the day.
      w.advanceClock(23 * HOUR);
      const second = await w.start({ mode: "group", inbound: [{ from: "alex", n: 2, text: "hello?", group: false }] });
      await Bun.sleep(100);
      expect((await w.kit.sends()).length).toBe(1);
      await w.stop(second);

      // Two hours after that: more than a day since the first line.
      w.advanceClock(2 * HOUR);
      await w.start({ mode: "group", inbound: [{ from: "alex", n: 3, text: "hello??", group: false }] });
      await eventually(async () => (await w.kit.sends()).length === 2);
    });

    test("restart replay: an unhandled message comes back once per start with the same ID, a handled one never does", async () => {
      const w = world();
      const first = await w.start({ mode: "group", inbound: [{ from: "alex", n: 1, text: "Tacos Tuesday?" }] });
      const id = w.events[0]!.id;
      await w.stop(first); // the worker never finished it

      const second = await w.start({ mode: "group" }); // nothing new from the platform
      expect(w.events.map((event) => event.id)).toEqual([id, id]); // the same event, so a worker that keys on the ID applies it once
      second.markHandled(id);
      await w.stop(second);

      await w.start({ mode: "group", inbound: [{ from: "alex", n: 1, text: "Tacos Tuesday?" }] }); // the platform redelivers it
      expect(w.events.length).toBe(2); // handled, so neither the replay nor the redelivery reaches the worker
    });

    test("a hand-off that throws leaves the message unhandled, so it replays", async () => {
      const w = world();
      const setup = w.adapt({ mode: "group", inbound: [{ from: "alex", n: 1, text: "hi" }] });
      const throwing = await startMessenger(w.kit.newAdapter(setup), {
        mode: setup.mode,
        members: w.kit.members,
        stateDir: w.stateDir,
        dryRun: false,
        onEvent: () => {
          throw new Error("worker fell over");
        },
        log: () => {},
        healthIntervalMs: HOUR,
      });
      await throwing.stop();
      await w.start({ mode: "group" });
      expect(w.events.length).toBe(1);
    });

    // ----- Acknowledgements -----

    test("acknowledge: 'received' when the worker gets it, 'handled' when the worker marks it done", async () => {
      const w = world();
      const messenger = await w.start({ mode: "group", inbound: [{ from: "alex", n: 1, text: "hi" }] });
      await eventually(async () => (await w.kit.acks()).length === 1);
      expect((await w.kit.acks()).map((ack) => ack.kind)).toEqual(["received"]);
      messenger.markHandled(w.events[0]!.id);
      await eventually(async () => (await w.kit.acks()).length === 2);
      expect((await w.kit.acks()).map((ack) => ack.kind)).toEqual(["received", "handled"]);
    });

    test("a failed acknowledgement is logged and changes nothing: the event arrives, the work is recorded as done", async () => {
      const w = world();
      const first = await w.start({ mode: "group", inbound: [{ from: "alex", n: 1, text: "hi" }], failAcks: true });
      expect(w.events.length).toBe(1);
      first.markHandled(w.events[0]!.id);
      await eventually(async () => w.logs.filter((line) => line.includes("failed")).length >= 2);
      expect(w.journal().some((line) => line.type === "handled" && line.reason === "handled by the worker")).toBe(true);
      await w.stop(first);

      await w.start({ mode: "group", failAcks: true });
      expect(w.events.length).toBe(1); // not replayed
    });

    // ----- Sending -----

    test("the reply goes to the conversation, as one send", async () => {
      const w = world();
      const messenger = await w.start({ mode: "group" });
      const outcome = await reply(messenger, "Monday: tacos");
      expect(outcome.kind).toBe("sent");
      expect(await w.kit.sends()).toEqual([replyRecord("Monday: tacos")]);
    });

    test("Unknown is never resent: one attempt, no sleeps, one failure record", async () => {
      const w = world();
      const messenger = await w.start({ mode: "group", sendScript: ["unknown"] });
      const outcome = await reply(messenger, "Monday: tacos");
      expect(outcome.kind).toBe("unknown");
      expect((await w.kit.sends()).length).toBe(1);
      expect(w.sleeps).toEqual([]);
      expect(w.failures().map((record) => record.class)).toEqual(["send-unknown"]);
    });

    test("a transient failure is retried at 1, 5 and 15 minutes, then recorded as failed", async () => {
      const w = world();
      const messenger = await w.start({ mode: "group", sendScript: ["transient-failure"] });
      const outcome = await reply(messenger, "Monday: tacos");
      expect(outcome.kind).toBe("failed");
      expect(w.sleeps).toEqual([60_000, 300_000, 900_000]);
      expect((await w.kit.sends()).length).toBe(4);
      // The platforms that retry only on a rate limit name it; the others say plain "send-failed".
      const failures = w.failures();
      expect(failures.length).toBe(1);
      expect(["send-failed", "rate-limited"]).toContain(failures[0].class);
    });

    test("a retry that goes through is Sent and records no failure", async () => {
      const w = world();
      const messenger = await w.start({ mode: "group", sendScript: ["transient-failure", "sent"] });
      expect((await reply(messenger, "Monday: tacos")).kind).toBe("sent");
      expect(w.sleeps).toEqual([60_000]);
      expect(w.failures()).toEqual([]);
    });

    test("a long reply is split to the platform's limit, each part journaled before it is sent", async () => {
      const w = world();
      const probe = w.kit.newAdapter(w.adapt({ mode: "group" }));
      const max = probe.capabilities.maxMessageChars;
      const lines = Array.from({ length: Math.ceil((max * 2.5) / 60) }, (_, index) => `Line ${index}: ${"x".repeat(50)}`);
      const text = lines.join("\n");

      const messenger = await w.start({ mode: "group" });
      const outcome = await reply(messenger, text, "reply-1");
      expect(outcome.kind).toBe("sent");

      const sent = (await w.kit.sends()).map((send) => send.text);
      expect(sent.length).toBeGreaterThanOrEqual(3);
      expect(sent.every((part) => part.length <= max)).toBe(true);
      expect(sent.join("\n")).toBe(text); // nothing lost, nothing repeated
      expect(outcome.recipients![0]!.parts.map((part) => part.kind)).toEqual(sent.map(() => "sent"));

      // The cut was journaled before the first part went out.
      const plan = w.outbox().find((record) => record.type === "plan");
      expect(plan.parts).toEqual(sent);
      expect(w.outbox().findIndex((record) => record.type === "plan")).toBeLessThan(w.outbox().findIndex((record) => record.type === "sending"));
    });

    test("restart mid-send: parts already sent, and a part left Unknown, are not sent again", async () => {
      const w = world();
      const max = w.kit.newAdapter(w.adapt({ mode: "group" })).capabilities.maxMessageChars;
      const text = Array.from({ length: Math.ceil((max * 2.5) / 60) }, (_, index) => `Line ${index}: ${"x".repeat(50)}`).join("\n");

      const first = await w.start({ mode: "group", sendScript: ["sent", "unknown"] });
      const outcome = await reply(first, text, "reply-1");
      expect(outcome.kind).toBe("partial"); // the first part is out; the second may or may not be
      const sentBefore = (await w.kit.sends()).length;
      expect(sentBefore).toBe(2);
      await w.stop(first);

      const second = await w.start({ mode: "group" });
      const again = await reply(second, text, "reply-1");
      expect(again.kind).toBe("partial");
      expect((await w.kit.sends()).length).toBe(sentBefore);
    });

    test("restart while a part was in flight: it is settled as Unknown, never sent again", async () => {
      const w = world();
      const first = await w.start({ mode: "group" });
      await reply(first, "Monday: tacos", "reply-1");
      await w.stop(first);
      // Rewrite the journal as it would look if the bridge died between "sending" and "result".
      const lines = readFileSync(join(w.stateDir, "outbox.jsonl"), "utf8").split("\n").filter((line) => line !== "");
      const withoutResult = lines.filter((line) => JSON.parse(line).type !== "result");
      await Bun.write(join(w.stateDir, "outbox.jsonl"), withoutResult.join("\n") + "\n");

      const sentBefore = (await w.kit.sends()).length;
      const second = await w.start({ mode: "group" });
      const outcome = await reply(second, "Monday: tacos", "reply-1");
      expect(outcome.kind).toBe("unknown");
      expect((await w.kit.sends()).length).toBe(sentBefore);
    });

    // ----- Dry run -----

    // Dry run is enforced where requests leave the adapter, not only in the shared sender: the
    // adapter is built the way the real bridge builds it in dry run, then asked to send, react and
    // (where it has one) deliver, directly. The fake provider must not see a single send request.
    transportOnly("dry run: an adapter asked to send or react posts nothing to the provider", async () => {
      const w = world();
      const setup = w.adapt({ mode: "group", dryRun: true });
      const adapter = w.kit.newAdapter(setup);
      await adapter.start({ onMessage: async () => {}, onFatal: () => {}, log: (line) => void w.logs.push(line) });
      const ref = {
        platform: adapter.platform,
        conversationId: adapter.conversationId ?? "1001",
        nativeId: "1",
        sender: { identity: w.kit.members[0]!.identities[adapter.platform] ?? "1001", displayName: null },
        timestamp: 1_790_000_000_000,
      };

      const toConversation = await adapter.sendToConversation("Monday: tacos").catch((error) => ({ kind: "threw", error }));
      const toMember = await adapter.sendToMember("alex", "Monday: tacos").catch((error) => ({ kind: "threw", error }));
      await adapter.acknowledge(ref, "received").catch(() => {});
      await adapter.stop();

      // Whatever each answered, it was not "sent".
      expect(toConversation.kind).not.toBe("sent");
      expect(toMember.kind).not.toBe("sent");
      expect(await w.kit.sends()).toEqual([]);
      expect(await w.kit.acks()).toEqual([]);
    });

    transportOnly("dry run: through the messenger nothing reaches the provider either, and the would-be sends are written down", async () => {
      const w = world();
      const setup = w.adapt({ mode: "group", dryRun: true });
      const messenger = await startMessenger(w.kit.newAdapter(setup), {
        mode: setup.mode,
        members: w.kit.members,
        stateDir: w.stateDir,
        dryRun: true,
        onEvent: () => {},
        log: (line) => w.logs.push(line),
        healthIntervalMs: HOUR,
      });
      running.push(messenger);
      const outcome = await reply(messenger, "Monday: tacos");
      expect(outcome).toMatchObject({ kind: "sent", dryRun: true });
      expect(await w.kit.sends()).toEqual([]);
      expect(readJsonLines(join(w.stateDir, "dry-run-sends.jsonl")).length).toBeGreaterThan(0);
    });

    // ----- household-dms mode -----

    test("household-dms: private messages from members ARE the conversation; groups and strangers are ignored", async () => {
      const w = world();
      await w.start({
        mode: "household-dms",
        inbound: [
          { from: "alex", n: 1, text: "Tacos Tuesday?", group: false },
          { from: "sam", n: 2, text: "in a group", group: true },
          { from: "stranger", n: 3, text: "hi", group: false },
        ],
      });
      expect(w.events.map((event) => [event.memberId, event.text])).toEqual([["alex", "Tacos Tuesday?"]]);
      expect(await w.kit.sends()).toEqual([]); // no "use the group" line: there is no group
    });

    test("household-dms: sendToConversation fans out to every member, with an outcome for each", async () => {
      const w = world();
      const messenger = await w.start({ mode: "household-dms" });
      const outcome = await messenger.sendToConversation("Monday: tacos");
      expect(outcome.kind).toBe("sent");
      expect(await w.kit.sends()).toEqual([
        { scope: "member", memberId: "alex", text: "Monday: tacos" },
        { scope: "member", memberId: "sam", text: "Monday: tacos" },
      ]);
      expect(outcome.recipients!.map((recipient) => [recipient.memberId, recipient.kind])).toEqual([
        ["alex", "sent"],
        ["sam", "sent"],
      ]);
    });

    test("household-dms: one member's send failing is Partial and names that member; the other is not resent", async () => {
      const w = world();
      const messenger = await w.start({ mode: "household-dms", sendScript: ["sent", "transient-failure"] });
      const outcome = await messenger.sendToConversation("Monday: tacos");
      expect(outcome.kind).toBe("partial");
      if (outcome.kind !== "partial") throw new Error("expected partial");
      expect(outcome.failedMembers).toEqual([{ member: "sam", type: "FAILED" }]);
      expect(outcome.recipients!.map((recipient) => [recipient.memberId, recipient.kind])).toEqual([
        ["alex", "sent"],
        ["sam", "failed"],
      ]);
      const sends = await w.kit.sends();
      expect(sends.filter((send) => send.memberId === "alex").length).toBe(1);
      expect(sends.filter((send) => send.memberId === "sam").length).toBe(4); // first try plus three retries
      expect(w.failures().map((record) => record.target)).toEqual([{ member: "sam" }]);
    });

    test("household-dms: the member list is snapshotted, so a restart with a different list sends to the same people", async () => {
      const w = world();
      const first = await w.start({ mode: "household-dms", sendScript: ["sent", "unknown"] });
      const outcome = await first.sendToConversation("Monday: tacos", "reply-1");
      expect(outcome.kind).toBe("partial"); // Alex got it; Sam's is Unknown
      await w.stop(first);
      const sentBefore = (await w.kit.sends()).length;

      const alexOnly = w.kit.members.filter((member) => member.id === "alex");
      const second = await w.start({ mode: "household-dms" }, { members: alexOnly });
      const again = await second.sendToConversation("Monday: tacos", "reply-1");
      expect(again.recipients!.map((recipient) => [recipient.memberId, recipient.kind])).toEqual([
        ["alex", "sent"],
        ["sam", "unknown"],
      ]);
      expect((await w.kit.sends()).length).toBe(sentBefore);
    });
  });
}
