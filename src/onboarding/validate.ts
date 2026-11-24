// Checks a proposed profile before any adult sees it, in plain words.
//
//   problems  things that cannot work as written. The interview does not read these back as a
//             proposal; it asks the adults to fix them first.
//   flags     things worth saying out loud, such as "only one dish found for fish". They go in the
//             read-back and never block it.
//
// Only structure is checked here. Whether a week can really be built still depends on the model
// and the recipes; "one dish found" is a heads-up, not a promise either way. A checked rule is
// never quietly turned into an advisory one: if a rule can't be checked, the interview says so and
// the adults approve it as an advisory.

import { NIGHTS, ProfileError, parseProfile, type Night, type NightTarget, type Rule } from "../data/profile.ts";
import { capGroupOf, dishCountsFor } from "../recipes/protein.ts";
import { renderProfile } from "./render.ts";
import type { Proposal } from "./state.ts";

export interface ValidationSettings {
  weeknights: readonly Night[]; // what "weeknights" means (planning.weeknights)
  minDiscoveryNights: number; // nights a draft must give to a dish the house hasn't had lately
}

export interface Validation {
  problems: string[];
  flags: string[];
}

// A dish as far as these checks care: its protein, and the groups that protein belongs to
// (beef -> red-meat), count as tags too.
export interface TaggedDish {
  name: string;
  protein: string;
  tags: string[];
}

export function dishCarries(dish: TaggedDish, tag: string): boolean {
  return dishCountsFor(dish.protein, dish.tags, tag);
}

// The tag a rule needs some dish to carry, if it is a "positive" rule: one that can only be met
// by a dish with that tag. "out" and "away" nights need no dish, and "max" and "forbid" rules ask
// for none.
export function neededTag(rule: Rule): string | null {
  const check = rule.check;
  if (check.kind === "min" && check.count > 0) return check.tag;
  if (check.kind === "require") return check.tag;
  if (check.kind === "fixed" && check.value !== "out" && check.value !== "away") return check.value;
  return null;
}

export interface TagCoverage {
  rule: Rule;
  tag: string;
  dishes: string[]; // names of the dishes that carry the tag
}

export function tagCoverage(rules: readonly Rule[], dishes: readonly TaggedDish[]): TagCoverage[] {
  const out: TagCoverage[] = [];
  for (const rule of rules) {
    const tag = neededTag(rule);
    if (tag === null) continue;
    out.push({ rule, tag, dishes: dishes.filter((dish) => dishCarries(dish, tag)).map((dish) => dish.name) });
  }
  return out;
}

// For `bun run doctor`: rules that name a tag no dish carries.
export function tagCoverageWarnings(rules: readonly Rule[], dishes: readonly TaggedDish[]): string[] {
  return tagCoverage(rules, dishes)
    .filter((entry) => entry.dishes.length === 0)
    .map((entry) => `The rule "${entry.rule.prose}" needs a dish tagged "${entry.tag}", and none of your dishes has that tag (a dish's protein, and the group it belongs to such as red-meat or seafood, count as tags). The bot will have to invent dishes for it. Add "${entry.tag}" to the Tags: line of a dish that fits.`);
}

function nightsOf(target: NightTarget, weeknights: readonly Night[]): Night[] {
  return target === "weeknights" ? [...weeknights] : [target];
}

