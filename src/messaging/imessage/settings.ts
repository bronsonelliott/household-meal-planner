// The iMessage adapter's own settings, derived from the household config.

import { cleanCredential } from "../../secrets.ts";
import { numberFromEnv, StartupError, type AppConfig, type ConversationMode } from "../../config.ts";
import { normalizeHandle } from "./normalize.ts";

type Env = Record<string, string | undefined>;

export interface IMessageMember {
  id: string;
  name: string;
  handle: string; // the person's canonical iMessage handle: "+15551234567" or a lowercase email
}

export interface IMessageAdapterConfig {
  serverUrl: string; // the BlueBubbles server, no password in it
  password: string; // from the environment variable the config names; never logged
  mode: ConversationMode;
  chatGuid: string | null; // the household group chat in group mode; null in household-dms mode
  sendMethod: "apple-script" | "private-api";
  pollIntervalMs: number;
  allowSms: boolean;
  botName: string; // a message that says this name (as a word) counts as speaking to the bot
  members: IMessageMember[];
  stateDir: string;
  // How long any one call may take before we call it unknown (milliseconds).
  requestTimeoutMs: number;
  // How far back the very first poll looks, and how far back every poll re-reads (milliseconds).
  // Tests shorten these; the defaults are in the adapter.
  firstRunLookbackMs?: number;
  overlapMs?: number;
  // A clock tests can move.
  now?: () => number;
  // Dry run: the client refuses every request that would send something.
  dryRun?: boolean;
}

export function imessageAdapterConfig(config: AppConfig, env: Env = process.env): IMessageAdapterConfig {
  if (config.messaging.platform !== "imessage") {
    throw new StartupError(`messaging.platform is "${config.messaging.platform}", not imessage, so there is no iMessage adapter to start.`);
  }
  const imessage = config.messaging.imessage;
  const mode = config.messaging.mode;
  return {
    serverUrl: env.HMP_BLUEBUBBLES_URL || imessage.serverUrl || "",
    password: cleanCredential(env[imessage.passwordEnv]),
    mode,
    chatGuid: mode === "group" ? (imessage.chatGuid ?? "") : null,
    sendMethod: imessage.sendMethod,
    pollIntervalMs: numberFromEnv(env, "HMP_IMESSAGE_POLL_MS", imessage.pollIntervalSeconds * 1000),
    allowSms: imessage.allowSms,
    botName: config.household.botName,
    members: config.members.map((member) => ({ id: member.id, name: member.name, handle: normalizeHandle(member.identities.imessage ?? "") })),
    stateDir: config.paths.stateDir,
    requestTimeoutMs: numberFromEnv(env, "HMP_RPC_TIMEOUT_MS", 30_000),
    dryRun: config.dryRun,
  };
}
