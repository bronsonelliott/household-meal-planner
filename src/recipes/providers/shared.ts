// What the three recipe providers (TheMealDB, Mealie, Tandoor) have in common.

import { HttpError, type PoliteClient } from "../http.ts";
import type { FetchedRecord, RecipeSource } from "../types.ts";

// A provider problem in plain words, safe to show in chat. Never carries a token.
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ProviderInput {
  source: RecipeSource;
  previous: FetchedRecord[]; // what the catalog holds for this source now
  client: PoliteClient;
  nowIso: string;
}

export interface ProviderRun {
  // The COMPLETE set of recipes this source should have after the refresh.
  records: FetchedRecord[];
  // True when there is more to fetch than this run's budget allowed (TheMealDB), so the next
  // run is due sooner than the usual schedule.
  backlog: boolean;
  // Recipes that could not be read this time (their previous copy was kept when there was one).
  skipped: number;
}

// Asks for JSON. `authHelp` is what to say when the server refuses the login.
export async function getJson(client: PoliteClient, url: string, headers: Record<string, string>, authHelp: string): Promise<unknown> {
  let response;
  try {
    response = await client.get(url, headers);
  } catch (error) {
    if (error instanceof HttpError) throw new ProviderError(error.message);
    throw error;
  }
  if (response.status === 401 || response.status === 403) throw new ProviderError(`The server refused the login (HTTP ${response.status}). ${authHelp}`);
  if (response.status < 200 || response.status >= 300) throw new ProviderError(`The server answered HTTP ${response.status} for ${new URL(url).pathname}.`);
  try {
    return JSON.parse(response.text);
  } catch {
    throw new ProviderError(`The server's answer for ${new URL(url).pathname} was not JSON, so this is probably not the right address.`);
  }
}

// A login problem is never worth retrying item by item.
export function isLoginProblem(error: unknown): boolean {
  return error instanceof ProviderError && error.message.startsWith("The server refused the login");
}

// Counts failures in a row, so a dead server stops a refresh after a few tries instead of
// waiting out a timeout for every single recipe.
export class FailureStreak {
  private streak = 0;
  constructor(private readonly limit: number = 3) {}
  ok(): void {
    this.streak = 0;
  }
  failed(error: unknown): void {
    if (isLoginProblem(error)) throw error;
    this.streak++;
    if (this.streak >= this.limit) {
      throw new ProviderError(`${this.streak} requests in a row failed, so I stopped. Last problem: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// Helpers for reading JSON whose shape we only partly trust.
export function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

// Removes empty and repeated entries, keeping the first spelling and the order.
export function uniqueWords(values: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (value === "" || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    kept.push(value);
  }
  return kept;
}
