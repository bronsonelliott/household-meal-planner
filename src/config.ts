// The household's settings: one hand-edited file, config.toml, read once at start-up.
//
// What lives where:
//   config.toml    machine and household settings: who is in the household, when the draft goes
//                  out, which chat app to use, which model to call (this file)
//   profile.md     food: rules, dishes, staples, grocery sections (src/data/profile.ts)
//   environment    secrets only. config.toml names the variable ("ANTHROPIC_API_KEY"); the
//                  value never appears in a file, a log line, or an error message.
//
// Every problem found is collected and reported together, each naming the key it is about
// ("members[1].identities.signal"), so one edit-and-retry fixes them all. Messages say what is
// wrong and never repeat a value that could be a secret.
//
// A few environment variables still override the file, for tests and dry runs:
//   HMP_CONFIG      path to the config file (default ./config.toml)
//   HMP_DRY_RUN     "1" logs would-be sends instead of sending
//   HMP_STATE_DIR   where runtime state lives (journal, lock, markers)
//   HMP_DATA_DIR    where the household's data lives (profile.md, weeks, log)

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { NIGHTS, type Night } from "./data/profile.ts";

export const REPO_DIR = join(import.meta.dir, "..");

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------------------------
// The shape of a valid config
// ---------------------------------------------------------------------------------------------

export const PLATFORMS = ["signal", "telegram", "whatsapp", "imessage"] as const;
export type Platform = (typeof PLATFORMS)[number];

export type MemberRole = "admin" | "adult";

export interface Member {
  id: string; // a short lowercase label, used in logs and files
  name: string; // what people call them in chat
  role: MemberRole;
  // How the chat app knows this person: Signal account ID, Telegram user ID, and so on.
  identities: Partial<Record<Platform, string>>;
}

export interface ScheduleConfig {
  timeZone: string; // an IANA zone such as "America/New_York"
  draftDay: Night;
  draftTime: string; // "HH:MM", 24-hour, in the household's zone
  draftMinutes: number; // the same, as minutes since local midnight
  catchUpDay: Night; // the last moment the bot will still draft a late week
  catchUpTime: string;
  catchUpMinutes: number;
  lateAfterMinutes: number; // a draft posted this long after draftTime is marked "(late)"
}

export interface PlanningConfig {
  weeknights: Night[]; // what "weeknights" means in a house rule
  minDiscoveryNights: number; // nights per week that should be a dish the house has not had lately
}

export interface SignalSettings {
  cliPath: string; // the signal-cli program
  dataDir: string; // signal-cli's own folder (the account's keys)
  javaHome: string; // "" means use the Java already on this machine
  botNumber: string | null; // the bot's own number, "+15551234567"
  groupId: string | null; // the household group, for conversation.mode = "group"
}

export interface TelegramSettings {
  botTokenEnv: string; // NAME of the environment variable holding the bot token
  chatId: string | null; // the household group chat
}

// WhatsApp through Meta's official Cloud API (beta).
export interface WhatsAppSettings {
  phoneNumberId: string | null; // the bot's number, as Meta numbers it (not the phone number itself)
  apiVersion: string; // the Graph API version, like "v23.0"
  // Where the bridge listens for Meta's webhook calls. A tunnel or reverse proxy forwards to it.
  webhook: { host: string; port: number; path: string };
  accessTokenEnv: string; // NAMES of environment variables, never the secrets themselves
  appSecretEnv: string;
  verifyTokenEnv: string;
  // An approved message template, sent to someone who has not written to the bot in 24 hours.
  template: { name: string; language: string } | null;
}

// iMessage through a BlueBubbles server running on a Mac (beta).
export interface IMessageSettings {
  serverUrl: string | null; // the BlueBubbles server, like "http://192.168.1.20:1234"
  passwordEnv: string; // NAME of the environment variable holding the server password
  chatGuid: string | null; // the household group chat, for conversation.mode = "group"
  // How replies are sent. "apple-script" works on a stock Mac; "private-api" also allows reactions
  // but needs BlueBubbles' Private API helper (which needs System Integrity Protection turned off).
  sendMethod: "apple-script" | "private-api";
  pollIntervalSeconds: number; // how often the bot asks the server for new messages
  allowSms: boolean; // also read plain text messages (SMS), not just iMessages
}

export type ConversationMode = "group" | "household-dms";

export interface MessagingConfig {
  platform: Platform;
  mode: ConversationMode;
  signal: SignalSettings;
  telegram: TelegramSettings;
  whatsapp: WhatsAppSettings;
  imessage: IMessageSettings;
}

