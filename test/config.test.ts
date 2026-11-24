// The config file: the example parses, every kind of mistake is reported by key, and no secret is
// ever repeated back.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, REPO_DIR, loadConfig, minutesFromTime, missingSecrets, parseConfig } from "../src/config.ts";
import { EXAMPLE_CONFIG_PATH, exampleConfig, exampleConfigText } from "./fixtures/config-fixtures.ts";

// Problems from parsing the example after `edit` changes its text. Fails the test if it parses.
function problemsAfter(edit: (text: string) => string, env: Record<string, string | undefined> = {}): string[] {
  try {
    parseConfig(exampleConfigText(edit), { baseDir: REPO_DIR, env });
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
  throw new Error("expected the config to be refused, but it parsed");
}

// Swaps exactly one piece of text, failing loudly if the example no longer contains it.
function swap(from: string, to: string): (text: string) => string {
  return (text) => {
    if (!text.includes(from)) throw new Error(`the example config no longer contains: ${from}`);
    return text.replace(from, to);
  };
}

describe("the example config", () => {
  test("parses, with the synthetic household and the settings the plan names", () => {
    const config = exampleConfig();
    expect(config.household).toEqual({ name: "The Example Household", botName: "Dinner Bot" });
    expect(config.members.map((m) => [m.id, m.name, m.role])).toEqual([
      ["alex", "Alex", "admin"],
      ["sam", "Sam", "adult"],
    ]);
    expect(config.schedule).toEqual({
      timeZone: "America/New_York",
      draftDay: "friday",
      draftTime: "16:00",
      draftMinutes: 960,
      catchUpDay: "sunday",
      catchUpTime: "12:00",
      catchUpMinutes: 720,
      lateAfterMinutes: 30,
    });
    expect(config.planning).toEqual({ weeknights: ["monday", "tuesday", "wednesday", "thursday"], minDiscoveryNights: 1 });
    expect(config.messaging.platform).toBe("signal");
    expect(config.messaging.mode).toBe("group");
    expect(config.model).toEqual({ id: "claude-sonnet-5-5", apiKeyEnv: "ANTHROPIC_API_KEY", timeoutMs: 120000, maxOutputTokens: 8192 });
    expect(config.recipes.secondsBetweenRequests).toBe(5);
    expect(config.alerts.channel).toBe("none");
    expect(config.dryRun).toBe(false);
  });

  test("folders default to ./data and ./state next to the config file", () => {
    const config = exampleConfig();
    expect(config.paths).toEqual({ dataDir: join(REPO_DIR, "data"), stateDir: join(REPO_DIR, "state") });
  });

  test("contains no secret values: every ...Env setting is just a variable name", () => {
    const config = exampleConfig();
    for (const name of [config.model.apiKeyEnv, config.messaging.telegram.botTokenEnv, config.messaging.whatsapp.accessTokenEnv]) {
      expect(name).toMatch(/^[A-Z_]+$/);
    }
  });

  test("a bare minimum config gets every default", () => {
    const minimal = [
      "[household]",
      'name = "Minimal"',
      "[[members]]",
      'id = "alex"',
      'name = "Alex"',
      'role = "admin"',
      "[members.identities]",
      'telegram = "100000001"',
      "[schedule]",
      'timezone = "Europe/London"',
      "[messaging]",
      'platform = "telegram"',
      "[messaging.telegram]",
      'chatId = "-1000000000001"',
    ].join("\n");
    const config = parseConfig(minimal, { baseDir: "/base" });
    expect(config.household.botName).toBe("Dinner Bot");
    expect(config.schedule).toMatchObject({ draftDay: "friday", draftTime: "16:00", catchUpDay: "sunday", catchUpTime: "12:00", lateAfterMinutes: 30 });
    expect(config.planning.weeknights).toEqual(["monday", "tuesday", "wednesday", "thursday"]);
    expect(config.planning.minDiscoveryNights).toBe(1);
    expect(config.model.id).toBe("claude-sonnet-5-5");
    expect(config.model.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    expect(config.paths).toEqual({ dataDir: "/base/data", stateDir: "/base/state" });
    expect(config.messaging.mode).toBe("group");
  });

  test("WhatsApp defaults to household direct messages, since its official service cannot join groups", () => {
    const text = [
      '[household]\nname = "H"',
      '[[members]]\nid = "alex"\nname = "Alex"\nrole = "admin"\n[members.identities]\nwhatsapp = "+15555550101"',
      '[schedule]\ntimezone = "UTC"',
      '[messaging]\nplatform = "whatsapp"',
      '[messaging.whatsapp]\nphoneNumberId = "123456789"',
    ].join("\n");
    expect(parseConfig(text).messaging.mode).toBe("household-dms");
  });
});

describe("environment overrides", () => {
  test("HMP_DRY_RUN, HMP_STATE_DIR and HMP_DATA_DIR override the file", () => {
    const config = exampleConfig({ HMP_DRY_RUN: "1", HMP_STATE_DIR: "/tmp/hmp-state", HMP_DATA_DIR: "/tmp/hmp-data" });
    expect(config.dryRun).toBe(true);
    expect(config.paths).toEqual({ dataDir: "/tmp/hmp-data", stateDir: "/tmp/hmp-state" });
    // signal-cli's folder is its own setting; the example writes it relative to the config file.
    expect(config.messaging.signal.dataDir).toBe(join(REPO_DIR, "state", "signal-cli"));
  });

  test("HMP_CONFIG points at the file, relative paths in it count from that file's folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"));
    writeFileSync(join(dir, "household.toml"), exampleConfigText());
    const config = loadConfig({ HMP_CONFIG: join(dir, "household.toml") });
    expect(config.paths.dataDir).toBe(join(dir, "data"));
    expect(config.paths.stateDir).toBe(join(dir, "state"));
  });

  test("a missing config file says where it looked and how to make one", () => {
    const missing = join(tmpdir(), "no-such-folder", "config.toml");
    expect(() => loadConfig({ HMP_CONFIG: missing })).toThrow(missing);
    expect(() => loadConfig({ HMP_CONFIG: missing })).toThrow("config.example.toml");
  });
});

