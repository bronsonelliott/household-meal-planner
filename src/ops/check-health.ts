// `bun run check-health`: the watchdog.
//
// Run it about once a minute from something that is NOT the bridge (a systemd timer, a launchd
// job, cron, or the Docker healthcheck), because a dead bridge cannot report itself. It only
// reads the state files the bridge leaves behind. It never starts message intake and never takes
// the household lock, so it is always safe to run, even while the bridge is running.
//
// What it looks for:
//
//   heartbeat-stale        the bridge has not had a healthy chat-app check for over an hour
//   friday-draft-missing   the weekly draft is not posted yet, some minutes after the draft time
//   friday-skipped-<week>  the bridge gave up on a week at the catch-up deadline (one alert per week)
//   unanswered             a member's message has waited 15 minutes with no reply
//   send failures          new lines in send-failures.jsonl (except "awaiting-reply", see below)
//
// "awaiting-reply" is a WhatsApp message held until the person writes again (WhatsApp only lets a
// bot start a conversation inside a 24-hour window). That is a delay, not a failure, so it is not
// reported here.
//
// Alerts: each problem is reported once when it starts, then stays quiet until it clears; if it
// comes back it is reported again. What has been reported is kept as one file per problem in
// <state>/alert-state/, so a reboot does not repeat anything. An alert that could not be sent is
// not recorded as sent, so the next run tries again.
//
// Alerts always go to stderr. If config.toml has [alerts] channel = "telegram", they also go to
// that Telegram chat (see src/ops/alerts.ts).
//
// Exit code: 0 healthy; 1 something is wrong right now, or an alert could not be sent; 2 the
// config file could not be read.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConfigError, loadConfig, type AppConfig } from "../config.ts";
import { addDays, describeMinutes, localDate, mondayOf } from "../week/state.ts";
import { postedMarkerPath, sendUnknownMarkerPath } from "../week/worker.ts";
import { createAlertNotifier, type AlertNotifier } from "./alerts.ts";
import { alertStatePath, clearAlert, hasAlerted, heartbeatPath, recordAlert, unansweredPath } from "./heartbeat.ts";
import { draftPhase, fridayErrorPath, lastDraftInstant, type FridayErrorFile } from "./scheduler.ts";
import { SEND_FAILURES_FILE } from "../messaging/sender.ts";

const MINUTE = 60_000;
export const HEARTBEAT_STALE_MS = 60 * MINUTE;
export const UNANSWERED_AFTER_MS = 15 * MINUTE;
const MAX_FAILURE_LINES_PER_ALERT = 10;
const OFFSET_KEY = "send-failures.offset";

export interface HealthCheckOptions {
  config: Pick<AppConfig, "schedule" | "paths">;
  nowMs: number;
  notifier: AlertNotifier;
  log: (line: string) => void; // ordinary progress lines
}

export interface HealthReport {
  ok: boolean;
  problems: string[]; // what is wrong right now
  alertFailed: boolean; // an alert could not be sent
}

export async function runHealthCheck(options: HealthCheckOptions): Promise<HealthReport> {
  const check = new HealthCheck(options);
  await check.run();
  return { ok: check.problems.length === 0 && !check.alertFailed, problems: check.problems, alertFailed: check.alertFailed };
}

class HealthCheck {
  problems: string[] = [];
  alertFailed = false;
  private stateDir: string;
  private nowMs: number;

  constructor(private options: HealthCheckOptions) {
    this.stateDir = options.config.paths.stateDir;
    this.nowMs = options.nowMs;
  }

  async run(): Promise<void> {
    await this.checkHeartbeat();
    await this.checkDraft();
    await this.checkSkippedWeeks();
    await this.checkUnanswered();
    await this.checkSendFailures();
  }

  // ----- Alert state -----

  // The problem holds right now: count it, and report it unless it was already reported.
  private async raise(key: string, text: string): Promise<void> {
    this.problems.push(text);
    await this.reportOnce(key, text);
  }

  // Reports once, and remembers that it did so (a failed send is not remembered, so it is retried).
  private async reportOnce(key: string, text: string): Promise<boolean> {
    if (hasAlerted(this.stateDir, key)) return false;
    const result = await this.options.notifier.send(text);
    if (result === "failed") {
      this.alertFailed = true;
      return false;
    }
    recordAlert(this.stateDir, key, text, this.nowMs);
    this.options.log(`alerted: ${key}`);
    return true;
  }