export interface ModelConfig {
  id: string;
  apiKeyEnv: string; // NAME of the environment variable holding the API key
  timeoutMs: number;
  maxOutputTokens: number;
}

export interface RecipesConfig {
  userAgent: string; // what we call ourselves when asking a website for a page
  pagesPerSourcePerDay: number;
  sitemapsPerSourcePerDay: number;
  secondsBetweenRequests: number; // per website
  refreshHours: number; // how often the recipe APIs are asked again
  providerSecondsBetweenRequests: number; // per API host (they publish APIs for this, so it is shorter)
  themealdb: { apiKeyEnv: string; lookupsPerRefresh: number };
  mealie: SelfHostedConfig | null; // null = not configured
  tandoor: SelfHostedConfig | null;
}

// A recipe manager the household runs itself.
export interface SelfHostedConfig {
  url: string; // no trailing slash
  tokenEnv: string; // NAME of the environment variable holding the API token
  maxRecipes: number;
}

export interface AlertsConfig {
  channel: "none" | "telegram";
  telegramBotTokenEnv: string;
  telegramChatId: string | null;
}

export interface PathsConfig {
  dataDir: string; // absolute
  stateDir: string; // absolute
}

export interface AppConfig {
  household: { name: string; botName: string };
  members: Member[];
  schedule: ScheduleConfig;
  planning: PlanningConfig;
  messaging: MessagingConfig;
  model: ModelConfig;
  recipes: RecipesConfig;
  alerts: AlertsConfig;
  paths: PathsConfig;
  dryRun: boolean;
}

export const DEFAULT_MODEL = "claude-sonnet-5-5";

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

