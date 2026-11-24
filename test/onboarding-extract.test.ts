// The interview's reading call, through the real brain with the Anthropic client faked.

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClaudeCaller, BrainError } from "../src/brain/claude.ts";
import { ClaudeBrain } from "../src/brain/index.ts";
import { ONBOARDING_PROMPT_PATH, parseExtraction, renderExtractRequest } from "../src/brain/onboarding.ts";
import { parseProfile } from "../src/data/profile.ts";
import { applyExtraction, startAsking, type OnboardingExtractRequest } from "../src/onboarding/state.ts";
import { FakeAnthropic, answer, apiError } from "./fixtures/fake-anthropic.ts";
import { BRAIN_SETTINGS } from "./fixtures/config-fixtures.ts";
import { NOW, add, applied, extraction, freshState, msg } from "./fixtures/onboarding-fixtures.ts";

const KEY = "sk-ant-api03-TEST-KEY-1234567890";
let fake: FakeAnthropic;
let logs: string[];

function brain(): ClaudeBrain {
  logs = [];
  return new ClaudeBrain({
    callModel: createClaudeCaller({ clientFactory: fake.factory, env: { ANTHROPIC_API_KEY: KEY } }),
    settings: BRAIN_SETTINGS,
    log: (line) => logs.push(line),
  });
}

beforeEach(() => {
  fake = new FakeAnthropic();
});

const A = msg("1700-a", "Alex", "Friday is eating out. Weeknight dinners need to be quick, 30 minutes or less.");
const S = msg("1700-b", "Sam", "I won't eat mushrooms.");

function request(batch = [A, S], state = startAsking(freshState(), NOW)): OnboardingExtractRequest {
  return { state, batch };
}

const GOOD = {
  additions: [
    { sourceMessageId: "1700-a", topic: "nights", kind: "rule", wording: "Friday is eating out.", check: { kind: "fixed", night: "friday", value: "out" } },
    { sourceMessageId: "1700-a", topic: "nights", kind: "rule", wording: "Weeknight dinners need to be quick", check: { kind: "require", tag: "Quick", nights: "weeknights" } },
    { sourceMessageId: "1700-a", topic: "nights", kind: "note", wording: "30 minutes or less" },
    { sourceMessageId: "1700-b", topic: "wont-eat", kind: "dislike", wording: "I won't eat mushrooms.", person: "Sam", what: "mushrooms" },
  ],
  topicsCovered: ["nights", "wont-eat"],
};

