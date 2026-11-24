// The watchdog (src/ops/check-health.ts) and the alert notifier (src/ops/alerts.ts). Each case
// builds a throwaway state folder and runs the check at a fixed instant, so there is no real
// clock and nothing reaches a real service. Alerts go to a recording notifier, or, for the
// notifier's own tests, to a fake Telegram on a loopback port. Expected values are written by hand.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAlertNotifier } from "../src/ops/alerts.ts";
import { main } from "../src/ops/check-health.ts";
import { scheduleWith } from "./fixtures/config-fixtures.ts";
import { exampleConfigText } from "./fixtures/config-fixtures.ts";
import { FAKE_TOKEN, FakeTelegramApi } from "./fixtures/fake-telegram-api.ts";
import { runChecker } from "./fixtures/health-harness.ts";

const MINUTE = 60_000;
// Central daylight time is UTC-5 in October 2026. 2026-10-02 is a Friday.
const THU_10AM = Date.parse("2026-10-01T15:00:00Z");
const FRI_4_29PM = Date.parse("2026-10-02T21:29:00Z");
const FRI_4_31PM = Date.parse("2026-10-02T21:31:00Z");
const SAT_9AM = Date.parse("2026-10-03T14:00:00Z");
const SUN_12_06PM = Date.parse("2026-10-04T17:06:00Z");

const folders: string[] = [];
afterEach(() => {
  while (folders.length > 0) rmSync(folders.pop()!, { recursive: true, force: true });
});

function newState(): string {
  const dir = mkdtempSync(join(tmpdir(), "check-health-"));
  folders.push(dir);
  return dir;
}

function setHeartbeat(stateDir: string, atMs: number): void {
  const path = join(stateDir, "heartbeat");
  writeFileSync(path, "ok\n");
  utimesSync(path, atMs / 1000, atMs / 1000);
}

// Runs the check and returns the alert texts it sent.
async function sentAt(stateDir: string, nowMs: number): Promise<string[]> {
  return (await runChecker({ stateDir, nowMs })).messages;
}

describe("the heartbeat", () => {
  test("59 minutes old is fine; 61 minutes alerts once, and again only after it recovers and goes stale again", async () => {
    const state = newState();
    setHeartbeat(state, THU_10AM - 59 * MINUTE);
    expect(await sentAt(state, THU_10AM)).toEqual([]);

    setHeartbeat(state, THU_10AM - 61 * MINUTE);
    const first = await sentAt(state, THU_10AM);
    expect(first.length).toBe(1);
    expect(first[0]).toContain("61 minutes");
    expect(first[0]).toContain("docs/operations.md");

    expect(await sentAt(state, THU_10AM + MINUTE)).toEqual([]); // still stale: quiet

    setHeartbeat(state, THU_10AM + 2 * MINUTE);
    expect(await sentAt(state, THU_10AM + 2 * MINUTE)).toEqual([]); // recovered: clears
    expect(existsSync(join(state, "alert-state", "heartbeat-stale"))).toBe(false);

    expect((await sentAt(state, THU_10AM + 2 * MINUTE + 61 * MINUTE)).length).toBe(1); // stale again: alerts again
  });

  test("no heartbeat file at all alerts", async () => {
    const run = await runChecker({ stateDir: newState(), nowMs: THU_10AM });
    expect(run.messages.length).toBe(1);
    expect(run.messages[0]).toContain("no heartbeat file");
    expect(run.ok).toBe(false);
  });

  test("a healthy run reports ok and sends nothing", async () => {
    const state = newState();
    setHeartbeat(state, THU_10AM);
    const run = await runChecker({ stateDir: state, nowMs: THU_10AM });
    expect(run.ok).toBe(true);
    expect(run.problems).toEqual([]);
    expect(run.messages).toEqual([]);
  });

  test("the bridge's own alert key is left alone", async () => {
    const state = newState();
    setHeartbeat(state, THU_10AM);
    mkdirSync(join(state, "alert-state"));
    writeFileSync(join(state, "alert-state", "auth-stop"), "bridge alert\n");
    await sentAt(state, THU_10AM);
    expect(readFileSync(join(state, "alert-state", "auth-stop"), "utf8")).toBe("bridge alert\n");
  });
});

