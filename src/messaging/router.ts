// Decides what to do with one journaled message. Shared by every platform.
//
// The allowlist is the household's configured members, matched on the identity the platform gave
// (an account ID, a user ID), never on a display name, which anyone can set to anything.
//
// It reads only the message and the config, so it gives the same answer on replay as on first
// receipt.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationMode, Member } from "../config.ts";
import { writeFileAtomically } from "../data/files.ts";
import type { IncomingMessage, InboundEvent, Platform } from "./types.ts";

// The fixed lines. Neither goes to the model.
export const DIRECT_MESSAGE_LINE = "I only work in the household group chat. Send it there and I'll pick it up.";
export const ATTACHMENT_ONLY_LINE = "I can't see photos or files. Can you send that in words?";

const DAY_MS = 24 * 60 * 60 * 1000;

export type Routing =
  | { action: "drop"; reason: string }
  | { action: "event"; event: InboundEvent }
  | { action: "attachment-only"; memberId: string } // gets the "say it in words" line
  | { action: "direct-message"; memberId: string }; // gets the once-a-day "use the group" line

export interface RouterContext {
  platform: Platform;
  mode: ConversationMode;
  members: Member[];
  // The household group's ID in group mode; null in household-dms mode.
  conversationId: string | null;
}

export function findMember(members: Member[], platform: Platform, identity: string): Member | undefined {
  if (identity === "") return undefined;
  return members.find((member) => member.identities[platform] === identity);
}

export function routeMessage(message: IncomingMessage, journalId: string, context: RouterContext): Routing {
  const member = findMember(context.members, context.platform, message.sender.identity);
  if (!member) return { action: "drop", reason: "sender not on the allowlist" };

  const text = message.text.trim();

  if (context.mode === "group") {
    if (!message.isGroup) {
      if (text === "" && !message.hasAttachments) return { action: "drop", reason: "empty direct message" };
      return { action: "direct-message", memberId: member.id };
    }
    if (message.conversationId !== context.conversationId) return { action: "drop", reason: "another conversation" };
  } else if (message.isGroup) {
    // In household-dms mode the private chats ARE the conversation; a group is somebody else's.
    return { action: "drop", reason: "group message in household-dms mode" };
  }

  if (text !== "") {
    return {
      action: "event",
      event: {
        id: journalId,
        kind: "text",
        memberId: member.id,
        memberName: member.name,
        text,
        timestamp: message.timestamp,
        mentionsBot: message.mentionsBot,
        repliesToBot: message.repliesToBot,
      },
    };
  }
  if (message.hasAttachments) return { action: "attachment-only", memberId: member.id };

  // Stickers, deletions, and anything else without words.
  return { action: "drop", reason: "no text" };
}

// Remembers, in the state directory, when each member last got the direct-message line, so the
// once-a-day limit holds across restarts.
export class DirectMessageNotices {
  private path: string;
  private lastSent: Record<string, number>;

  constructor(stateDir: string) {
    this.path = join(stateDir, "dm-notices.json");
    this.lastSent = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {};
  }

  isDue(memberId: string, now: number): boolean {
    const last = this.lastSent[memberId];
    return last === undefined || now - last >= DAY_MS;
  }

  recordSent(memberId: string, now: number): void {
    this.lastSent[memberId] = now;
    writeFileAtomically(this.path, JSON.stringify(this.lastSent, null, 2));
  }
}
