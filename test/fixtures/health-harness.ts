// Runs the health check (src/ops/check-health.ts) against a state folder with a notifier that just
// records what it was asked to send, so nothing reaches Telegram.

import { runHealthCheck, type HealthReport } from "../../src/ops/check-health.ts";
import type { AlertNotifier, AlertResult } from "../../src/ops/alerts.ts";
import type { ScheduleConfig } from "../../src/config.ts";
import { CHICAGO_SCHEDULE } from "./config-fixtures.ts";

export interface CheckerRun extends HealthReport {
  messages: string[]; // the alert texts, in order
}

// `results` are what the recording notifier answers with, in order (then "sent").
export async function runChecker(options: { stateDir: string; nowMs: number; schedule?: ScheduleConfig; results?: AlertResult[] }): Promise<CheckerRun> {
  const messages: string[] = [];
  const results = [...(options.results ?? [])];
  const notifier: AlertNotifier = {
    configured: true,
    send: async (text) => {
      messages.push(text);
      return results.shift() ?? "sent";
    },
  };
  const report = await runHealthCheck({
    config: { schedule: options.schedule ?? CHICAGO_SCHEDULE, paths: { dataDir: "unused", stateDir: options.stateDir } },
    nowMs: options.nowMs,
    notifier,
    log: () => {},
  });
  return { ...report, messages };
}
