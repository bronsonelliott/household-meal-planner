// Tests for the shared pieces on their own, with the FakeAdapter: message splitting, the router,
// and the sender's retry rules. (The contract suite covers the same ground end to end.)

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Member } from "../../src/config.ts";
import { FakeAdapter } from "../../src/messaging/fake.ts";
import { journalId } from "../../src/messaging/inbox.ts";
import { routeMessage } from "../../src/messaging/router.ts";
import { MessageSender } from "../../src/messaging/sender.ts";
import { splitMessage } from "../../src/messaging/split.ts";
import type { IncomingMessage, SendOutcome } from "../../src/messaging/types.ts";

const MEMBERS: Member[] = [
  { id: "alex", name: "Alex", role: "admin", identities: { telegram: "1001" } },
  { id: "sam", name: "Sam", role: "adult", identities: { telegram: "1002" } },
];

describe("splitMessage", () => {
  test("a short message is one part, untouched", () => {
    expect(splitMessage("Monday: tacos", 100)).toEqual(["Monday: tacos"]);
  });

  test("it cuts at blank lines and line breaks before it cuts a sentence", () => {
    const text = ["Monday: tacos", "Tuesday: soup", "", "Wednesday: pizza", "Thursday: pasta"].join("\n");
    const parts = splitMessage(text, 35);
    expect(parts.every((part) => part.length <= 35)).toBe(true);
    expect(parts.join("\n").replace(/\n+/g, "\n")).toBe(text.replace(/\n+/g, "\n"));
  });

  test("one word longer than the limit is cut where it stands", () => {
    expect(splitMessage("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });
});

function message(overrides: Partial<IncomingMessage>): IncomingMessage {
  return {
    platform: "telegram",
    conversationId: "household",
    nativeId: "1",
    sender: { identity: "1001", displayName: "Alex" },
    isGroup: true,
    text: "hello",
    hasAttachments: false,
    mentionsBot: false,
    repliesToBot: false,
    timestamp: 1,
    ...overrides,
  };
}

describe("routeMessage", () => {
  const group = { platform: "telegram" as const, mode: "group" as const, members: MEMBERS, conversationId: "household" };

  test("a member's group text is an event keyed by the configured member, not the display name", () => {
    const routing = routeMessage(message({ sender: { identity: "1002", displayName: "Alex" } }), "id-1", group);
    expect(routing).toMatchObject({ action: "event", event: { memberId: "sam", memberName: "Sam", id: "id-1" } });
  });

  test("an unknown identity is dropped whatever name it shows", () => {
    expect(routeMessage(message({ sender: { identity: "555", displayName: "Alex" } }), "id", group)).toEqual({ action: "drop", reason: "sender not on the allowlist" });
  });

  test("an empty identity never matches anyone", () => {
    expect(routeMessage(message({ sender: { identity: "", displayName: null } }), "id", group).action).toBe("drop");
  });

  test("another group is dropped; a private message gets the once-a-day line; a photo gets the words line", () => {
    expect(routeMessage(message({ conversationId: "elsewhere" }), "id", group).action).toBe("drop");
    expect(routeMessage(message({ isGroup: false, conversationId: "1001" }), "id", group)).toEqual({ action: "direct-message", memberId: "alex" });
    expect(routeMessage(message({ text: "", hasAttachments: true }), "id", group)).toEqual({ action: "attachment-only", memberId: "alex" });
    expect(routeMessage(message({ text: "  " }), "id", group)).toEqual({ action: "drop", reason: "no text" });
  });

  test("household-dms mode: a private message is the conversation, a group message is ignored", () => {
    const dms = { ...group, mode: "household-dms" as const, conversationId: null };
    expect(routeMessage(message({ isGroup: false, conversationId: "1001" }), "id", dms).action).toBe("event");
    expect(routeMessage(message({}), "id", dms).action).toBe("drop");
  });

  test("the journal ID is platform, conversation and the platform's own ID", () => {
    expect(journalId(message({ nativeId: "42" }))).toBe("telegram/household/42");
  });
});

describe("MessageSender", () => {
  function setup(outcomes: SendOutcome[], mode: "group" | "household-dms" = "group") {
    const stateDir = mkdtempSync(join(tmpdir(), "hmp-sender-"));
    const adapter = new FakeAdapter({ platform: "telegram", conversationId: mode === "group" ? "household" : null, maxMessageChars: 50 });
    adapter.scriptSends(outcomes);
    const sleeps: number[] = [];
    const sender = new MessageSender({
      adapter,
      mode,
      members: MEMBERS,
      stateDir,
      dryRun: false,
      retryDelaysMs: [60_000, 300_000, 900_000],
      sleep: async (ms) => void sleeps.push(ms),
      now: () => 1_790_000_000_000,
      log: () => {},
    });
    return { adapter, sender, sleeps, stateDir };
  }

  test("a failure that is not marked transient is not retried", async () => {
    const { adapter, sender, sleeps } = setup([{ kind: "failed", detail: "the chat is gone" }]);
    expect((await sender.send("hi", { kind: "conversation" })).kind).toBe("failed");
    expect(adapter.sends.length).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("a Retry-After longer than the first wait is honoured; one longer than the longest retry gives up", async () => {
    const short = setup([{ kind: "failed", detail: "slow down", transient: true, retryAfterMs: 120_000 }, { kind: "sent", timestamp: 1 }]);
    expect((await short.sender.send("hi", { kind: "conversation" })).kind).toBe("sent");
    expect(short.sleeps).toEqual([120_000]);

    const long = setup([{ kind: "failed", detail: "slow down", transient: true, retryAfterMs: 24 * 60 * 60 * 1000, failureClass: "rate-limited" }]);
    expect((await long.sender.send("hi", { kind: "conversation" })).kind).toBe("failed");
    expect(long.adapter.sends.length).toBe(1);
    expect(JSON.parse(readFileSync(join(long.stateDir, "send-failures.jsonl"), "utf8").trim()).class).toBe("rate-limited");
  });

  test("an adapter that throws is Unknown, not a crash and not a retry", async () => {
    const { adapter, sender } = setup([]);
    adapter.sendToConversation = async () => {
      throw new Error("socket hang up");
    };
    const outcome = await sender.send("hi", { kind: "conversation" });
    expect(outcome.kind).toBe("unknown");
  });

  test("a later part failing after an earlier one got through is Partial and names the part", async () => {
    const { adapter, sender } = setup([{ kind: "sent", timestamp: 7 }, { kind: "failed", detail: "gone" }]);
    const text = "a".repeat(40) + "\n" + "b".repeat(40) + "\n" + "c".repeat(40);
    const outcome = await sender.send(text, { kind: "conversation" });
    expect(outcome.kind).toBe("partial");
    expect(adapter.sends.length).toBe(2); // the third part is not sent after the second failed
    expect(outcome.recipients![0]!.parts.map((part) => part.kind)).toEqual(["sent", "failed", "not-attempted"]);
  });

  test("a dry run sends nothing and writes each part for each recipient to the dry-run file", async () => {
    const { adapter, stateDir } = setup([], "household-dms");
    const dry = new MessageSender({
      adapter,
      mode: "household-dms",
      members: MEMBERS,
      stateDir,
      dryRun: true,
      retryDelaysMs: [],
      sleep: async () => {},
      now: () => 1,
      log: () => {},
    });
    const outcome = await dry.send("hi", { kind: "conversation" });
    expect(outcome).toMatchObject({ kind: "sent", dryRun: true });
    expect(adapter.sends).toEqual([]);
    const lines = readFileSync(join(stateDir, "dry-run-sends.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.target)).toEqual([{ member: "alex" }, { member: "sam" }]);
  });
});
