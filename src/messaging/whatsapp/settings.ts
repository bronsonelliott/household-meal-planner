// The WhatsApp adapter's own settings, derived from the household config.

import { cleanCredential } from "../../secrets.ts";
import { numberFromEnv, StartupError, type AppConfig } from "../../config.ts";

type Env = Record<string, string | undefined>;

export interface WhatsAppMember {
  id: string;
  name: string;
  waId: string; // the person's WhatsApp number, digits only ("15551234567")
}

export interface WhatsAppAdapterConfig {
  phoneNumberId: string;
  apiVersion: string;
  // Secrets, read from the environment variables the config names. Never logged.
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  members: WhatsAppMember[];
  // Where the Graph API lives. Tests point this at a loopback fake.
  apiBaseUrl: string;
  webhook: { host: string; port: number; path: string };
  // The approved message template for people outside the 24-hour window; null when none is set.
  template: { name: string; language: string } | null;
  stateDir: string;
  // How long any one call may take before we call it unknown (milliseconds).
  requestTimeoutMs: number;
  // A clock tests can move. The 24-hour window is measured with it.
  now?: () => number;
  // Dry run: the client refuses every request that would send something.
  dryRun?: boolean;
}

export const DEFAULT_API_BASE_URL = "https://graph.facebook.com";

export function whatsappAdapterConfig(config: AppConfig, env: Env = process.env): WhatsAppAdapterConfig {
  if (config.messaging.platform !== "whatsapp") {
    throw new StartupError(`messaging.platform is "${config.messaging.platform}", not whatsapp, so there is no WhatsApp adapter to start.`);
  }
  const whatsapp = config.messaging.whatsapp;
  return {
    phoneNumberId: whatsapp.phoneNumberId ?? "",
    apiVersion: whatsapp.apiVersion,
    accessToken: cleanCredential(env[whatsapp.accessTokenEnv]),
    appSecret: cleanCredential(env[whatsapp.appSecretEnv]),
    verifyToken: cleanCredential(env[whatsapp.verifyTokenEnv]),
    members: config.members.map((member) => ({ id: member.id, name: member.name, waId: member.identities.whatsapp ?? "" })),
    apiBaseUrl: env.HMP_WHATSAPP_API_URL || DEFAULT_API_BASE_URL,
    webhook: whatsapp.webhook,
    template: whatsapp.template,
    stateDir: config.paths.stateDir,
    requestTimeoutMs: numberFromEnv(env, "HMP_RPC_TIMEOUT_MS", 30_000),
    dryRun: config.dryRun,
  };
}
