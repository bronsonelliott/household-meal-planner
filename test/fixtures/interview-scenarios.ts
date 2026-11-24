// Reusable pieces of the interview stories: how the "model" reads the usual answers, and a
// household taken to the first read-back.

import type { ExtractionResult, OnboardingExtractRequest } from "../../src/onboarding/state.ts";
import { InterviewHarness } from "./interview-harness.ts";
import { add, extraction } from "./onboarding-fixtures.ts";

// Boots a household and registers it, so the test file's afterEach can stop it.
export async function start(options: ConstructorParameters<typeof InterviewHarness>[0], registry: InterviewHarness[]): Promise<InterviewHarness> {
  const h = new InterviewHarness(options);
  registry.push(h);
  await h.boot();
  return h;
}

// The model's reading of a batch, built from the batch's own messages (their IDs are made at run time).
export function reading(build: (batch: OnboardingExtractRequest["batch"], request: OnboardingExtractRequest) => Partial<ExtractionResult>) {
  return (request: OnboardingExtractRequest) => ({ ok: true as const, result: extraction(build(request.batch, request)) });
}

// Alex's first answer covers two topics at once (the calendar and how they like to eat), so the
// "habits" question is never asked.
export function alexNightsAndHabits() {
  return reading((batch) => ({
    additions: [
      add(batch[0]!, "nights", "Friday is eating out.", { kind: "rule", check: { kind: "fixed", night: "friday", value: "out" } }),
      add(batch[0]!, "nights", "Weeknight dinners need to be quick", { kind: "rule", check: { kind: "require", tag: "quick", nights: "weeknights" } }),
      add(batch[0]!, "habits", "chicken at least once a week", { kind: "rule", check: { kind: "min", tag: "chicken", count: 1 } }),
    ],
    topicsCovered: ["nights", "habits"],
  }));
}

export function dinners() {
  return reading((batch) => ({
    additions: [
      add(batch[0]!, "dinners", "Chicken tacos", { kind: "dish", name: "Chicken tacos", protein: "chicken", tags: ["quick", "mexican"], pool: "usual" }),
      add(batch[0]!, "dinners", "Spaghetti and meatballs", { kind: "dish", name: "Spaghetti and meatballs", protein: "beef", tags: ["pasta", "red-meat"], pool: "usual" }),
    ],
    topicsCovered: ["dinners"],
  }));
}

// Gets a fresh household to the first read-back: nights and habits in one answer, the dinners,
// then "skip" for the last two questions (no model call for those).
export async function reachProposal(h: InterviewHarness): Promise<void> {
  h.reads(alexNightsAndHabits());
  await h.say("Alex", "Friday is eating out. Weeknight dinners need to be quick. Chicken at least once a week.");
  h.reads(dinners());
  await h.say("Sam", "Chicken tacos and spaghetti and meatballs are our usual.");
  await h.say("Alex", "skip");
  await h.say("Sam", "skip");
}

// One answer that settles every question: a Friday rule, and "nothing special" for the rest.
export function everythingInOneAnswer() {
  return reading((batch) => ({
    additions: [
      add(batch[0]!, "nights", "Friday is eating out.", { kind: "rule", check: { kind: "fixed", night: "friday", value: "out" } }),
      add(batch[0]!, "habits", "nothing special for habits", { kind: "note" }),
      add(batch[0]!, "dinners", "nothing special for dinners", { kind: "note" }),
      add(batch[0]!, "wont-eat", "nothing special for wont-eat", { kind: "note" }),
      add(batch[0]!, "staples", "nothing special for staples", { kind: "note" }),
    ],
    topicsCovered: ["nights", "habits", "dinners", "wont-eat", "staples"],
  }));
}