  private resolve(key: string): void {
    if (!hasAlerted(this.stateDir, key)) return;
    clearAlert(this.stateDir, key);
    this.options.log(`cleared: ${key}`);
  }

  // ----- The conditions -----

  private async checkHeartbeat(): Promise<void> {
    const file = heartbeatPath(this.stateDir);
    if (!existsSync(file)) {
      await this.raise("heartbeat-stale", `Dinner bot: there is no heartbeat file in ${this.stateDir}, so the bridge has never had a healthy chat-app check. Is it running? See docs/operations.md.`);
      return;
    }
    const age = this.nowMs - statSync(file).mtimeMs;
    if (age > HEARTBEAT_STALE_MS) {
      await this.raise(
        "heartbeat-stale",
        `Dinner bot: no healthy chat-app check for ${Math.floor(age / MINUTE)} minutes. The bridge may be down, or it can no longer reach your chat app. See docs/operations.md, "Heartbeat is stale".`,
      );
    } else {
      this.resolve("heartbeat-stale");
    }
  }

  // The draft should be posted shortly after the draft time. "Shortly" is lateAfterMinutes (30 by
  // default), the same moment the draft itself starts being marked "(late)". It stays on until the
  // draft posts or the week is skipped.
  private async checkDraft(): Promise<void> {
    const { schedule } = this.options.config;
    const key = "friday-draft-missing";
    const due = lastDraftInstant(this.nowMs, schedule) + schedule.lateAfterMinutes * MINUTE;
    if (draftPhase(this.nowMs, schedule) === "outside" || this.nowMs < due) {
      this.resolve(key);
      return;
    }

    const weekOf = addDays(mondayOf(localDate(this.nowMs, schedule.timeZone)), 7);
    // Posted (or counted as posted), or sent with an unknown result, which send-failures.jsonl reports.
    if (existsSync(postedMarkerPath(this.stateDir, weekOf)) || existsSync(sendUnknownMarkerPath(this.stateDir, weekOf))) {
      this.resolve(key);
      return;
    }

    const error = readJson<FridayErrorFile>(fridayErrorPath(this.stateDir, weekOf));
    const cause = error
      ? `Last error: ${error.errorClass} (${error.detail}), try ${error.attempts} at ${error.when}.`
      : "No draft try is recorded, so the bridge may not be running.";
    const by = `${capitalize(schedule.draftDay)} ${describeMinutes((schedule.draftMinutes + schedule.lateAfterMinutes) % 1440)}`;
    await this.raise(
      key,
      `Dinner bot: the draft for the week of ${weekOf} has not posted by ${by}. ${cause} The bridge keeps retrying until ${capitalize(schedule.catchUpDay)} ${describeMinutes(schedule.catchUpMinutes)}, then skips the week.`,
    );
  }

  // The scheduler writes skipped: true when it gives up at the catch-up deadline. One alert per week.
  private async checkSkippedWeeks(): Promise<void> {
    if (!existsSync(this.stateDir)) return;
    for (const name of readdirSync(this.stateDir).sort()) {
      const match = name.match(/^friday-error-(\d{4}-\d{2}-\d{2})\.json$/);
      if (!match) continue;
      const weekOf = match[1]!;
      if (hasAlerted(this.stateDir, `friday-skipped-${weekOf}`)) continue; // these files are never deleted
      const error = readJson<FridayErrorFile>(join(this.stateDir, name));
      if (!error?.skipped) continue;
      const sent = await this.reportOnce(
        `friday-skipped-${weekOf}`,
        `Dinner bot: no draft was posted in time, so the week of ${weekOf} was skipped. Last error: ${error.errorClass} (${error.detail}).`,
      );
      if (sent) this.problems.push(`the week of ${weekOf} was skipped`);
    }
  }

  // unanswered.json lists member messages still waiting, each with when the bridge first saw it.
  private async checkUnanswered(): Promise<void> {
    const file = readJson<{ messages?: Array<{ firstSeenMs: number }> }>(unansweredPath(this.stateDir));
    const times = (file?.messages ?? []).map((message) => message.firstSeenMs);
    if (times.length === 0) {
      this.resolve("unanswered");
      return;
    }
    const age = this.nowMs - Math.min(...times);
    if (age >= UNANSWERED_AFTER_MS) {
      await this.raise("unanswered", `Dinner bot: a member's message has had no reply for ${Math.floor(age / MINUTE)} minutes, and no deliberate silence was logged. The model may be down or rate-limited; check the bridge's log. See docs/operations.md.`);
    } else {
      this.resolve("unanswered");
    }
  }

