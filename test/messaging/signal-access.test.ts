// Tests for the access gate: the start-up group check, the once-a-day direct-message line, and the
// attachment-only line.

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ATTACHMENT_ONLY_LINE, DIRECT_MESSAGE_LINE } from "../../src/messaging/router.ts";
import {
  ADULT_ID,
  BOT_MEMBER_ID,
  DEFAULT_ACCESS,
  GROUP_ID,
  STRANGER_ID,
  makeConfig,
  makeStateDir,
  readFixture,
  readJsonLines,
  runStandInBridge,
  startTransport,
  StartupError,
  variant,
  waitFor,
  type Transport,
} from "../fixtures/signal-harness.ts";

const running: Transport[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
});

function dryRunSends(stateDir: string) {
  return readJsonLines(join(stateDir, "dry-run-sends.jsonl"));
}

describe("start-up group check", () => {
  test("a configured group the bot is not in is refused, listing the groups and members found", async () => {
    const stateDir = makeStateDir({ ...DEFAULT_ACCESS, groupId: "T1RIRVItR1JPVVA=" });
    const attempt = startTransport(makeConfig(stateDir), { onEvent: () => {}, log: () => {} });
    await expect(attempt).rejects.toThrow(StartupError);
    const message = await attempt.catch((error: Error) => error.message);
    expect(message).toContain("T1RIRVItR1JPVVA="); // what was configured
    expect(message).toContain("Test group"); // what was found
    expect(message).toContain(GROUP_ID);
    expect(message).toContain(BOT_MEMBER_ID);
    expect(message).toContain(ADULT_ID);
  });

  test("an allowlisted adult who is not a member is refused, and the stand-in bridge exits non-zero", async () => {
    const access = {
      ...DEFAULT_ACCESS,
      allowlist: [...DEFAULT_ACCESS.allowlist, { name: "Adult Two", accountId: STRANGER_ID }],
    };
    const stateDir = makeStateDir(access);
    const result = await runStandInBridge(makeConfig(stateDir));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(STRANGER_ID);
    expect(result.stderr).toContain("Test group");
    expect(result.stderr).toContain(ADULT_ID);
  });

  test("a group the bot has left (isMember false) is refused", async () => {
    const stateDir = makeStateDir();
    const groups = readFixture("rpc-listGroups-response.json");
    groups.result[0].isMember = false;
    const attempt = startTransport(makeConfig(stateDir, { listGroups: { result: groups.result } }), {
      onEvent: () => {},
      log: () => {},
    });
    await expect(attempt).rejects.toThrow(StartupError);
  });

  test("extra members beyond the bot and the allowlist are allowed", async () => {
    const stateDir = makeStateDir();
    const groups = readFixture("rpc-listGroups-response.json");
    groups.result[0].members.push({ number: null, uuid: STRANGER_ID, isAdmin: false });
    const transport = await startTransport(makeConfig(stateDir, { listGroups: { result: groups.result } }), {
      onEvent: () => {},
      log: () => {},
    });
    running.push(transport);
  });

  test("messages received during the settle window are journaled even when the check fails, and replay once it passes", async () => {
    // The check reads signal-cli's local group state, which only updates as messages arrive,
    // so a failed start must not lose what it already fetched from Signal's server.
    const stateDir = makeStateDir();
    const groups = readFixture("rpc-listGroups-response.json");
    groups.result[0].members = groups.result[0].members.filter((member: any) => member.uuid !== ADULT_ID);
    const failed = startTransport(
      makeConfig(stateDir, { listGroups: { result: groups.result }, afterSubscribe: ["group-text.json"] }),
      { onEvent: () => {}, log: () => {} },
    );
    await expect(failed).rejects.toThrow(StartupError);

    const events: string[] = [];
    const transport = await startTransport(makeConfig(stateDir), {
      onEvent: (event) => void events.push(event.text),
      log: () => {},
    });
    running.push(transport);
    expect(events).toEqual(["Tacos Tuesday?"]);
  });
});

