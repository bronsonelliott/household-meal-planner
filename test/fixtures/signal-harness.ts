// Shared setup for the Signal adapter tests: a temp state directory, a config that points at the
// fake signal-cli, a start-up helper that wires the Signal adapter into the shared messenger, and
// readers for what happened.
//
// The IDs are the fixed fakes from test/fixtures/envelopes/README.md.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMode, Member } from "../../src/config.ts";
import { startMessenger, StartupError, type Messenger, type MessengerOptions } from "../../src/messaging/messenger.ts";
import { SignalAdapter } from "../../src/messaging/signal/adapter.ts";
import type { SignalAdapterConfig } from "../../src/messaging/signal/settings.ts";
import type { FakeScenario } from "./fake-signal-cli.ts";

export { StartupError };
export type Transport = Messenger;

export const ADULT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
export const STRANGER_ID = "cccccccc-0000-4000-8000-00000000000c";
export const BOT_MEMBER_ID = "bbbbbbbb-0000-4000-8000-0000000000b0";
export const BOT_NUMBER = "+15555550123";
export const GROUP_ID = "VEVTVC1HUk9VUC1GSVhUVVJFLTAwMDAwMDAwMDAwMDA=";

export const FAKE_SIGNAL_CLI = join(import.meta.dir, "fake-signal-cli.ts");
export const RUN_MESSENGER = join(import.meta.dir, "run-messenger.ts");
const ENVELOPES_DIR = join(import.meta.dir, "envelopes");

export interface AccessFileShape {
  botNumber: string;
  groupId: string;
  allowlist: Array<{ name: string; accountId: string }>;
}

export const DEFAULT_ACCESS: AccessFileShape = {
  botNumber: BOT_NUMBER,
  groupId: GROUP_ID,
  allowlist: [{ name: "Adult One", accountId: ADULT_ID }],
};

// Who the bot listens to now travels in the config, not in a file. A test says it once, when it
// makes its state directory; makeConfig picks it up from here. (Pass null for an empty setup.)
const accessByStateDir = new Map<string, AccessFileShape | null>();

// A fresh state directory, remembering the access settings the test's config should carry.
export function makeStateDir(access: AccessFileShape | null = DEFAULT_ACCESS): string {
  const stateDir = mkdtempSync(join(tmpdir(), "hmp-signal-"));
  accessByStateDir.set(stateDir, access);
  return stateDir;
}

// Everything a test chooses about one start: the household, the shared messenger's settings, and
// the Signal adapter's settings.
export interface TestConfig {
  stateDir: string;
  mode: ConversationMode;
  members: Member[];
  dryRun: boolean;
  retryDelaysMs: number[];
  healthIntervalMs: number;
  signal: SignalAdapterConfig;
}

// A member's configured ID is made from their name: "Adult One" is "adult-one".
export function memberId(name: string): string {
  return name.toLowerCase().replace(/ /g, "-");
}

export interface ConfigOverrides {
  dryRun?: boolean;
  javaHome?: string;
  rpcTimeoutMs?: number;
  settleMs?: number;
  mode?: ConversationMode;
  access?: AccessFileShape;
}

// A config that runs the fake signal-cli with `scenario`, logging to <stateDir>/fake-log.jsonl.
export function makeConfig(stateDir: string, scenario: FakeScenario = {}, overrides: ConfigOverrides = {}): TestConfig {
  const scenarioPath = join(stateDir, `scenario-${Date.now()}-${Math.random()}.json`);
  writeFileSync(scenarioPath, JSON.stringify({ log: join(stateDir, "fake-log.jsonl"), ...scenario }));
  const access = overrides.access ?? accessByStateDir.get(stateDir) ?? { botNumber: "", groupId: "", allowlist: [] };
  const mode = overrides.mode ?? "group";
  const members: Member[] = access.allowlist.map((adult) => ({
    id: memberId(adult.name),
    name: adult.name,
    role: "adult" as const,
    identities: { signal: adult.accountId },
  }));
  return {
    stateDir,
    mode,
    members,
    dryRun: overrides.dryRun ?? false,
    retryDelaysMs: [60_000, 300_000, 900_000],
    healthIntervalMs: 60 * 60 * 1000,
    signal: {
      botNumber: access.botNumber,
      groupId: mode === "group" ? access.groupId : null,
      mode,
      members: members.map((member) => ({ id: member.id, name: member.name, accountId: member.identities.signal! })),
      signalCliCommand: [process.execPath, FAKE_SIGNAL_CLI, "--scenario", scenarioPath],
      signalDataDir: join(stateDir, "signal-cli"),
      javaHome: overrides.javaHome ?? "/opt/homebrew/opt/openjdk",
      rpcTimeoutMs: overrides.rpcTimeoutMs ?? 2000,
      settleMs: overrides.settleMs ?? 150,
    },
  };
}

// The test's own settings plus the shared messenger's callbacks.
export type StartOptions = Partial<Omit<MessengerOptions, "mode" | "members" | "stateDir" | "dryRun">> & {
  onEvent?: MessengerOptions["onEvent"];
};

// Starts the Signal adapter inside the shared messenger, the way bridge.ts does.
export async function startTransport(config: TestConfig, options: StartOptions = {}): Promise<Transport> {
  return startMessenger(new SignalAdapter(config.signal), {
    mode: config.mode,
    members: config.members,
    stateDir: config.stateDir,
    dryRun: config.dryRun,
    retryDelaysMs: config.retryDelaysMs,
    healthIntervalMs: config.healthIntervalMs,
    onEvent: () => {},
    log: () => {},
    ...options,
  });
}

export function readJsonLines(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

// What the fake signal-cli saw: its launch record and every request, per start.
export function fakeLog(stateDir: string) {
  const lines = readJsonLines(join(stateDir, "fake-log.jsonl"));
  return {
    launches: lines.filter((line) => "argv" in line),
    requests: lines.filter((line) => "request" in line).map((line) => line.request),
  };
}

export function sendRequests(stateDir: string): any[] {
  return fakeLog(stateDir).requests.filter((request) => request.method === "send");
}

export function readFixture(name: string): any {
  return JSON.parse(readFileSync(join(ENVELOPES_DIR, name), "utf8"));
}

// A copy of a captured notification with a different sender and/or timestamp.
export function variant(fixtureName: string, changes: { source?: string; timestamp?: number }): any {
  const notification = readFixture(fixtureName);
  const envelope = notification.params.result.envelope;
  if (changes.source) {
    envelope.source = changes.source;
    envelope.sourceUuid = changes.source;
    envelope.sourceName = "Someone Else";
  }
  if (changes.timestamp) {
    envelope.timestamp = changes.timestamp;
    if (envelope.dataMessage) envelope.dataMessage.timestamp = changes.timestamp;
  }
  return notification;
}

// A receive notification wrapped the way manual receive mode wraps it.
export function receiveNotification(envelope: object): object {
  return {
    jsonrpc: "2.0",
    method: "receive",
    params: { subscription: 0, result: { envelope, account: BOT_NUMBER } },
  };
}

export async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await Bun.sleep(10);
  }
}

// Runs the stand-in bridge (run-messenger.ts) as its own process and waits for it to end.
export async function runStandInBridge(config: TestConfig, maxMs = 5000) {
  const configPath = join(config.stateDir, "stand-in-config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const child = Bun.spawn([process.execPath, RUN_MESSENGER, configPath], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), maxMs);
  const exitCode = await child.exited;
  clearTimeout(timer);
  return {
    exitCode,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}
