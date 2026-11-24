// Sorting Meta's answer to one send call into the shared SendOutcome.
//
//   sent     Meta accepted it and gave it a message ID. ("Accepted" is as far as Meta says at this
//            point; later "delivered" and "read" updates arrive as webhook statuses.)
//   failed   Meta refused it. Transient (worth retrying) only for the rate and spam limits
//            (130429, 131048, 131056, HTTP 429), because then Meta definitely did not send it. A rejected token (190) is permanent and is
//            flagged as an auth failure. 131047 means the 24-hour window has closed; the adapter
//            handles that before it gets here, but it is named plainly if it does.
//   unknown  no answer in time, or the connection broke after the request went out. It may have
//            been posted, and there is no way to ask, so it is never sent again.

import { DRY_RUN_DETAIL } from "../dry-run.ts";
import type { SendOutcome } from "../types.ts";
import type { ApiAnswer } from "./client.ts";
import { describeAnswer } from "./client.ts";

export const WINDOW_CLOSED_CODE = 131047;
const RATE_LIMIT_CODES = [130429, 131048, 131056];
const AUTH_STEP =
  "Make a new permanent access token (a system user token in Meta Business Settings), put it in the environment variable named by messaging.whatsapp.accessTokenEnv, and restart the bridge.";

export function isWindowClosed(answer: ApiAnswer): boolean {
  return answer.kind === "api-error" && answer.code === WINDOW_CLOSED_CODE;
}

export function sortSendAnswer(answer: ApiAnswer, now: () => number = Date.now): SendOutcome {
  switch (answer.kind) {
    case "ok": {
      const id = answer.body?.messages?.[0]?.id;
      // A 200 with no message ID is not the answer we know how to read; do not claim it was sent.
      if (typeof id !== "string") return { kind: "unknown", detail: "WhatsApp answered ok but gave no message ID" };
      return { kind: "sent", timestamp: now(), nativeId: id };
    }

    case "timeout":
      return { kind: "unknown", detail: "WhatsApp did not answer before the timeout" };
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
      if (answer.code === 190 || answer.httpStatus === 401) {
        return { kind: "failed", detail, failureClass: "auth-failed", failureExtra: { authFailed: true, fixStep: AUTH_STEP } };
      }
      if (answer.httpStatus === 429 || (answer.code !== null && RATE_LIMIT_CODES.includes(answer.code))) {
        return {
          kind: "failed",
          detail,
          transient: true,
          failureClass: "rate-limited",
          ...(answer.retryAfterMs !== undefined ? { retryAfterMs: answer.retryAfterMs } : {}),
          failureExtra: { retryAfterSeconds: answer.retryAfterMs !== undefined ? answer.retryAfterMs / 1000 : null, code: answer.code },
        };
      }
      if (answer.code === WINDOW_CLOSED_CODE) {
        return { kind: "failed", detail: "WhatsApp only allows replies within 24 hours of the person's last message", failureClass: "window-closed" };
      }
      // Any server-side error, a gateway error included: the request reached Meta's side,
      // which may have sent it before failing.
      if (answer.httpStatus >= 500) return { kind: "unknown", detail };
      return { kind: "failed", detail };
    }
  }
}
