// A practice run keeps its own inbox journal, so a real start never picks up practice messages as
// unanswered.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox } from "../src/messaging/inbox.ts";
import type { IncomingMessage } from "../src/messaging/types.ts";

function message(nativeId: string): IncomingMessage {
  return {
    platform: "telegram",
    conversationId: "-1001234567890",
    nativeId,
    sender: { identity: "111111111" },
    isGroup: true,
    text: "swap tuesday for tacos",
    hasAttachments: false,
    mentionsBot: false,
    repliesToBot: false,
    timestamp: 1_700_000_000_000,
  } as IncomingMessage;
}

describe("practice-run inbox", () => {
  test("messages recorded in a practice run are not in the real inbox", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "hmp-inbox-"));
    const practice = new Inbox(stateDir, () => {}, true);
    await practice.record(message("1"));

    expect(existsSync(join(stateDir, "inbox.dry-run.jsonl"))).toBe(true);
    expect(existsSync(join(stateDir, "inbox.jsonl"))).toBe(false);

    // A real start reading the same state folder sees the message as new, not as already journaled.
    const real = new Inbox(stateDir, () => {});
    const result = await real.record(message("1"));
    expect(result.isNew).toBe(true);
  });
});
