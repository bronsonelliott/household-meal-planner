// The pure planning half of the worker: which week a night names, what a batch's steps do to
// the weeks, and what a dish the model named resolves to. Nothing here reads or writes a file,
// so a replay after a crash computes exactly what the first run did.

import type { ScheduleConfig } from "../config.ts";
import type { LoggedNight } from "../data/log.ts";
import { NIGHTS, type HouseProfile, type Night } from "../data/profile.ts";
import { capitalize, type ChangeSet, type IngredientFill, type IngredientRequest, type NightChange } from "./changeset.ts";
import { findUsableRecord, proteinOf } from "../recipes/catalog.ts";
import { snapshotOfRecord, snapshotOfSuggestion } from "../recipes/snapshot.ts";
import { findSourceById } from "../recipes/sources.ts";
import type { RecipeContext } from "../recipes/types.ts";
import type { LogAction, Step } from "./journal.ts";
import {
  addHave,
  beforeDraftDeadline,
  describeCatchUp,
  changeNight,
  lockWeek,
  promoteIfComplete,
  shortDate,
  skipWeek,
  unskipWeek,
  weekdayIndex,
  type NightValue,
  type WeekFile,
  type WeekStatus,
} from "./state.ts";

// ---------------------------------------------------------------------------------------------
// Which week a night names. The model never says; the harness decides.
// ---------------------------------------------------------------------------------------------

export type TargetWeek = "current" | "coming" | "ambiguous";

export function resolveTargetWeek(night: Night, messageText: string, today: string, comingStatus: WeekStatus): TargetWeek {
  const text = messageText.toLowerCase().replace(/[‘’]/g, "'");
  const todayIndex = weekdayIndex(today);
  const nightIndex = NIGHTS.indexOf(night);

  // Words that settle it.
  if (new RegExp(`\\bnext ${night}\\b`).test(text) || /\bnext week\b/.test(text)) return "coming";
  if (new RegExp(`\\bthis ${night}\\b`).test(text) || /\bthis week\b/.test(text)) return "current";
  if (/\btonight\b/.test(text) && nightIndex === todayIndex) return "current";
  if (/\btomorrow\b/.test(text) && nightIndex === todayIndex + 1) return "current";

  // A short answer to the one question: "next", "this one", "next Sunday!".
  const shortAnswer = text.trim().match(/^(the )?(this|next)( one| week| [a-z]+day)?[.! ]*$/);
  if (shortAnswer) return shortAnswer[2] === "next" ? "coming" : "current";

  // Once next week's draft has posted, a bare night name means next week.
  if (comingStatus === "drafted" || comingStatus === "locked") return "coming";

  // Before the draft: a night already past this week can only mean next week.
  if (nightIndex < todayIndex) return "coming";
  return "ambiguous";
}

// ---------------------------------------------------------------------------------------------
// Applying steps to weeks: pure, so a replay computes exactly what the first run did
// ---------------------------------------------------------------------------------------------

export interface WeekPlan {
  weeks: Map<string, WeekFile>;
  fragments: Array<string | null>; // one per step
  logActions: LogAction[][]; // one list per step
  changedNights: Map<string, Set<Night>>;
  extras: Map<string, Partial<Record<Night, string>>>; // one-reply notes on conflicting nights
  lockedNow: Set<string>;
  relocked: Set<string>;
  // Weeks where this batch locked, changed a night, or changed the have-list: the only weeks
  // whose grocery list the reply may show or change.
  listTouched: Set<string>;
  // Weeks this batch unskipped before their draft deadline. The worker clears their Friday
  // markers so the scheduler drafts them; a skipped week already counts as posted.
  reopenedForDraft: Set<string>;
}

// The catalog id of the recipe a night came from, as a field to spread into a log entry.
function recipeIdField(value: { recipe?: { recipeId: string | null } | null }): { recipeId?: string } {
  const id = value.recipe?.recipeId;
  return id ? { recipeId: id } : {};
}

export function loggedNights(week: WeekFile): LoggedNight[] {
  const nights: LoggedNight[] = [];
  for (const night of NIGHTS) {
    const value = week.nights[night];
    if (!value) continue;
    nights.push({ day: capitalize(night), dish: value.dish, protein: value.protein ?? "none", swappedFromDraft: value.swappedFromDraft, ...recipeIdField(value) });
  }
  return nights;
}