// The config could not be used. `problems` holds one plain sentence per problem.
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[], source = "config.toml") {
    super(`${source} has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

// A start-up check failed. The bridge prints the message and exits non-zero, so the service
// manager restarts it and the message lands in the bridge's log.
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

// ---------------------------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------------------------

export function configPathFrom(env: Env = process.env): string {
  return resolve(env.HMP_CONFIG || "./config.toml");
}

// Reads and checks the config file named by HMP_CONFIG (default ./config.toml).
export function loadConfig(env: Env = process.env): AppConfig {
  const path = configPathFrom(env);
  if (!existsSync(path)) {
    throw new ConfigError([`There is no config file at ${path}. Copy config.example.toml to config.toml and edit it, or point HMP_CONFIG at your file.`]);
  }
  return parseConfig(readFileSync(path, "utf8"), { baseDir: dirname(path), env });
}

export interface ParseOptions {
  baseDir?: string; // relative paths in the file are resolved against this folder
  env?: Env; // for the HMP_* overrides
}

// Parses config text and checks every key. Throws a ConfigError listing all the problems.
export function parseConfig(text: string, options: ParseOptions = {}): AppConfig {
  const baseDir = options.baseDir ?? process.cwd();
  const env = options.env ?? {};

  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (error) {
    // The parser's message names the kind of mistake, not the file's contents.
    throw new ConfigError([`The file is not valid TOML (${(error as Error).message}). Check quotes, brackets and = signs.`]);
  }

  const problems: string[] = [];
  findPlaceholders(raw, "", problems);
  const config = readConfig(raw, baseDir, env, problems);
  if (problems.length > 0 || !config) throw new ConfigError(problems);
  return config;
}

// Any text still shaped like <something> is a template blank nobody filled in.
function findPlaceholders(value: unknown, path: string, problems: string[]): void {
  if (typeof value === "string") {
    if (/<[^<>]*>/.test(value)) problems.push(`${path} still has a placeholder in <angle brackets>. Replace it with your real value.`);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => findPlaceholders(item, `${path}[${i}]`, problems));
  } else if (isTable(value)) {
    for (const [key, item] of Object.entries(value)) findPlaceholders(item, path ? `${path}.${key}` : key, problems);
  }
}

// ---------------------------------------------------------------------------------------------
// Small readers. Each one records a problem and returns a fallback instead of throwing, so one
// run finds every mistake.
// ---------------------------------------------------------------------------------------------

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A table that may be absent. Unknown keys are mistakes (usually typos), so they are named.
function readTable(parent: Table, key: string, path: string, allowed: string[], problems: string[], required = false): Table {
  const value = parent[key];
  const here = path ? `${path}.${key}` : key;
  if (value === undefined) {
    if (required) problems.push(`[${here}] is missing.`);
    return {};
  }
  if (!isTable(value)) {
    problems.push(`${here} must be a [${here}] table.`);
    return {};
  }
  checkKeys(value, allowed, here, problems);
  return value;
}

function checkKeys(table: Table, allowed: string[], path: string, problems: string[]): void {
  for (const key of Object.keys(table)) {
    if (!allowed.includes(key)) problems.push(`${path}.${key} is not a setting I know. Check the spelling (known: ${allowed.join(", ")}).`);
  }
}

// Text in quotes. With a fallback, a missing key quietly uses it; with null, a missing key is a problem.
function readString(table: Table, key: string, path: string, problems: string[], fallback: string | null): string | null {
  const value = table[key];
  const here = `${path}.${key}`;
  if (value === undefined) {
    if (fallback === null) problems.push(`${here} is missing.`);
    return fallback;
  }
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`${here} must be some text in quotes, not empty.`);
    return fallback;
  }
  return value.trim();
}

function readOptionalString(table: Table, key: string, path: string, problems: string[]): string | null {
  if (table[key] === undefined) return null;
  return readString(table, key, path, problems, null);
}

function readInteger(table: Table, key: string, path: string, problems: string[], fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = table[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    problems.push(`${path}.${key} must be a whole number from ${min} to ${max}.`);
    return fallback;
  }
  return value;
}

function readChoice<T extends string>(table: Table, key: string, path: string, choices: readonly T[], problems: string[], fallback: T | null): T | null {
  const value = table[key];
  const here = `${path}.${key}`;
  if (value === undefined) {
    if (fallback === null) problems.push(`${here} is missing. Choose one of: ${choices.join(", ")}.`);
    return fallback;
  }
  const lower = typeof value === "string" ? value.trim().toLowerCase() : "";
  const match = choices.find((choice) => choice === lower);
  if (!match) {
    problems.push(`${here} must be one of: ${choices.join(", ")}.`);
    return fallback;
  }
  return match;
}

// The name of an environment variable, such as ANTHROPIC_API_KEY. If someone pastes the secret
// itself here, the error says so without repeating it.
function readBoolean(table: Table, key: string, path: string, problems: string[], fallback: boolean): boolean {
  const value = table[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    problems.push(`${path}.${key} must be true or false (no quotes).`);
    return fallback;
  }
  return value;
}

function readEnvName(table: Table, key: string, path: string, problems: string[], fallback: string): string {
  const value = table[key];
  const here = `${path}.${key}`;
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    problems.push(`${here} must be the NAME of an environment variable (like ${fallback}), never the secret itself. Put the secret in your environment.`);
    return fallback;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Times and zones
// ---------------------------------------------------------------------------------------------

export function isValidTimeZone(zone: string): boolean {
  if (zone === "UTC") return true;
  if (!zone.includes("/")) return false; // "EST" and "CST6CDT" parse but are not real city zones
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// "16:00" -> 960. Returns null for anything that is not a 24-hour HH:MM.
export function minutesFromTime(time: string): number | null {
  const match = time.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function readTime(table: Table, key: string, path: string, problems: string[], fallback: string): { text: string; minutes: number } {
  const value = readString(table, key, path, problems, fallback)!;
  const minutes = minutesFromTime(value);
  if (minutes === null) {
    problems.push(`${path}.${key} must be a 24-hour time written HH:MM, like 16:00 (got "${value}").`);
    return { text: fallback, minutes: minutesFromTime(fallback)! };
  }
  return { text: value, minutes };
}

// ---------------------------------------------------------------------------------------------
// Identity formats, per chat app
// ---------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = /^\+[0-9]{7,15}$/;

const IDENTITY_RULES: Record<Platform, { test: (value: string) => boolean; hint: string }> = {
  signal: { test: (v) => UUID.test(v), hint: "a Signal account ID (a UUID like 0a1b2c3d-...)" },
  telegram: { test: (v) => /^[0-9]{1,15}$/.test(v), hint: "a numeric Telegram user ID" },
  whatsapp: { test: (v) => /^\+?[0-9]{7,15}$/.test(v), hint: "a phone number with country code, like 15551234567" },
  imessage: { test: (v) => PHONE.test(v) || /^[^\s@]+@[^\s@]+$/.test(v), hint: "a phone number (+15551234567) or an Apple ID email" },
};

// ---------------------------------------------------------------------------------------------
// The whole file
// ---------------------------------------------------------------------------------------------

const TOP_LEVEL_KEYS = ["household", "members", "schedule", "planning", "messaging", "model", "recipes", "alerts", "paths"];
const DEFAULT_WEEKNIGHTS: Night[] = ["monday", "tuesday", "wednesday", "thursday"];

function readConfig(raw: unknown, baseDir: string, env: Env, problems: string[]): AppConfig | null {
  if (!isTable(raw)) {
    problems.push("The file is empty.");
    return null;
  }
  checkKeys(raw, TOP_LEVEL_KEYS, "(top level)", problems);

  const household = readHousehold(raw, problems);
  const paths = readPaths(raw, baseDir, env, problems);
  const messaging = readMessaging(raw, baseDir, paths.stateDir, problems);
  const members = readMembers(raw, messaging.platform, problems);
  const schedule = readSchedule(raw, problems);
  const planning = readPlanning(raw, problems);
  const model = readModel(raw, problems);
  const recipes = readRecipes(raw, problems);
  const alerts = readAlerts(raw, problems);

  return { household, members, schedule, planning, messaging, model, recipes, alerts, paths, dryRun: env.HMP_DRY_RUN === "1" };
}

function readHousehold(raw: Table, problems: string[]): AppConfig["household"] {
  const table = readTable(raw, "household", "", ["name", "botName"], problems, true);
  return {
    name: readString(table, "name", "household", problems, null) ?? "",
    botName: readString(table, "botName", "household", problems, "Dinner Bot")!,
  };
}

function readMembers(raw: Table, platform: Platform, problems: string[]): Member[] {
  const list = raw.members;
  if (list === undefined || (Array.isArray(list) && list.length === 0)) {
    problems.push("members is empty. Add at least one [[members]] entry (the admin) so someone is allowed to talk to the bot.");
    return [];
  }
  if (!Array.isArray(list) || !list.every(isTable)) {
    problems.push("members must be a list of [[members]] tables.");
    return [];
  }

  const members: Member[] = [];
  const seenIds = new Map<string, number>();
  const seenNames = new Map<string, number>();
  const seenIdentities = new Map<string, number>(); // "platform:identity" -> index of the member who has it

  list.forEach((entry, index) => {
    const path = `members[${index}]`;
    checkKeys(entry, ["id", "name", "role", "identities"], path, problems);

    const id = readString(entry, "id", path, problems, null);
    const name = readString(entry, "name", path, problems, null);
    const role = readChoice(entry, "role", path, ["admin", "adult"] as const, problems, "adult")!;

    if (id) {
      if (!/^[a-z][a-z0-9-]*$/.test(id)) problems.push(`${path}.id must be lowercase letters, digits and dashes, starting with a letter.`);
      if (seenIds.has(id)) problems.push(`${path}.id is the same as members[${seenIds.get(id)}].id. Each member needs their own.`);
      seenIds.set(id, index);
    }
    if (name) {
      const lower = name.toLowerCase();
      if (seenNames.has(lower)) problems.push(`${path}.name is the same as members[${seenNames.get(lower)}].name. Use names that tell people apart.`);
      seenNames.set(lower, index);
    }

    const identities: Member["identities"] = {};
    const rawIdentities = readTable(entry, "identities", path, [...PLATFORMS], problems);
    for (const chat of PLATFORMS) {
      let value = rawIdentities[chat];
      if (value === undefined) continue;
      const here = `${path}.identities.${chat}`;
      if (typeof value === "number" && Number.isInteger(value)) value = String(value); // a Telegram ID written without quotes
      if (typeof value !== "string" || !IDENTITY_RULES[chat].test(value.trim())) {
        problems.push(`${here} must be ${IDENTITY_RULES[chat].hint}.`);
        continue;
      }
      // WhatsApp knows people by their number with digits only ("15551234567"), so a leading + is dropped.
      // iMessage handles are a phone number or an email; emails are compared in lowercase.
      const clean = chat === "whatsapp" ? value.trim().replace(/^\+/, "") : chat === "imessage" ? value.trim().toLowerCase() : value.trim();
      const key = `${chat}:${clean.toLowerCase()}`;
      if (seenIdentities.has(key)) {
        problems.push(`${here} is the same as members[${seenIdentities.get(key)}].identities.${chat}. Two people cannot share one account.`);
      } else {
        seenIdentities.set(key, index);
      }
      identities[chat] = clean;
    }
    // The bot has to recognise every member on the chat app it actually uses.
    if (identities[platform] === undefined && rawIdentities[platform] === undefined) {
      problems.push(`${path}.identities.${platform} is missing. The bot is set to use ${platform}, so it must know who this person is there.`);
    }

    members.push({ id: id ?? "", name: name ?? "", role, identities });
  });

  if (!members.some((member) => member.role === "admin")) {
    problems.push('No member has role = "admin". Give at least one person the admin role.');
  }
  return members;
}

function readSchedule(raw: Table, problems: string[]): ScheduleConfig {
  const table = readTable(raw, "schedule", "", ["timezone", "draftDay", "draftTime", "catchUpUntil", "lateAfterMinutes"], problems, true);

  const zone = readString(table, "timezone", "schedule", problems, null) ?? "UTC";
  if (table.timezone !== undefined && typeof table.timezone === "string" && !isValidTimeZone(zone)) {
    problems.push(`schedule.timezone "${zone}" is not a time zone I know. Use a city name such as America/New_York or Europe/London.`);
  }

  const draftDay = readChoice(table, "draftDay", "schedule", NIGHTS, problems, "friday")!;
  const draft = readTime(table, "draftTime", "schedule", problems, "16:00");
  const catchUp = readTable(table, "catchUpUntil", "schedule", ["day", "time"], problems);
  const catchUpDay = readChoice(catchUp, "day", "schedule.catchUpUntil", NIGHTS, problems, "sunday")!;
  const catchUpTime = readTime(catchUp, "time", "schedule.catchUpUntil", problems, "12:00");
  const lateAfterMinutes = readInteger(table, "lateAfterMinutes", "schedule", problems, 30, 1, 720);

  // The catch-up deadline has to come after the draft time, within the same Monday-to-Sunday week.
  const draftSlot = NIGHTS.indexOf(draftDay) * 1440 + draft.minutes;
  const catchUpSlot = NIGHTS.indexOf(catchUpDay) * 1440 + catchUpTime.minutes;
  if (catchUpSlot <= draftSlot) {
    problems.push("schedule.catchUpUntil must be later in the week than draftDay and draftTime (weeks run Monday to Sunday).");
  }

  return {
    timeZone: zone,
    draftDay,
    draftTime: draft.text,
    draftMinutes: draft.minutes,
    catchUpDay,
    catchUpTime: catchUpTime.text,
    catchUpMinutes: catchUpTime.minutes,
    lateAfterMinutes,
  };
}

function readPlanning(raw: Table, problems: string[]): PlanningConfig {
  const table = readTable(raw, "planning", "", ["weeknights", "minDiscoveryNights"], problems);

  let weeknights: Night[] = [...DEFAULT_WEEKNIGHTS];
  if (table.weeknights !== undefined) {
    const list = table.weeknights;
    const names = Array.isArray(list) ? list.map((item) => (typeof item === "string" ? item.trim().toLowerCase() : "")) : [];
    const valid = names.length > 0 && names.every((name) => (NIGHTS as readonly string[]).includes(name));
    if (!valid) {
      problems.push('planning.weeknights must be a list of day names, like ["monday", "tuesday"].');
    } else if (new Set(names).size !== names.length) {
      problems.push("planning.weeknights lists the same day twice.");
    } else {
      weeknights = names as Night[];
    }
  }
  return { weeknights, minDiscoveryNights: readInteger(table, "minDiscoveryNights", "planning", problems, 1, 0, 7) };
}

function readMessaging(raw: Table, baseDir: string, stateDir: string, problems: string[]): MessagingConfig {
  const table = readTable(raw, "messaging", "", ["platform", "conversation", "signal", "telegram", "whatsapp", "imessage"], problems, true);
  const platform = readChoice(table, "platform", "messaging", PLATFORMS, problems, null) ?? "signal";

  // WhatsApp's official API cannot post into groups, so its natural default is direct messages.
  const conversation = readTable(table, "conversation", "messaging", ["mode"], problems);
  const mode = readChoice(conversation, "mode", "messaging.conversation", ["group", "household-dms"] as const, problems, platform === "whatsapp" ? "household-dms" : "group")!;

  const signalTable = readTable(table, "signal", "messaging", ["cliPath", "dataDir", "javaHome", "botNumber", "groupId"], problems, platform === "signal");
  const telegramTable = readTable(table, "telegram", "messaging", ["botTokenEnv", "chatId"], problems, platform === "telegram");
  const whatsappTable = readTable(table, "whatsapp", "messaging", ["phoneNumberId", "apiVersion", "webhook", "accessTokenEnv", "appSecretEnv", "verifyTokenEnv", "template"], problems, platform === "whatsapp");
  const imessageTable = readTable(table, "imessage", "messaging", ["serverUrl", "passwordEnv", "chatGuid", "sendMethod", "pollIntervalSeconds", "allowSms"], problems, platform === "imessage");

  const signal: SignalSettings = {
    cliPath: absolute(readString(signalTable, "cliPath", "messaging.signal", problems, join(REPO_DIR, "vendor", "signal-cli", "bin", "signal-cli"))!, baseDir),
    dataDir: absolute(readString(signalTable, "dataDir", "messaging.signal", problems, join(stateDir, "signal-cli"))!, baseDir),
    javaHome: readOptionalString(signalTable, "javaHome", "messaging.signal", problems) ?? "",
    botNumber: readOptionalString(signalTable, "botNumber", "messaging.signal", problems),
    groupId: readOptionalString(signalTable, "groupId", "messaging.signal", problems),
  };
  if (signal.botNumber !== null && !PHONE.test(signal.botNumber)) {
    problems.push("messaging.signal.botNumber must be a phone number with country code, like +15551234567.");
  }
  if (platform === "signal") {
    if (signal.botNumber === null && signalTable.botNumber === undefined) problems.push("messaging.signal.botNumber is missing. It is the bot's own Signal number.");
    if (mode === "group" && signal.groupId === null && signalTable.groupId === undefined) {
      problems.push('messaging.signal.groupId is missing. With conversation.mode = "group" the bot needs the household group\'s ID.');
    }
  }

  if (platform === "telegram" && mode === "group" && telegramTable.chatId === undefined) {
    problems.push('messaging.telegram.chatId is missing. With conversation.mode = "group" the bot needs the household group\'s chat ID.');
  }
  const telegram: TelegramSettings = {
    botTokenEnv: readEnvName(telegramTable, "botTokenEnv", "messaging.telegram", problems, "TELEGRAM_BOT_TOKEN"),
    chatId: readOptionalString(telegramTable, "chatId", "messaging.telegram", problems),
  };
  if (telegram.chatId !== null && !/^-?[0-9]{1,16}$/.test(telegram.chatId)) {
    problems.push('messaging.telegram.chatId must be the chat ID as text in quotes, like "-1001234567890".');
  }
  const webhookTable = readTable(whatsappTable, "webhook", "messaging.whatsapp", ["host", "port", "path"], problems);
  const templateTable = readTable(whatsappTable, "template", "messaging.whatsapp", ["name", "language"], problems);
  const webhookPath = readString(webhookTable, "path", "messaging.whatsapp.webhook", problems, "/whatsapp/webhook")!;
  if (!webhookPath.startsWith("/")) problems.push('messaging.whatsapp.webhook.path must start with a slash, like "/whatsapp/webhook".');
  const apiVersion = readString(whatsappTable, "apiVersion", "messaging.whatsapp", problems, "v23.0")!;
  if (!/^v[0-9]{1,3}\.[0-9]$/.test(apiVersion)) problems.push('messaging.whatsapp.apiVersion must look like "v23.0".');
  const templateName = readOptionalString(templateTable, "name", "messaging.whatsapp.template", problems);
  if (whatsappTable.template !== undefined && templateName === null) problems.push("messaging.whatsapp.template.name is missing. Use the name Meta approved the template under.");

  if (platform === "whatsapp") {
    if (mode === "group") {
      problems.push(
        'conversation.mode = "group" is not available on WhatsApp. The official WhatsApp Cloud API cannot join family group chats ' +
          '(its Groups API is limited to verified business accounts). Use mode = "household-dms": the bot talks to each person in a private chat.',
      );
    }
    if (whatsappTable.phoneNumberId === undefined) {
      problems.push("messaging.whatsapp.phoneNumberId is missing. It is the Phone number ID shown in Meta's WhatsApp setup page (not the phone number).");
    }
  }
  const whatsapp: WhatsAppSettings = {
    phoneNumberId: readOptionalString(whatsappTable, "phoneNumberId", "messaging.whatsapp", problems),
    apiVersion,
    webhook: {
      host: readString(webhookTable, "host", "messaging.whatsapp.webhook", problems, "127.0.0.1")!,
      port: readInteger(webhookTable, "port", "messaging.whatsapp.webhook", problems, 8787, 0, 65535),
      path: webhookPath,
    },
    template:
      templateName === null
        ? null
        : { name: templateName, language: readString(templateTable, "language", "messaging.whatsapp.template", problems, "en_US")! },
    accessTokenEnv: readEnvName(whatsappTable, "accessTokenEnv", "messaging.whatsapp", problems, "WHATSAPP_ACCESS_TOKEN"),
    appSecretEnv: readEnvName(whatsappTable, "appSecretEnv", "messaging.whatsapp", problems, "WHATSAPP_APP_SECRET"),
    verifyTokenEnv: readEnvName(whatsappTable, "verifyTokenEnv", "messaging.whatsapp", problems, "WHATSAPP_VERIFY_TOKEN"),
  };
  const imessage: IMessageSettings = {
    serverUrl: readOptionalString(imessageTable, "serverUrl", "messaging.imessage", problems),
    passwordEnv: readEnvName(imessageTable, "passwordEnv", "messaging.imessage", problems, "BLUEBUBBLES_PASSWORD"),
    chatGuid: readOptionalString(imessageTable, "chatGuid", "messaging.imessage", problems),
    sendMethod: readChoice(imessageTable, "sendMethod", "messaging.imessage", ["apple-script", "private-api"] as const, problems, "apple-script")!,
    pollIntervalSeconds: readInteger(imessageTable, "pollIntervalSeconds", "messaging.imessage", problems, 5, 1, 3600),
    allowSms: readBoolean(imessageTable, "allowSms", "messaging.imessage", problems, false),
  };
  if (imessage.serverUrl !== null && !/^https?:\/\/[^\s/]+/.test(imessage.serverUrl)) {
    problems.push('messaging.imessage.serverUrl must be a web address starting with http:// or https://, like "http://192.168.1.20:1234".');
  }
  if (imessage.serverUrl !== null && /[?#]|password=/i.test(imessage.serverUrl)) {
    problems.push("messaging.imessage.serverUrl must be just the server's address. The password goes in the environment variable, never in the address.");
  }
  if (platform === "imessage") {
    if (imessage.serverUrl === null && imessageTable.serverUrl === undefined) {
      problems.push('messaging.imessage.serverUrl is missing. It is the address of your BlueBubbles server, like "http://192.168.1.20:1234".');
    }
    if (mode === "group" && imessage.chatGuid === null && imessageTable.chatGuid === undefined) {
      problems.push('messaging.imessage.chatGuid is missing. With conversation.mode = "group" the bot needs the household group chat\'s GUID (like "iMessage;+;chat123456789").');
    }
  }
  if (imessage.chatGuid !== null && !/^[^;\s]+;\+;\S+$/.test(imessage.chatGuid)) {
    problems.push('messaging.imessage.chatGuid must be a group chat GUID like "iMessage;+;chat123456789" (a one-to-one chat looks like "iMessage;-;+15551234567" and is not a group).');
  }

  return { platform, mode, signal, telegram, whatsapp, imessage };
}

function readModel(raw: Table, problems: string[]): ModelConfig {
  const table = readTable(raw, "model", "", ["id", "apiKeyEnv", "timeoutMs", "maxOutputTokens"], problems);
  return {
    id: readString(table, "id", "model", problems, DEFAULT_MODEL)!,
    apiKeyEnv: readEnvName(table, "apiKeyEnv", "model", problems, "ANTHROPIC_API_KEY"),
    timeoutMs: readInteger(table, "timeoutMs", "model", problems, 120_000, 1000),
    maxOutputTokens: readInteger(table, "maxOutputTokens", "model", problems, 4096, 256),
  };
}

function readRecipes(raw: Table, problems: string[]): RecipesConfig {
  const table = readTable(
    raw,
    "recipes",
    "",
    ["userAgent", "pagesPerSourcePerDay", "sitemapsPerSourcePerDay", "secondsBetweenRequests", "refreshHours", "providerSecondsBetweenRequests", "themealdb", "mealie", "tandoor"],
    problems,
  );
  const themealdb = readTable(table, "themealdb", "recipes", ["apiKeyEnv", "lookupsPerRefresh"], problems);
  return {
    userAgent: readString(table, "userAgent", "recipes", problems, "household-meal-planner/0.1 (self-hosted)")!,
    pagesPerSourcePerDay: readInteger(table, "pagesPerSourcePerDay", "recipes", problems, 20, 0),
    sitemapsPerSourcePerDay: readInteger(table, "sitemapsPerSourcePerDay", "recipes", problems, 10, 0),
    secondsBetweenRequests: readInteger(table, "secondsBetweenRequests", "recipes", problems, 5, 1),
    refreshHours: readInteger(table, "refreshHours", "recipes", problems, 168, 1),
    providerSecondsBetweenRequests: readInteger(table, "providerSecondsBetweenRequests", "recipes", problems, 1, 0),
    themealdb: {
      apiKeyEnv: readEnvName(themealdb, "apiKeyEnv", "recipes.themealdb", problems, "THEMEALDB_API_KEY"),
      lookupsPerRefresh: readInteger(themealdb, "lookupsPerRefresh", "recipes.themealdb", problems, 40, 1, 500),
    },
    mealie: readSelfHosted(table, "mealie", "MEALIE_API_TOKEN", problems),
    tandoor: readSelfHosted(table, "tandoor", "TANDOOR_API_TOKEN", problems),
  };
}

// [recipes.mealie] or [recipes.tandoor]: absent means "not used". The address is the server's
// own address (it may be on the home network); the token is only ever named, never written here.
function readSelfHosted(recipes: Table, key: "mealie" | "tandoor", defaultTokenEnv: string, problems: string[]): SelfHostedConfig | null {
  if (recipes[key] === undefined) return null;
  const path = `recipes.${key}`;
  const table = readTable(recipes, key, "recipes", ["url", "tokenEnv", "maxRecipes"], problems);
  const rawUrl = readString(table, "url", path, problems, null);
  let url = "";
  if (rawUrl !== null) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") problems.push(`${path}.url must start with http:// or https://.`);
      else if (parsed.username !== "" || parsed.password !== "") problems.push(`${path}.url must not contain a user name or password. The token goes in an environment variable.`);
      else if (parsed.search !== "" || parsed.hash !== "") problems.push(`${path}.url must be just the server's address, with no ? or # part.`);
      else url = parsed.toString().replace(/\/+$/, "");
    } catch {
      problems.push(`${path}.url must be a web address like http://mealie.local:9000.`);
    }
  }
  return {
    url,
    tokenEnv: readEnvName(table, "tokenEnv", path, problems, defaultTokenEnv),
    maxRecipes: readInteger(table, "maxRecipes", path, problems, 300, 1, 5000),
  };
}