describe("extractOnboarding", () => {
  test("a good answer comes back parsed, with tags cleaned, through one isolated, tool-less call", async () => {
    fake.push(answer(JSON.stringify(GOOD)));
    const outcome = await brain().extractOnboarding(request());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.additions).toHaveLength(4);
    expect(outcome.result.additions[1]!.detail).toEqual({ kind: "rule", check: { kind: "require", tag: "quick", nights: "weeknights" } });
    expect(outcome.result.topicsCovered).toEqual(["nights", "wont-eat"]);

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect("tools" in call.params).toBe(false);
    expect(call.system).toContain("House-rules interviewer");
    expect(call.system).toContain("Dinner Bot");
    expect(call.system).toContain("Monday to Thursday");
    expect(call.prompt).toContain("[1700-a] Alex: Friday is eating out.");
  });

  test("it feeds into the state: facts are attributed to the message authors", async () => {
    fake.push(answer(JSON.stringify(GOOD)));
    const outcome = await brain().extractOnboarding(request());
    if (!outcome.ok) throw new Error("expected ok");
    const state = applyExtraction(startAsking(freshState(), NOW), [A, S], outcome.result, NOW).state;
    expect(state.facts.map((f) => [f.memberName, f.kind])).toEqual([["Alex", "rule"], ["Alex", "rule"], ["Alex", "note"], ["Sam", "dislike"]]);
    expect(state.covered.nights).toBeDefined();
    expect(state.covered["wont-eat"]).toBeDefined();
  });

  test("an unusable answer is retried once with every problem named, then reported as not ok", async () => {
    const bad = { additions: [{ sourceMessageId: "nope", topic: "nights", kind: "veto", wording: "x", dish: "y" }] };
    fake.push(answer(JSON.stringify(bad)), answer("not json at all"));
    const outcome = await brain().extractOnboarding(request());
    expect(outcome.ok).toBe(false);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.prompt).toContain("Your last answer could not be used");
    expect(fake.calls[1]!.prompt).toContain("is not one of the new messages");
    expect(logs.some((line) => line.includes("unusable"))).toBe(true);
  });

  test("a bad first answer and a good second one succeeds", async () => {
    fake.push(answer("{}}"), answer(JSON.stringify(GOOD)));
    expect((await brain().extractOnboarding(request())).ok).toBe(true);
    expect(fake.calls).toHaveLength(2);
  });

  test("a failed call throws a BrainError for the failure policy; it is not retried here", async () => {
    fake.push({ throws: apiError(429, "rate limited") });
    const error = await brain().extractOnboarding(request()).catch((e) => e);
    expect(error).toBeInstanceOf(BrainError);
    expect((error as BrainError).errorClass).toBe("rate-limit");
    expect(fake.calls).toHaveLength(1);
  });

  test("an empty batch makes no call", async () => {
    const outcome = await brain().extractOnboarding(request([]));
    expect(outcome).toEqual({ ok: true, result: extraction({}) });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("parseExtraction is strict", () => {
  const parse = (value: unknown, req = request()) => parseExtraction(JSON.stringify(value), req);
  const problemsOf = (value: unknown, req = request()) => {
    const parsed = parse(value, req);
    return parsed.ok ? [] : parsed.problems;
  };
  const rule = (extra: object = {}) => ({ sourceMessageId: "1700-a", topic: "nights", kind: "rule", wording: "Friday is eating out.", check: { kind: "fixed", night: "friday", value: "out" }, ...extra });

  test("accepts JSON inside a code fence or with text around it", () => {
    expect(parseExtraction("Here you go:\n```json\n" + JSON.stringify({ additions: [rule()] }) + "\n```", request()).ok).toBe(true);
  });

  test("an unknown message id is a problem that names the id", () => {
    expect(problemsOf({ additions: [rule({ sourceMessageId: "9999" })] }).join(" ")).toContain('"9999" is not one of the new messages');
  });

  test("wording that is not in the cited message is a problem; another message's words do not count", () => {
    expect(problemsOf({ additions: [rule({ wording: "Friday is for pizza." })] }).join(" ")).toContain("does not appear in message 1700-a");
    expect(problemsOf({ additions: [rule({ wording: "I won't eat mushrooms." })] }).join(" ")).toContain("does not appear");
  });

  test("whitespace differences in a quote are tolerated, wording differences are not", () => {
    const spaced = msg("m", "Alex", "Friday   is\n eating out.");
    expect(parse({ additions: [rule({ sourceMessageId: "m" })] }, request([spaced])).ok).toBe(true);
  });

  test("checks are validated field by field", () => {
    const bad = (check: unknown) => problemsOf({ additions: [rule({ check })] }).join(" ");
    expect(bad({ kind: "fixed", night: "someday", value: "out" })).toContain("night must be a day name");
    expect(bad({ kind: "min", tag: "fish", count: 2.5 })).toContain("whole number");
    expect(bad({ kind: "min", tag: "", count: 2 })).toContain("one-word tag");
    expect(bad({ kind: "require", tag: "quick", nights: "weekends" })).toContain("weeknights");
    expect(bad({ kind: "teleport" })).toContain("is not a kind of check");
    expect(bad("min fish 2")).toContain("must be an object");
  });

  test("a dish needs a name and protein, a usable pool and tags", () => {
    const dish = (extra: object) => ({ sourceMessageId: "1700-a", topic: "dinners", kind: "dish", wording: "Friday is eating out.", name: "Tacos", protein: "chicken", ...extra });
    expect(parse({ additions: [dish({})] }).ok).toBe(true);
    expect(problemsOf({ additions: [dish({ protein: "" })] }).join(" ")).toContain('"protein"');
    expect(problemsOf({ additions: [dish({ pool: "sometimes" })] }).join(" ")).toContain('"pool"');
    expect(problemsOf({ additions: [dish({ tags: "quick" })] }).join(" ")).toContain('"tags" must be a list');
  });

  test("unknown topics and kinds are problems", () => {
    expect(problemsOf({ additions: [rule({ topic: "weather" })] }).join(" ")).toContain('"topic" must be one of');
    expect(problemsOf({ additions: [rule({ kind: "recipe" })] }).join(" ")).toContain("not a kind of addition");
    expect(problemsOf({ topicsCovered: ["weather"] }).join(" ")).toContain("not a topic");
  });

  test("a list that is not a list, or not an object at all, is a problem", () => {
    expect(problemsOf({ additions: "lots" }).join(" ")).toContain('"additions" must be a list');
    expect(parseExtraction("[1,2]", request()).ok).toBe(false);
  });

  describe("conflicts", () => {
    const conflict = (versions: unknown[]) => ({ conflicts: [{ topic: "nights", subject: "Friday dinner", versions }] });
    const second = msg("1700-c", "Sam", "Fridays we cook at home.");

    test("quotes must match the batch text and come from two different adults", () => {
      const req = request([A, second]);
      const ok = parse(conflict([{ sourceMessageId: "1700-a", quote: "Friday is eating out." }, { sourceMessageId: "1700-c", quote: "Fridays we cook at home." }]), req);
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.value.conflicts[0]!.versions.map((v) => v.memberName)).toEqual(["Alex", "Sam"]);

      expect(problemsOf(conflict([{ sourceMessageId: "1700-a", quote: "Friday is eating out." }, { sourceMessageId: "1700-c", quote: "We always cook." }]), req).join(" ")).toContain("does not appear in message 1700-c");
      expect(problemsOf(conflict([{ sourceMessageId: "1700-a", quote: "Friday is eating out." }, { sourceMessageId: "1700-a", quote: "30 minutes or less" }]), req).join(" ")).toContain("two different adults");
      expect(problemsOf(conflict([{ sourceMessageId: "1700-a", quote: "Friday is eating out." }]), req).join(" ")).toContain("at least two");
    });

    test("an earlier fact can be one side of the conflict, with its own words and author", () => {
      const first = msg("m0", "Alex", "Friday is eating out.");
      const state = applied(startAsking(freshState(), NOW), [first], extraction({ additions: [add(first, "nights", "Friday is eating out.", { kind: "rule", check: { kind: "fixed", night: "friday", value: "out" } })] }));
      const parsed = parse(conflict([{ factId: "f1" }, { sourceMessageId: "1700-c", quote: "Fridays we cook at home." }]), request([second], state));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.conflicts[0]!.versions[0]).toMatchObject({ memberName: "Alex", quote: "Friday is eating out.", factId: "f1" });
      expect(problemsOf(conflict([{ factId: "f77" }, { sourceMessageId: "1700-c", quote: "Fridays we cook at home." }]), request([second], state)).join(" ")).toContain("not a fact I showed you");
    });
  });

  describe("withdrawals and resolutions", () => {
    const first = msg("m0", "Alex", "Friday is eating out.");
    const withFact = () => applied(startAsking(freshState(), NOW), [first], extraction({ additions: [add(first, "nights", "Friday is eating out.", { kind: "rule", check: { kind: "fixed", night: "friday", value: "out" } })] }));

    test("only the author's own message can withdraw a fact", () => {
      const byAlex = msg("m1", "Alex", "scrap that");
      const bySam = msg("m2", "Sam", "scrap Alex's");
      expect(parse({ withdrawals: [{ factId: "f1", sourceMessageId: "m1" }] }, request([byAlex], withFact())).ok).toBe(true);
      expect(problemsOf({ withdrawals: [{ factId: "f1", sourceMessageId: "m2" }] }, request([bySam], withFact())).join(" ")).toContain("only a message from Alex can withdraw");
      expect(problemsOf({ withdrawals: [{ factId: "f9", sourceMessageId: "m1" }] }, request([byAlex], withFact())).join(" ")).toContain("not a fact I showed you");
    });

    test("resolving needs an open conflict that was shown", () => {
      const m = msg("m3", "Sam", "ok, out");
      expect(problemsOf({ resolvedConflicts: [{ conflictId: "c1", sourceMessageId: "m3" }] }, request([m], withFact())).join(" ")).toContain("not an open conflict");
    });
  });
});