describe("the weekly draft", () => {
  function writeError(state: string, skipped: boolean, weekOf = "2026-10-05"): void {
    writeFileSync(
      join(state, `friday-error-${weekOf}.json`),
      JSON.stringify({ weekOf, errorClass: "rate-limit", detail: "test rate limit", attempts: 3, at: "2026-10-02T21:20:00.000Z", when: "Fri 4:20 PM", skipped }),
    );
  }

  test("nothing at 4:29 PM Friday; one alert at 4:31 naming the week and the error; quiet after; cleared once posted", async () => {
    const state = newState();
    writeError(state, false);
    setHeartbeat(state, FRI_4_29PM);
    expect(await sentAt(state, FRI_4_29PM)).toEqual([]);

    setHeartbeat(state, FRI_4_31PM);
    const first = await sentAt(state, FRI_4_31PM);
    expect(first.length).toBe(1);
    expect(first[0]).toContain("week of 2026-10-05");
    expect(first[0]).toContain("rate-limit");
    expect(first[0]).toContain("Friday 4:30 PM");

    setHeartbeat(state, SAT_9AM);
    expect(await sentAt(state, SAT_9AM)).toEqual([]);

    writeFileSync(join(state, "friday-posted-2026-10-05.json"), '{"outcome":"sent"}');
    const posted = await runChecker({ stateDir: state, nowMs: SAT_9AM + MINUTE });
    expect(posted.messages).toEqual([]);
    expect(posted.ok).toBe(true);
    expect(existsSync(join(state, "alert-state", "friday-draft-missing"))).toBe(false);
  });

  test("posted on time, or a send-unknown marker: no draft alert", async () => {
    for (const marker of ["friday-posted-2026-10-05.json", "friday-send-unknown-2026-10-05.json"]) {
      const state = newState();
      setHeartbeat(state, FRI_4_31PM);
      writeFileSync(join(state, marker), "{}");
      expect(await sentAt(state, FRI_4_31PM)).toEqual([]);
    }
  });

  // A draft WhatsApp is keeping until people reply is waiting on the household, not missed.
  test("a draft kept for replies (posted marker saying queued) is not a missing draft", async () => {
    const state = newState();
    setHeartbeat(state, FRI_4_31PM);
    writeFileSync(join(state, "friday-posted-2026-10-05.json"), '{"outcome":"queued","detail":"waiting for replies"}');
    expect(await sentAt(state, FRI_4_31PM)).toEqual([]);
    setHeartbeat(state, SAT_9AM);
    expect(await sentAt(state, SAT_9AM)).toEqual([]);
    expect(existsSync(join(state, "alert-state", "friday-draft-missing"))).toBe(false);
  });

  test("no draft and no try recorded: one alert that says so", async () => {
    const state = newState();
    setHeartbeat(state, FRI_4_31PM);
    const sent = await sentAt(state, FRI_4_31PM);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("No draft try is recorded");
  });

  test("a skipped week: one alert, never repeated", async () => {
    const state = newState();
    setHeartbeat(state, SUN_12_06PM);
    writeError(state, true);
    writeFileSync(join(state, "friday-posted-2026-10-05.json"), '{"outcome":"skipped-no-draft"}');
    const first = await sentAt(state, SUN_12_06PM);
    expect(first.length).toBe(1);
    expect(first[0]).toContain("skipped");
    expect(first[0]).toContain("rate-limit");
    expect(await sentAt(state, SUN_12_06PM + MINUTE)).toEqual([]);
  });

  test("follows the configured day, time and zone, not Friday 4 PM", async () => {
    // Wednesday 09:00 in London, 45 minutes of grace. 2026-10-07 is a Wednesday; London is on BST (UTC+1).
    const schedule = scheduleWith({ timeZone: "Europe/London", draftDay: "wednesday", draftTime: "09:00", draftMinutes: 9 * 60, lateAfterMinutes: 45, catchUpDay: "friday" });
    const state = newState();
    const at = (iso: string) => {
      setHeartbeat(state, Date.parse(iso)); // keep the heartbeat fresh so only the draft is in question
      return runChecker({ stateDir: state, nowMs: Date.parse(iso), schedule });
    };

    expect((await at("2026-10-07T08:30:00Z")).messages).toEqual([]); // 09:30 local: not yet
    expect((await at("2026-10-07T08:44:00Z")).messages).toEqual([]); // 09:44 local: not yet
    const late = await at("2026-10-07T08:46:00Z"); // 09:46 local: past 09:45
    expect(late.messages.length).toBe(1);
    expect(late.messages[0]).toContain("week of 2026-10-12");
    expect(late.messages[0]).toContain("Wednesday 9:45 AM");
    expect((await at("2026-10-07T23:00:00Z")).messages).toEqual([]); // already reported
    // The Saturday after the catch-up deadline is outside the window: cleared.
    await at("2026-10-10T12:00:00Z");
    expect(existsSync(join(state, "alert-state", "friday-draft-missing"))).toBe(false);
  });
});