function readAlerts(raw: Table, problems: string[]): AlertsConfig {
  const table = readTable(raw, "alerts", "", ["channel", "telegramBotTokenEnv", "telegramChatId"], problems);
  const channel = readChoice(table, "channel", "alerts", ["none", "telegram"] as const, problems, "none")!;
  const chatId = readOptionalString(table, "telegramChatId", "alerts", problems);
  if (channel === "telegram" && chatId === null && table.telegramChatId === undefined) {
    problems.push("alerts.telegramChatId is missing. Alerts go to that Telegram chat.");
  }
  return { channel, telegramBotTokenEnv: readEnvName(table, "telegramBotTokenEnv", "alerts", problems, "TELEGRAM_BOT_TOKEN"), telegramChatId: chatId };
}

// Folders: the HMP_* override, then the file's setting, then ./data and ./state. Relative paths
// count from the config file's folder.
function readPaths(raw: Table, baseDir: string, env: Env, problems: string[]): PathsConfig {
  const table = readTable(raw, "paths", "", ["dataDir", "stateDir"], problems);
  const dataDir = env.HMP_DATA_DIR || readString(table, "dataDir", "paths", problems, "./data")!;
  const stateDir = env.HMP_STATE_DIR || readString(table, "stateDir", "paths", problems, "./state")!;
  return { dataDir: absolute(dataDir, baseDir), stateDir: absolute(stateDir, baseDir) };
}

