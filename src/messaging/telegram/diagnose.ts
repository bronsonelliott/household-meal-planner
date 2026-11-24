// What the bot's start-up log and `bun run doctor --online` say about Telegram's privacy mode.
//
// By default Telegram bots are in "privacy mode": in a group they see only messages that mention
// them, replies to them, and slash commands. The household bot can still work that way, but a
// plain "Tuesday tacos" would never reach it. Turning privacy mode off (or making the bot a group
// admin) lets it see everything said in the group.

import type { TelegramAdapterConfig } from "./settings.ts";
import { describeAnswer, TelegramApi } from "./client.ts";

export const PRIVACY_MODE_NOTE =
  "Telegram privacy mode is ON for this bot, so in the group it only sees messages that @mention it, " +
  "replies to it, and /commands. To let it see everything, turn privacy mode off in BotFather " +
  "(/mybots, pick the bot, Bot Settings, Group Privacy, Turn off), then remove the bot from the group and add it back " +
  "(Telegram applies the change only to groups it joins afterwards), or make the bot a group admin.";

export interface TelegramDiagnosis {
  problems: string[];
  lines: string[];
}

// Asks Telegram (so it needs the network and the real token) whether the setup works.
export async function diagnoseTelegram(config: TelegramAdapterConfig): Promise<TelegramDiagnosis> {
  const api = new TelegramApi(config.token, config.apiBaseUrl, config.requestTimeoutMs);
  const lines: string[] = [];
  const problems: string[] = [];

  const me = await api.call("getMe");
  if (me.kind !== "ok") {
    problems.push(`telegram: could not use the bot token (${describeAnswer(me)}). Check the token in the environment variable and that nothing blocks api.telegram.org.`);
    return { problems, lines };
  }
  lines.push(`Telegram bot: @${me.result.username} (token accepted)`);

  if (config.mode === "group") {
    const chat = await api.call("getChat", { chat_id: Number(config.chatId) });
    if (chat.kind !== "ok") {
      problems.push(`telegram: could not open the household chat ${config.chatId} (${describeAnswer(chat)}). Is the bot in the group, and is the chat ID right?`);
    } else {
      lines.push(`Telegram group: "${chat.result.title ?? config.chatId}" (${chat.result.type})`);
    }
    // A group admin sees everything whatever the privacy setting says.
    const member = await api.call("getChatMember", { chat_id: Number(config.chatId), user_id: me.result.id });
    const isAdmin = member.kind === "ok" && (member.result.status === "administrator" || member.result.status === "creator");
    if (me.result.can_read_all_group_messages === false && !isAdmin) lines.push(`Warning: ${PRIVACY_MODE_NOTE}`);
    else lines.push("Telegram privacy: the bot sees every message in the group.");
  }
  return { problems, lines };
}
