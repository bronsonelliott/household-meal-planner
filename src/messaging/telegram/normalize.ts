// Turning one Telegram update into a shared IncomingMessage, or the reason it is not one.
//
// Who counts as a sender: a real person's account (message.from) that is not a bot. Posts "as the
// group" by an anonymous admin, posts from a channel, and anything with a sender_chat carry no
// person we could check against the allowlist, so they are ignored.

import type { IncomingMessage } from "../types.ts";

export interface BotIdentity {
  id: number;
  username: string; // without the @
}

export type Normalized = { message: IncomingMessage } | { ignored: string };

// The kinds of content that count as "has an attachment" when there are no words.
const ATTACHMENT_KEYS = [
  "photo",
  "document",
  "sticker",
  "video",
  "video_note",
  "animation",
  "audio",
  "voice",
  "contact",
  "location",
  "venue",
  "poll",
  "dice",
];

// Telegram counts text positions in UTF-16 units, which is what JavaScript strings use, so
// entity offsets slice the text directly.
interface Entity {
  type: string;
  offset: number;
  length: number;
  user?: { id: number };
}

function displayName(from: any): string | null {
  const full = [from.first_name, from.last_name].filter(Boolean).join(" ");
  return full || from.username || null;
}

// If a Telegram group migrates to a supergroup, Telegram posts a service message in each chat
// naming the other. Returns the old and new chat IDs, or null for any other update.
export function findMigration(update: any): { from: string; to: string } | null {
  const message = update?.message;
  if (!message) return null;
  if (typeof message.migrate_to_chat_id === "number") return { from: String(message.chat.id), to: String(message.migrate_to_chat_id) };
  if (typeof message.migrate_from_chat_id === "number") return { from: String(message.migrate_from_chat_id), to: String(message.chat.id) };
  return null;
}

// `logicalChatId` turns Telegram's chat ID into the one the rest of the bot uses (see the adapter:
// after a group migration the old, configured ID keeps standing for the group).
export function normalizeUpdate(update: any, bot: BotIdentity, logicalChatId: (chatId: number) => string): Normalized {
  // We ask Telegram only for new messages. Edits, reactions, membership changes and the rest are
  // not requested; if one shows up anyway it is skipped here.
  const message = update?.message;
  if (!message) return { ignored: "not a new message" };

  const chat = message.chat;
  if (!chat || typeof chat.id !== "number") return { ignored: "no chat" };
  if (chat.type === "channel") return { ignored: "channel post" };
  const isGroup = chat.type === "group" || chat.type === "supergroup";
  if (!isGroup && chat.type !== "private") return { ignored: `chat type ${chat.type}` };

  if (message.sender_chat) return { ignored: "sent as a group or channel (anonymous admin or channel post)" };
  if (message.is_automatic_forward) return { ignored: "automatic forward from a channel" };
  const from = message.from;
  if (!from || typeof from.id !== "number") return { ignored: "no sender" };
  if (from.is_bot) return { ignored: "sent by a bot" };
  if (typeof message.message_id !== "number" || typeof message.date !== "number") return { ignored: "no message ID or date" };

  // A caption (the words under a photo) counts as the message's text.
  const hasText = typeof message.text === "string";
  let text: string = hasText ? message.text : typeof message.caption === "string" ? message.caption : "";
  const entities: Entity[] = (hasText ? message.entities : message.caption_entities) ?? [];
  const wantsUsername = `@${bot.username}`.toLowerCase();

  let mentionsBot = false;
  for (const entity of entities) {
    const piece = text.slice(entity.offset, entity.offset + entity.length);
    if (entity.type === "mention" && piece.toLowerCase() === wantsUsername) mentionsBot = true;
    if (entity.type === "text_mention" && entity.user?.id === bot.id) mentionsBot = true;

    // "/sources@dinner_bot" at the start: addressed to one bot among several in the group.
    if (entity.type === "bot_command" && entity.offset === 0 && piece.includes("@")) {
      const [command, target] = piece.split("@");
      if (target!.toLowerCase() !== bot.username.toLowerCase()) return { ignored: "command for another bot" };
      text = command + text.slice(entity.length); // later code sees plain "/sources"
      mentionsBot = true;
    }
  }

  return {
    message: {
      platform: "telegram",
      conversationId: logicalChatId(chat.id),
      nativeId: String(message.message_id),
      sender: { identity: String(from.id), displayName: displayName(from) },
      isGroup,
      text,
      hasAttachments: ATTACHMENT_KEYS.some((key) => message[key] !== undefined),
      mentionsBot,
      repliesToBot: message.reply_to_message?.from?.id === bot.id,
      timestamp: message.date * 1000,
    },
  };
}
