// `bun run doctor`: checks the household's setup and says, in plain words, whether it is ready.
//
// It reads config.toml (found through HMP_CONFIG, default ./config.toml) and the profile.md in
// the data folder, and checks the environment variable NAMES the setup needs are filled in.
// It starts nothing, sends nothing, and calls no network service. It never prints a secret.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, configPathFrom, loadConfig, missingSecrets, type AppConfig } from "./config.ts";
import { diagnoseTelegram } from "./messaging/telegram/diagnose.ts";
import { telegramAdapterConfig } from "./messaging/telegram/settings.ts";
import { diagnoseIMessage } from "./messaging/imessage/diagnose.ts";
import { imessageAdapterConfig } from "./messaging/imessage/settings.ts";
import { diagnoseWhatsApp } from "./messaging/whatsapp/diagnose.ts";
import { whatsappAdapterConfig } from "./messaging/whatsapp/settings.ts";
import { ProfileError, readProfileStatus } from "./data/profile.ts";
import { loadOnboardingState, onboardingStatePath } from "./onboarding/state.ts";
import { tagCoverageWarnings } from "./onboarding/validate.ts";
import { diagnoseProviders, providerNotes } from "./recipes/providers/diagnose.ts";
import type { ProviderDeps } from "./recipes/providers/index.ts";

export interface DoctorReport {
  ok: boolean;
  problems: string[];
  warnings?: string[]; // worth knowing, but the setup still works
  lines: string[]; // what to print
}

type Env = Record<string, string | undefined>;

// "1 member", "2 members".
function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

