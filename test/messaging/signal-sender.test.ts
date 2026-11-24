// Tests for the sender: every send is sorted Sent / Partial / Failed / Unknown by signal-cli's
// per-recipient results, only Failed is retried (1, 5, 15 minutes), and each
// failure class lands in the state directory for the checker.

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { FakeScenario } from "../fixtures/fake-signal-cli.ts";
import {
  ADULT_ID,
  GROUP_ID,
  STRANGER_ID,
  makeConfig,
  makeStateDir,
  readJsonLines,
  sendRequests,
  startTransport,
  waitFor,
  type ConfigOverrides,
  type Transport,
} from "../fixtures/signal-harness.ts";

const running: Transport[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
});

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000]; // 1, 5, 15 minutes

function result(type: string, uuid: string, extra: object = {}) {
  return { recipientAddress: { uuid, number: null, username: null }, groupId: GROUP_ID, type, ...extra };
}

async function startWith(scenario: FakeScenario, overrides: ConfigOverrides = {}) {
  const stateDir = makeStateDir();
  const sleeps: number[] = [];
  const logLines: string[] = [];
  const transport = await startTransport(makeConfig(stateDir, scenario, overrides), {
    onEvent: () => {},
    log: (line) => logLines.push(line),
    // Retries wait on this instead of real minutes.
    sleep: async (ms) => void sleeps.push(ms),
  });
  running.push(transport);
  return { stateDir, transport, sleeps, logLines };
}

function failures(stateDir: string) {
  return readJsonLines(join(stateDir, "send-failures.jsonl"));
}

describe("dry run", () => {
  test("records the group ID and text, and the fake signal-cli receives no send call", async () => {
    const { stateDir, transport } = await startWith({}, { dryRun: true });
    const outcome = await transport.sendToConversation("Monday: tacos");
    expect(outcome.kind).toBe("sent");
    expect(readJsonLines(join(stateDir, "dry-run-sends.jsonl")).map(({ target, text }) => ({ target, text }))).toEqual([
      { target: { conversation: GROUP_ID }, text: "Monday: tacos" },
    ]);
    expect(sendRequests(stateDir)).toEqual([]);
  });
});

describe("Sent", () => {
  test("every member's result is success: Sent, with signal-cli's timestamp", async () => {
    const { stateDir, transport } = await startWith({});
    const outcome = await transport.sendToConversation("Monday: tacos");
    expect(outcome).toMatchObject({ kind: "sent", timestamp: 1790806738638 });
    expect(sendRequests(stateDir).map((request) => request.params)).toEqual([
      { groupId: GROUP_ID, message: "Monday: tacos" },
    ]);
    expect(failures(stateDir)).toEqual([]);
  });

  test("a direct send addresses the account ID", async () => {
    const { stateDir, transport } = await startWith({});
    await transport.sendToMember("adult-one", "hi");
    expect(sendRequests(stateDir)[0].params).toEqual({ recipient: [ADULT_ID], message: "hi" });
  });
});

describe("Partial", () => {
  test("a failed member returns Partial, is never re-sent, and writes a failure class naming that member", async () => {
    const { stateDir, transport, sleeps } = await startWith({
      send: [{ result: { timestamp: 42, results: [result("SUCCESS", ADULT_ID), result("UNREGISTERED_FAILURE", STRANGER_ID)] } }],
    });
    const outcome = await transport.sendToConversation("Monday: tacos");
    expect(outcome.kind).toBe("partial");
    expect(sendRequests(stateDir).length).toBe(1);
    expect(sleeps).toEqual([]);

    const [failure] = failures(stateDir);
    expect(failure.outcome).toBe("partial");
    expect(failure.failedMembers).toEqual([{ member: STRANGER_ID, type: "UNREGISTERED_FAILURE" }]);
  });
});

