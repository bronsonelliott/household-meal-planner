// A small client for Meta's Graph API (the WhatsApp Cloud API), over plain fetch.
//
// The access token travels in an Authorization header. This file never lets the token or the app
// secret reach a log line or an error message: everything we report goes through redact() first.

import { blankOut } from "../../secrets.ts";
import { DRY_RUN_DETAIL } from "../dry-run.ts";

// What one call came back as. Nothing here throws: the caller decides what each answer means.
export type ApiAnswer =
  | { kind: "ok"; body: any }
  // Meta answered, and said no. `code` is Meta's own error code (190, 131047, ...).
  | { kind: "api-error"; httpStatus: number; code: number | null; subcode: number | null; message: string; retryAfterMs?: number }
  // No answer in time. The request may or may not have been acted on.
  | { kind: "timeout" }
  // The connection failed. `notSent` is true when it failed before anything left this machine.
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

export class GraphApi {
  private baseUrl: string;

  constructor(
    private accessToken: string,
    private secrets: string[], // everything that must never appear in text we show (token, app secret)
    baseUrl: string,
    private version: string,
    private defaultTimeoutMs: number,
    private dryRun = false,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  // Removes every secret from any text we are about to show.
  redact(text: string): string {
    return blankOut(text, [this.accessToken, ...this.secrets], "<secret>");
  }

  // `path` is what comes after the version, like "123456/messages". GET when there is no body.
  async call(path: string, body?: Record<string, unknown>, options: CallOptions = {}): Promise<ApiAnswer> {
    // Every POST here is a text, a template, a reaction or a read receipt.
    if (this.dryRun && body !== undefined) return { kind: "dry-run" };
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.defaultTimeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/${this.version}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
    } catch (error) {
      return this.sortFetchError(error, timeout, options.signal);
    }

    let parsed: any = null;
    try {
      parsed = await response.json();
    } catch (error) {
      // An HTML error page from a proxy, or a connection cut while the body was coming.
      if (signal.aborted) return this.sortFetchError(error, timeout, options.signal);
    }

    if (response.ok && !parsed?.error) return { kind: "ok", body: parsed };

    const retryAfter = Number(response.headers.get("retry-after"));
    return {
      kind: "api-error",
      httpStatus: response.status,
      code: typeof parsed?.error?.code === "number" ? parsed.error.code : null,
      subcode: typeof parsed?.error?.error_subcode === "number" ? parsed.error.error_subcode : null,
      message: this.redact(String(parsed?.error?.error_data?.details ?? parsed?.error?.message ?? `HTTP ${response.status}`)),
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
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
      return `WhatsApp said ${answer.code ?? answer.httpStatus}: ${answer.message}`;
    case "timeout":
      return "WhatsApp did not answer in time";
    case "network-error":
      return `network error: ${answer.message}`;
    case "aborted":
      return "cancelled";
    case "dry-run":
      return DRY_RUN_DETAIL;
  }
}
