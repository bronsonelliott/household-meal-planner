// Turns a proposal into the two things people and the program need:
//
//   renderProfile   the exact text of profile.md, in the format parseProfile reads
//   renderReadBack  the same proposal in plain words, in message-sized chunks, for the adults to
//                   check before anything is saved
//
// Both are pure. The profile text only ever comes from the proposal, never from the model's own
// prose, and every line is forced to a single line so one odd answer can't start a new heading.

import { formatRuleCheck, type Night, type RuleCheck } from "../data/profile.ts";
import { DEFAULT_GROCERY_SECTIONS } from "../data/profile.ts";
import { diffProposals, oneLine, proseLine, snapshotSummary, type Proposal, type ProposalDish } from "./state.ts";

// ---------------------------------------------------------------------------------------------
// profile.md
// ---------------------------------------------------------------------------------------------

export function renderProfile(proposal: Proposal): string {
  const lines: string[] = [
    "# House Profile",
    "",
    "Made by the house-rules interview and approved in the chat. Edit it by hand any time;",
    "docs/house-rules.md explains the rules and their checks.",
    "",
    "## Rules",
    "",
  ];
  for (const rule of proposal.rules) lines.push(`- ${proseLine(rule.prose)} [${formatRuleCheck(rule.check)}]`);

  lines.push("", "## Usual Dishes", "");
  pushDishes(lines, proposal.dishes.filter((dish) => dish.pool === "usual"));
  lines.push("## Also-Like Dishes", "");
  pushDishes(lines, proposal.dishes.filter((dish) => dish.pool === "also-like"));

  // The heading is left out when the household gave no store layout: the standard list applies.
  if (proposal.sections.length > 0) {
    lines.push("## Grocery Sections", "");
    for (const section of proposal.sections) lines.push(`- ${oneLine(section)}`);
    lines.push("");
  }

  lines.push("## Staples", "");
  for (const staple of proposal.staples) lines.push(`- ${oneLine(staple)}`);
  lines.push("", "## Dislikes", "");
  for (const dislike of proposal.dislikes) lines.push(`- ${oneLine(dislike.person).replace(/:/g, "")}: ${oneLine(dislike.what)}`);
  lines.push("", "## Vetoes", "");
  for (const veto of proposal.vetoes) lines.push(`- ${oneLine(veto)}`);
  lines.push("", "## Lock Words", "");
  for (const word of proposal.lockWords) lines.push(`- ${oneLine(word)}`);
  const t = proposal.thresholds;
  lines.push(
    "",
    "## Thresholds",
    "",
    `- max-usual-dishes-per-week: ${t.maxUsualDishesPerWeek}`,
    `- max-nights-per-protein: ${t.maxNightsPerProtein}`,
    `- repeat-window-weeks: ${t.repeatWindowWeeks}`,
    `- batching-window-seconds: ${t.batchingWindowSeconds}`,
    "",
  );
  return lines.join("\n");
}

function pushDishes(lines: string[], dishes: ProposalDish[]): void {
  for (const dish of dishes) {
    lines.push(`### ${oneLine(dish.name)}`, `- Protein: ${oneLine(dish.protein).toLowerCase() || "other"}`);
    if (dish.tags.length > 0) lines.push(`- Tags: ${dish.tags.join(", ")}`);
    for (const line of dish.ingredients) lines.push(`- ${oneLine(line.section)}: ${oneLine(line.text)}`);
    lines.push("");
  }
}

// ---------------------------------------------------------------------------------------------
// The read-back
// ---------------------------------------------------------------------------------------------

const DAY_NAMES: Record<Night, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

