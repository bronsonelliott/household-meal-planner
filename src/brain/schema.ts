// The change-set schema: the model's JSON answer, checked field by field before
// the harness uses any of it.
//
// The prompt asks for structured output; nothing here trusts it. Every problem is collected as
// one plain line, so the one retry can quote them all back to the model. The types the result
// is checked into are in changeset.ts; this file adds only the model's reply and the rules
// it says it had to drop.

import { NIGHTS, matchGrocerySection, type IngredientLine, type Night, type NightTarget, type RuleCheck } from "../data/profile.ts";
import { ACTIONS, type Action, type ChangeSet, type DishChoice, type IngredientFill, type IngredientRequest, type NightChange, type Operation } from "../week/changeset.ts";
import type { BrainReply } from "../week/worker.ts";

export interface ModelOutput {
  changeSet: ChangeSet;
  reply: BrainReply;
  droppedRules: string[]; // rules the model could not fit, from the bottom of the list
  // Rules or caps an adult set aside for this week, each citing the message that asked.
  setAside: Array<{ rule: string; sourceMessageId: string }>;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; problems: string[] };

// A profile dish may carry the model's tags, used only to fill a tag the profile entry lacks
//. The worker never sees them: stripModelOnlyFields removes them.
interface ProfileChoiceWithTags {
  kind: "profile";
  name: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------------------------
// Getting the JSON out of the answer
// ---------------------------------------------------------------------------------------------

// The model may wrap its JSON in a code fence or add a sentence around it; take the outermost
// object.
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; problem: string } {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end < start) return { ok: false, problem: "the answer was not valid JSON: it has no JSON object in it" };
  try {
    return { ok: true, value: JSON.parse(trimmed.slice(start, end + 1)) };
  } catch (error) {
    return { ok: false, problem: `the answer was not valid JSON: ${(error as Error).message}` };
  }
}

// ---------------------------------------------------------------------------------------------
// Small field checks. Each returns the cleaned value, or null after noting a problem.
// ---------------------------------------------------------------------------------------------

type Problems = string[];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Model strings end up as single lines in profile.md and the log, where a line starting "## "
// begins a new section. A value with a line break in it could slip in its own heading (say
// "## Lock Words") and take over that section, so every string field must be one line. The
// two Unicode separators count too: some editors show them as line breaks.
const LINE_BREAK = /[\r\n\u2028\u2029]/;

// A one-line, non-empty string, trimmed. Ingredient lines go through here as well.
function text(value: unknown, where: string, problems: Problems): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`${where} must be a non-empty string`);
    return null;
  }
  const clean = value.trim();
  if (LINE_BREAK.test(clean)) {
    problems.push(`${where} must be one line, with no line breaks`);
    return null;
  }
  return clean;
}

function stringList(value: unknown, where: string, problems: Problems, options: { required: boolean }): string[] | null {
  if (value === undefined && !options.required) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    problems.push(`${where} must be a list of strings`);
    return null;
  }
  const items = value.map((item: string) => item.trim()).filter((item) => item !== "");
  if (items.some((item) => LINE_BREAK.test(item))) {
    problems.push(`${where} must hold one-line strings, with no line breaks`);
    return null;
  }
  return items;
}

// Tags are one lowercase word each, the same form the profile file uses.
function tagList(value: unknown, where: string, problems: Problems): string[] | null {
  const tags = stringList(value, where, problems, { required: false });
  if (!tags) return null;
  const clean = tags.map((tag) => tag.toLowerCase());
  const spaced = clean.filter((tag) => /\s/.test(tag));
  if (spaced.length > 0) {
    problems.push(`${where} has tags with spaces (${spaced.join(", ")}); a tag is one word, like "big-cook"`);
    return null;
  }
  return clean;
}

function night(value: unknown, where: string, problems: Problems): Night | null {
  const lower = typeof value === "string" ? value.trim().toLowerCase() : "";
  if ((NIGHTS as readonly string[]).includes(lower)) return lower as Night;
  problems.push(`${where} must be one of ${NIGHTS.join(", ")}`);
  return null;
}

