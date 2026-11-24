// What Meta's webhook calls look like, and how to check one is really from Meta.
//
// Every POST carries X-Hub-Signature-256: "sha256=" and the HMAC-SHA256 of the raw request body,
// keyed with the app secret. We check it BEFORE reading the body as JSON, so nothing from an
// unsigned call is ever parsed or acted on.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "../types.ts";

// A comparison that takes the same time wherever the two texts differ, so an attacker cannot learn
// a secret one character at a time from how fast we answer.
export function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signatureIsValid(rawBody: Uint8Array, header: string | null, appSecret: string): boolean {
  if (appSecret === "" || header === null || !header.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return sameSecret(header, expected);
}

// What a test (or Meta) computes to sign a body.
export function signBody(rawBody: string | Uint8Array, appSecret: string): string {
  return "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
}

export interface StatusEvent {
  messageId: string;
  status: string;
  at: number; // epoch ms
  error?: string;
}

export interface ParsedWebhook {
  messages: IncomingMessage[];
  statuses: StatusEvent[];
  // Notes about things we skipped, for the log (never the content).
  skipped: string[];
}

// Message types that carry a file. Some can have a caption, which counts as the message's words.
const FILE_TYPES = ["image", "video", "document", "audio", "sticker"];

function normalizeMessage(raw: any, contacts: any[]): IncomingMessage | "skip" {
  const from = String(raw?.from ?? "");
  const id = String(raw?.id ?? "");
  if (from === "" || id === "") return "skip";
  const type = String(raw?.type ?? "");

  let text = "";
  let hasAttachments = false;
  if (type === "text") {
    text = String(raw.text?.body ?? "");
  } else if (FILE_TYPES.includes(type)) {
    hasAttachments = true;
    text = typeof raw[type]?.caption === "string" ? raw[type].caption : "";
  } else {
    return "skip"; // location, contacts, reactions, buttons, "unsupported", ...
  }

  const contact = contacts.find((candidate) => String(candidate?.wa_id) === from);
  const seconds = Number(raw.timestamp);
  return {
    platform: "whatsapp",
    conversationId: from, // each person's private chat is named by their number
    nativeId: id,
    sender: { identity: from, displayName: typeof contact?.profile?.name === "string" ? contact.profile.name : null },
    isGroup: false,
    text,
    hasAttachments,
    mentionsBot: false,
    repliesToBot: false,
    timestamp: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now(),
  };
}

// Reads entry[].changes[].value for the messages and statuses meant for our phone number.
export function parseWebhook(body: any, phoneNumberId: string): ParsedWebhook {
  const parsed: ParsedWebhook = { messages: [], statuses: [], skipped: [] };
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value;
      if (change?.field !== "messages" || typeof value !== "object" || value === null) continue;
      if (value.metadata?.phone_number_id !== undefined && String(value.metadata.phone_number_id) !== phoneNumberId) {
        parsed.skipped.push("an event for a different phone number ID");
        continue;
      }
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      for (const raw of Array.isArray(value.messages) ? value.messages : []) {
        const message = normalizeMessage(raw, contacts);
        if (message === "skip") parsed.skipped.push(`a ${String(raw?.type ?? "unknown")} message`);
        else parsed.messages.push(message);
      }
      for (const raw of Array.isArray(value.statuses) ? value.statuses : []) {
        if (typeof raw?.id !== "string" || typeof raw?.status !== "string") continue;
        const error = Array.isArray(raw.errors) && raw.errors.length > 0 ? `${raw.errors[0].code ?? "?"}: ${raw.errors[0].title ?? raw.errors[0].message ?? "no detail"}` : undefined;
        const seconds = Number(raw.timestamp);
        parsed.statuses.push({
          messageId: raw.id,
          status: raw.status,
          at: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now(),
          ...(error ? { error } : {}),
        });
      }
    }
  }
  return parsed;
}