function dayList(nights: readonly Night[]): string {
  const order = Object.keys(DAY_NAMES) as Night[];
  const sorted = [...nights].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const names = sorted.map((night) => DAY_NAMES[night]);
  const run = sorted.length > 2 && sorted.every((night, i) => i === 0 || order.indexOf(night) === order.indexOf(sorted[i - 1]!) + 1);
  if (run) return `${names[0]} to ${names[names.length - 1]}`;
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// Says what a check does in plain words, using the household's own idea of "weeknights".
export function explainCheck(check: RuleCheck, weeknights: readonly Night[]): string {
  const nightsText = (target: string) => (target === "weeknights" ? `weeknights (${dayList(weeknights)})` : DAY_NAMES[target as Night]);
  const dinners = (n: number) => `${n} dinner${n === 1 ? "" : "s"}`;
  switch (check.kind) {
    case "min":
      return `every week at least ${dinners(check.count)} must be "${check.tag}" dishes`;
    case "max":
      return check.count === 0 ? `no dinner in a week may be a "${check.tag}" dish` : `no more than ${dinners(check.count)} in a week may be "${check.tag}" dishes`;
    case "fixed":
      if (check.value === "out") return `${DAY_NAMES[check.night]} is always eating out, so I plan nothing for it`;
      if (check.value === "away") return `${DAY_NAMES[check.night]} dinner is somewhere else, so I plan nothing for it`;
      return `${DAY_NAMES[check.night]} is always a "${check.value}" dish`;
    case "require":
      return `every home-cooked dinner on ${nightsText(check.nights)} must be a "${check.tag}" dish`;
    case "forbid":
      return `no dinner on ${nightsText(check.nights)} may be a "${check.tag}" dish`;
    case "advisory":
      return "nothing to check";
  }
}

export interface ReadBackOptions {
  revision: number;
  weeknights: readonly Night[];
  previous?: Proposal | null; // the last version shown (or the old profile), for "what changed"
  flags?: string[]; // from validation: "one dish found for ..."
  // Longest chunk, in characters. Items are never split across chunks.
  maxChars?: number;
  mode?: "first-run" | "redo";
}

const DEFAULT_CHUNK = 1400;

export function renderReadBack(proposal: Proposal, options: ReadBackOptions): string[] {
  const blocks: string[][] = [];

  // Rules
  const rules: string[] = [];
  if (proposal.rules.length === 0) rules.push("No house rules yet. I'll plan freely.");
  proposal.rules.forEach((rule, i) => {
    const head = `${i + 1}. ${rule.prose} (${rule.who})`;
    if (rule.check.kind === "advisory") rules.push(`${head}\n   I'll keep it in mind. I can't check this one, so it won't be enforced.`);
    else rules.push(`${head}\n   I'll check this: ${explainCheck(rule.check, options.weeknights)}.`);
  });
  blocks.push(["Your house rules, most important first (the ones at the bottom give way first when a week can't fit them all):", ...rules]);

  // Dishes
  const usual = proposal.dishes.filter((dish) => dish.pool === "usual");
  const alsoLike = proposal.dishes.filter((dish) => dish.pool === "also-like");
  const dishLine = (dish: ProposalDish) => `- ${dish.name}: ${dish.protein}${dish.tags.length > 0 ? `; tags ${dish.tags.join(", ")}` : ""}`;
  const dishBlock: string[] = [];
  if (usual.length > 0) dishBlock.push("Your usual dishes:", ...usual.map(dishLine));
  if (alsoLike.length > 0) dishBlock.push("Dishes you like too:", ...alsoLike.map(dishLine));
  if (dishBlock.length === 0) dishBlock.push("No usual dishes yet. I'll suggest new ones.");
  blocks.push(dishBlock);

  // Everything else
  const rest: string[] = [];
  if (proposal.dislikes.length > 0) rest.push("Won't eat (I'll note these, but they never rule out a dish by themselves):", ...proposal.dislikes.map((d) => `- ${d.person}: ${d.what}`));
  if (proposal.vetoes.length > 0) rest.push("Never again (I won't plan these):", ...proposal.vetoes.map((v) => `- ${v}`));
  if (proposal.staples.length > 0) rest.push(`Always in the house: ${proposal.staples.join(", ")}.`);
  rest.push(
    proposal.sections.length > 0
      ? `Your store sections, in order: ${proposal.sections.join(", ")}.`
      : `Store sections: the standard list (${DEFAULT_GROCERY_SECTIONS.length} sections), since you didn't give me a layout.`,
  );
  if (proposal.notes.length > 0) rest.push("Noted, but nothing for me to save or check:", ...proposal.notes.map((n) => `- ${n}`));
  blocks.push(rest);

  // Defaults, disclosed
  const t = proposal.thresholds;
  const defaults: string[] = [];
  if (proposal.defaults.lockWords) defaults.push(`You lock the week by saying: ${proposal.lockWords.map((w) => `"${w}"`).join(" or ")}.`);
  if (proposal.defaults.thresholds) {
    defaults.push(`Limits I'm starting with: at most ${t.maxUsualDishesPerWeek} usual dishes a week, no protein on more than ${t.maxNightsPerProtein} nights, and no repeating a dish within ${t.repeatWindowWeeks} weeks.`);
  }
  defaults.push('A dish counts for a rule if its protein or its tags match (a "chicken" dish counts as "chicken").');
  if (defaults.length > 0) blocks.push(["Things I filled in myself:", ...defaults, "You can change any of this later."]);

  // Flags and changes
  if (options.flags && options.flags.length > 0) blocks.push(["Worth knowing:", ...options.flags.map((flag) => `- ${flag}`)]);
  const changes = diffProposals(options.previous ?? null, proposal);
  if (options.previous) blocks.push(changes.length > 0 ? ["What changed since the last version:", ...changes.map((c) => `- ${c}`)] : ["Nothing changed since the last version."]);

  const footer = `Version ${options.revision}. Nothing is saved yet. Say "save it" to save these, or tell me what to change.`;
  return packChunks(blocks, footer, options.maxChars ?? DEFAULT_CHUNK);
}

// ---------------------------------------------------------------------------------------------
// The confirm question
// ---------------------------------------------------------------------------------------------

// The confirm question, asked when "save it" can't be tied to the read-back that was just shown.
// It shows what would be saved (every rule in the adults' words with its check explained, then a
// short list of dishes, dislikes, never-agains and staples), so a "save it" in answer to it
// approves something they have actually read. Split into chunks if it is long.
export function renderSnapshot(proposal: Proposal, options: { weeknights: readonly Night[]; maxChars?: number }): string[] {
  const blocks: string[][] = [];

  const rules: string[] = [];
  if (proposal.rules.length === 0) rules.push("No house rules. I'll plan freely.");
  proposal.rules.forEach((rule, i) => {
    const how = rule.check.kind === "advisory" ? "I'll only keep it in mind (I can't check it)" : `I'll check this: ${explainCheck(rule.check, options.weeknights)}`;
    rules.push(`${i + 1}. ${rule.prose}\n   ${how}.`);
  });
  blocks.push([`Save these rules: ${snapshotSummary(proposal)}? This is exactly what I'd save.`, ...rules]);

  const dish = (d: ProposalDish) => `- ${d.name}: ${d.protein}${d.tags.length > 0 ? `; ${d.tags.join(", ")}` : ""}`;
  const usual = proposal.dishes.filter((d) => d.pool === "usual");
  const alsoLike = proposal.dishes.filter((d) => d.pool === "also-like");
  if (usual.length > 0) blocks.push(["Usual dishes:", ...usual.map(dish)]);
  if (alsoLike.length > 0) blocks.push(["Dishes you like too:", ...alsoLike.map(dish)]);
  if (proposal.dislikes.length > 0) blocks.push(["Won't eat:", ...proposal.dislikes.map((d) => `- ${d.person}: ${d.what}`)]);
  if (proposal.vetoes.length > 0) blocks.push(["Never again:", ...proposal.vetoes.map((v) => `- ${v}`)]);
  if (proposal.staples.length > 0) blocks.push(["Always in the house:", ...wrapList(proposal.staples, 300)]);

  const rest: string[] = [
    proposal.sections.length > 0 ? `Store sections: ${proposal.sections.join(", ")}.` : "Store sections: the standard list.",
    `Lock words: ${proposal.lockWords.map((w) => `"${w}"`).join(" or ")}.`,
    `Limits: at most ${proposal.thresholds.maxUsualDishesPerWeek} usual dishes a week, no protein on more than ${proposal.thresholds.maxNightsPerProtein} nights, no repeating a dish within ${proposal.thresholds.repeatWindowWeeks} weeks.`,
  ];
  blocks.push(rest);

  const footer = 'Say "save it" to save exactly this, or tell me what to change.';
  return packChunks(blocks, footer, options.maxChars ?? DEFAULT_CHUNK);
}

// A comma list as several lines, so a long list can be split between chunks.
function wrapList(items: string[], maxChars: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    const next = current === "" ? item : `${current}, ${item}`;
    if (current !== "" && next.length > maxChars) {
      lines.push(`${current},`);
      current = item;
    } else {
      current = next;
    }
  }
  if (current !== "") lines.push(`${current}.`);
  return lines;
}

