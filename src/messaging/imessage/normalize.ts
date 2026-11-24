// Turning BlueBubbles' message records into the few facts the adapter needs, plus the small text
// helpers (handles, bot name, chat GUIDs).
//
// EVERY field name read from a BlueBubbles message is in readMessage() below, and nowhere else.
// The code was written against BlueBubbles server v1.9.9 (see docs/platforms/imessage.md) and has
// not been run against a live server. If a field is named differently in your version, that one
// function is the only place to fix.

export interface SeenMessage {
  guid: string;
  text: string; // "" when there are no words
  dateCreated: number; // epoch milliseconds
  isFromMe: boolean;
  chatGuid: string | null; // "iMessage;+;chat123" (a group) or "iMessage;-;+15551234567" (one person)
  senderAddress: string | null; // the other party's phone number or email (the sender, in a group)
  isReaction: boolean; // a tapback ("loved", "liked", ...), not a real message
  hasAttachments: boolean;
  threadOriginatorGuid: string | null; // set when this message is an inline reply to another
}

// The object-replacement character Messages puts in the text where a photo or file sits.
const ATTACHMENT_PLACEHOLDER = /￼/g;

// MUST BE CHECKED against the pinned BlueBubbles version: guid, text, dateCreated (ms), isFromMe,
// handle.address, chats[0].guid (needs `with: ["chat"]` on the query), associatedMessageType,
// hasAttachments, attachments, threadOriginatorGuid.
export function readMessage(raw: any): SeenMessage | null {
  if (typeof raw?.guid !== "string" || raw.guid === "") return null;
  if (typeof raw.dateCreated !== "number" || !Number.isFinite(raw.dateCreated)) return null;
  const chatGuid = typeof raw.chats?.[0]?.guid === "string" ? raw.chats[0].guid : typeof raw.chatGuid === "string" ? raw.chatGuid : null;
  const type = raw.associatedMessageType;
  // A normal message has no associated type; a tapback has a name ("love") or a number (2000).
  const isReaction = type !== undefined && type !== null && type !== "" && type !== 0 && type !== "0";
  return {
    guid: raw.guid,
    text: typeof raw.text === "string" ? raw.text.replace(ATTACHMENT_PLACEHOLDER, "").trim() : "",
    dateCreated: raw.dateCreated,
    isFromMe: raw.isFromMe === true,
    chatGuid,
    senderAddress: typeof raw.handle?.address === "string" ? raw.handle.address : null,
    isReaction,
    hasAttachments: raw.hasAttachments === true || (Array.isArray(raw.attachments) && raw.attachments.length > 0),
    threadOriginatorGuid: typeof raw.threadOriginatorGuid === "string" && raw.threadOriginatorGuid !== "" ? stripGuidPrefix(raw.threadOriginatorGuid) : null,
  };
}

// MUST BE CHECKED against the pinned BlueBubbles version: data.server_version, data.os_version,
// data.private_api (is the Private API helper on).
export function readServerInfo(body: any): { version: string | null; macVersion: string | null; privateApi: boolean | null } {
  const data = body?.data;
  return {
    version: typeof data?.server_version === "string" ? data.server_version : null,
    macVersion: typeof data?.os_version === "string" ? data.os_version : null,
    privateApi: typeof data?.private_api === "boolean" ? data.private_api : null,
  };
}

// Some BlueBubbles fields write a message guid as "p:0/ABCD-...". The bare guid is what we keep.
export function stripGuidPrefix(guid: string): string {
  return guid.replace(/^[a-z]+:\d+\//i, "");
}

// ---------------------------------------------------------------------------------------
// Chats

// "iMessage;+;chat123" is a group; "iMessage;-;+15551234567" is a conversation with one person.
// This is the BlueBubbles naming convention: service, then "+" (group) or "-" (one person), then the id.
export function isGroupChat(chatGuid: string): boolean {
  return chatGuid.split(";")[1] === "+";
}

// The service in front of the chat GUID: "iMessage" or "SMS".
export function chatService(chatGuid: string): string {
  return chatGuid.split(";")[0] ?? "";
}

export function isIMessageChat(chatGuid: string): boolean {
  return chatService(chatGuid).toLowerCase() === "imessage";
}

// The private chat with one person, by the BlueBubbles convention.
export function directChatGuid(handle: string): string {
  return `iMessage;-;${handle}`;
}

// ---------------------------------------------------------------------------------------
// People

// One spelling per person: a phone number is "+" and digits only; an email is lowercase.
export function normalizeHandle(address: string): string {
  const trimmed = address.trim();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (digits === "") return trimmed;
  return trimmed.startsWith("+") ? `+${digits}` : digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

// ---------------------------------------------------------------------------------------
// Speaking to the bot

// iMessage has no way to @-mention a bot, so a message counts as speaking to it when it says the
// bot's name as a whole word, in any capitals ("dinner bot, swap monday" or "thanks Dinner Bot!").
export function mentionsName(text: string, botName: string): boolean {
  const name = botName.trim();
  if (name === "") return false;
  const escaped = name
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(text);
}
