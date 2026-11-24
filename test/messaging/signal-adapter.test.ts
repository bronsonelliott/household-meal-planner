// Tests for the client: launching signal-cli, the start-up sequence, the lock file, health,
// child exit.

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_DIR } from "../../src/config.ts";
import { createAdapter } from "../../src/messaging/index.ts";
import { startMessenger } from "../../src/messaging/messenger.ts";
import { signalAdapterConfig } from "../../src/messaging/signal/settings.ts";
import type { HealthResult } from "../../src/messaging/types.ts";
import {
  BOT_NUMBER,
  DEFAULT_ACCESS,
  FAKE_SIGNAL_CLI,
  fakeLog,
  makeConfig,
  makeStateDir,
  readJsonLines,
  runStandInBridge,
  sendRequests,
  startTransport,
  StartupError,
  waitFor,
  type Transport,
} from "../fixtures/signal-harness.ts";
import { exampleConfig } from "../fixtures/config-fixtures.ts";

const running: Transport[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
});

async function start(config: Parameters<typeof startTransport>[0], options: Partial<Parameters<typeof startTransport>[1]> = {}) {
  const transport = await startTransport(config, { onEvent: () => {}, log: () => {}, ...options });
  running.push(transport);
  return transport;
}

describe("launching signal-cli", () => {
  test("launch arguments include manual receive, always-trust, the data folder, the bot number, and JAVA_HOME", async () => {
    const stateDir = makeStateDir();
    const config = makeConfig(stateDir, {}, { javaHome: "/test/java-home" });
    await start(config);

    const [launch] = fakeLog(stateDir).launches;
    const args: string[] = launch.argv.slice(2); // drop "--scenario <file>"
    expect(args).toEqual([
      "--config",
      join(stateDir, "signal-cli"),
      "-a",
      BOT_NUMBER,
      "--trust-new-identities",
      "always",
      "jsonRpc",
      "--receive-mode",
      "manual",
      "--ignore-attachments",
      "--ignore-stories",
      "--ignore-avatars",
      "--ignore-stickers",
    ]);
    expect(launch.javaHome).toBe("/test/java-home");
  });

  test("a dry-run start logs the subscribe and sends nothing to signal-cli", async () => {
    const stateDir = makeStateDir();
    const config = makeConfig(stateDir, { afterSubscribe: ["group-attachment-only.json"] }, { dryRun: true });
    const logLines: string[] = [];
    await start(config, { log: (line) => logLines.push(line) });

    // The attachment-only message triggers a fixed line, which dry-run only records.
    await waitFor(() => readJsonLines(join(stateDir, "dry-run-sends.jsonl")).length === 1);
    expect(logLines.some((line) => line.includes("subscribed"))).toBe(true);
    expect(sendRequests(stateDir)).toEqual([]);
  });

  test("subscribe comes before the group check (listGroups)", async () => {
    const stateDir = makeStateDir();
    await start(makeConfig(stateDir));
    const methods = fakeLog(stateDir).requests.map((request) => request.method);
    expect(methods.indexOf("subscribeReceive")).toBeLessThan(methods.indexOf("listGroups"));
  });
});