describe("unanswered member messages", () => {
  function writeUnanswered(state: string, firstSeenMs: number | null): void {
    const messages = firstSeenMs === null ? [] : [{ id: "sam:1", firstSeenMs }];
    writeFileSync(join(state, "unanswered.json"), JSON.stringify({ messages, lastAnsweredMs: null }));
  }

  test("16 minutes with no reply alerts once; 14 minutes does not; answered clears", async () => {
    const state = newState();
    setHeartbeat(state, THU_10AM);
    writeUnanswered(state, THU_10AM - 14 * MINUTE);
    expect(await sentAt(state, THU_10AM)).toEqual([]);

    writeUnanswered(state, THU_10AM - 16 * MINUTE);
    const sent = await sentAt(state, THU_10AM);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("no reply");
    expect(await sentAt(state, THU_10AM + MINUTE)).toEqual([]);

    writeUnanswered(state, null);
    setHeartbeat(state, THU_10AM + 2 * MINUTE);
    await sentAt(state, THU_10AM + 2 * MINUTE);
    expect(existsSync(join(state, "alert-state", "unanswered"))).toBe(false);
  });

  test("a message that arrives one second after a run is alerted on the 16th minute, once", async () => {
    const state = newState();
    setHeartbeat(state, THU_10AM);
    await sentAt(state, THU_10AM);
    writeUnanswered(state, THU_10AM + 1000);
    let firstAlertAt: number | null = null;
    let alerts = 0;
    for (let k = 1; k <= 20; k++) {
      const now = THU_10AM + k * MINUTE;
      setHeartbeat(state, now);
      const sent = await sentAt(state, now);
      alerts += sent.length;
      if (sent.length > 0 && firstAlertAt === null) firstAlertAt = now;
    }
    expect(firstAlertAt).toBe(THU_10AM + 16 * MINUTE);
    expect(alerts).toBe(1);
  });
});

describe("when an alert cannot be sent", () => {
  test("it is not recorded as sent, the run is not ok, and the next run tries again", async () => {
    const state = newState();
    setHeartbeat(state, THU_10AM - 61 * MINUTE);
    const failed = await runChecker({ stateDir: state, nowMs: THU_10AM, results: ["failed"] });
    expect(failed.messages.length).toBe(1);
    expect(failed.alertFailed).toBe(true);
    expect(failed.ok).toBe(false);
    expect(existsSync(join(state, "alert-state", "heartbeat-stale"))).toBe(false);

    const retried = await runChecker({ stateDir: state, nowMs: THU_10AM + MINUTE });
    expect(retried.messages.length).toBe(1);
    expect(existsSync(join(state, "alert-state", "heartbeat-stale"))).toBe(true);
  });

  test("a log-only alert counts as reported, so stderr is not repeated every minute", async () => {
    const state = newState();
    setHeartbeat(state, THU_10AM - 61 * MINUTE);
    const run = await runChecker({ stateDir: state, nowMs: THU_10AM, results: ["log-only"] });
    expect(run.alertFailed).toBe(false);
    expect(existsSync(join(state, "alert-state", "heartbeat-stale"))).toBe(true);
  });
});