describe("the request text", () => {
  test("it shows the topic status, the facts so far with ids, and the messages", () => {
    const first = msg("m0", "Alex", "Friday is eating out.");
    const state = applied(startAsking(freshState(), NOW), [first], extraction({ additions: [add(first, "nights", "Friday is eating out.", { kind: "rule", check: { kind: "fixed", night: "friday", value: "out" } })], topicsCovered: ["nights"] }));
    const text = renderExtractRequest({ state, batch: [S] });
    expect(text).toContain("- nights: covered");
    expect(text).toContain("- habits: not covered yet (this is the question being asked)");
    expect(text).toContain('- f1 | Alex | nights | rule, check {"kind":"fixed","night":"friday","value":"out"} | "Friday is eating out."');
    expect(text).toContain("[1700-b] Sam: I won't eat mushrooms.");
  });
});

describe("the reference examples in the prompt", () => {
  const prompt = readFileSync(ONBOARDING_PROMPT_PATH, "utf8");
  const cookbook = readFileSync(join(import.meta.dir, "..", "docs", "house-rules.md"), "utf8");
  const examples = prompt.split("\n").filter((line) => /^- .*\[[^\]]+\]$/.test(line));

  test("there are examples, and every one is a line from the cookbook", () => {
    expect(examples.length).toBeGreaterThanOrEqual(8);
    for (const line of examples) expect(cookbook).toContain(line);
  });

  test("every example parses as a rule", () => {
    const text = ["## Rules", ...examples, "## Usual Dishes", "## Also-Like Dishes", "## Staples", "## Dislikes", "## Vetoes", "## Lock Words", "## Thresholds", "- max-usual-dishes-per-week: 2", "- max-nights-per-protein: 2", "- repeat-window-weeks: 3", "- batching-window-seconds: 15"].join("\n");
    expect(parseProfile(text).rules).toHaveLength(examples.length);
  });

  test("it says examples are never household facts, and has no unfilled blanks other than the three it names", () => {
    expect(prompt).toContain("never facts about this household");
    const blanks = [...prompt.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    expect(new Set(blanks)).toEqual(new Set(["botName", "memberNames", "weeknights"]));
  });
});