  // New lines since the last run. The byte offset already reported is kept in the alert-state
  // folder and moves on only after the alert went out.
  private async checkSendFailures(): Promise<void> {
    const file = join(this.stateDir, SEND_FAILURES_FILE);
    if (!existsSync(file)) return;
    const offsetFile = alertStatePath(this.stateDir, OFFSET_KEY);
    let offset = existsSync(offsetFile) ? Number(readFileSync(offsetFile, "utf8").trim()) || 0 : 0;
    const bytes = readFileSync(file);
    if (bytes.length < offset) offset = 0; // the file was replaced
    if (bytes.length === offset) return;

    const records = bytes
      .subarray(offset)
      .toString("utf8")
      .split("\n")
      .map(parseJsonLine)
      .filter((record): record is SendFailureRecord => record !== null && record.class !== "awaiting-reply");

    if (records.length > 0) {
      const lines = records.slice(0, MAX_FAILURE_LINES_PER_ALERT).map(describeFailure);
      const more = records.length > lines.length ? [`...and ${records.length - lines.length} more in ${file}`] : [];
      const text = [`Dinner bot: ${records.length} send problem${records.length === 1 ? "" : "s"}:`, ...lines, ...more].join("\n");
      this.problems.push(`${records.length} new send problem${records.length === 1 ? "" : "s"}`);
      const result = await this.options.notifier.send(text);
      if (result === "failed") {
        this.alertFailed = true;
        return; // the offset stays, so the next run tries again
      }
      this.options.log(`alerted: ${records.length} send failure(s)`);
    }
    mkdirSync(dirname(offsetFile), { recursive: true });
    writeFileSync(offsetFile, `${bytes.length}\n`);
  }
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

interface SendFailureRecord {
  class: string;
  target?: { member?: string; conversation?: string };
  attempts?: number;
  detail?: string;
  token?: string;
  failedMembers?: Array<{ member: string; type: string }>;
}

function describeFailure(record: SendFailureRecord): string {
  const to = record.target?.member ? `member ${record.target.member}` : `conversation ${record.target?.conversation ?? "unknown"}`;
  switch (record.class) {
    case "rate-limited":
      return `- rate-limited: Signal rate-limited a send to ${to} (${record.detail}). Captcha token: ${record.token ?? "none given"}. See docs/platforms/signal.md.`;
    case "partial-send":
      return `- partial-send: a send to ${to} did not reach ${(record.failedMembers ?? []).map((m) => `${m.member} (${m.type})`).join(", ")}.`;
    case "send-unknown":
      return `- send-unknown: a send to ${to} may or may not have gone out (${record.detail}); it is not retried.`;
    default:
      return `- ${record.class}: a send to ${to} failed after ${record.attempts ?? "several"} tries (${record.detail}); it was not delivered.`;
  }
}

function parseJsonLine(line: string): SendFailureRecord | null {
  if (line.trim() === "") return null;
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && typeof value.class === "string" ? (value as SendFailureRecord) : null;
  } catch {
    return null; // a half-written last line: its bytes are counted, and it is skipped
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null; // missing or half-written: treated as "nothing there"
  }
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// ---------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------

export interface MainOptions {
  env?: Record<string, string | undefined>;
  nowMs?: number;
  fetchFn?: typeof fetch;
  telegramApi?: string; // tests point this at a local fake
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function main(options: MainOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((line) => console.log(line));
  const stderr = options.stderr ?? ((line) => console.error(line));

  let config: AppConfig;
  try {
    config = loadConfig(env);
  } catch (error) {
    const reasons = error instanceof ConfigError ? error.problems : [(error as Error).message];
    for (const reason of reasons) stderr(`check-health: ${reason}`);
    return 2;
  }

  const notifier = createAlertNotifier(config.alerts, { env, echo: stderr, fetchFn: options.fetchFn, apiBase: options.telegramApi });
  const report = await runHealthCheck({ config, nowMs: options.nowMs ?? Date.now(), notifier, log: stdout });
  if (report.ok) {
    stdout("check-health: healthy");
    return 0;
  }
  if (report.problems.length > 0) stdout(`check-health: ${report.problems.length} problem${report.problems.length === 1 ? "" : "s"}`);
  if (report.alertFailed) stdout("check-health: an alert could not be sent; it will be tried again on the next run");
  return 1;
}

if (import.meta.main) {
  process.exit(await main());
}