describe("send failures", () => {
  const rateLimited = '{"at":"2026-10-01T14:59:00.000Z","outcome":"failed","class":"rate-limited","target":{"conversation":"R1JPVVA="},"attempts":4,"detail":"signal-cli error -5: rate limited","token":"tok-123"}\n';
  const partial = '{"outcome":"partial","class":"partial-send","target":{"conversation":"R1JPVVA="},"timestamp":1,"failedMembers":[{"member":"aaaaaaaa-0000-4000-8000-000000000001","type":"UNREGISTERED_FAILURE"}]}\n';
  const awaiting = '{"outcome":"failed","class":"awaiting-reply","target":{"member":"sam"},"attempts":1,"detail":"held until Sam replies"}\n';

  test("a new line alerts once with its class and who it was for; later lines alert again", async () => {
    const state = newState();
    setHeartbeat(state, THU_10AM);
    writeFileSync(join(state, "send-failures.jsonl"), rateLimited);
    const first = await sentAt(state, THU_10AM);
    expect(first.length).toBe(1);
    expect(first[0]).toContain("rate-limited");
    expect(first[0]).toContain("tok-123");
    expect(first[0]).toContain("R1JPVVA=");
    expect(await sentAt(state, THU_10AM + MINUTE)).toEqual([]);

    appendFileSync(join(state, "send-failures.jsonl"), partial);
    const second = await sentAt(state, THU_10AM + 2 * MINUTE);
    expect(second.length).toBe(1);
    expect(second[0]).toContain("partial-send");
    expect(second[0]).toContain("aaaaaaaa-0000-4000-8000-000000000001");
    expect(second[0]).not.toContain("rate-limited"); // only the new line
  });

  test("awaiting-reply is a delay, not a failure: no alert, and it is not reported later either", async () => {
    const state = newState();
    setHeartbeat(state, THU_10AM);
    writeFileSync(join(state, "send-failures.jsonl"), awaiting);
    const run = await runChecker({ stateDir: state, nowMs: THU_10AM });
    expect(run.messages).toEqual([]);
    expect(run.ok).toBe(true);

    // A real failure next to a held message: only the real one is reported.
    appendFileSync(join(state, "send-failures.jsonl"), awaiting + partial);
    const mixed = await sentAt(state, THU_10AM + MINUTE);
    expect(mixed.length).toBe(1);
    expect(mixed[0]).toContain("1 send problem");
    expect(mixed[0]).not.toContain("awaiting-reply");
  });

  test("a send failure that could not be reported is reported on the next run", async () => {
    const state = newState();
    setHeartbeat(state, THU_10AM);
    writeFileSync(join(state, "send-failures.jsonl"), rateLimited);
    await runChecker({ stateDir: state, nowMs: THU_10AM, results: ["failed"] });
    expect((await sentAt(state, THU_10AM + MINUTE)).length).toBe(1);
    expect(await sentAt(state, THU_10AM + 2 * MINUTE)).toEqual([]);
  });

  test("a half-written last line is skipped, and many failures are summarised", async () => {
    const state = newState();
    setHeartbeat(state, THU_10AM);
    writeFileSync(join(state, "send-failures.jsonl"), rateLimited.repeat(12) + '{"class":"rate-lim');
    const sent = await sentAt(state, THU_10AM);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("12 send problems");
    expect(sent[0]).toContain("...and 2 more");
  });

  test("a replaced (shorter) file is read from the start", async () => {
    const state = newState();
    setHeartbeat(state, THU_10AM);
    writeFileSync(join(state, "send-failures.jsonl"), rateLimited + rateLimited);
    await sentAt(state, THU_10AM);
    writeFileSync(join(state, "send-failures.jsonl"), partial);
    expect((await sentAt(state, THU_10AM + MINUTE)).length).toBe(1);
  });
});

