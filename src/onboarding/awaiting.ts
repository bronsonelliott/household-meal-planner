// "Awaiting profile": the first-run interview has not produced a profile yet, so there is nothing
// to draft from. The scheduler uses it to wait politely (one reminder per week instead of failed
// drafts), and the health check uses it to stay quiet while setup is verifiably in progress.
//
// "Verifiably" matters: the state file must exist and be readable. A missing profile with no
// interview behind it is a real problem and is not called awaiting.

import { readProfileStatus } from "../data/profile.ts";
import { loadOnboardingState, onboardingStatePath } from "./state.ts";

export interface AwaitingInput {
  stateDir: string;
  profilePath: string;
  dryRun: boolean;
}

export function awaitingProfile(input: AwaitingInput): boolean {
  if (readProfileStatus(input.profilePath).kind !== "setup-needed") return false;
  const loaded = loadOnboardingState(onboardingStatePath(input.stateDir, input.dryRun));
  if (loaded.kind !== "ok" || loaded.state.mode !== "first-run") return false;
  // A finished practice run (dry run) wrote no profile, so it is still waiting for a real one.
  return loaded.state.phase !== "done" || input.dryRun;
}

// The reason the interview's state file cannot be used, or null when it is fine or absent.
export function onboardingStateProblem(stateDir: string, dryRun: boolean): string | null {
  const loaded = loadOnboardingState(onboardingStatePath(stateDir, dryRun));
  return loaded.kind === "corrupt" ? loaded.message : null;
}
