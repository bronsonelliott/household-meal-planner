// One plain, tool-less call to the Anthropic Messages API, using the household's own API key.
//
// Every call is a fresh, single-message request: a system prompt, one user message, and no
// `tools` field at all, so the model has nothing to run. If an answer ever contains a tool_use
// block anyway, it is refused. The API key is read from the environment variable named in
// config.toml ([model] apiKeyEnv) on every call, so fixing a key and restarting is all it takes.
//
// This file never logs the key, the request headers, the prompt or the answer, and any error
// text that leaves it is scrubbed of the key first.
//
// Failures come back as a BrainError carrying one of four classes, which the scheduler's failure
// policy switches on:
//   "rate-limit"  a rate limit or overload (HTTP 429 or 529): retry on the scheduler's schedule
//   "auth"        no key, a rejected key (401/403), or billing/credit trouble: the auth stop
//   "parse"       the model answered, but the answer was unusable (set by the brain, and here
//                 for an answer that tried to use a tool or had no text)
//   "other"       anything else: a network failure, a server error, a timeout
//
// Retries: the SDK's own automatic retries are switched off (maxRetries 0), so the only retry
// anywhere is the brain's "at most two attempts per operation".

import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_MODEL } from "../config.ts";

// The model comes from config.toml ([model] id); HMP_MODEL overrides it for one-off tests.
export { DEFAULT_MODEL };

export function modelId(env: Record<string, string | undefined> = process.env): string {
  return env.HMP_MODEL || DEFAULT_MODEL;
}

export const CALL_TIMEOUT_MS = 120_000; // wall-clock abort
export const DEFAULT_MAX_TOKENS = 8192; // room for a full week's draft or ingredient fill
export const DEFAULT_API_KEY_ENV = "ANTHROPIC_API_KEY";

export type BrainErrorClass = "rate-limit" | "auth" | "parse" | "other";

export class BrainError extends Error {
  readonly errorClass: BrainErrorClass;

  constructor(errorClass: BrainErrorClass, message: string) {
    super(message);
    this.name = "BrainError";
    this.errorClass = errorClass;
  }
}

// The part of the SDK's client that this file uses, so tests can hand in a fake. The real
// client fits it.
export interface MessageParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user"; content: string }>;
}

export interface MessageResponse {
  stop_reason?: string | null; // "max_tokens" means the answer was cut off at the limit
  content: Array<{ type: string; text?: string }>;
}

export interface MessagesClient {
  messages: {
    create(params: MessageParams, options?: { signal?: AbortSignal }): Promise<MessageResponse>;
  };
}

// Builds a client for one call. The default makes a real SDK client; tests give a fake.
export type ClientFactory = (apiKey: string) => MessagesClient;

export const realClient: ClientFactory = (apiKey) =>
  new Anthropic({ apiKey, maxRetries: 0 }) as unknown as MessagesClient; // maxRetries 0: see the top of the file

export interface ClaudeCallerOptions {
  model?: string; // default: modelId()
  apiKeyEnv?: string; // the NAME of the variable holding the key; default ANTHROPIC_API_KEY
  maxTokens?: number; // default 8192 (config: [model] maxOutputTokens)
  timeoutMs?: number; // default: CALL_TIMEOUT_MS
  clientFactory?: ClientFactory; // default: the real SDK client
  env?: Record<string, string | undefined>; // where the key is read from; default process.env
}

export interface ModelCall {
  system: string; // prompt.md, inlined
  prompt: string; // the harness-supplied context and messages
  maxTokens?: number; // overrides the configured limit for this call (the auth re-check uses a tiny one)
}

export interface ModelAnswer {
  text: string;
  cutOff?: boolean; // true when the model ran out of output room, so `text` stops mid-answer
}

export type CallModel = (call: ModelCall) => Promise<ModelAnswer>;

export function createClaudeCaller(options: ClaudeCallerOptions = {}): CallModel {
  const model = options.model ?? modelId();
  const keyName = options.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
  const makeClient = options.clientFactory ?? realClient;
  const env = options.env ?? process.env;

  return async (call: ModelCall): Promise<ModelAnswer> => {
    const apiKey = (env[keyName] ?? "").trim();
    if (apiKey === "") {
      throw new BrainError("auth", `The model API key is missing: the environment variable ${keyName} is not set. See docs/model.md.`);
    }

    const abortController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, timeoutMs);

    try {
      const response = await makeClient(apiKey).messages.create(
        {
          model,
          max_tokens: call.maxTokens ?? options.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: call.system,
          messages: [{ role: "user", content: call.prompt }],
          // No `tools` field on purpose: the model gets nothing it could call.
        },
        { signal: abortController.signal },
      );
      const text = answerText(response);
      return response.stop_reason === "max_tokens" ? { text, cutOff: true } : { text };
    } catch (error) {
      if (error instanceof BrainError) throw error;
      if (timedOut) throw new BrainError("other", `The model call timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      throw failureFrom(error, apiKey);
    } finally {
      clearTimeout(timer);
    }
  };
}

// The answer's text blocks joined together. A tool_use block, or no text at all, is refused.
function answerText(response: MessageResponse): string {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  if (blocks.some((block) => block.type === "tool_use")) {
    throw new BrainError("parse", "The model's answer asked to use a tool, which this bot never allows, so I refused it.");
  }
  const text = blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  if (text.trim() === "") throw new BrainError("parse", "The model's answer had no text in it.");
  return text;
}

// Words that mark a billing or credit problem, which a 400 can carry.
const BILLING_TEXT = /credit balance|billing|payment|plans? (&|and) billing/i;

// What the SDK throws (an APIError carries .status; connection errors carry none), sorted into
// our classes. The message is scrubbed of the key before it goes anywhere.
function failureFrom(error: unknown, apiKey: string): BrainError {
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : null;
  const raw = error instanceof Error ? error.message : String(error);
  const text = scrub(raw, apiKey);

  if (status === 401 || status === 403) {
    return new BrainError("auth", `The Anthropic API rejected the API key (HTTP ${status}). Check the key and that its account is in good standing.`);
  }
  if (status === 402 || (status === 400 && BILLING_TEXT.test(text))) {
    return new BrainError("auth", "The Anthropic account has a billing problem (for example, no credit left). Add credit in the Anthropic Console.");
  }
  if (status === 429 || status === 529) {
    return new BrainError("rate-limit", `The model is rate limited or overloaded (HTTP ${status}): ${text}`);
  }
  return new BrainError("other", `The model call failed${status ? ` (HTTP ${status})` : ""}: ${text}`);
}

// Removes the key itself, and anything shaped like an Anthropic key, from text that may be shown.
export function scrub(text: string, apiKey: string): string {
  let clean = apiKey ? text.split(apiKey).join("[key]") : text;
  clean = clean.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[key]");
  return clean;
}
