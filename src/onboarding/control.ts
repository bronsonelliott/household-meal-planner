// The words the adults can type to steer the interview, and the bundled sample profile.
//
// Commands and approval words are matched on the whole message (a little punctuation and any
// capitals are fine), so a sentence that merely contains "save it" is an ordinary answer.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProfile, type HouseProfile } from "../data/profile.ts";
import {
  proposalFromProfile,
  type Addition,
  type BatchMessage,
  type ExtractionResult,
  type Proposal,
  type TopicId,
} from "./state.ts";

export type InterviewCommand = "setup" | "cancel" | "sample" | "approve";

function plain(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^[\s.!,]+|[\s.!,]+$/g, "")
    .replace(/\s+/g, " ");
}

const WORDS: Record<InterviewCommand, string[]> = {
  setup: ["set up house rules", "set up the house rules", "setup house rules"],
  cancel: ["cancel setup", "cancel the setup"],
  sample: ["use the sample", "use sample"],
  approve: ["looks good", "save it", "save", "yes save", "yes, save", "save these", "save them"],
};

export function parseInterviewCommand(text: string): InterviewCommand | null {
  const wanted = plain(text);
  for (const [command, words] of Object.entries(WORDS) as Array<[InterviewCommand, string[]]>) {
    if (words.includes(wanted)) return command;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The sample
// ---------------------------------------------------------------------------------------------

// A copy of data.example/profile.md that ships with the code (a test keeps the two identical).
export const SAMPLE_PROFILE_PATH = join(import.meta.dir, "sample-profile.md");

export function loadSampleProfile(): HouseProfile {
  return parseProfile(readFileSync(SAMPLE_PROFILE_PATH, "utf8"));
}

export function sampleProposal(): Proposal {
  return proposalFromProfile(loadSampleProfile());
}

// The sample, written as the facts the interview works from, all said by the adult who asked for
// it (so they can take any of it back). Applying this is the same path as applying a model's
// reading of real answers, which keeps the sample editable like everything else.
export function sampleExtraction(proposal: Proposal, message: BatchMessage): ExtractionResult {
  const additions: Addition[] = [];
  const add = (topic: TopicId, wording: string, detail: Addition["detail"]) => additions.push({ messageId: message.id, topic, wording, detail });

  for (const rule of proposal.rules) add(rule.check.kind === "fixed" ? "nights" : "habits", rule.prose, { kind: "rule", check: rule.check });
  for (const dish of proposal.dishes) add("dinners", dish.name, { kind: "dish", name: dish.name, protein: dish.protein, tags: dish.tags, pool: dish.pool });
  for (const dislike of proposal.dislikes) add("wont-eat", `${dislike.person}: ${dislike.what}`, { kind: "dislike", person: dislike.person, what: dislike.what });
  for (const veto of proposal.vetoes) add("wont-eat", veto, { kind: "veto", dish: veto });
  for (const staple of proposal.staples) add("staples", staple, { kind: "staple", item: staple });
  for (const section of proposal.sections) add("staples", section, { kind: "section", name: section });

  // A topic the sample has nothing for still counts as answered.
  const topics: TopicId[] = ["nights", "habits", "dinners", "wont-eat", "staples"];
  for (const topic of topics) {
    if (!additions.some((addition) => addition.topic === topic)) add(topic, "Nothing in the sample for this.", { kind: "note" });
  }
  return { additions, topicsCovered: topics, withdrawals: [], conflicts: [], resolvedConflicts: [] };
}
