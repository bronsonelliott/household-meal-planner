// Sorting the BlueBubbles server's answer to one send call into the shared SendOutcome.
//
//   sent     the server said 200 and gave the new message's guid. That means the server accepted
//            it, not that Messages has delivered it: BlueBubbles can answer before Messages
//            finishes sending. (It is the same "provider-accepted" meaning the other platforms use.)
//   failed   401/403: the password is wrong (permanent, flagged as an auth failure). 429 and
//            "could not connect": transient, because the server either refused or was not
//            reached. Any other 4xx (a chat that does not exist, a bad request): permanent.
//   unknown  no answer in time, a 5xx answer, or the connection broke after the request went out.
//            A 5xx can come after the server already accepted the message. It may have
//            been sent, and there is no way to ask, so it is never sent again.

import { DRY_RUN_DETAIL } from "../dry-run.ts";
import type { SendOutcome } from "../types.ts";
import { describeAnswer, type ApiAnswer } from "./client.ts";
import { stripGuidPrefix } from "./normalize.ts";

const AUTH_STEP = "Check the BlueBubbles server password: it must match the environment variable named by messaging.imessage.passwordEnv. Then restart the bridge.";

export function sortSendAnswer(answer: ApiAnswer, now: () => number = Date.now): SendOutcome {
  switch (answer.kind) {
    case "ok": {
      // A 200 with no message guid is not the answer we know how to read; do not claim it was sent.
      if (typeof answer.body?.data?.guid !== "string") return { kind: "unknown", detail: "the BlueBubbles server answered ok but gave no message guid" };
      return { kind: "sent", timestamp: now(), nativeId: stripGuidPrefix(answer.body.data.guid) };
    }

    case "timeout":
      return { kind: "unknown", detail: "the BlueBubbles server did not answer before the timeout" };
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
      if (answer.httpStatus === 401 || answer.httpStatus === 403) {
        return { kind: "failed", detail, failureClass: "auth-failed", failureExtra: { authFailed: true, fixStep: AUTH_STEP } };
      }
      if (answer.httpStatus === 429) {
        return {
          kind: "failed",
          detail,
          transient: true,
          failureClass: "rate-limited",
          ...(answer.retryAfterMs !== undefined ? { retryAfterMs: answer.retryAfterMs } : {}),
        };
      }
      // A 5xx after the request reached the server: the server may have accepted it before failing.
      if (answer.httpStatus >= 500) return { kind: "unknown", detail };
      return { kind: "failed", detail };
    }
  }
}
