// Small builders for the house-rules interview tests: two adults, messages, and extraction results.

import {
  applyExtraction,
  emptyExtraction,
  newOnboardingState,
  type Addition,
  type BatchMessage,
  type ExtractionResult,
  type FactDetail,
  type OnboardingState,
  type TopicId,
} from "../../src/onboarding/state.ts";

export const NOW = new Date("2026-03-02T18:00:00Z");

export function msg(id: string, who: "Alex" | "Sam", text: string): BatchMessage {
  return { id, memberId: who.toLowerCase(), memberName: who, text };
}

export function add(message: BatchMessage, topic: TopicId, wording: string, detail: FactDetail): Addition {
  return { messageId: message.id, topic, wording, detail };
}

export function extraction(parts: Partial<ExtractionResult>): ExtractionResult {
  return { ...emptyExtraction(), ...parts };
}

export function freshState(mode: "first-run" | "redo" = "first-run"): OnboardingState {
  return newOnboardingState(mode, "none", NOW);
}

// Applies one batch and returns just the new state.
export function applied(state: OnboardingState, batch: BatchMessage[], result: ExtractionResult): OnboardingState {
  return applyExtraction(state, batch, result, NOW).state;
}