// Packs blocks into message-sized chunks. A block's lines stay together where they fit; a very
// long block is split between lines, never inside one. Chunks are numbered when there are several.
function packChunks(blocks: string[][], footer: string, maxChars: number): string[] {
  const pieces: string[] = [];
  for (const block of blocks) {
    // The first line of a block is its heading; keep it with the line after it.
    let current = "";
    for (let i = 0; i < block.length; i++) {
      const line = block[i]!;
      const lead = i === 0 && block.length > 1 ? `${line}\n${block[++i]!}` : line;
      if (current !== "" && current.length + 1 + lead.length > maxChars) {
        pieces.push(current);
        current = lead;
      } else {
        current = current === "" ? lead : `${current}\n${lead}`;
      }
    }
    if (current !== "") pieces.push(current);
  }

  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current !== "" && current.length + 2 + piece.length > maxChars) {
      chunks.push(current);
      current = piece;
    } else {
      current = current === "" ? piece : `${current}\n\n${piece}`;
    }
  }
  if (current !== "") chunks.push(current);
  if (chunks.length > 0 && chunks[chunks.length - 1]!.length + 2 + footer.length <= maxChars) chunks[chunks.length - 1] += `\n\n${footer}`;
  else chunks.push(footer);

  return chunks.length === 1 ? chunks : chunks.map((chunk, i) => `(${i + 1} of ${chunks.length})\n${chunk}`);
}
