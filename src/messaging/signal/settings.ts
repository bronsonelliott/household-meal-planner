// The Signal adapter's own settings, derived from the household config.

import { numberFromEnv, StartupError, type AppConfig, type ConversationMode } from "../../config.ts";
import type { SignalMember } from "./access.ts";

type Env = Record<string, string | undefined>;

export interface SignalAdapterConfig {
  botNumber: string;
  // The household group, for conversation.mode = "group"; null in household-dms mode.
  groupId: string | null;
  mode: ConversationMode;
  members: SignalMember[];
  // The program to run as signal-cli, plus any arguments that come before the launch args.
  // Normally just the signal-cli script; tests point it at the fake signal-cli.
  signalCliCommand: string[];
  // signal-cli's own data folder (the account's keys).
  signalDataDir: string;
  // JAVA_HOME for signal-cli; "" leaves the machine's own Java alone.
  javaHome: string;
  // How long to wait for any one JSON-RPC answer before calling it unknown.
  rpcTimeoutMs: number;
  // After subscribing, how long to let messages arrive before the group check. The check reads
  // signal-cli's local group state, which only updates as messages are received.
  settleMs: number;
  // Dry run: the client refuses every request that would send something.
  dryRun?: boolean;
}

export function signalAdapterConfig(config: AppConfig, env: Env = process.env): SignalAdapterConfig {
  const signal = config.messaging.signal;
  if (config.messaging.platform !== "signal") {
    throw new StartupError(`messaging.platform is "${config.messaging.platform}", not signal, so there is no Signal adapter to start.`);
  }
  // A .ts path means the fake signal-cli (for a dry-run walk), which Bun has to run.
  const signalCliCommand = signal.cliPath.endsWith(".ts") ? [process.execPath, signal.cliPath] : [signal.cliPath];

  return {
    botNumber: signal.botNumber ?? "",
    groupId: config.messaging.mode === "group" ? (signal.groupId ?? "") : null,
    mode: config.messaging.mode,
    members: config.members.map((member) => ({ id: member.id, name: member.name, accountId: member.identities.signal ?? "" })),
    signalCliCommand,
    signalDataDir: signal.dataDir,
    javaHome: signal.javaHome,
    rpcTimeoutMs: numberFromEnv(env, "HMP_RPC_TIMEOUT_MS", 60_000),
    settleMs: numberFromEnv(env, "HMP_SETTLE_MS", 5_000),
    dryRun: config.dryRun,
  };
}
