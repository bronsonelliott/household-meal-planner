// Signal's start-up group check: the configured group exists, the bot is in it, and every
// household member is in it.

// A member as the Signal adapter knows them: their configured ID and name, plus the Signal
// account ID (a UUID) the allowlist matches on.
export interface SignalMember {
  id: string;
  name: string;
  accountId: string;
}

// The parts of a listGroups entry the check reads.
interface GroupMember {
  number: string | null;
  uuid: string | null;
}
export interface Group {
  id: string;
  name: string;
  isMember: boolean;
  members: GroupMember[];
}

// The configured group must exist, the bot must be in it, and every member must be in it. Extra
// members are fine: either adult may add people (settled).
// Returns null when the check passes, or the reason it failed, with everything found.
export function checkGroupMembership(groups: Group[], groupId: string, botNumber: string, members: SignalMember[]): string | null {
  const group = groups.find((candidate) => candidate.id === groupId);
  const problems: string[] = [];

  if (!group) {
    problems.push(`the configured group ${groupId} is not in this account's groups`);
  } else {
    // The bot's member entry carries its number; its member UUID differs from the one
    // getUserStatus reports, so the number is what identifies it here.
    const botIsMember = group.isMember && group.members.some((member) => member.number === botNumber);
    if (!botIsMember) problems.push(`the bot (${botNumber}) is not a member of "${group.name}"`);

    for (const member of members) {
      if (!group.members.some((entry) => entry.uuid === member.accountId)) {
        problems.push(`${member.name} (${member.accountId}) is not a member of "${group.name}"`);
      }
    }
  }

  if (problems.length === 0) return null;
  return `Group check failed: ${problems.join("; ")}.\n${describeGroups(groups)}`;
}

function describeGroups(groups: Group[]): string {
  if (groups.length === 0) return "This account is in no groups.";
  const lines = groups.map((group) => {
    const members = group.members.map((member) => [member.uuid, member.number].filter(Boolean).join(" ")).join(", ");
    const left = group.isMember ? "" : " (bot is no longer a member)";
    return `  - "${group.name}" (id ${group.id})${left}: members ${members || "none"}`;
  });
  return `Groups found:\n${lines.join("\n")}`;
}