describe("what the config refuses, and how it says so", () => {
  test("a placeholder still in <angle brackets>, named by its key", () => {
    const problems = problemsAfter(swap('botNumber = "+15555550123"', 'botNumber = "<your bot number>"'));
    expect(problems.some((p) => p.startsWith("messaging.signal.botNumber still has a placeholder"))).toBe(true);
    expect(problems.join("\n")).not.toContain("your bot number");
  });

  test("an empty member list", () => {
    const minimal = '[household]\nname = "H"\n[schedule]\ntimezone = "UTC"\n[messaging]\nplatform = "telegram"\n';
    expect(() => parseConfig(minimal)).toThrow(/members is empty/);
  });

  test("no admin among the members", () => {
    const problems = problemsAfter(swap('role = "admin"', 'role = "adult"'));
    expect(problems).toContain('No member has role = "admin". Give at least one person the admin role.');
  });

  test("a member whose role is not admin or adult", () => {
    const problems = problemsAfter(swap('role = "adult"', 'role = "child"'));
    expect(problems).toContain("members[1].role must be one of: admin, adult.");
  });

  test("two members sharing one identity, without printing the identity", () => {
    const problems = problemsAfter(swap('signal = "22222222-2222-4222-8222-222222222222"', 'signal = "11111111-1111-4111-8111-111111111111"'));
    expect(problems).toContain("members[1].identities.signal is the same as members[0].identities.signal. Two people cannot share one account.");
    expect(problems.join("\n")).not.toContain("11111111-1111");
  });

  test("a member with no identity on the chat app in use", () => {
    const problems = problemsAfter(swap('signal = "22222222-2222-4222-8222-222222222222"\n', ""));
    expect(problems.some((p) => p.startsWith("members[1].identities.signal is missing"))).toBe(true);
  });

  test("an identity in the wrong format for its chat app", () => {
    const problems = problemsAfter(swap('signal = "22222222-2222-4222-8222-222222222222"', 'signal = "sam"'));
    expect(problems.some((p) => p.startsWith("members[1].identities.signal must be a Signal account ID"))).toBe(true);
  });

  test("duplicate member ids and names", () => {
    const problems = problemsAfter(swap('id = "sam"\nname = "Sam"', 'id = "alex"\nname = "ALEX"'));
    expect(problems).toContain("members[1].id is the same as members[0].id. Each member needs their own.");
    expect(problems.some((p) => p.startsWith("members[1].name is the same as members[0].name"))).toBe(true);
  });

  test("an invalid time zone", () => {
    const problems = problemsAfter(swap('timezone = "America/New_York"', 'timezone = "Mars/Olympus_Mons"'));
    expect(problems).toContain('schedule.timezone "Mars/Olympus_Mons" is not a time zone I know. Use a city name such as America/New_York or Europe/London.');
  });

  test("an abbreviation is not a time zone, because it cannot follow daylight saving", () => {
    const problems = problemsAfter(swap('timezone = "America/New_York"', 'timezone = "EST"'));
    expect(problems.some((p) => p.startsWith('schedule.timezone "EST"'))).toBe(true);
  });

  test("a missing time zone", () => {
    const problems = problemsAfter(swap('timezone = "America/New_York"\n', ""));
    expect(problems).toContain("schedule.timezone is missing.");
  });

  test("bad HH:MM times", () => {
    expect(problemsAfter(swap('draftTime = "16:00"', 'draftTime = "4pm"')).some((p) => p.startsWith("schedule.draftTime must be a 24-hour time written HH:MM"))).toBe(true);
    expect(problemsAfter(swap('draftTime = "16:00"', 'draftTime = "25:00"')).some((p) => p.startsWith("schedule.draftTime"))).toBe(true);
    expect(problemsAfter(swap('time = "12:00"', 'time = "12:60"')).some((p) => p.startsWith("schedule.catchUpUntil.time"))).toBe(true);
    expect(minutesFromTime("00:00")).toBe(0);
    expect(minutesFromTime("23:59")).toBe(1439);
    expect(minutesFromTime("9:00")).toBeNull();
  });

  test("a day that is not a day, and a catch-up deadline before the draft", () => {
    expect(problemsAfter(swap('draftDay = "friday"', 'draftDay = "fryday"'))).toContain(
      "schedule.draftDay must be one of: monday, tuesday, wednesday, thursday, friday, saturday, sunday.",
    );
    const problems = problemsAfter(swap('day = "sunday"', 'day = "thursday"'));
    expect(problems.some((p) => p.startsWith("schedule.catchUpUntil must be later in the week"))).toBe(true);
  });

  test("an unknown setting is named, so a typo is caught", () => {
    const problems = problemsAfter(swap("lateAfterMinutes = 30", "lateAfterMinuts = 30"));
    expect(problems.some((p) => p.startsWith("schedule.lateAfterMinuts is not a setting I know"))).toBe(true);
  });

  test("a wrong platform, conversation mode, or weeknights list", () => {
    expect(problemsAfter(swap('platform = "signal"', 'platform = "carrier-pigeon"'))).toContain(
      "messaging.platform must be one of: signal, telegram, whatsapp, imessage.",
    );
    expect(problemsAfter(swap('mode = "group"', 'mode = "huddle"'))).toContain("messaging.conversation.mode must be one of: group, household-dms.");
    expect(problemsAfter(swap('weeknights = ["monday", "tuesday", "wednesday", "thursday"]', 'weeknights = ["monday", "someday"]'))).toContain(
      'planning.weeknights must be a list of day names, like ["monday", "tuesday"].',
    );
  });

  test("the chosen platform's own settings are required: signal needs a bot number and a group", () => {
    const problems = problemsAfter((text) => text.replace('botNumber = "+15555550123"\n', "").replace(/groupId = ".*"\n/, ""));
    expect(problems.some((p) => p.startsWith("messaging.signal.botNumber is missing"))).toBe(true);
    expect(problems.some((p) => p.startsWith("messaging.signal.groupId is missing"))).toBe(true);
  });

  test("every problem is reported at once, not one per run", () => {
    const problems = problemsAfter((text) => text.replace('timezone = "America/New_York"', 'timezone = "Nowhere/Land"').replace('draftTime = "16:00"', 'draftTime = "late"'));
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });

  test("the error message lists the problems as a plain bulleted list", () => {
    try {
      parseConfig(exampleConfigText(swap('role = "admin"', 'role = "adult"')), { baseDir: REPO_DIR });
      throw new Error("should have been refused");
    } catch (error) {
      expect((error as Error).message).toMatch(/^config.toml has 1 problem:\n {2}- No member has role = "admin"/);
    }
  });

  test("text that is not TOML at all is refused without echoing the file", () => {
    const secret = "sk-ant-this-must-not-appear";
    try {
      parseConfig(`[household\nname = "${secret}`);
      throw new Error("should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain("not valid TOML");
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe("secrets are named, never printed", () => {
  const SECRET = "sk-ant-api03-DO-NOT-PRINT-THIS";

  test("a key pasted where an environment variable NAME belongs is refused without repeating it", () => {
    const problems = problemsAfter(swap('apiKeyEnv = "ANTHROPIC_API_KEY"', `apiKeyEnv = "${SECRET}"`));
    expect(problems).toContain("model.apiKeyEnv must be the NAME of an environment variable (like ANTHROPIC_API_KEY), never the secret itself. Put the secret in your environment.");
    expect(problems.join("\n")).not.toContain(SECRET);
    expect(problems.join("\n")).not.toContain("DO-NOT-PRINT");
  });

  test("the same for every other ...Env setting", () => {
    const text = [
      '[household]\nname = "H"',
      '[[members]]\nid = "alex"\nname = "Alex"\nrole = "admin"\n[members.identities]\ntelegram = "100000001"',
      '[schedule]\ntimezone = "UTC"',
      '[messaging]\nplatform = "telegram"',
      `[messaging.telegram]\nchatId = "-1000000000001"\nbotTokenEnv = "123456:${SECRET}"`,
      `[alerts]\ntelegramBotTokenEnv = "${SECRET} extra"`,
    ].join("\n");
    try {
      parseConfig(text);
      throw new Error("should have been refused");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("messaging.telegram.botTokenEnv must be the NAME");
      expect(message).toContain("alerts.telegramBotTokenEnv must be the NAME");
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain("123456:");
    }
  });

  test("a missing secret is reported by its variable name only, and a present one is never echoed", () => {
    const config = exampleConfig();
    expect(missingSecrets(config, {})).toEqual(["The environment variable ANTHROPIC_API_KEY is not set. It should hold the model API key."]);
    expect(missingSecrets(config, { ANTHROPIC_API_KEY: SECRET })).toEqual([]);
  });

  test("the chat app in use decides which other secrets are needed", () => {
    const config = exampleConfig();
    config.messaging.platform = "telegram";
    config.alerts.channel = "telegram";
    const problems = missingSecrets(config, { ANTHROPIC_API_KEY: SECRET });
    expect(problems).toEqual(["The environment variable TELEGRAM_BOT_TOKEN is not set. It should hold the Telegram bot token."]);
  });
});

describe("the example file stays honest", () => {
  test("every key the example sets is one the parser knows (a typo here would be refused)", () => {
    expect(() => parseConfig(exampleConfigText(), { baseDir: REPO_DIR })).not.toThrow();
  });

  test("the example is the file named in the docs", () => {
    expect(EXAMPLE_CONFIG_PATH.endsWith("config.example.toml")).toBe(true);
  });
});
