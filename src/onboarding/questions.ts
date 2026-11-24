// The words the bot says during the interview. The text is fixed here, in code, so it is
// predictable and testable; the model only reads the answers, it never writes these messages.

import type { Conflict, Mode, TopicId } from "./state.ts";

// The five questions, one per message, in the order they are asked.
export const TOPIC_QUESTIONS: Record<TopicId, string> = {
  nights:
    'First, the calendar. Are there nights you always eat out or are away? Is there a night you do a big cook? And on weeknights, what counts as a "quick" dinner for you, in minutes?',
  habits:
    'Next, how you like to eat. Which proteins or cuisines do you want most weeks, and which do you want to limit? For example: "chicken at least once a week", "red meat no more than once", "no fish on weeknights".',
  dinners:
    "Now your go-to dinners: the meals you make again and again. List them the way you'd say them out loud, and add anything that matters about them, like quick, kid-friendly or a big cook.",
  "wont-eat":
    "Two different things here. Who won't eat what? I'll note it, but it won't ban a dish. And is there anything I should never suggest again? Tell me who each one is for.",
  staples:
    'Last one, and you can skip it: what do you always keep in the house, and how is your grocery store laid out, aisle by aisle? Say "skip" and I\'ll use a standard layout.',
};

export function questionFor(topic: TopicId): string {
  return TOPIC_QUESTIONS[topic];
}

export interface WelcomeInput {
  botName: string;
  memberNames: string[];
  mode: Mode;
}

export function welcomeMessage(input: WelcomeInput): string {
  const names = input.memberNames.length > 1 ? `${input.memberNames.slice(0, -1).join(", ")} and ${input.memberNames[input.memberNames.length - 1]}` : (input.memberNames[0] ?? "you");
  const intro =
    input.mode === "redo"
      ? `Let's redo your house rules. Your current rules stay in use until you approve new ones.`
      : `Hi ${names}, I'm ${input.botName}. Before I can plan dinners I need to learn your house rules.`;
  return [
    intro,
    "",
    "I'll ask five short questions, one at a time. Either of you can answer, and you can both chip in. Say \"skip\" to skip a question.",
    "Nothing is saved until you both have had a look and one of you says to save it.",
    "",
    TOPIC_QUESTIONS.nights,
  ].join("\n");
}

// One question to both adults when what they said doesn't fit together, quoting each version.
export function clarificationMessage(conflict: Conflict): string {
  const names = [...new Set(conflict.versions.map((version) => version.memberName))];
  const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "both of you");
  return [
    `${who}, I heard two different things about ${conflict.subject}:`,
    ...conflict.versions.map((version) => `- ${version.memberName}: "${version.quote}"`),
    "Which one should I go with, or is there a middle ground?",
  ].join("\n");
}

// The confirm question, asked when "save it" can't be tied to the read-back that was just shown.
export function snapshotQuestion(summary: string): string {
  return `Save these rules: ${summary}? Say "save it" to save exactly this, or tell me what to change.`;
}

export const REPHRASE_REQUEST = "I couldn't make sense of that one. Could you say it again in other words?";

export function problemsMessage(problems: string[]): string {
  return ["Before I can show you the rules, one thing needs sorting out:", ...problems.map((problem) => `- ${problem}`)].join("\n");
}

export const CANCELLED_MESSAGE = 'Okay, I\'ve stopped the setup. Say "set up house rules" any time to start again.';

export const SAMPLE_INTRO = "Here's the sample set of house rules. It's only a starting point, and nothing is saved until you approve it.";

// What the bot says after the profile has been saved.
export function savedMessage(mode: Mode): string {
  return mode === "first-run"
    ? "Saved. Those are your house rules, and I'll use them for every draft. Since this was your first set, there's nothing to undo. To change something, just tell me, or edit data/profile.md."
    : 'Saved. The new rules are in use. Say "undo" within 30 minutes to go back to your old ones.';
}

export const EXTERNAL_EDIT_MESSAGE = "The profile file was changed by hand while I was saving, so I left it alone. I'll read back my version again so you can check it.";