function absolute(path: string, baseDir: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

// ---------------------------------------------------------------------------------------------
// Secrets: checked on request (doctor), never stored in the config object
// ---------------------------------------------------------------------------------------------

// Names the environment variables the chosen setup needs that are not set. Values are never put
// into a message.
export function missingSecrets(config: AppConfig, env: Env = process.env): string[] {
  const needed: Array<{ name: string; why: string }> = [{ name: config.model.apiKeyEnv, why: "the model API key" }];
  switch (config.messaging.platform) {
    case "telegram":
      needed.push({ name: config.messaging.telegram.botTokenEnv, why: "the Telegram bot token" });
      break;
    case "whatsapp":
      needed.push(
        { name: config.messaging.whatsapp.accessTokenEnv, why: "the WhatsApp access token" },
        { name: config.messaging.whatsapp.appSecretEnv, why: "the WhatsApp app secret" },
        { name: config.messaging.whatsapp.verifyTokenEnv, why: "the WhatsApp webhook verify token" },
      );
      break;
    case "imessage":
      needed.push({ name: config.messaging.imessage.passwordEnv, why: "the BlueBubbles server password" });
      break;
    case "signal":
      break; // Signal's keys live in signal-cli's own data folder
  }
  if (config.alerts.channel === "telegram") needed.push({ name: config.alerts.telegramBotTokenEnv, why: "the Telegram alert bot token" });
  // TheMealDB's key is not listed: it works without one (the public test key).
  if (config.recipes.mealie) needed.push({ name: config.recipes.mealie.tokenEnv, why: "the Mealie API token" });
  if (config.recipes.tandoor) needed.push({ name: config.recipes.tandoor.tokenEnv, why: "the Tandoor API token" });

  const seen = new Set<string>();
  const problems: string[] = [];
  for (const { name, why } of needed) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!env[name]) problems.push(`The environment variable ${name} is not set. It should hold ${why}.`);
  }
  return problems;
}

// Reads a non-negative number from an environment variable, or the fallback when it is unset.
// Used for the runtime knobs (timeouts, intervals) that tests and dry runs shorten.
export function numberFromEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new StartupError(`${name} must be a non-negative number`);
  return value;
}
