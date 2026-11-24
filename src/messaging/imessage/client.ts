// A small client for the BlueBubbles server's REST API (v1), over plain fetch.
//
// BlueBubbles takes its password as a query parameter (?password=...), so the password is part of
// every URL we call. That makes redaction matter: nothing this file reports, and nothing it throws,
// may contain the password, in plain or URL-encoded form.

import { DRY_RUN_DETAIL } from "../dry-run.ts";

// What one call came back as. Nothing here throws: the caller decides what each answer means.
export type ApiAnswer =
  | { kind: "ok"; body: any }
  // The server answered, and said no (or failed).
  | { kind: "api-error"; httpStatus: number; message: string; retryAfterMs?: number }
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

// The server calls that put a message or a reaction in front of someone. (Reading new messages is
// also a POST, so "has a body" is not enough to tell.)
const SENDING_PATHS = new Set(["message/text", "message/react"]);

export class BlueBubblesApi {
  private baseUrl: string;

  constructor(
    serverUrl: string,
    private password: string,
    private defaultTimeoutMs: number,
    private dryRun = false,
  ) {
    this.baseUrl = serverUrl.replace(/\/+$/, "");
  }

  // Removes the password from any text we are about to show, however it was written.
  redact(text: string): string {
    let clean = text;
    if (this.password !== "") {
      clean = clean.split(this.password).join("<secret>").split(encodeURIComponent(this.password)).join("<secret>");
    }
    return clean.replace(/(password=)[^&\s"')]*/gi, "$1<secret>");
  }

  // `path` is what comes after /api/v1/, like "message/text". GET when there is no body.
  async call(path: string, body?: Record<string, unknown>, options: CallOptions = {}): Promise<ApiAnswer> {
    if (this.dryRun && SENDING_PATHS.has(path)) return { kind: "dry-run" };
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.defaultTimeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const url = `${this.baseUrl}/api/v1/${path}${path.includes("?") ? "&" : "?"}password=${encodeURIComponent(this.password)}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
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

    // BlueBubbles wraps everything as {status, message, data}. Its status normally matches the
    // HTTP status; if it ever disagrees, the worse of the two wins.
    const bodyStatus = typeof parsed?.status === "number" ? parsed.status : 200;
    const status = Math.max(response.status, bodyStatus >= 400 ? bodyStatus : 0);
    if (response.ok && status < 400) return { kind: "ok", body: parsed };

    const retryAfter = Number(response.headers.get("retry-after"));
    const message = parsed?.error?.message ?? parsed?.error?.error ?? parsed?.message ?? `HTTP ${status}`;
    return {
      kind: "api-error",
      httpStatus: status,
      message: this.redact(String(message)),
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
    };
  }

  private sortFetchError(error: unknown, timeout: AbortSignal, outside?: AbortSignal): ApiAnswer {
    if (outside?.aborted) return { kind: "aborted" };
    if (timeout.aborted) return { kind: "timeout" };
    // The runtime's own error text can quote the URL, password and all.
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
      return `the BlueBubbles server said ${answer.httpStatus}: ${answer.message}`;
    case "timeout":
      return "the BlueBubbles server did not answer in time";
    case "network-error":
      return `network error: ${answer.message}`;
    case "aborted":
      return "cancelled";
    case "dry-run":
      return DRY_RUN_DETAIL;
  }
}

// The path for looking up one chat. The GUID has ";" and "+" in it, so it is encoded.
export function chatLookupPath(chatGuid: string): string {
  return `chat/${encodeURIComponent(chatGuid)}`;
}