export function planWeeks(weeksBefore: WeekFile[], steps: Step[], today: string, at: string, schedule: ScheduleConfig): WeekPlan {
  const plan: WeekPlan = {
    weeks: new Map(weeksBefore.map((week) => [week.weekOf, structuredClone(week)])),
    fragments: [],
    logActions: [],
    changedNights: new Map(),
    extras: new Map(),
    lockedNow: new Set(),
    relocked: new Set(),
    listTouched: new Set(),
    reopenedForDraft: new Set(),
  };
  // Who set each night in this batch, in order, to name both adults on a conflict.
  const setters = new Map<string, Array<{ who: string; dish: string }>>();
  const swappedWeeks = new Set<string>();

  const week = (weekOf: string): WeekFile => {
    if (!plan.weeks.has(weekOf)) throw new Error(`the batch names week ${weekOf}, which it did not snapshot`);
    return plan.weeks.get(weekOf)!;
  };

  for (const step of steps) {
    let fragment: string | null = null;
    const actions: LogAction[] = [];

    switch (step.kind) {
      case "night": {
        const result = changeNight(week(step.weekOf), step.night, step.value, { mode: step.mode, who: step.who, today });
        if (result.refused) {
          fragment = result.refused;
          break;
        }
        plan.weeks.set(step.weekOf, result.week);
        plan.listTouched.add(step.weekOf);
        fragment = result.note;
        if (!plan.changedNights.has(step.weekOf)) plan.changedNights.set(step.weekOf, new Set());
        plan.changedNights.get(step.weekOf)!.add(step.night);
        if (step.mode === "swap") swappedWeeks.add(step.weekOf);

        const key = `${step.weekOf}:${step.night}`;
        if (!setters.has(key)) setters.set(key, []);
        setters.get(key)!.push({ who: step.who, dish: step.value.dish });

        const stored = result.week.nights[step.night]!;
        if (stored.changedAfterLock) {
          actions.push({ kind: "change-after-lock", weekOf: step.weekOf, night: step.night, dish: stored.dish, protein: stored.protein ?? "none", ...recipeIdField(stored) });
        }
        break;
      }
      case "lock": {
        const result = lockWeek(week(step.weekOf), at);
        plan.weeks.set(step.weekOf, result.week);
        plan.listTouched.add(step.weekOf);
        if (result.result === "locked") {
          plan.lockedNow.add(step.weekOf);
          fragment = `Locked the week of ${shortDate(step.weekOf)}.`;
          actions.push({ kind: "lock", weekOf: step.weekOf, nights: loggedNights(result.week) });
        } else if (result.result === "already-locked") {
          plan.relocked.add(step.weekOf);
          fragment = `The week of ${shortDate(step.weekOf)} was already locked.`;
        } else {
          fragment = `There's nothing to lock yet: the week of ${shortDate(step.weekOf)} hasn't been drafted. Want me to draft it now?`;
        }
        break;
      }
      case "skip": {
        const result = skipWeek(week(step.weekOf));
        plan.weeks.set(step.weekOf, result.week);
        fragment = result.refused ?? `Skipping the week of ${shortDate(step.weekOf)}. I won't post a draft for it.`;
        break;
      }
      case "unskip": {
        const result = unskipWeek(week(step.weekOf));
        plan.weeks.set(step.weekOf, result.week);
        if (result.refused) {
          fragment = result.refused;
        } else if (beforeDraftDeadline(step.weekOf, Date.parse(at), schedule)) {
          plan.reopenedForDraft.add(step.weekOf);
          fragment = `The week of ${shortDate(step.weekOf)} is back on, and a draft is coming.`;
        } else {
          // Past the catch-up deadline the scheduler no longer drafts, so the nights have to come from us.
          fragment = `The week of ${shortDate(step.weekOf)} is back on, but it's past ${describeCatchUp(schedule)}, so I won't post a draft for it. Tell me the dinners you want.`;
        }
        break;
      }
      case "have":
        plan.weeks.set(step.weekOf, addHave(week(step.weekOf), step.items));
        plan.listTouched.add(step.weekOf);
        break;
      case "report":
        actions.push({ kind: "report", weekOf: step.weekOf, text: step.text });
        fragment = `Logged it under the week of ${shortDate(step.weekOf)}.`;
        break;
      case "say":
        fragment = step.text;
        break;
      case "profile":
      case "command":
        break; // run against the profile and recipe files at apply time
    }
    plan.fragments.push(fragment);
    plan.logActions.push(actions);
  }

  // A swap that filled every night of a pre-draft week is a draft on request.
  for (const weekOf of swappedWeeks) plan.weeks.set(weekOf, promoteIfComplete(week(weekOf)));

  // The later message won; the line names what the earlier adult asked for.
  for (const [key, list] of setters) {
    const last = list[list.length - 1]!;
    const others = list.filter((entry) => entry.who !== last.who);
    if (others.length === 0) continue;
    const [weekOf, night] = key.split(":") as [string, Night];
    const earlier = others[others.length - 1]!;
    if (!plan.extras.has(weekOf)) plan.extras.set(weekOf, {});
    plan.extras.get(weekOf)![night] = `${earlier.who} asked for ${earlier.dish}`;
  }
  return plan;
}