describe("the adapter's settings come from config.toml", () => {
  test("the example config maps to the signal-cli launch settings", () => {
    const app = exampleConfig();
    const config = signalAdapterConfig(app, {});
    expect(app.paths.stateDir).toBe(join(REPO_DIR, "state"));
    expect(config.signalDataDir).toBe(join(REPO_DIR, "state", "signal-cli"));
    expect(config.signalCliCommand).toEqual([join(REPO_DIR, "vendor", "signal-cli", "bin", "signal-cli")]);
    expect(config.javaHome).toBe(""); // not set: signal-cli uses the machine's own Java
    expect(app.dryRun).toBe(false);
    expect(config.botNumber).toBe("+15555550123");
    expect(config.members.map((member) => member.name)).toEqual(["Alex", "Sam"]);
    expect(config.members.map((member) => member.id)).toEqual(["alex", "sam"]);
  });

  test("HMP_* variables override the file, and a dry-run start runs against the fake signal-cli", async () => {
    const stateDir = makeStateDir();
    const app = exampleConfig({ HMP_STATE_DIR: stateDir, HMP_DRY_RUN: "1" });
    // The one adult and group the fake signal-cli knows about.
    app.members = [{ id: "adult-one", name: "Adult One", role: "admin", identities: { signal: DEFAULT_ACCESS.allowlist[0]!.accountId } }];
    app.messaging.signal.groupId = DEFAULT_ACCESS.groupId;
    app.messaging.signal.cliPath = FAKE_SIGNAL_CLI; // no scenario: the fake answers from the captures

    const adapterConfig = signalAdapterConfig(app, { HMP_SETTLE_MS: "50" });
    expect(app.paths.stateDir).toBe(stateDir);
    expect(app.dryRun).toBe(true);
    expect(adapterConfig.signalCliCommand).toEqual([process.execPath, FAKE_SIGNAL_CLI]);
    const logLines: string[] = [];
    const messenger = await startMessenger(createAdapter(app, { HMP_SETTLE_MS: "50" }), {
      mode: app.messaging.mode,
      members: app.members,
      stateDir: app.paths.stateDir,
      dryRun: app.dryRun,
      onEvent: () => {},
      log: (line) => logLines.push(line),
    });
    running.push(messenger);
    expect(logLines.some((line) => line.includes("subscribed"))).toBe(true);
    expect((await messenger.sendToConversation("hello")).kind).toBe("sent");
    expect(readJsonLines(join(stateDir, "dry-run-sends.jsonl")).length).toBe(1);
  });

  test("a platform other than signal has no Signal adapter", () => {
    const app = exampleConfig();
    app.messaging.platform = "imessage";
    expect(() => signalAdapterConfig(app, {})).toThrow(/not signal/);
  });
});

describe("start-up refusals", () => {
  test("an empty allowlist exits non-zero with a clear message, before signal-cli starts", async () => {
    const stateDir = makeStateDir({ ...DEFAULT_ACCESS, allowlist: [] });
    const result = await runStandInBridge(makeConfig(stateDir));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("allowlist is empty");
    expect(fakeLog(stateDir).launches).toEqual([]);
  });

  test("a config with no bot number is refused, naming the setting", async () => {
    const stateDir = makeStateDir();
    const attempt = startTransport(makeConfig(stateDir, {}, { access: { ...DEFAULT_ACCESS, botNumber: "" } }), { onEvent: () => {}, log: () => {} });
    await expect(attempt).rejects.toThrow(StartupError);
    await expect(attempt).rejects.toThrow("messaging.signal.botNumber");
  });
});

describe("one bridge per account (lock file)", () => {
  test("a second start while the first holds the lock is refused, and the stand-in bridge exits non-zero", async () => {
    const stateDir = makeStateDir();
    await start(makeConfig(stateDir));

    await expect(startTransport(makeConfig(stateDir), { onEvent: () => {}, log: () => {} })).rejects.toThrow(
      /another bridge/i,
    );

    const result = await runStandInBridge(makeConfig(stateDir));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/another bridge/i);
    // Only the first start ever launched signal-cli.
    expect(fakeLog(stateDir).launches.length).toBe(1);
  });

  test("a stale lock file (its process is gone) is cleared and the start goes ahead", async () => {
    const stateDir = makeStateDir();
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    writeFileSync(join(stateDir, "bridge.lock"), String(gone.pid));

    await start(makeConfig(stateDir));
    expect(readFileSync(join(stateDir, "bridge.lock"), "utf8").trim()).toBe(String(process.pid));
  });

  test("a lock written before the last boot is stale even if its PID is alive again", async () => {
    // After a reboot the old PID can belong to an unrelated process.
    const stateDir = makeStateDir();
    const lockPath = join(stateDir, "bridge.lock");
    writeFileSync(lockPath, "1"); // launchd's PID: always alive
    const longAgo = new Date("2020-01-01T00:00:00Z");
    utimesSync(lockPath, longAgo, longAgo);

    await start(makeConfig(stateDir));
    expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
  });

  test("stopping releases the lock so the next start works", async () => {
    const stateDir = makeStateDir();
    const first = await startTransport(makeConfig(stateDir), { onEvent: () => {}, log: () => {} });
    await first.stop();
    await start(makeConfig(stateDir));
    expect(fakeLog(stateDir).launches.length).toBe(2);
  });
});

