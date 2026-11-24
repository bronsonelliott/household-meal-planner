// Sorting signal-cli's answer to one `send` call into the shared SendOutcome:
//
//   sent     every member's result is SUCCESS. Signal's server holds it for each phone.
//   partial  some members got it, some did not.
//   failed   signal-cli answered with an error, or no member got it. Marked transient, so the
//            shared sender retries it at 1, 5 and 15 minutes.
//   unknown  no answer in time, or signal-cli died mid-call. It may have gone out and Signal
//            offers no way to ask.

import type { FailedMember, SendOutcome } from "../types.ts";
import { DRY_RUN_DETAIL } from "../dry-run.ts";
import type { RpcAnswer } from "./client.ts";

interface RateLimit {
  token: string | null; // the challenge token for submitRateLimitChallenge
  retryAfterSeconds: number | null;
}

function memberName(result: any): string {
  const address = result?.recipientAddress ?? {};
  return address.uuid ?? address.number ?? address.username ?? "unknown member";
}

function findRateLimit(results: any[]): RateLimit | null {
  const limited = results.find((result) => result?.type === "RATE_LIMIT_FAILURE");
  if (!limited) return null;
  return { token: limited.token ?? null, retryAfterSeconds: limited.retryAfterSeconds ?? null };
}

function captchaStep(token: string): string {
  return (
    "Rate limited by Signal. Stop the bridge, solve a captcha at " +
    "https://signalcaptchas.org/challenge/generate.html, copy the \"Open Signal\" link, then run: " +
    `signal-cli -a <bot number> submitRateLimitChallenge --challenge ${token} --captcha <that link>. ` +
    "Then start the bridge again."
  );
}

function failed(detail: string, rateLimit: RateLimit | null): SendOutcome {
  if (!rateLimit) return { kind: "failed", detail, transient: true };
  return {
    kind: "failed",
    detail,
    transient: true,
    failureClass: "rate-limited",
    ...(rateLimit.retryAfterSeconds !== null ? { retryAfterMs: rateLimit.retryAfterSeconds * 1000 } : {}),
    failureExtra: {
      token: rateLimit.token,
      retryAfterSeconds: rateLimit.retryAfterSeconds,
      ...(rateLimit.token ? { captchaStep: captchaStep(rateLimit.token) } : {}),
    },
  };
}

export function sortSendAnswer(answer: RpcAnswer): SendOutcome {
  if (answer.kind === "timeout") return { kind: "unknown", detail: "no answer from signal-cli before the timeout" };
  if (answer.kind === "dry-run") return { kind: "failed", detail: DRY_RUN_DETAIL };
  if (answer.kind === "died") return { kind: "unknown", detail: "signal-cli exited during the send" };

  if (answer.kind === "error") {
    // signal-cli puts the per-recipient results of a failed direct send under
    // error.data.response; code -5 is its rate-limit error.
    const results: any[] = answer.error.data?.response?.results ?? [];
    let rateLimit = findRateLimit(results);
    if (!rateLimit && answer.error.code === -5) rateLimit = { token: null, retryAfterSeconds: null };
    return failed(`signal-cli error ${answer.error.code}: ${answer.error.message}`, rateLimit);
  }

  const results: any[] = answer.result?.results ?? [];
  const timestamp: number = answer.result?.timestamp;
  const failures = results.filter((result) => result?.type !== "SUCCESS");
  const successes = results.filter((result) => result?.type === "SUCCESS");

  // A Signal message is named by its timestamp; that is also what a later quote of it carries.
  const nativeId = typeof timestamp === "number" ? { nativeId: String(timestamp) } : {};
  if (failures.length === 0) return { kind: "sent", timestamp, ...nativeId };
  const failedMembers: FailedMember[] = failures.map((result) => ({ member: memberName(result), type: String(result?.type) }));
  if (successes.length === 0) {
    const summary = failedMembers.map((member) => `${member.member} ${member.type}`).join(", ");
    return failed(`no member got the message: ${summary}`, findRateLimit(results));
  }
  return { kind: "partial", timestamp, failedMembers, ...nativeId };
}