describe("the Telegram notifier", () => {
  const alerts = { channel: "telegram" as const, telegramBotTokenEnv: "ALERT_TOKEN", telegramChatId: "100000001" };

  function notifier(api: FakeTelegramApi, env: Record<string, string | undefined>, echoed: string[]) {
    return createAlertNotifier(alerts, { env, echo: (line) => echoed.push(line), apiBase: api.url });
  }

  test("HTTP 200 is sent, and the alert is also written to the log", async () => {
    const api = new FakeTelegramApi();
    try {
      const echoed: string[] = [];
      const n = notifier(api, { ALERT_TOKEN: FAKE_TOKEN }, echoed);
      expect(n.configured).toBe(true);
      expect(await n.send("the draft is late")).toBe("sent");
      expect(api.sends()).toEqual([{ chat_id: "100000001", text: "the draft is late" } as any]);
      expect(echoed[0]).toContain("the draft is late");
    } finally {
      api.stop();
    }
  });

  test("a 5xx is retried once; two in a row fail; a 4xx is not retried", async () => {
    const api = new FakeTelegramApi();
    try {
      const n = notifier(api, { ALERT_TOKEN: FAKE_TOKEN }, []);
      api.scriptSends([{ error: 502 }, { ok: true }]);
      expect(await n.send("a")).toBe("sent");
      expect(api.sends().length).toBe(2);

      api.requests = [];
      api.scriptSends([{ error: 500 }, { error: 503 }]);
      expect(await n.send("b")).toBe("failed");
      expect(api.sends().length).toBe(2);

      api.requests = [];
      api.scriptSends([{ error: 400 }]);
      expect(await n.send("c")).toBe("failed");
      expect(api.sends().length).toBe(1);
    } finally {
      api.stop();
    }
  });

  test("a missing token is a failure that sends nothing and never prints the token", async () => {
    const api = new FakeTelegramApi();
    try {
      const echoed: string[] = [];
      expect(await notifier(api, {}, echoed).send("x")).toBe("failed");
      expect(api.sends().length).toBe(0);
      expect(echoed.join("\n")).toContain("ALERT_TOKEN");
    } finally {
      api.stop();
    }
  });

  test("a wrong token (Telegram says 401) is a failure and the token is not logged", async () => {
    const api = new FakeTelegramApi();
    try {
      const echoed: string[] = [];
      expect(await notifier(api, { ALERT_TOKEN: "999:wrong-token" }, echoed).send("x")).toBe("failed");
      expect(echoed.join("\n")).not.toContain("999:wrong-token");
    } finally {
      api.stop();
    }
  });

  test("channel none is log-only and says nobody was told; a dry run sends nothing", async () => {
    const echoed: string[] = [];
    const none = createAlertNotifier({ channel: "none", telegramBotTokenEnv: "T", telegramChatId: null }, { env: {}, echo: (line) => echoed.push(line) });
    expect(none.configured).toBe(false);
    expect(await none.send("hello")).toBe("log-only");
    expect(echoed).toEqual(["ALERT: hello"]);

    const api = new FakeTelegramApi();
    try {
      const dry = createAlertNotifier(alerts, { env: { ALERT_TOKEN: FAKE_TOKEN }, echo: () => {}, apiBase: api.url, dryRun: true });
      expect(await dry.send("hello")).toBe("sent");
      expect(api.sends().length).toBe(0);
    } finally {
      api.stop();
    }
  });
});

describe("bun run check-health (main)", () => {
  function setup(editConfig: (text: string) => string = (text) => text) {
    const dir = newState();
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    const configPath = join(dir, "config.toml");
    writeFileSync(configPath, exampleConfigText(editConfig));
    const out: string[] = [];
    const err: string[] = [];
    const env = { HMP_CONFIG: configPath, HMP_STATE_DIR: stateDir, HMP_DATA_DIR: join(dir, "data"), ALERT_TOKEN: FAKE_TOKEN };
    const run = (nowMs: number, api?: FakeTelegramApi) => main({ env, nowMs, stdout: (l) => out.push(l), stderr: (l) => err.push(l), telegramApi: api?.url });
    return { stateDir, run, out, err };
  }

  test("a missing config file exits 2 and says why", async () => {
    const err: string[] = [];
    const code = await main({ env: { HMP_CONFIG: join(tmpdir(), "no-such-config.toml") }, stderr: (l) => err.push(l), stdout: () => {} });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("There is no config file");
  });

  test("healthy exits 0; stale exits 1, writes to stderr and Telegram once; recovery exits 0", async () => {
    const api = new FakeTelegramApi();
    try {
      const { stateDir, run, err } = setup((text) =>
        text.replace('channel = "none"', 'channel = "telegram"').replace('# telegramBotTokenEnv = "TELEGRAM_BOT_TOKEN"', 'telegramBotTokenEnv = "ALERT_TOKEN"').replace('# telegramChatId = "100000001"', 'telegramChatId = "100000001"'),
      );
      setHeartbeat(stateDir, THU_10AM);
      expect(await run(THU_10AM, api)).toBe(0);

      expect(await run(THU_10AM + 90 * MINUTE, api)).toBe(1);
      expect(api.sends().length).toBe(1);
      expect(err.join("\n")).toContain("no healthy chat-app check");
      expect(await run(THU_10AM + 91 * MINUTE, api)).toBe(1); // still wrong, but not reported twice
      expect(api.sends().length).toBe(1);

      setHeartbeat(stateDir, THU_10AM + 92 * MINUTE);
      expect(await run(THU_10AM + 92 * MINUTE, api)).toBe(0);
    } finally {
      api.stop();
    }
  });

  test("with no alert channel, a problem goes to stderr only", async () => {
    const { run, err } = setup();
    expect(await run(THU_10AM)).toBe(1); // no heartbeat file
    expect(err.join("\n")).toContain("ALERT: Dinner bot: there is no heartbeat file");
  });
});