function ingredientLines(value: unknown, where: string, problems: Problems, sections: readonly string[]): IngredientLine[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push(`${where} must be a list of {"section", "text"} lines`);
    return null;
  }
  const lines: IngredientLine[] = [];
  let ok = true;
  value.forEach((line, i) => {
    const at = `${where}[${i}]`;
    if (!isObject(line)) {
      problems.push(`${at} must be an object with "section" and "text"`);
      ok = false;
      return;
    }
    const sectionName = typeof line.section === "string" ? line.section.trim() : "";
    const section = matchGrocerySection(sections, sectionName);
    if (!section) {
      problems.push(`${at}: "${String(line.section)}" is not one of the grocery sections (use one of: ${sections.join(", ")})`);
      ok = false;
    }
    const lineText = text(line.text, `${at}.text`, problems); // also rejects line breaks
    if (!lineText) ok = false;
    if (section && lineText) lines.push({ section, text: lineText });
  });
  return ok ? lines : null;
}

function dishChoice(value: unknown, where: string, problems: Problems, sections: readonly string[]): DishChoice | null {
  if (!isObject(value)) {
    problems.push(`${where} must be an object with a "kind"`);
    return null;
  }
  const before = problems.length;
  switch (value.kind) {
    case "out":
    case "away":
      return { kind: value.kind };
    case "profile": {
      const name = text(value.name, `${where}.name`, problems);
      const tags = tagList(value.tags, `${where}.tags`, problems);
      if (problems.length > before || !name || !tags) return null;
      const choice: ProfileChoiceWithTags = tags.length > 0 ? { kind: "profile", name, tags } : { kind: "profile", name };
      return choice;
    }
    case "catalog": {
      const id = text(value.id, `${where}.id`, problems);
      const tags = tagList(value.tags, `${where}.tags`, problems);
      if (problems.length > before || !id || !tags) return null;
      return { kind: "catalog", id, tags };
    }
    case "source": {
      const sourceId = text(value.sourceId, `${where}.sourceId`, problems);
      const name = text(value.name, `${where}.name`, problems);
      const tags = tagList(value.tags, `${where}.tags`, problems);
      const protein = value.protein === undefined ? undefined : text(value.protein, `${where}.protein`, problems);
      if (problems.length > before || !sourceId || !name || !tags || protein === null) return null;
      const choice: Extract<DishChoice, { kind: "source" }> = { kind: "source", sourceId, name, tags };
      if (protein !== undefined) choice.protein = protein.toLowerCase();
      return choice;
    }
    case "new": {
      const name = text(value.name, `${where}.name`, problems);
      const protein = text(value.protein, `${where}.protein`, problems);
      const tags = tagList(value.tags, `${where}.tags`, problems);
      const ingredients = ingredientLines(value.ingredients, `${where}.ingredients`, problems, sections);
      if (problems.length > before || !name || !protein || !tags || !ingredients) return null;
      return { kind: "new", name, protein: protein.toLowerCase(), tags, ingredients };
    }
    default:
      problems.push(`${where}.kind must be one of profile, catalog, source, new, out, away`);
      return null;
  }
}

function nightChanges(value: unknown, where: string, problems: Problems, sections: readonly string[]): NightChange[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push(`${where} must be a non-empty list of night changes`);
    return null;
  }
  const changes: NightChange[] = [];
  const before = problems.length;
  value.forEach((change, i) => {
    const at = `${where}[${i}]`;
    if (!isObject(change)) {
      problems.push(`${at} must be an object with "night", "rule", and "dish"`);
      return;
    }
    const which = night(change.night, `${at}.night`, problems);
    const rule = typeof change.rule === "string" && change.rule.trim() !== "" ? change.rule.trim() : null;
    if (rule !== null && LINE_BREAK.test(rule)) problems.push(`${at}.rule must be one line, with no line breaks`);
    const dish = dishChoice(change.dish, `${at}.dish`, problems, sections);
    if (which && dish) changes.push({ night: which, dish, rule });
  });
  return problems.length > before ? null : changes;
}