// Nights with no ingredient lines in a locked or current week whose list this batch touches
//. Only those nights go to the model.
export function nightsNeedingIngredients(plan: WeekPlan): IngredientRequest[] {
  const requests: IngredientRequest[] = [];
  for (const week of plan.weeks.values()) {
    if (!plan.listTouched.has(week.weekOf)) continue;
    if (week.status !== "locked" && week.status !== "current") continue;
    for (const night of NIGHTS) {
      const value = week.nights[night];
      if (value && value.kind === "dish" && value.ingredients.length === 0) {
        const recipe = value.recipe;
        const publisherLines = recipe?.ingredientProvenance === "publisher" && recipe.ingredients ? [...recipe.ingredients] : null;
        requests.push({ weekOf: week.weekOf, night, dish: value.dish, pool: value.pool ?? "new", publisherLines });
      }
    }
  }
  return requests;
}

export function injectFills(weeks: Map<string, WeekFile>, fills: IngredientFill[]): void {
  for (const fill of fills) {
    const value = weeks.get(fill.weekOf)?.nights[fill.night];
    // Only fill the dish the lines were asked for, and only if it still has none.
    if (!value || value.dish !== fill.dish || value.ingredients.length > 0) continue;
    value.ingredients = structuredClone(fill.ingredients);
  }
}

// ---------------------------------------------------------------------------------------------
// Dish lookup: the model names profile dishes, catalog recipes (by id) and link sources; the
// harness fills in what the profile, catalog or source knows about them, and copies the recipe
// or link into the night so a later change to the catalog or a source cannot change the week.
// ---------------------------------------------------------------------------------------------

export function resolveDish(
  change: NightChange,
  profile: HouseProfile,
  recipes: RecipeContext,
  changeSet: ChangeSet,
): { value: NightValue } | { problem: string } {
  const choice = change.dish;
  const base = { rule: change.rule };

  switch (choice.kind) {
    case "out":
    case "away":
      return {
        value: { ...base, kind: choice.kind, dish: choice.kind === "out" ? "Out" : "Away", protein: null, tags: [], pool: null, ingredients: [] },
      };
    case "new":
      return {
        value: { ...base, kind: "dish", dish: choice.name, protein: choice.protein.toLowerCase(), tags: choice.tags, pool: "new", ingredients: choice.ingredients },
      };
    case "profile": {
      const wanted = choice.name.trim().toLowerCase();
      const usual = profile.usualDishes.find((dish) => dish.name.toLowerCase() === wanted);
      const alsoLike = profile.alsoLikeDishes.find((dish) => dish.name.toLowerCase() === wanted);
      const dish = usual ?? alsoLike;
      if (dish) {
        return {
          value: { ...base, kind: "dish", dish: dish.name, protein: dish.protein, tags: dish.tags, pool: usual ? "usual" : "also-like", ingredients: dish.ingredients },
        };
      }
      // A dish added to the profile in this same batch ("add fish tacos to the usual dishes, Tuesday").
      for (const op of changeSet.operations) {
        if (op.action === "add-dish" && op.dish.name.trim().toLowerCase() === wanted) {
          return {
            value: { ...base, kind: "dish", dish: op.dish.name, protein: op.dish.protein.toLowerCase(), tags: op.dish.tags, pool: op.pool, ingredients: op.dish.ingredients },
          };
        }
      }
      return { problem: `I couldn't find "${choice.name}" on the usual or also-like dishes, so I left ${capitalize(change.night)} alone.` };
    }
    case "catalog": {
      const record = findUsableRecord(recipes.catalog, choice.id);
      if (!record) return { problem: `I couldn't find that recipe in the saved recipes, so I left ${capitalize(change.night)} alone.` };
      // A fetched recipe's lines have no grocery sections yet, and a bookmark has no lines at all:
      // both are filled in at lock.
      return {
        value: {
          ...base,
          kind: "dish",
          dish: record.name,
          protein: proteinOf(record),
          tags: choice.tags,
          pool: "catalog",
          ingredients: [],
          recipe: snapshotOfRecord(record, recipes.sources),
        },
      };
    }
    case "source": {
      const source = findSourceById(recipes.sources, choice.sourceId);
      if (!source) return { problem: `"${choice.sourceId}" isn't one of the recipe sources, so I left ${capitalize(change.night)} alone.` };
      return {
        value: {
          ...base,
          kind: "dish",
          dish: choice.name,
          protein: (choice.protein ?? "unknown").toLowerCase(),
          tags: choice.tags,
          pool: "source",
          ingredients: [],
          recipe: snapshotOfSuggestion(source, choice.name),
        },
      };
    }
  }
}
