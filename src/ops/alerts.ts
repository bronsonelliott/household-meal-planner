// The send-only alert notifier: how the bridge and the health check tell the admin that something
// needs a human.
//
// It is deliberately separate from the household's chat app. It works even when the household
// talks over Signal, WhatsApp or iMessage, because all it needs is a small Telegram bot and a chat
// ID (config.toml, [alerts]). It only ever sends; it never reads messages and never starts the
// bridge's message intake.
//
// Every alert is also written to the log (`echo`), whatever the channel. The result says what
// really happened, so callers never claim the admin was told when nobody was:
//
//   "sent"      the alert was delivered to Telegram (HTTP 2xx)
//   "log-only"  no alert channel is set up; the line went to the log and that is all
//   "failed"    a channel is set up but the send did not work; the caller should try again later

import type { AlertsConfig } from "../config.ts";

export type AlertResult = "sent" | "log-only" | "failed";

export interface AlertNotifier {
  // True when alerts reach a person (a channel is set up), not just the log.
  configured: boolean;
  send(text: string): Promise<AlertResult>;
}

export interface NotifierOptions {
  env: Record<string, string | undefined>;
  echo: (line: string) => void; // where every alert is written: the log or stderr
  fetchFn?: typeof fetch;
  apiBase?: string; // the Telegram Bot API address; tests point it at a local fake
  dryRun?: boolean;
}

export function createAlertNotifier(alerts: AlertsConfig, options: NotifierOptions): AlertNotifier {
  const { env, echo } = options;
  if (alerts.channel !== "telegram") {
    return {
      configured: false,
      send: async (text) => {
        echo(`ALERT: ${text}`);
        return "log-only";
      },
    };
  }

  return {
    configured: true,
    send: async (text) => {
      echo(`ALERT: ${text}`);
      if (options.dryRun) {
        echo("DRY RUN: the alert was not sent to Telegram");
        return "sent";
      }
      const token = env[alerts.telegramBotTokenEnv];
      if (!token || !alerts.telegramChatId) {
        echo(`The alert could not be sent to Telegram: the environment variable ${alerts.telegramBotTokenEnv} is not set.`);
        return "failed";
      }
      const sent = await postToTelegram(options.apiBase ?? "https://api.telegram.org", token, alerts.telegramChatId, text, options.fetchFn ?? fetch, echo);
      return sent ? "sent" : "failed";
    },
  };
}

// HTTP 2xx means Telegram took it. A 5xx gets one retry; anything else is a failure. The token is
// never written to the log (it is part of the URL, so error messages are kept to the status).
async function postToTelegram(api: string, token: string, chatId: string, text: string, fetchFn: typeof fetch, echo: (line: string) => void): Promise<boolean> {
  const url = `${api}/bot${token}/sendMessage`;
  const body = JSON.stringify({ chat_id: chatId, text });
  for (let attempt = 1; attempt <= 2; attempt++) {
    let status: number;
    try {
      const response = await fetchFn(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(15_000) });
      status = response.status;
    } catch {
      echo("The alert could not be sent to Telegram: the request failed (no answer).");
      return false;
    }
    if (status >= 200 && status < 300) return true;
    if (status >= 500 && attempt === 1) {
      echo(`Telegram answered ${status}; trying once more.`);
      continue;
    }
    echo(`The alert could not be sent to Telegram: it answered ${status}.`);
    return false;
  }
  return false;
}