describe("Failed", () => {
  const ioError = { error: { code: -3, message: "Failed to send message: IO error" } };

  test("an error response is retried at 1, 5, and 15 minutes, then the failure class is written", async () => {
    const { stateDir, transport, sleeps, logLines } = await startWith({ send: [ioError] });
    const outcome = await transport.sendToConversation("Monday: tacos");
    expect(outcome.kind).toBe("failed");
    expect(sleeps).toEqual(RETRY_DELAYS_MS);
    expect(sendRequests(stateDir).length).toBe(4);

    const [failure] = failures(stateDir);
    expect(failure.outcome).toBe("failed");
    expect(failure.detail).toContain("IO error");
    expect(logLines.some((line) => line.includes("undelivered") && line.includes("Monday: tacos"))).toBe(true);
  });

  test("a retry that goes through returns Sent and writes no failure", async () => {
    const { stateDir, transport, sleeps } = await startWith({
      send: [ioError, { fixture: "rpc-send-group-success-response.json" }],
    });
    const outcome = await transport.sendToConversation("Monday: tacos");
    expect(outcome.kind).toBe("sent");
    expect(sleeps).toEqual([60_000]);
    expect(failures(stateDir)).toEqual([]);
  });

  test("a group send where no member got it counts as Failed", async () => {
    const { transport } = await startWith({
      send: [{ result: { timestamp: 42, results: [result("NETWORK_FAILURE", ADULT_ID)] } }],
    });
    expect((await transport.sendToConversation("x")).kind).toBe("failed");
  });

  test("after the retries the inbound message is marked handled, the reply logged undelivered, and nothing more is posted", async () => {
    // The attachment-only fixed line is a reply the transport sends itself.
    const { stateDir, logLines } = await startWith({ send: [ioError], afterSubscribe: ["group-attachment-only.json"] });
    const inboundId = `signal/${GROUP_ID}/${ADULT_ID}:1790806602925`;
    const journal = () => readJsonLines(join(stateDir, "inbox.jsonl"));
    await waitFor(() => journal().some((line) => line.type === "handled" && line.id === inboundId));

    expect(sendRequests(stateDir).length).toBe(4);
    expect(failures(stateDir).length).toBe(1);
    expect(logLines.some((line) => line.includes("undelivered"))).toBe(true);
    await Bun.sleep(100);
    expect(sendRequests(stateDir).length).toBe(4);
  });

  test("a rate-limited group send returns Failed and its failure class carries the token and names the captcha step", async () => {
    const rateLimited = result("RATE_LIMIT_FAILURE", ADULT_ID, { token: "fake-challenge-token", retryAfterSeconds: 86400 });
    const { stateDir, transport } = await startWith({ send: [{ result: { timestamp: 42, results: [rateLimited] } }] });
    const outcome = await transport.sendToConversation("Monday: tacos");
    expect(outcome.kind).toBe("failed");

    const [failure] = failures(stateDir);
    expect(failure.class).toBe("rate-limited");
    expect(failure.token).toBe("fake-challenge-token");
    expect(failure.captchaStep).toContain("submitRateLimitChallenge");
    expect(failure.captchaStep).toContain("fake-challenge-token");
  });

  test("a rate-limit error response (direct send) carries the token from the error data", async () => {
    // signal-cli 0.14.8 answers a direct send that reached nobody with error code -5 and the
    // send results under error.data.response (SignalJsonRpcCommandHandler.getErrorDataNode).
    const rateLimitError = {
      error: {
        code: -5,
        message: "Failed to send message due to rate limiting",
        data: {
          response: {
            timestamp: 42,
            results: [
              { recipientAddress: { uuid: ADULT_ID, number: null, username: null }, groupId: null, type: "RATE_LIMIT_FAILURE", token: "dm-token", retryAfterSeconds: 60 },
            ],
          },
        },
      },
    };
    const { stateDir, transport } = await startWith({ send: [rateLimitError] });
    expect((await transport.sendToMember("adult-one", "hi")).kind).toBe("failed");
    const [failure] = failures(stateDir);
    expect(failure.class).toBe("rate-limited");
    expect(failure.token).toBe("dm-token");
  });
});

describe("Unknown", () => {
  test("no answer within the timeout returns Unknown, is never retried, and writes one failure class", async () => {
    const { stateDir, transport, sleeps } = await startWith({ send: [{ noReply: true }] }, { rpcTimeoutMs: 300 });
    const outcome = await transport.sendToConversation("Monday: tacos");
    expect(outcome.kind).toBe("unknown");
    expect(sleeps).toEqual([]);
    expect(sendRequests(stateDir).length).toBe(1);
    const all = failures(stateDir);
    expect(all.length).toBe(1);
    expect(all[0].outcome).toBe("unknown");
  });

  test("signal-cli dying mid-call returns Unknown", async () => {
    const { stateDir, transport, sleeps } = await startWith({ send: [{ die: true }] });
    const outcome = await transport.sendToConversation("Monday: tacos");
    expect(outcome.kind).toBe("unknown");
    expect(sleeps).toEqual([]);
    expect(failures(stateDir)[0].outcome).toBe("unknown");
  });
});