export function validateProposal(proposal: Proposal, settings: ValidationSettings): Validation {
  const problems: string[] = [];
  const flags: string[] = [];
  const rules: Rule[] = proposal.rules.map((rule) => ({ prose: rule.prose, check: rule.check }));
  const quote = (rule: Rule) => `"${rule.prose}"`;

  // 1. The profile must read back through the real parser, so every check really parses.
  try {
    const parsed = parseProfile(renderProfile(proposal));
    if (parsed.rules.length !== rules.length) problems.push("Some rules would not survive being saved. Please say them again in other words.");
  } catch (error) {
    problems.push(error instanceof ProfileError ? error.message : (error as Error).message);
  }

  // 2. Tags: a rule that needs a dish with a tag needs one in the list.
  for (const entry of tagCoverage(rules, proposal.dishes)) {
    if (entry.dishes.length === 0) {
      problems.push(`The rule ${quote(entry.rule)} needs a dish tagged "${entry.tag}", and none of the dishes so far has that tag. Tell me a dish that fits, or we can drop the rule.`);
    } else if (entry.dishes.length === 1) {
      flags.push(`One dish found for "${entry.tag}" (${entry.dishes[0]}), for the rule ${quote(entry.rule)}. That may not give much variety.`);
    } else if (entry.rule.check.kind === "min" && entry.rule.check.count > entry.dishes.length) {
      flags.push(`The rule ${quote(entry.rule)} asks for ${entry.rule.check.count}, and I found ${entry.dishes.length} dishes tagged "${entry.tag}". I can look for new ones that fit.`);
    }
  }

  // 3. Two rules that fix the same night to different things.
  const fixed = rules.flatMap((rule) => (rule.check.kind === "fixed" ? [{ rule, night: rule.check.night, value: rule.check.value }] : []));
  for (const night of NIGHTS) {
    const here = fixed.filter((entry) => entry.night === night);
    const values = new Set(here.map((entry) => entry.value));
    if (values.size > 1) {
      problems.push(`${here.map((entry) => quote(entry.rule)).join(" and ")} set ${cap(night)} dinner to different things. Which one do you want?`);
    }
  }

  // 4. A rule that requires a tag where another forbids it (or a fixed night is forbidden).
  const requires = rules.flatMap((rule) => (rule.check.kind === "require" ? [{ rule, tag: rule.check.tag, nights: nightsOf(rule.check.nights, settings.weeknights) }] : []));
  const forbids = rules.flatMap((rule) => (rule.check.kind === "forbid" ? [{ rule, tag: rule.check.tag, nights: nightsOf(rule.check.nights, settings.weeknights) }] : []));
  for (const need of requires) {
    for (const ban of forbids) {
      const shared = need.nights.filter((night) => ban.nights.includes(night));
      if (need.tag === ban.tag && shared.length > 0) {
        problems.push(`${quote(need.rule)} requires "${need.tag}" on ${listNights(shared)}, but ${quote(ban.rule)} forbids it there.`);
      }
    }
  }
  for (const entry of fixed) {
    for (const ban of forbids) {
      if (entry.value === ban.tag && ban.nights.includes(entry.night)) {
        problems.push(`${quote(entry.rule)} sets ${cap(entry.night)} to "${entry.value}", but ${quote(ban.rule)} forbids that on ${cap(entry.night)}.`);
      }
    }
  }

  // 5 and 6. Minimums against maximums, and against the nights that are left.
  const awayNights = new Set(fixed.filter((entry) => entry.value === "out" || entry.value === "away").map((entry) => entry.night));
  const homeNights = NIGHTS.filter((night) => !awayNights.has(night));
  for (const rule of rules) {
    if (rule.check.kind !== "min") continue;
    const { tag, count } = rule.check;
    for (const other of rules) {
      if (other.check.kind === "max" && other.check.tag === tag && count > other.check.count) {
        problems.push(`${quote(rule)} wants at least ${count} "${tag}" dinners, but ${quote(other)} allows at most ${other.check.count}.`);
      }
    }
    const banned = new Set(forbids.filter((ban) => ban.tag === tag).flatMap((ban) => ban.nights));
    const eligible = homeNights.filter((night) => !banned.has(night));
    if (count > eligible.length) {
      problems.push(`${quote(rule)} wants at least ${count} "${tag}" dinners, but only ${eligible.length} night${eligible.length === 1 ? "" : "s"} are left once the eating-out, away and forbidden nights are taken out.`);
    }
  }

  // 7. A protein asked for more nights than any one protein may be served.
  const cap_ = proposal.thresholds.maxNightsPerProtein;
  for (const rule of rules) {
    if (rule.check.kind !== "min") continue;
    const { tag, count } = rule.check;
    const carrying = proposal.dishes.filter((dish) => dishCarries(dish, tag));
    // "fish" is one protein for the cap, however many fish species the dishes use.
    const isThatProtein = (dish: TaggedDish) => dish.protein.toLowerCase() === tag.toLowerCase() || capGroupOf(dish.protein) === tag.toLowerCase();
    const isProtein = carrying.some(isThatProtein);
    const onlyThatProtein = carrying.every(isThatProtein);
    if (isProtein && onlyThatProtein && count > cap_) {
      problems.push(`${quote(rule)} wants ${tag} on at least ${count} nights, but the limit is ${cap_} nights for any one protein.`);
    }
  }

  // 7b. Nights that fixed and require rules already force onto one protein, against the same limit.
  // "fixed friday chicken" and "require chicken weeknights" both fill nights with chicken; a min
  // rule only adds nights beyond those. (Rule 7 above covers a min rule on its own.)
  const proteins = new Set(proposal.dishes.map((dish) => capGroupOf(dish.protein)).filter((protein) => protein !== ""));
  for (const protein of proteins) {
    const forced = new Set<Night>();
    const sources: Rule[] = [];
    for (const entry of fixed) {
      if (capGroupOf(entry.value) === protein) {
        forced.add(entry.night);
        sources.push(entry.rule);
      }
    }
    for (const need of requires) {
      if (capGroupOf(need.tag) === protein) {
        for (const night of need.nights) forced.add(night);
        sources.push(need.rule);
      }
    }
    if (forced.size === 0) continue;
    const mins = rules.flatMap((rule) => (rule.check.kind === "min" && capGroupOf(rule.check.tag) === protein ? [rule.check.count] : []));
    const total = Math.max(forced.size, ...mins);
    if (total > cap_) {
      const named = sources.map(quote).join(" and ");
      problems.push(`${named} would put ${protein} on ${total} nights (${listNights([...forced])} are already set), but the limit is ${cap_} nights for any one protein.`);
    }
  }

  // 8. New dishes need nights to land on.
  const home = homeNights.length;
  if (settings.minDiscoveryNights > home) {
    problems.push(`Each week needs at least ${settings.minDiscoveryNights} night${settings.minDiscoveryNights === 1 ? "" : "s"} with a dish you haven't had lately, but only ${home} night${home === 1 ? " is" : "s are"} left after eating out and away nights.`);
  }

  // A heads-up on piling on checks.
  const checked = rules.filter((rule) => rule.check.kind !== "advisory").length;
  if (checked > 8) flags.push(`That's ${checked} checked rules. Seven nights only hold so many; the rules at the bottom of the list give way first.`);

  return { problems, flags };
}

function cap(night: string): string {
  return night.charAt(0).toUpperCase() + night.slice(1);
}

function listNights(nights: Night[]): string {
  const names = nights.map(cap);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
