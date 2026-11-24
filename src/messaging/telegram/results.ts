// Sorting Telegram's answer to one sendMessage call into the shared SendOutcome.
//
//   sent     Telegram accepted it.
//   failed   Telegram refused it. Only a rate limit (429) is marked transient, because then Telegram
//            definitely did not send it. A 5xx is unknown, not failed. A 400 or 403
//            (the bot was removed, the chat is gone, the person never started a chat with the
//            bot) will not fix itself.
//   unknown  no answer in time, or the connection broke after the request went out. It may have
//            been posted, and there is no way to ask, so it is never sent again.

import { DRY_RUN_DETAIL } from "../dry-run.ts";
import type { SendOutcome } from "../types.ts";
import type { ApiAnswer } from "./client.ts";
import { describeAnswer } from "./client.ts";

export function sortSendAnswer(answer: ApiAnswer, now: () => number = Date.now): SendOutcome {
  switch (answer.kind) {
    case "ok":
      return {
        kind: "sent",
        timestamp: typeof answer.result?.date === "number" ? answer.result.date * 1000 : now(),
        ...(typeof answer.result?.message_id === "number" ? { nativeId: String(answer.result.message_id) } : {}),
      };

    case "timeout":
      return { kind: "unknown", detail: "Telegram did not answer before the timeout" };
    case "aborted":
      return { kind: "unknown", detail: "the bridge was stopping during the send" };
    case "dry-run":
      return { kind: "failed", detail: DRY_RUN_DETAIL };

    case "network-error":
      // Failing before anything was sent is a clean failure we can try again; failing after is unknown.
      if (answer.notSent) return { kind: "failed", detail: describeAnswer(answer), transient: true };
      return { kind: "unknown", detail: describeAnswer(answer) };

    case "api-error": {
      const detail = describeAnswer(answer);
      if (answer.errorCode === 429) {
        const seconds = answer.parameters.retry_after;
        return {
          kind: "failed",
          detail,
          transient: true,
          failureClass: "rate-limited",
          ...(typeof seconds === "number" ? { retryAfterMs: seconds * 1000 } : {}),
          failureExtra: { retryAfterSeconds: seconds ?? null },
        };
      }
      // Any server-side error, a gateway error included: the request reached Telegram's side,
      // which may have posted it before failing.
      if (answer.errorCode >= 500) return { kind: "unknown", detail };
      return { kind: "failed", detail };
    }
  }
}