// With `online` set, the online checks run right after, so the "run doctor --online" hints are left out.
export function runDoctor(env: Env = process.env, options: { online?: boolean } = {}): DoctorReport {
  const online = options.online ?? false;
  const problems: string[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  let config: AppConfig | null = null;

  try {
    config = loadConfig(env);
    notes.push(`Config file: ${configPathFrom(env)}`);
  } catch (error) {
    if (error instanceof ConfigError) problems.push(...error.problems.map((problem) => `config: ${problem}`));
    else problems.push(`config: ${(error as Error).message}`);
  }

  if (config) {
    const profilePath = join(config.paths.dataDir, "profile.md");
    const status = readProfileStatus(profilePath);
    if (status.kind === "setup-needed") {
      notes.push("Profile: Ready for chat setup: the bot will interview you in the chat when it starts (there is no profile.md yet).");
    } else if (status.kind === "error") {
      problems.push(`profile: ${status.message}`);
    } else {
      const profile = status.profile;
      notes.push(`Profile: ${profilePath} (${count(profile.usualDishes.length, "usual dish", "usual dishes")}, ${count(profile.grocerySections.length, "grocery section")})`);
      warnings.push(...tagCoverageWarnings(profile.rules, [...profile.usualDishes, ...profile.alsoLikeDishes]).map((warning) => `profile: ${warning}`));
    }
    // What the chat interview is up to, if it has been started.
    const interview = loadOnboardingState(onboardingStatePath(config.paths.stateDir, config.dryRun));
    if (interview.kind === "corrupt") problems.push(`interview: ${interview.message}`);
    else if (interview.kind === "ok") notes.push(`House-rules interview: ${describeInterview(interview.state.phase, interview.state.mode)}`);
    problems.push(...missingSecrets(config, env).map((problem) => `secrets: ${problem}`));
  }

  if (problems.length > 0) {
    const lines = [
      `Not ready yet. ${problems.length} thing${problems.length === 1 ? "" : "s"} to fix:`,
      ...problems.map((problem) => `  - ${problem}`),
    ];
    return { ok: false, problems, lines };
  }

  const c = config!;
  const lines = [
    "All good. Your setup looks ready.",
    ...notes.map((note) => `  ${note}`),
    `  Household: ${c.household.name}, bot "${c.household.botName}", ${count(c.members.length, "member")}`,
    `  Chat app: ${c.messaging.platform} (${c.messaging.mode})`,
    `  Draft: ${c.schedule.draftDay} at ${c.schedule.draftTime}, ${c.schedule.timeZone}`,
    ...(c.messaging.platform === "telegram" && !online ? ["  Telegram: run `bun run doctor --online` to check the token, the group and BotFather's privacy mode."] : []),
    ...(c.messaging.platform === "whatsapp" ? whatsappNotes(c, online) : []),
    ...(c.messaging.platform === "imessage" ? imessageNotes(c, online) : []),
    ...providerNotes(c.recipes, env),
    ...(warnings.length > 0 ? ["Worth a look (not blocking):", ...warnings.map((warning) => `  - ${warning}`)] : []),
    "Nothing was started and nothing was sent.",
  ];
  return { ok: true, problems, warnings, lines };
}

function describeInterview(phase: string, mode: string): string {
  const what = mode === "redo" ? "a redo of your house rules" : "the first setup";
  switch (phase) {
    case "done":
      return `${what} finished.`;
    case "cancelled":
      return `${what} was cancelled. Say "set up house rules" in the chat to pick it up again.`;
    default:
      return `${what} is in progress (${phase}). It continues in the chat.`;
  }
}

// What the WhatsApp setup says about itself without asking Meta anything.
function whatsappNotes(config: AppConfig, online: boolean): string[] {
  const { webhook, template } = config.messaging.whatsapp;
  return [
    "  WhatsApp (beta): the webhook listens on " + `${webhook.host}:${webhook.port}${webhook.path}` + " (your tunnel or proxy must forward Meta's calls there).",
    template
      ? `  WhatsApp template: "${template.name}" (${template.language}) is sent to anyone who has not written to the bot in 24 hours.`
      : "  WhatsApp template: none set. Anyone who has not written to the bot in the last 24 hours cannot be sent the plan until they do. See docs/platforms/whatsapp.md.",
    ...(online ? [] : ["  WhatsApp: run `bun run doctor --online` to check the access token and the phone number."]),
  ];
}

// What the iMessage setup says about itself without asking the server anything.
function imessageNotes(config: AppConfig, online: boolean): string[] {
  const { serverUrl, sendMethod } = config.messaging.imessage;
  const lines = [
    `  iMessage (beta): reads and sends through the BlueBubbles server at ${serverUrl}.`,
    sendMethod === "private-api"
      ? "  iMessage: sendMethod is private-api, so the bot reacts to messages with tapbacks. That needs BlueBubbles' Private API on the Mac."
      : "  iMessage: sendMethod is apple-script, so the bot does not react to messages (tapbacks need the Private API).",
  ];
  // The bot may run on any computer; only the BlueBubbles server has to be on a Mac.
  if (process.platform !== "darwin") {
    lines.push("  iMessage: this computer is not a Mac. That is fine as long as it can reach the server's address; BlueBubbles itself must run on a Mac.");
  }
  if (!online) lines.push("  iMessage: run `bun run doctor --online` to ping the server and look up the chat.");
  return lines;
}

// The extra checks that ask the chat app's servers and the recipe APIs (so they need the network
// and the real secrets): `bun run doctor --online`. Telegram, WhatsApp and iMessage have a chat
// check; each configured recipe provider gets one cheap read. None sends or saves anything.
export async function runOnlineChecks(env: Env = process.env, deps: ProviderDeps = {}): Promise<DoctorReport> {
  const config = loadConfig(env);
  const lines: string[] = [];
  const problems: string[] = [];

  const platform = config.messaging.platform;
  if (platform !== "telegram" && platform !== "whatsapp" && platform !== "imessage") {
    lines.push(`  No online check for ${platform} yet.`);
  } else {
    const diagnosis =
      platform === "whatsapp"
        ? await diagnoseWhatsApp(whatsappAdapterConfig(config, env))
        : platform === "imessage"
          ? await diagnoseIMessage(imessageAdapterConfig(config, env))
          : await diagnoseTelegram(telegramAdapterConfig(config, env));
    lines.push(...diagnosis.lines.map((line) => `  ${line}`), ...diagnosis.problems.map((problem) => `  - ${problem}`));
    problems.push(...diagnosis.problems);
  }

  const recipes = await diagnoseProviders(config.recipes, env, deps);
  lines.push(...recipes.lines.map((line) => `  ${line}`), ...recipes.problems.map((problem) => `  - ${problem}`));
  problems.push(...recipes.problems);
  return { ok: problems.length === 0, problems, lines };
}

if (import.meta.main) {
  const report = runDoctor(process.env, { online: process.argv.includes("--online") });
  console.log(report.lines.join("\n"));
  let ok = report.ok;
  if (ok && process.argv.includes("--online")) {
    console.log("\nOnline checks:");
    const online = await runOnlineChecks();
    console.log(online.lines.join("\n"));
    ok = online.ok;
  }
  process.exit(ok ? 0 : 1);
}