describe("direct messages", () => {
  test("a direct message from an adult gets exactly one fixed line in 24 hours (dry-run log)", async () => {
    const stateDir = makeStateDir();
    const second = variant("direct-message.json", { timestamp: 1790806685342 + 60_000 });
    const now = 1790806700000;
    const transport = await startTransport(
      makeConfig(stateDir, { afterSubscribe: ["direct-message.json", second] }, { dryRun: true }),
      { onEvent: () => {}, log: () => {}, now: () => now },
    );
    running.push(transport);

    await waitFor(() => dryRunSends(stateDir).length === 1);
    await Bun.sleep(100);
    const sends = dryRunSends(stateDir);
    expect(sends.length).toBe(1);
    expect(sends[0].target).toEqual({ member: "adult-one" });
    expect(sends[0].text).toBe(DIRECT_MESSAGE_LINE);
  });

  test("a day later, the next direct message gets the line again, even across a restart", async () => {
    const stateDir = makeStateDir();
    let now = 1790806700000;
    const first = await startTransport(makeConfig(stateDir, { afterSubscribe: ["direct-message.json"] }, { dryRun: true }), {
      onEvent: () => {},
      log: () => {},
      now: () => now,
    });
    await waitFor(() => dryRunSends(stateDir).length === 1);
    await first.stop();

    // Restart 23 hours later: still inside the day, no second line.
    now += 23 * 60 * 60 * 1000;
    const nextMessage = variant("direct-message.json", { timestamp: 1790806685342 + 1000 });
    const second = await startTransport(makeConfig(stateDir, { afterSubscribe: [nextMessage] }, { dryRun: true }), {
      onEvent: () => {},
      log: () => {},
      now: () => now,
    });
    await Bun.sleep(100);
    expect(dryRunSends(stateDir).length).toBe(1);
    await second.stop();

    // 25 hours after the first line: a new one is due.
    now += 2 * 60 * 60 * 1000;
    const laterMessage = variant("direct-message.json", { timestamp: 1790806685342 + 2000 });
    const third = await startTransport(makeConfig(stateDir, { afterSubscribe: [laterMessage] }, { dryRun: true }), {
      onEvent: () => {},
      log: () => {},
      now: () => now,
    });
    running.push(third);
    await waitFor(() => dryRunSends(stateDir).length === 2);
  });

  test("a direct message from a stranger gets nothing", async () => {
    const stateDir = makeStateDir();
    const transport = await startTransport(
      makeConfig(stateDir, { afterSubscribe: [variant("direct-message.json", { source: STRANGER_ID })] }, { dryRun: true }),
      { onEvent: () => {}, log: () => {} },
    );
    running.push(transport);
    await Bun.sleep(100);
    expect(dryRunSends(stateDir)).toEqual([]);
  });
});

describe("attachment-only messages", () => {
  test("a photo with no text from an adult gets one fixed line in the group (dry-run log)", async () => {
    const stateDir = makeStateDir();
    const transport = await startTransport(
      makeConfig(stateDir, { afterSubscribe: ["group-attachment-only.json"] }, { dryRun: true }),
      { onEvent: () => {}, log: () => {} },
    );
    running.push(transport);
    await waitFor(() => dryRunSends(stateDir).length === 1);
    await Bun.sleep(100);
    const sends = dryRunSends(stateDir);
    expect(sends.length).toBe(1);
    expect(sends[0].target).toEqual({ conversation: GROUP_ID });
    expect(sends[0].text).toBe(ATTACHMENT_ONLY_LINE);
  });

  test("the fixed-line message is marked handled, so a restart does not send it again", async () => {
    const stateDir = makeStateDir();
    const first = await startTransport(
      makeConfig(stateDir, { afterSubscribe: ["group-attachment-only.json"] }, { dryRun: true }),
      { onEvent: () => {}, log: () => {} },
    );
    await waitFor(() => dryRunSends(stateDir).length === 1);
    await first.stop();

    const second = await startTransport(makeConfig(stateDir, {}, { dryRun: true }), { onEvent: () => {}, log: () => {} });
    running.push(second);
    await Bun.sleep(100);
    expect(dryRunSends(stateDir).length).toBe(1);
  });
});