// The typed form of a rule, in the same shape the profile file stores.
function ruleCheck(value: unknown, where: string, problems: Problems): RuleCheck | null {
  if (!isObject(value)) {
    problems.push(`${where} must be an object with a "kind"`);
    return null;
  }
  const before = problems.length;
  const oneWord = (raw: unknown, field: string): string | null => {
    const word = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (word === "" || /\s/.test(word)) {
      problems.push(`${where}.${field} must be one word`);
      return null;
    }
    return word;
  };
  switch (value.kind) {
    case "advisory":
      return { kind: "advisory" };
    case "min":
    case "max": {
      const tag = oneWord(value.tag, "tag");
      const count = value.count;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) problems.push(`${where}.count must be a whole number, 0 or more`);
      if (problems.length > before || !tag) return null;
      return { kind: value.kind, tag, count: count as number };
    }
    case "fixed": {
      const which = night(value.night, `${where}.night`, problems);
      const fixedValue = oneWord(value.value, "value");
      if (!which || !fixedValue) return null;
      return { kind: "fixed", night: which, value: fixedValue };
    }
    case "require":
    case "forbid": {
      const tag = oneWord(value.tag, "tag");
      const target = typeof value.nights === "string" ? value.nights.trim().toLowerCase() : "";
      if (target !== "weeknights" && !(NIGHTS as readonly string[]).includes(target)) {
        problems.push(`${where}.nights must be "weeknights" or a night name`);
      }
      if (problems.length > before || !tag) return null;
      return { kind: value.kind, tag, nights: target as NightTarget };
    }
    default:
      problems.push(`${where}.kind must be one of min, max, fixed, require, forbid, advisory`);
      return null;
  }
}

function operation(value: unknown, where: string, problems: Problems, sections: readonly string[]): Operation | null {
  if (!isObject(value)) {
    problems.push(`${where} must be an object with "action" and "sourceMessageId"`);
    return null;
  }
  const action = value.action as Action;
  if (!(ACTIONS as readonly string[]).includes(action)) {
    problems.push(`${where}.action must be one of ${ACTIONS.join(", ")}`);
    return null;
  }
  const sourceMessageId = text(value.sourceMessageId, `${where}.sourceMessageId`, problems);
  if (!sourceMessageId) return null;
  const base = { sourceMessageId };

  switch (action) {
    case "swap":
    case "pin": {
      const nights = nightChanges(value.nights, `${where}.nights`, problems, sections);
      return nights ? { ...base, action, nights } : null;
    }
    case "lock":
    case "skip":
    case "unskip":
    case "undo":
    case "none":
      return { ...base, action };
    case "rule": {
      const prose = text(value.prose, `${where}.prose`, problems);
      const check = ruleCheck(value.check, `${where}.check`, problems);
      return prose && check ? { ...base, action, prose, check } : null;
    }
    case "veto": {
      const dish = text(value.dish, `${where}.dish`, problems);
      return dish ? { ...base, action, dish } : null;
    }
    case "dislike": {
      const person = text(value.person, `${where}.person`, problems);
      const what = text(value.what, `${where}.what`, problems);
      return person && what ? { ...base, action, person, what } : null;
    }
    case "report": {
      const reportText = text(value.text, `${where}.text`, problems);
      return reportText ? { ...base, action, text: reportText } : null;
    }
    case "remove": {
      const list = value.list;
      if (list !== "rules" && list !== "vetoes") problems.push(`${where}.list must be "rules" or "vetoes"`);
      const removeText = text(value.text, `${where}.text`, problems);
      return (list === "rules" || list === "vetoes") && removeText ? { ...base, action, list, text: removeText } : null;
    }
    case "have": {
      const items = stringList(value.items, `${where}.items`, problems, { required: true });
      if (items && items.length === 0) problems.push(`${where}.items must name at least one thing`);
      return items && items.length > 0 ? { ...base, action, items } : null;
    }
    case "add-dish": {
      const pool = value.pool;
      if (pool !== "usual" && pool !== "also-like") problems.push(`${where}.pool must be "usual" or "also-like"`);
      const dish = isObject(value.dish) ? value.dish : {};
      const name = text(dish.name, `${where}.dish.name`, problems);
      const protein = text(dish.protein, `${where}.dish.protein`, problems);
      const tags = tagList(dish.tags, `${where}.dish.tags`, problems);
      const ingredients = ingredientLines(dish.ingredients, `${where}.dish.ingredients`, problems, sections);
      if ((pool !== "usual" && pool !== "also-like") || !name || !protein || !tags || !ingredients) return null;
      return { ...base, action, pool, dish: { name, protein: protein.toLowerCase(), tags, ingredients } };
    }
  }
}

function reply(value: unknown, problems: Problems): BrainReply | null {
  if (isObject(value) && value.kind === "text" && typeof value.text === "string") return { kind: "text", text: value.text.trim() };
  if (isObject(value) && value.kind === "silent") {
    return { kind: "silent", reason: typeof value.reason === "string" && value.reason.trim() !== "" ? value.reason.trim() : "no reason given" };
  }
  problems.push('reply must be {"kind": "text", "text": "..."} or {"kind": "silent", "reason": "..."}');
  return null;
}