describe("signal-cli exiting", () => {
  test("the fake signal-cli exiting makes the stand-in bridge exit non-zero", async () => {
    const stateDir = makeStateDir();
    const result = await runStandInBridge(makeConfig(stateDir, { exitAfterSubscribeMs: 400 }, { settleMs: 50 }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/signal-cli exited/);
  });

  test("the messenger reports the child's exit code", async () => {
    const stateDir = makeStateDir();
    const exits: string[] = [];
    await start(makeConfig(stateDir, { exitAfterSubscribeMs: 400 }, { settleMs: 50 }), {
      onFatal: (reason) => exits.push(reason),
    });
    await waitFor(() => exits.length === 1);
    expect(exits[0]).toContain("signal-cli exited (code 3)");
  });
});

describe("health", () => {
  test("a registered bot is healthy, checked once at start-up", async () => {
    const stateDir = makeStateDir();
    const reports: HealthResult[] = [];
    const transport = await start(makeConfig(stateDir), { onHealth: (result) => reports.push(result) });
    await waitFor(() => reports.length === 1);
    expect(reports[0].healthy).toBe(true);
    expect((await transport.checkHealth()).healthy).toBe(true);

    const statusCall = fakeLog(stateDir).requests.find((request) => request.method === "getUserStatus");
    expect(statusCall.params).toEqual({ recipient: [BOT_NUMBER] });
  });

  test("a health call that Signal's server answers as not registered reports unhealthy", async () => {
    const stateDir = makeStateDir();
    const reports: HealthResult[] = [];
    await start(makeConfig(stateDir, { getUserStatus: { fixture: "rpc-getUserStatus-unregistered-response.json" } }), {
      onHealth: (result) => reports.push(result),
    });
    await waitFor(() => reports.length === 1);
    expect(reports[0].healthy).toBe(false);
  });

  test("a health call answered with an error reports unhealthy", async () => {
    const stateDir = makeStateDir();
    const transport = await start(
      makeConfig(stateDir, { getUserStatus: { error: { code: -3, message: "Network failure" } } }),
    );
    const result = await transport.checkHealth();
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain("Network failure");
  });

  test("a receive notification carrying an error reports unhealthy until a clean envelope arrives", async () => {
    const stateDir = makeStateDir();
    // Shape from signal-cli 0.14.8's JsonReceiveMessageHandler (account, exception, envelope).
    const receiveError = {
      jsonrpc: "2.0",
      method: "receive",
      params: {
        subscription: 0,
        result: { account: BOT_NUMBER, exception: { message: "Connection closed", type: "ConnectionClosedException" } },
      },
    };
    const transport = await start(makeConfig(stateDir, { afterSubscribe: [receiveError] }));
    const unhealthy = await transport.checkHealth();
    expect(unhealthy.healthy).toBe(false);
    expect(unhealthy.reason).toContain("Connection closed");
  });

  test("a later clean envelope clears the receive error", async () => {
    const stateDir = makeStateDir();
    const receiveError = {
      jsonrpc: "2.0",
      method: "receive",
      params: { subscription: 0, result: { account: BOT_NUMBER, exception: { message: "boom", type: "X" } } },
    };
    const transport = await start(makeConfig(stateDir, { afterSubscribe: [receiveError, "receipt-delivery.json"] }));
    expect((await transport.checkHealth()).healthy).toBe(true);
  });
});

