// A small client for the Telegram Bot API, over plain fetch.
//
// Every call is a POST to <base>/bot<token>/<method> with a JSON body. The token is part of that
// URL, so this file is careful never to let the URL, or the token, reach a log line or an error
// message: anything we report goes through redact() first.

import { blankOut } from "../../secrets.ts";
import { DRY_RUN_DETAIL } from "../dry-run.ts";

// What one call came back as. Nothing here throws: the caller decides what each answer means.
export type ApiAnswer =
  | { kind: "ok"; result: any }
  // Telegram answered, and said no. `parameters` can hold retry_after (rate limit) or
  // migrate_to_chat_id (the group was upgraded to a supergroup).
  | { kind: "api-error"; httpStatus: number; errorCode: number; description: string; parameters: { retry_after?: number; migrate_to_chat_id?: number } }
  // No answer in time. The request may or may not have been acted on.
  | { kind: "timeout" }
  // The connection failed. `notSent` is true when it failed before anything left this machine
  // (could not connect, could not look the address up), so we know Telegram never saw it.
  | { kind: "network-error"; message: string; notSent: boolean }
  // Our own side cancelled the call (the bridge is stopping).
  | { kind: "aborted" }
  // Dry run: this call would have sent something, so it was not made.
  | { kind: "dry-run" };

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

// Signs of "could not even connect" in the errors Bun and Node raise.
const NOT_SENT_HINTS = ["ConnectionRefused", "ECONNREFUSED", "ENOTFOUND", "Unable to connect", "FailedToOpenSocket"];

// The Bot API methods that put something in front of a person.
const SENDING_METHODS = new Set(["sendMessage", "setMessageReaction"]);

export class TelegramApi {
  private baseUrl: string;

  constructor(
    private token: string,
    baseUrl: string,
    private defaultTimeoutMs: number,
    private dryRun = false,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  // Removes the token (and the way it appears inside a URL) from any text we are about to show.
  redact(text: string): string {
    return blankOut(text, [this.token], "<token>");
  }

  async call(method: string, params: Record<string, unknown> = {}, options: CallOptions = {}): Promise<ApiAnswer> {
    if (this.dryRun && SENDING_METHODS.has(method)) return { kind: "dry-run" };
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.defaultTimeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal,
      });
    } catch (error) {
      return this.sortFetchError(error, timeout, options.signal);
    }

    let body: any = null;
    try {
      body = await response.json();
    } catch (error) {
      // An HTML error page from a proxy, or a connection cut while the body was coming.
      if (signal.aborted) return this.sortFetchError(error, timeout, options.signal);
    }

    if (body?.ok === true) return { kind: "ok", result: body.result };
    return {
      kind: "api-error",
      httpStatus: response.status,
      errorCode: typeof body?.error_code === "number" ? body.error_code : response.status,
      description: this.redact(String(body?.description ?? `HTTP ${response.status}`)),
      parameters: body?.parameters ?? {},
    };
  }

  private sortFetchError(error: unknown, timeout: AbortSignal, outside?: AbortSignal): ApiAnswer {
    if (outside?.aborted) return { kind: "aborted" };
    if (timeout.aborted) return { kind: "timeout" };
    const message = this.redact(String((error as Error)?.message ?? error));
    const code = String((error as any)?.code ?? "");
    const notSent = NOT_SENT_HINTS.some((hint) => code.includes(hint) || message.includes(hint));
    return { kind: "network-error", message, notSent };
  }
}

// One plain sentence for a log line or an error.
export function describeAnswer(answer: ApiAnswer): string {
  switch (answer.kind) {
    case "ok":
      return "ok";
    case "api-error":
      return `Telegram said ${answer.errorCode}: ${answer.description}`;
    case "timeout":
      return "Telegram did not answer in time";
    case "network-error":
      return `network error: ${answer.message}`;
    case "aborted":
      return "cancelled";
    case "dry-run":
      return DRY_RUN_DETAIL;
  }
}