// ---------------------------------------------------------------------------------------------
// The two answers the model gives
// ---------------------------------------------------------------------------------------------

// The answer to a message batch or a weekly draft.
export function parseModelOutput(answer: string, sections: readonly string[]): Parsed<ModelOutput> {
  const json = extractJson(answer);
  if (!json.ok) return { ok: false, problems: [json.problem] };
  const problems: Problems = [];
  const root = json.value;
  if (!isObject(root)) return { ok: false, problems: ["the answer must be one JSON object"] };

  const operations: Operation[] = [];
  if (!Array.isArray(root.operations)) {
    problems.push("operations must be a list (use [] when nothing changes)");
  } else {
    root.operations.forEach((op, i) => {
      const parsed = operation(op, `operations[${i}]`, problems, sections);
      if (parsed) operations.push(parsed);
    });
  }
  const parsedReply = reply(root.reply, problems);
  const droppedRules = stringList(root.droppedRules, "droppedRules", problems, { required: false });
  const setAside = setAsideList(root.setAside, problems);

  if (problems.length > 0 || !parsedReply || !droppedRules || !setAside) return { ok: false, problems };
  return { ok: true, value: { changeSet: { operations }, reply: parsedReply, droppedRules, setAside } };
}

// Optional: [{ "rule": "<exact rule text or cap label>", "sourceMessageId": "<id>" }, ...]
function setAsideList(value: unknown, problems: Problems): ModelOutput["setAside"] | null {
  if (value === undefined) return [];
  const shape = 'setAside must be a list of {"rule": "...", "sourceMessageId": "..."}';
  if (!Array.isArray(value)) {
    problems.push(shape);
    return null;
  }
  const entries: ModelOutput["setAside"] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.rule !== "string" || typeof item.sourceMessageId !== "string") {
      problems.push(shape);
      return null;
    }
    if (LINE_BREAK.test(item.rule.trim())) {
      problems.push("setAside rule must be one line, with no line breaks");
      return null;
    }
    entries.push({ rule: item.rule.trim(), sourceMessageId: item.sourceMessageId.trim() });
  }
  return entries;
}

// The answer to an ingredient request: one fill per requested night, in request order,
// under the dish name the request used.
export function parseIngredientFills(answer: string, requests: IngredientRequest[], sections: readonly string[]): Parsed<IngredientFill[]> {
  const json = extractJson(answer);
  if (!json.ok) return { ok: false, problems: [json.problem] };
  const root = json.value;
  if (!isObject(root) || !Array.isArray(root.fills)) return { ok: false, problems: ['the answer must be {"fills": [...]}'] };

  const problems: Problems = [];
  const fills: IngredientFill[] = [];
  for (const request of requests) {
    const index = root.fills.findIndex(
      (fill) =>
        isObject(fill) &&
        fill.weekOf === request.weekOf &&
        typeof fill.night === "string" &&
        fill.night.toLowerCase() === request.night &&
        typeof fill.dish === "string" &&
        fill.dish.trim().toLowerCase() === request.dish.trim().toLowerCase(),
    );
    const where = `the fill for ${request.night} (${request.dish})`;
    if (index === -1) {
      problems.push(`${where} is missing`);
      continue;
    }
    const lines = ingredientLines((root.fills[index] as Record<string, unknown>).ingredients, `fills[${index}].ingredients`, problems, sections);
    if (lines && lines.length === 0) problems.push(`${where} has no ingredient lines`);
    if (lines && lines.length > 0) fills.push({ weekOf: request.weekOf, night: request.night, dish: request.dish, ingredients: lines });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: fills };
}

// The change set as the worker gets it: a profile dish's model tags are dropped, since the
// worker stores the profile's own tags for it.
export function stripModelOnlyFields(changeSet: ChangeSet): ChangeSet {
  return {
    operations: changeSet.operations.map((op) => {
      if (op.action !== "swap" && op.action !== "pin") return op;
      return {
        ...op,
        nights: op.nights.map((change) =>
          change.dish.kind === "profile" ? { ...change, dish: { kind: "profile", name: change.dish.name } } : change,
        ),
      };
    }),
  };
}
