// The Telegram adapter's own settings, derived from the household config.

import { cleanCredential } from "../../secrets.ts";
import { numberFromEnv, StartupError, type AppConfig, type ConversationMode } from "../../config.ts";

type Env = Record<string, string | undefined>;

export interface TelegramMember {
  id: string;
  name: string;
  userId: string; // the numeric Telegram user ID, as text
}

export interface TelegramAdapterConfig {
  token: string; // from the environment variable named in the config; never logged
  // The household group's chat ID (a negative number) in group mode; null in household-dms mode.
  chatId: string | null;
  mode: ConversationMode;
  members: TelegramMember[];
  // Where the Bot API lives. Tests point this at a loopback fake.
  apiBaseUrl: string;
  stateDir: string;
  // How long Telegram may hold a getUpdates call open waiting for news (seconds).
  pollTimeoutSec: number;
  // How long any one other call may take before we call it unknown (milliseconds).
  requestTimeoutMs: number;
  // Waits between failed polls, shortest first; the last one repeats.
  pollRetryDelaysMs: number[];
  // Dry run: the client refuses every request that would send something.
  dryRun?: boolean;
}

export const DEFAULT_API_BASE_URL = "https://api.telegram.org";

export function telegramAdapterConfig(config: AppConfig, env: Env = process.env): TelegramAdapterConfig {
  if (config.messaging.platform !== "telegram") {
    throw new StartupError(`messaging.platform is "${config.messaging.platform}", not telegram, so there is no Telegram adapter to start.`);
  }
  const telegram = config.messaging.telegram;
  return {
    token: cleanCredential(env[telegram.botTokenEnv]),
    chatId: config.messaging.mode === "group" ? (telegram.chatId ?? "") : null,
    mode: config.messaging.mode,
    members: config.members.map((member) => ({ id: member.id, name: member.name, userId: member.identities.telegram ?? "" })),
    apiBaseUrl: env.HMP_TELEGRAM_API_URL || DEFAULT_API_BASE_URL,
    stateDir: config.paths.stateDir,
    pollTimeoutSec: numberFromEnv(env, "HMP_TELEGRAM_POLL_TIMEOUT_S", 30),
    requestTimeoutMs: numberFromEnv(env, "HMP_RPC_TIMEOUT_MS", 30_000),
    pollRetryDelaysMs: [1_000, 2_000, 5_000, 15_000, 30_000],
    dryRun: config.dryRun,
  };
}
